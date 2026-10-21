// Everything is offline and isolated from the owner's Pi and Claude installations.
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ArtifactBodyDoc, ArtifactsDoc } from "../src/server/docs.ts";
import {
    collectUsage,
    headerWindows,
    normalizeUsage,
    renderDashboard,
} from "../docs/examples/provider-usage.ts";

const agentDir = join(root, "usage-agent");
const claudeDir = join(root, "usage-claude");
const options = { env: {}, claudeDir, now: 1 };

await mkdir(agentDir, { recursive: true });
await mkdir(claudeDir, { recursive: true });
after(cleanUp);

async function credentials(value: unknown) {
    await writeFile(join(agentDir, "auth.json"), JSON.stringify(value));
    await writeFile(join(agentDir, "models.json"), "{}");
}

function usageOf(tokens: number, cost: number) {
    return {
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
}

function mockFetch(callback: (url: string, init: RequestInit) => Response): typeof fetch {
    return (async (url, init) => callback(String(url), init ?? {})) as typeof fetch;
}

test("Claude recognizes all windows, flat scoped limits, and extra-usage warning", () => {
    const row = normalizeUsage("anthropic", {
        five_hour: { utilization: 0, resets_at: "2026-10-09T00:00:00Z" },
        seven_day: { utilization: 80 },
        seven_day_sonnet: { utilization: 100 },
        limits: [
            { percent: 12, kind: "weekly_scoped", scope: { model: { display_name: "Fable" } } },
        ],
        extra_usage: { is_enabled: true },
        access_token: "NEVER_SHOW_THIS",
    });

    assert.deepEqual(
        row.windows.map((window) => window.used),
        [0, 80, 100, 12],
    );
    assert.equal(row.windows[0]!.reset, "2026-10-09T00:00:00.000Z");
    assert.match(row.facts[0]!, /additional charges/);
    assert.ok(!JSON.stringify(row).includes("NEVER_SHOW_THIS"));
    assert.equal(
        normalizeUsage("anthropic", { five_hour: { utilization: 1, resets_at: 1e20 } }).windows[0]!
            .reset,
        undefined,
    );
});

test("Codex durations, resets, credits and per-model quotas are not conflated with API costs", () => {
    const row = normalizeUsage("openai-codex", {
        plan_type: "plus",
        rate_limit: {
            primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1791504000 },
            secondary_window: { used_percent: 10, limit_window_seconds: 604800 },
        },
        additional_rate_limits: [
            { limit_name: "Spark", rate_limit: { primary_window: { used_percent: 5 } } },
        ],
        credits: { balance: "12.5" },
    });

    assert.equal(row.windows[0]!.label, "Codex · 5h");
    assert.equal(row.windows[1]!.label, "Codex · 168h");
    assert.match(row.windows[2]!.label, /Spark/);
    assert.ok(row.facts.includes("Codex credits: 12.5"));
    assert.match(row.message, /not.*API spending/);
});

test("OpenRouter uses key spending and budget, not the account balance", () => {
    const row = normalizeUsage("openrouter", {
        data: { usage: 3, limit: 10, limit_remaining: 7, usage_daily: 1 },
    });

    assert.equal(row.windows[0]!.used, 30);
    assert.ok(row.facts.includes("Key spending: $3.00"));
    assert.match(row.message, /not the whole account/);
    assert.equal(normalizeUsage("openrouter", { data: { usage: 0, limit: null } }).status, "ok");
    assert.equal(
        normalizeUsage("anthropic", { five_hour: { utilization: null } }).status,
        "unavailable",
    );
    assert.equal(
        normalizeUsage("openai-codex", { rate_limit: { primary_window: { used_percent: "NaN" } } })
            .status,
        "unavailable",
    );
});

test("OpenRouter reset-period budgets never use lifetime spending as current usage", () => {
    const period = normalizeUsage("openrouter", {
        data: { usage: 500, usage_daily: 2, limit: 10, limit_reset: "daily" },
    });
    const remaining = normalizeUsage("openrouter", {
        data: { usage: 500, limit: 10, limit_remaining: 7 },
    });

    assert.equal(period.windows[0]!.used, 20);
    assert.equal(remaining.windows[0]!.used, 30);
});

