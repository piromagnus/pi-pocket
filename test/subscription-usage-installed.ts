// Manual integration checks for the official gallery drop-in, using fake sign-ins and no real services.
// node --test test/subscription-usage-installed.ts
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";

const folder =
    process.env.SUBSCRIPTION_USAGE_EXTENSION_DIR ?? join(homedir(), ".pi-pocket", "extensions");
const module = await import(pathToFileURL(join(folder, "subscription-usage.ts")).href);
const root = mkdtempSync(join(tmpdir(), "subscription-usage-check-"));

after(() => rmSync(root, { recursive: true, force: true }));

async function fixture(
    t: TestContext,
    credentials: unknown = {
        claudeAiOauth: { accessToken: "fake-bridge-token", expiresAt: Date.now() + 60000 },
    },
) {
    const directory = mkdtempSync(join(root, "claude-"));

    if (credentials !== undefined) {
        writeFileSync(
            join(directory, ".credentials.json"),
            typeof credentials === "string" ? credentials : JSON.stringify(credentials),
        );
    }

    const before = process.env.CLAUDE_CONFIG_DIR;

    process.env.CLAUDE_CONFIG_DIR = directory;
    const authCalls: string[] = [];

    t.mock.method(
        ModelRuntime,
        "create",
        async () =>
            ({
                getAuth: async (provider: string) => {
                    authCalls.push(provider);

                    return { auth: { apiKey: "fake-pi-token" } };
                },
            }) as unknown as ModelRuntime,
    );
    t.mock.method(childProcess, "spawn", () => {
        throw new Error("Codex intentionally unavailable in this offline check");
    });
    syncBuiltinESMExports();
    const requests: { url: string; authorization: string | null }[] = [];

    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(url),
            authorization: new Headers(init?.headers).get("authorization"),
        });
        assert.equal(init?.redirect, "error");

        return Response.json({
            five_hour: { utilization: 25, resets_at: "2026-10-23T00:00:00Z" },
            seven_day: { utilization: 60 },
        });
    });
    let handler!: (request: { query: URLSearchParams }) => any;
    const dispose: (() => unknown)[] = [];

    module.default(undefined, {
        route: (method: string, path: string, run: typeof handler) => {
            assert.equal(method, "GET");
            assert.equal(path, "usage");
            handler = run;
        },
        client: () => {},
        command: () => {},
        onDispose: (run: () => unknown) => dispose.push(run),
    });
    t.after(async () => {
        await Promise.all(dispose.map((run) => run()));
        t.mock.restoreAll();
        syncBuiltinESMExports();

        if (before === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = before;
        }
    });
    const read = (source = "pi") =>
        Promise.resolve(handler({ query: new URLSearchParams({ claude: source }) }));

    return { read, authCalls, requests, directory };
}

test("Claude Bridge uses Claude Code credentials and keeps tokens out of reports", async (t) => {
    const f = await fixture(t);
    const response = await f.read("bridge");
    // v1.2.0 sorts ok answers first, so find the report by id instead of trusting reports[0].
    const report = response.reports.find((entry: any) => entry.id === "claude-bridge");

    assert.ok(report);
    assert.equal(report.ok, true);
    assert.equal(report.limits[0].percent, 25);
    assert.equal(
        f.requests.find((r) => r.url.includes("anthropic"))?.authorization,
        "Bearer fake-bridge-token",
    );
    assert.equal(f.authCalls.includes("anthropic"), false);
    assert.equal(JSON.stringify(response).includes("fake-bridge-token"), false);
    // Six answers with these fixtures: Grok stays out because its sign-in is not OAuth.
    assert.equal(response.reports.length, 6);
});

test("Pi remains the default and source-specific caches never mix sign-ins", async (t) => {
    const f = await fixture(t);
    const [pi, bridge] = await Promise.all([f.read(), f.read("bridge")]);

    assert.equal(pi.reports[0].id, "anthropic");
    assert.equal(bridge.reports[0].id, "claude-bridge");
    assert.equal((await f.read()).reports[0].id, "anthropic");
    assert.equal((await f.read("bridge")).reports[0].id, "claude-bridge");
    const headers = f.requests
        .filter((r) => r.url.includes("anthropic"))
        .map((r) => r.authorization)
        .sort();

    assert.deepEqual(headers, ["Bearer fake-bridge-token", "Bearer fake-pi-token"]);
});

test("simultaneous Bridge reads share one request", async (t) => {
    const f = await fixture(t);

    await Promise.all([f.read("bridge"), f.read("bridge"), f.read("bridge")]);
    assert.equal(f.requests.filter((r) => r.url.includes("anthropic")).length, 1);
});