test("Copilot distinguishes unlimited quota from 0% used", () => {
    const row = normalizeUsage("github-copilot", {
        copilot_plan: "individual",
        quota_reset_date: "2026-11-01",
        quota_snapshots: {
            premium_interactions: { percent_remaining: 75 },
            chat: { unlimited: true },
        },
    });

    assert.equal(row.windows[0]!.used, 25);
    assert.ok(row.facts.includes("chat: unlimited"));
});

test("collection inventories providers, uses fixed GET endpoints and never leaks credentials", async () => {
    await credentials({
        anthropic: { type: "oauth", access: "secret-claude", expires: 100 },
        "openai-codex": {
            type: "oauth",
            access: "secret-codex",
            accountId: "workspace",
            expires: 100,
        },
        openrouter: { type: "api_key", key: "secret-router" },
        mistral: { type: "api_key", key: "secret-mistral" },
    });
    await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({ providers: { custom: { apiKey: "!never-run" } } }),
    );
    const calls: string[] = [];
    const rows = await collectUsage({ agentDir }, undefined, {
        ...options,
        fetch: mockFetch((url, init) => {
            calls.push(url);
            assert.equal(init.method, "GET");
            assert.equal(init.redirect, "error");
            assert.ok(init.signal);

            return Response.json(
                url.includes("openrouter")
                    ? { data: { usage: 0, limit: null } }
                    : {
                          five_hour: { utilization: 1 },
                          rate_limit: { primary_window: { used_percent: 2 } },
                      },
            );
        }),
    });

    assert.equal(calls.length, 3);
    assert.ok(calls.includes("https://chatgpt.com/backend-api/wham/usage"));
    assert.equal(rows.find((row) => row.id === "mistral")!.status, "unavailable");
    assert.ok(rows.some((row) => row.id === "custom"));
    assert.ok(!JSON.stringify(rows).includes("secret-"));
});

test("token sharing and Mistral keys reach no usage endpoint; Pi's own requests' limits show instead", async () => {
    await credentials({
        openai: {
            type: "oauth",
            access: "secret-share",
            refresh: "secret-refresh",
            expires: 1e15,
            clientId: "client",
            scopes: ["chatgpt.tokens.use.direct"],
        },
        mistral: { type: "api_key", key: "secret-mistral" },
        anthropic: { type: "oauth", access: "secret-claude", expires: 0 },
    });
    const day = 24 * 3600 * 1000;
    const now = 10 * day;
    const calls: string[] = [];
    const rows = await collectUsage(
        {
            agentDir,
            providerLimits: () => ({
                mistral: {
                    at: now - 1000,
                    status: 200,
                    headers: {
                        "x-ratelimit-limit-tokens-minute": "500000",
                        "x-ratelimit-remaining-tokens-minute": "375000",
                        "x-ratelimit-limit-req-minute": "1000",
                        "x-ratelimit-remaining-req-minute": "999",
                    },
                },
                openai: {
                    at: now - 2000,
                    status: 429,
                    headers: {},
                    limited: { at: now - 2000, headers: {} },
                },
                anthropic: {
                    at: now - 3000,
                    status: 200,
                    headers: {
                        "anthropic-ratelimit-unified-5h-utilization": "0.5",
                        "anthropic-ratelimit-unified-5h-reset": "1791543619",
                    },
                    limited: { at: now - 8 * day, headers: {} },
                },
            }),
        },
        undefined,
        {
            ...options,
            now,
            fetch: mockFetch((url) => {
                calls.push(url);

                return Response.json({});
            }),
        },
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

    assert.deepEqual(calls, []);
    assert.equal(byId.mistral!.status, "observed");
    assert.deepEqual(
        byId.mistral!.windows.map((window) => [window.label, window.used]),
        [
            ["Tokens per minute", 25],
            ["Requests per minute", 0.1],
        ],
    );
    assert.equal(byId.openai!.status, "observed");
    assert.match(byId.openai!.message, /Subscription Sharing/);
    assert.equal(byId.openai!.limited, new Date(now - 2000).toISOString());
    // An expired login still shows what Pi's requests saw; a week-old refusal is no longer news.
    assert.equal(byId.anthropic!.status, "observed");
    assert.deepEqual(byId.anthropic!.windows[0], {
        label: "5h",
        used: 50,
        reset: new Date(1791543619 * 1000).toISOString(),
    });
    assert.equal(byId.anthropic!.limited, undefined);
    assert.ok(!JSON.stringify(rows).includes("secret-"));
    assert.match(renderDashboard(rows), /refused for a usage limit/);
});

test("rate-limit headers of OpenAI API keys and Codex read as windows", () => {
    assert.deepEqual(
        headerWindows({
            at: 0,
            headers: {
                "x-ratelimit-limit-requests": "100",
                "x-ratelimit-remaining-requests": "75",
                "x-ratelimit-reset-requests": "30",
                "x-codex-primary-used-percent": "40",
                "x-codex-primary-window-minutes": "300",
                "x-codex-secondary-window-minutes": "10080",
            },
        }),
        [
            { label: "Requests", used: 25, reset: new Date(30_000).toISOString() },
            { label: "Codex · 5h", used: 40, reset: undefined },
        ],
    );
});

test("all-session totals cover providers this conversation never used", async () => {
    await credentials({});
    const rows = await collectUsage(
        { agentDir },
        { models: { "mistral/small": usageOf(10, 0.5) }, tools: {} },
        options,
        { mistral: { tokens: 40, cost: 2 }, gone: { tokens: 5, cost: 0.25 } },
    );
    const html = renderDashboard(rows);

    assert.deepEqual(
        rows.map((row) => [row.id, row.tokens, row.all?.tokens]),
        [
            ["gone", undefined, 5],
            ["mistral", 10, 40],
        ],
    );
    assert.match(html, /All Pi Pocket sessions: 40 tokens · \$2\.0000/);
    assert.match(html, /This session: 10 tokens/);
});

test("expired tokens and command-valued keys are not used; no auth files are rewritten", async () => {
    await credentials({
        anthropic: { type: "oauth", access: "secret", expires: 0 },
        openrouter: { type: "api_key", key: "!touch /tmp/never-run" },
    });
    const before = await readFile(join(agentDir, "auth.json"), "utf8");
    const rows = await collectUsage({ agentDir }, undefined, {
        ...options,
        fetch: mockFetch(() => {
            throw new Error("should not run");
        }),
    });

    assert.match(rows.find((row) => row.id === "anthropic")!.message, /expired/);
    assert.equal(rows.find((row) => row.id === "openrouter")!.status, "unavailable");
    assert.equal(await readFile(join(agentDir, "auth.json"), "utf8"), before);
});

test("provider failures are isolated and raw errors and invalid JSON are redacted", async () => {
    await credentials({
        anthropic: { type: "oauth", access: "secret" },
        openrouter: { type: "api_key", key: "secret" },
    });
    const rows = await collectUsage({ agentDir }, undefined, {
        ...options,
        fetch: mockFetch((url) =>
            url.includes("anthropic")
                ? new Response("secret invalid JSON")
                : new Response("secret error body", { status: 429 }),
        ),
    });

    assert.ok(rows.every((row) => row.status === "error"));
    assert.match(rows.find((row) => row.id === "openrouter")!.message, /Rate limited/);
    assert.ok(!JSON.stringify(rows).includes("secret"));
    const network = await collectUsage({ agentDir }, undefined, {
        ...options,
        fetch: mockFetch(() => {
            throw new Error("secret request headers");
        }),
    });

    assert.ok(!JSON.stringify(network).includes("secret"));
});

test("oversized responses and malformed credential JSON fail without exposing file contents", async () => {
    await credentials({ openrouter: { type: "api_key", key: "secret" } });
    const rows = await collectUsage({ agentDir }, undefined, {
        ...options,
        fetch: mockFetch(() => new Response("secret".repeat(50_000))),
    });

    assert.match(rows[0]!.message, /size limit/);
    await writeFile(join(agentDir, "auth.json"), '{"secret":invalid}');
    await assert.rejects(collectUsage({ agentDir }, undefined, options), (error: Error) => {
        assert.ok(!error.message.includes("secret"));

        return /could not be read/.test(error.message);
    });
});

test("Claude Code credentials and environment keys are supported without executing commands", async () => {
    await credentials({});
    await writeFile(
        join(claudeDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "secret-code", expiresAt: 100 } }),
    );
    const rows = await collectUsage({ agentDir }, undefined, {
        ...options,
        env: { OPENROUTER_API_KEY: "secret-env" },
        fetch: mockFetch((url, init) => {
            const headers = objectHeaders(init);

            assert.equal(
                headers.Authorization,
                url.includes("anthropic") ? "Bearer secret-code" : "Bearer secret-env",
            );

            return Response.json(
                url.includes("anthropic")
                    ? { five_hour: { utilization: 50 } }
                    : { data: { usage: 1 } },
            );
        }),
    });

    assert.equal(rows.find((row) => row.id === "claude-bridge")!.windows[0]!.used, 50);
});