for (const [label, credentials] of [
    ["malformed", "secret-invalid-json"],
    ["missing-token", { claudeAiOauth: {} }],
    ["expired", { claudeAiOauth: { accessToken: "fake-expired-secret", expiresAt: 1 } }],
] as const) {
    test(`${label} Claude Code credentials fail without leaking secrets or sending an Anthropic request`, async (t) => {
        const f = await fixture(t, credentials);
        const response = await f.read("bridge");
        // v1.2.0 sorts ok answers first: find the failed bridge report by id.
        const report = response.reports.find((entry: any) => entry.id === "claude-bridge");

        assert.ok(report);
        assert.equal(report.ok, false);
        assert.match(report.error, /claude auth login/);
        assert.equal(
            /secret-invalid-json|fake-expired-secret/.test(JSON.stringify(response)),
            false,
        );
        assert.equal(
            f.requests.some((r) => r.url.includes("anthropic")),
            false,
        );
    });
}

test("Bridge authentication rejection points to Claude Code without returning the response body", async (t) => {
    const f = await fixture(t);

    t.mock.method(
        globalThis,
        "fetch",
        async () => new Response("private-secret-from-service", { status: 401 }),
    );
    const response = await f.read("bridge");

    assert.match(response.reports[0].error, /Claude Code.*401/);
    assert.equal(JSON.stringify(response).includes("private-secret-from-service"), false);
});

test(
    "phone selector persists and ignores a previous sign-in's late response",
    {
        skip: findBrowser() ? false : "no Chromium-based browser",
    },
    async () => {
        const assets = new Map([
            ["/preact.js", import.meta.resolve("preact")],
            ["/hooks.js", import.meta.resolve("preact/hooks")],
            ["/htm.js", import.meta.resolve("htm")],
            ["/usage.js", pathToFileURL(join(folder, "subscription-usage/index.js")).href],
            ["/look.css", pathToFileURL(join(folder, "subscription-usage/look.css")).href],
        ]);
        const server = createServer((req, res) => {
            const asset = assets.get(req.url ?? "");

            if (asset) {
                res.setHeader(
                    "Content-Type",
                    req.url === "/look.css" ? "text/css" : "text/javascript",
                );
                res.end(readFileSync(new URL(asset)));

                return;
            }

            res.setHeader("Content-Type", "text/html");
            res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <script type="importmap">{"imports":{"preact":"/preact.js","preact/hooks":"/hooks.js"}}</script>
            <link rel="stylesheet" href="/look.css"><div id="app"></div>
            <script type="module">
            import {h,render} from 'preact'; import * as hooks from 'preact/hooks';
            import htm from '/htm.js'; import setup from '/usage.js';
            const html=htm.bind(h);
            setup({html,...hooks,Icon:()=>null,Spinner:()=>null,Loader:()=>html\`<p>Loading</p>\`,
                style:()=>{},rail:()=>({update:()=>{}}),launcher:()=>{},onDispose:()=>{},
                page:({component})=>render(h(component),document.querySelector('#app')),
                api:async(path)=>{
                    const bridge=path.includes('claude=bridge');
                    if(window.holdPi&&!bridge) await new Promise(resolve=>window.releasePi=resolve);
                    return {at:Date.now(),reports:[{id:bridge?'claude-bridge':'anthropic',
                        name:bridge?'Claude Bridge (Claude Code)':'Pi Anthropic',ok:true,limits:[]}]};
                }
            });
            </script>`);
        });
        const browsers = new Browsers({
            dataDir: join(root, "browser"),
            load: async () => undefined,
            save: () => {},
        });

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const page = await browsers.open(1);
        const value = async (expression: string) =>
            JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`));

        const wait = async (expression: string) => {
            for (let i = 0; i < 100; i++) {
                if (await value(expression)) {
                    return;
                }

                await new Promise((resolve) => setTimeout(resolve, 50));
            }

            assert.fail(`Timed out: ${expression}`);
        };

        const choose = async (source: string) =>
            page.evaluate(
                `const select=document.querySelector('select'); select.value=${JSON.stringify(source)}; select.dispatchEvent(new Event('change',{bubbles:true}))`,
            );

        try {
            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
            await wait("document.body.textContent.includes('Pi Anthropic')");
            assert.equal(await value("document.querySelector('select').value"), "pi");
            await choose("bridge");
            await wait("!!document.getElementById('su-plan-claude-bridge')");
            assert.equal(await value("document.querySelector('select').value"), "bridge");
            assert.equal(await value("document.documentElement.scrollWidth <= innerWidth"), true);
            await page.reload();
            await wait(
                "document.querySelector('select')?.value === 'bridge' && !!document.getElementById('su-plan-claude-bridge')",
            );
            await page.evaluate("window.holdPi=true");
            await choose("pi");
            await wait("typeof window.releasePi === 'function'");
            await choose("bridge");
            await wait("!!document.getElementById('su-plan-claude-bridge')");
            await page.evaluate("window.releasePi()");
            assert.equal(await value("!!document.getElementById('su-plan-anthropic')"), false);
            assert.equal(await value("document.querySelector('select').value"), "bridge");
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    },
);