function objectHeaders(init: RequestInit) {
    return init.headers as Record<string, string>;
}

test("HTML is escaped and the dashboard is a responsive, credential-free snapshot", () => {
    const html = renderDashboard(
        [
            {
                id: "<script>evil</script>",
                status: "unavailable",
                message: "No endpoint",
                windows: [],
                facts: [],
                tokens: 123,
                cost: 0.01,
            },
        ],
        1,
    );

    assert.ok(html.includes("&lt;script&gt;evil&lt;/script&gt;"));
    assert.ok(html.includes('name="viewport"'));
    assert.ok(html.includes("123 tokens"));
    assert.ok(!html.includes("<script>evil"));
});

test("the owner-installed drop-in lets steering guests publish and refresh; viewers remain read-only", async () => {
    const data = join(root, "usage-app");
    const extensions = join(data, "extensions");
    const source = resolve("docs/examples/provider-usage.ts");

    await mkdir(extensions, { recursive: true });
    await writeFile(
        join(extensions, "provider-usage.ts"),
        `/** Offline usage dashboard test. */\nimport create from ${JSON.stringify(source)};\nexport default host => create(host, { env: {}, claudeDir: ${JSON.stringify(join(root, "empty-claude"))}, fetch: async () => { throw new Error("No live network allowed"); } });`,
    );
    const app = await openApp(
        scriptedModel((input) => {
            const last = lastText(input as never);

            return last.role === "toolResult"
                ? fauxAssistantMessage([fauxText(last.text)])
                : fauxAssistantMessage([fauxToolCall("subscription_usage", {})], {
                      stopReason: "toolUse",
                  });
        }),
        data,
    );

    try {
        const module = (await app.extensions(owner(app))).modules.find(
            (item) => item.file === "provider-usage.ts",
        )!;

        assert.equal(module.enabled, false);
        await app.setExtensionEnabled(owner(app), "provider-usage.ts", true);
        const id = await newSession(app);

        await say(app, id, "show usage");
        await say(app, id, "refresh usage");
        const index = await app.harness.snapshot(ArtifactsDoc, id, context);

        assert.deepEqual(Object.keys(index!.items), ["provider-usage"]);
        assert.equal(index!.items["provider-usage"]!.versions.length, 2);
        const body = await app.harness.snapshot(ArtifactBodyDoc, id, "provider-usage@2", context);

        assert.ok(body!.content.includes("This session:"));
        assert.ok(body!.content.includes("All Pi Pocket sessions:"));
        const guest = app.config.addUser("Guest", "guest").user;
        const submission = await app.commands.submit(id, guest, {
            text: "show usage",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submission.submissionId, context))!.wait(context);
        const afterGuest = await app.harness.snapshot(ArtifactsDoc, id, context);

        assert.equal(afterGuest!.items["provider-usage"]!.versions.length, 3);
        const guestRefresh = await app.commands.submit(id, guest, {
            text: "refresh usage",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(guestRefresh.submissionId, context))!.wait(context);
        const refreshed = await app.harness.snapshot(ArtifactsDoc, id, context);

        assert.equal(refreshed!.items["provider-usage"]!.versions.length, 4);
        const sharedId = await newSession(app);
        const scopedGuest = app.config.addUser("Scoped guest", "guest", [String(sharedId)]).user;
        const firstRequest = await app.commands.submit(sharedId, scopedGuest, {
            text: "show usage",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(firstRequest.submissionId, context))!.wait(context);
        const sharedIndex = await app.harness.snapshot(ArtifactsDoc, sharedId, context);

        assert.equal(sharedIndex!.items["provider-usage"]!.versions.length, 1);
        await assert.rejects(
            app.commands.submit(id, scopedGuest, {
                text: "show usage",
                requestId: crypto.randomUUID(),
            }),
            /not shared with you/,
        );
        const viewer = app.config.addUser("Viewer", "viewer", [String(sharedId)]).user;

        await assert.rejects(
            app.commands.submit(sharedId, viewer, {
                text: "show usage",
                requestId: crypto.randomUUID(),
            }),
            /not steer Pi/,
        );
        const afterViewer = await app.harness.snapshot(ArtifactsDoc, sharedId, context);

        assert.equal(afterViewer!.items["provider-usage"]!.versions.length, 1);
    } finally {
        await app.close();
    }
});
