// Import helpers first: every test uses temporary Pi state and a fake loopback proxy.
import {
    cleanUp,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { normalizeContext, Type, type Model } from "@earendil-works/pi-ai";
import {
    createGeminiBridgeModule,
    GeminiBridge,
    subscriptionProxyKey,
} from "../extensions/provider-bridges/gemini-bridge.ts";

const MODEL = "gemini-3.8-flash-high";
const KEY = "offline-local-proxy-key";
const prompt = () =>
    normalizeContext({
        systemPrompt: "Keep all supplied safety instructions unchanged.",
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    });
const config = () => ({
    "api-keys": [KEY],
    plugins: { enabled: false },
    "quota-exceeded": {
        "switch-project": false,
        "switch-preview-model": false,
        "antigravity-credits": false,
    },
});

after(cleanUp);

function send(response: ServerResponse, delta: object, finish = "stop") {
    response.writeHead(200, { "Content-Type": "text/event-stream" });

    for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
            choices: [{ index: 0, delta: {}, finish_reason: finish }],
            usage: {
                prompt_tokens: 9,
                completion_tokens: 4,
                total_tokens: 13,
                prompt_tokens_details: { cached_tokens: 2 },
            },
        },
    ]) {
        response.write(`data: ${JSON.stringify({ id: "offline", model: MODEL, ...chunk })}\n\n`);
    }

    response.end("data: [DONE]\n\n");
}

async function fixture(t: TestContext) {
    const directory = await mkdtemp(join(root, "gemini-"));
    const configPath = join(directory, "config.yaml");
    const state = {
        ids: [MODEL],
        posts: [] as Record<string, any>[],
        respond: (_body: Record<string, any>, response: ServerResponse) =>
            send(response, { content: "héllo 🌘" }),
    };
    const server = createServer(async (request, response) => {
        assert.equal(request.headers.authorization, `Bearer ${KEY}`);

        if (request.url === "/v1/models") {
            response.setHeader("Content-Type", "application/json");
            response.end(
                JSON.stringify({
                    data: [
                        ...state.ids.map((id) => ({ id, owned_by: "antigravity" })),
                        { id: "claude-sonnet-5-5-high", owned_by: "antigravity" },
                        { id: "claude-opus-5-5-high", owned_by: "antigravity" },
                        { id: "gemini-paid-api", owned_by: "google" },
                        { id: "gemini-3.1-flash-image", owned_by: "antigravity" },
                    ],
                }),
            );

            return;
        }

        assert.equal(request.url, "/v1/chat/completions");
        const chunks = [];

        for await (const chunk of request) {
            chunks.push(chunk);
        }

        const body = JSON.parse(Buffer.concat(chunks).toString());

        state.posts.push(body);
        state.respond(body, response);
    });

    await writeFile(configPath, JSON.stringify(config()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const bridge = new GeminiBridge({ configPath, baseUrl });

    t.after(async () => {
        await bridge.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    });

    const registration = await bridge.registration();
    const listed = registration.config.models!.find((model) => model.id === MODEL);

    assert.ok(listed && "reasoning" in listed);
    const model: Model<"openai-completions"> = {
        ...listed,
        api: "openai-completions",
        provider: registration.id,
        baseUrl,
    };

    return { bridge, registration, model, state, directory, configPath, baseUrl };
}

test("module cleanup closes its dispatcher even when provider removal throws", async (t) => {
    const f = await fixture(t);
    const close = GeminiBridge.prototype.close;
    let closed = 0;
    let dispose: (() => unknown) | undefined;

    GeminiBridge.prototype.close = async function () {
        closed++;
        await close.call(this);
    };

    t.after(() => {
        GeminiBridge.prototype.close = close;
    });

    const create = createGeminiBridgeModule({ baseUrl: f.baseUrl, configPath: f.configPath });

    await create(
        {
            registerModelProvider: () => () => {
                throw new Error("unregister failed");
            },
        } as never,
        { onDispose: (run: () => unknown) => (dispose = run) } as never,
    );

    await assert.rejects(async () => dispose?.(), /unregister failed/);
    assert.equal(closed, 1);
});

test("subscription guard refuses credits, substitution, paid backends, aliases, and missing local keys", () => {
    assert.equal(subscriptionProxyKey(config()), KEY);

    for (const flag of ["switch-project", "switch-preview-model", "antigravity-credits"]) {
        for (const value of [true, undefined, "false"]) {
            const unsafe = config();

            (unsafe["quota-exceeded"] as Record<string, unknown>)[flag] = value;
            assert.throws(
                () => subscriptionProxyKey(unsafe),
                /requires CLIProxyAPI quota-exceeded/,
            );
        }
    }

    for (const key of [
        "gemini-api-key",
        "vertex-api-key",
        "claude-api-key",
        "codex-api-key",
        "openai-compatibility",
        "payload",
        "oauth-model-alias",
    ]) {
        assert.throws(() =>
            subscriptionProxyKey({ ...config(), [key]: [{ secret: "do not print" }] }),
        );
    }

    const canonical = {
        ...config(),
        access: { "api-keys": [KEY] },
        "api-keys": {},
        oauth: { providers: { antigravity: { "antigravity-credits": false } } },
    };

    assert.equal(subscriptionProxyKey(canonical), KEY);

    for (const group of [
        "gemini",
        "vertex",
        "claude",
        "codex",
        "openai-compatibility",
        "interactions",
        "xai",
        "meta",
    ]) {
        assert.throws(
            () =>
                subscriptionProxyKey({
                    ...canonical,
                    "api-keys": { [group]: [{ "api-key": "do not print" }] },
                }),
            /upstream api-keys/,
        );
    }

    assert.throws(
        () =>
            subscriptionProxyKey({
                ...canonical,
                oauth: { providers: { antigravity: { "antigravity-credits": true } } },
            }),
        /oauth.providers.antigravity/,
    );
    assert.throws(
        () =>
            subscriptionProxyKey({
                ...canonical,
                oauth: {
                    "model-alias": { antigravity: [{ name: MODEL, alias: "gemini-4-argon" }] },
                },
            }),
        /model aliases/,
    );
    assert.throws(
        () =>
            subscriptionProxyKey({
                ...canonical,
                requests: { payload: { override: [{ params: { model: "paid" } }] } },
            }),
        /requests.payload/,
    );
    assert.throws(
        () => subscriptionProxyKey({ ...config(), plugins: { enabled: true } }),
        /plugins.enabled/,
    );
    assert.throws(() => subscriptionProxyKey({ ...config(), "api-keys": [] }), /client key/);
    assert.throws(() => subscriptionProxyKey(null));
});

test("model discovery filters source and operation; models are never invented or substituted", async (t) => {
    const f = await fixture(t);

    assert.deepEqual(
        f.registration.config.models!.map((m) => m.id),
        ["claude-opus-5-5-high", "claude-sonnet-5-5-high", MODEL],
    );
    const missing = await f.bridge
        .stream({ ...f.model, id: "gemini-4-argon-high" }, prompt())
        .result();

    assert.equal(missing.stopReason, "error");
    assert.match(missing.errorMessage!, /not advertised/);
    assert.equal(f.state.posts.length, 0);
    f.state.ids.push("gemini-4-argon-high");
    assert.ok((await f.bridge.models()).some((m) => m.id === "gemini-4-argon-high"));
});

test("streams Unicode, exact model IDs, effective instructions, token usage, and instrumentation", async (t) => {
    const f = await fixture(t);
    const observed: string[] = [];
    const output = f.bridge.stream(f.model, prompt(), {
        apiKey: "must-not-be-used",
        headers: { Authorization: "Bearer must-not-be-used" },
        onPayload: (payload) => {
            observed.push("payload");

            return payload;
        },
        onResponse: (response) => {
            observed.push(`response:${response.status}`);
        },
        onProviderStreamEvent: () => {
            observed.push("event");
        },
    });
    const events = [];

    for await (const event of output) {
        events.push(event);
    }

    const result = await output.result();

    assert.equal(result.stopReason, "stop");
    assert.deepEqual(result.content, [{ type: "text", text: "héllo 🌘" }]);
    assert.equal(events.filter((e) => e.type === "start").length, 1);
    assert.equal(events.filter((e) => e.type === "done" || e.type === "error").length, 1);
    assert.equal(result.usage.input, 7);
    assert.equal(result.usage.cacheRead, 2);
    assert.equal(result.usage.output, 4);
    assert.equal(result.usage.cost.total, 0);
    assert.equal(f.state.posts[0]!.model, MODEL);
    assert.ok(
        JSON.stringify(f.state.posts[0]!.messages).includes(
            "Keep all supplied safety instructions unchanged.",
        ),
    );
    assert.ok(
        observed.includes("payload") &&
            observed.includes("response:200") &&
            observed.includes("event"),
    );
});

test("function calls return to Pocket and committed tool results can be replayed", async (t) => {
    const f = await fixture(t);

    f.state.respond = (_body, response) =>
        send(
            response,
            {
                tool_calls: [
                    {
                        index: 0,
                        id: "call_offline",
                        type: "function",
                        function: { name: "offline_tool", arguments: '{"input":"hi"}' },
                    },
                ],
            },
            "tool_calls",
        );
    const first = await f.bridge
        .stream(
            f.model,
            normalizeContext({
                ...prompt(),
                tools: [
                    {
                        name: "offline_tool",
                        description: "Offline test only",
                        parameters: Type.Object({ input: Type.String() }),
                    },
                ],
            }),
        )
        .result();

    assert.equal(first.stopReason, "toolUse");
    assert.deepEqual(first.content[0], {
        type: "toolCall",
        id: "call_offline",
        name: "offline_tool",
        arguments: { input: "hi" },
    });
    f.state.respond = (_body, response) => send(response, { content: "tool result received" });
    const second = await f.bridge
        .stream(
            f.model,
            normalizeContext({
                messages: [
                    ...prompt().messages,
                    first,
                    {
                        role: "toolResult",
                        toolCallId: "call_offline",
                        toolName: "offline_tool",
                        content: [{ type: "text", text: "committed result" }],
                        isError: false,
                        timestamp: 2,
                    },
                ],
            }),
        )
        .result();

    assert.equal(second.stopReason, "stop");
    assert.ok(
        f.state.posts[1]!.messages.some(
            (m: any) => m.role === "tool" && m.content.includes("committed result"),
        ),
    );
});

test("each request rechecks safety; malformed YAML never exposes nearby secrets", async (t) => {
    const f = await fixture(t);
    const unsafe = config();

    unsafe["quota-exceeded"]["antigravity-credits"] = true;
    await writeFile(f.configPath, JSON.stringify(unsafe));
    const blocked = await f.bridge.stream(f.model, prompt()).result();

    assert.equal(blocked.stopReason, "error");
    assert.equal(f.state.posts.length, 0);
    await writeFile(f.configPath, "secret: SHOULD_NOT_LEAK\nbroken: [\n");
    const malformed = await f.bridge.stream(f.model, prompt()).result();

    assert.match(malformed.errorMessage!, /cannot read a valid/);
    assert.ok(!malformed.errorMessage!.includes("SHOULD_NOT_LEAK"));
});

test("endpoint, payload-model and custom-transport overrides are rejected", async (t) => {
    const f = await fixture(t);

    for (const baseUrl of [
        "https://example.com/v1",
        "http://127.0.0.1:8317/v1?redirect=1",
        "http://user:pass@127.0.0.1/v1",
    ]) {
        assert.throws(() => new GeminiBridge({ baseUrl }), /loopback endpoint/);
    }

    const override = await f.bridge
        .stream({ ...f.model, baseUrl: "http://example.com/v1" }, prompt())
        .result();
    const rewrite = await f.bridge
        .stream(f.model, prompt(), {
            onPayload: (payload) => ({ ...(payload as object), model: "paid-other-model" }),
        })
        .result();
    const transport = await f.bridge.stream(f.model, prompt(), { fetch }).result();

    for (const result of [override, rewrite, transport]) {
        assert.equal(result.stopReason, "error");
    }

    assert.equal(f.state.posts.length, 0);
});

test("abort and module disposal terminate an in-flight generation", async (t) => {
    const f = await fixture(t);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
        started = resolve;
    });

    f.state.respond = (_body, response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
            'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
        );
    };

    const controller = new AbortController();
    const output = f.bridge.stream(f.model, prompt(), {
        signal: controller.signal,
        onResponse: () => {
            started();
        },
    });

    await ready;
    controller.abort();
    assert.equal((await output.result()).stopReason, "aborted");
    let secondStarted!: () => void;
    const secondReady = new Promise<void>((resolve) => {
        secondStarted = resolve;
    });
    const active = f.bridge.stream(f.model, prompt(), {
        onResponse: () => {
            secondStarted();
        },
    });

    await secondReady;
    await f.bridge.close();
    assert.equal((await active.result()).stopReason, "aborted");
    assert.equal((await f.bridge.stream(f.model, prompt()).result()).stopReason, "aborted");
});

test("safety is checked again after payload inspection and before POST", async (t) => {
    const f = await fixture(t);
    const result = await f.bridge
        .stream(f.model, prompt(), {
            onPayload: async (payload) => {
                const unsafe = config();

                unsafe["quota-exceeded"]["antigravity-credits"] = true;
                await writeFile(f.configPath, JSON.stringify(unsafe));

                return payload;
            },
        })
        .result();

    assert.equal(result.stopReason, "error");
    assert.equal(f.state.posts.length, 0);
});

test("empty responses, HTTP errors, malformed streams, and redirects do not trigger fallback", async (t) => {
    const f = await fixture(t);

    f.state.respond = (_body, response) => send(response, { content: "" });
    assert.equal((await f.bridge.stream(f.model, prompt()).result()).stopReason, "stop");

    f.state.respond = (_body, response) => {
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "subscription quota exceeded" } }));
    };

    assert.equal((await f.bridge.stream(f.model, prompt()).result()).stopReason, "error");
    assert.equal(f.state.posts.length, 2, "No automatic 429 retry or alternate model");

    f.state.respond = (_body, response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end("data: {not-valid-json}\n\n");
    };

    assert.equal((await f.bridge.stream(f.model, prompt()).result()).stopReason, "error");

    f.state.respond = (_body, response) => {
        response.writeHead(307, { Location: `${f.baseUrl}/chat/completions` });
        response.end();
    };

    assert.equal((await f.bridge.stream(f.model, prompt()).result()).stopReason, "error");
    assert.equal(f.state.posts.length, 4, "Never follow even a same-host redirect");
    assert.ok(f.state.posts.every((body) => body.model === MODEL));
});

test("known Gemini metadata permits image input without native tool execution", async (t) => {
    const f = await fixture(t);
    const result = await f.bridge
        .stream(
            f.model,
            normalizeContext({
                messages: [
                    {
                        role: "user",
                        timestamp: 1,
                        content: [
                            { type: "text", text: "Describe this image" },
                            {
                                type: "image",
                                mimeType: "image/png",
                                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
                            },
                        ],
                    },
                ],
            }),
        )
        .result();

    assert.equal(result.stopReason, "stop");
    assert.ok(
        f.state.posts[0]!.messages.some(
            (m: any) =>
                Array.isArray(m.content) &&
                m.content.some((part: any) => part.type === "image_url"),
        ),
    );
});

test("owner-enabled module keeps Durable tools, guards, and model choice across restart", async (t) => {
    const f = await fixture(t);
    const dataDir = join(f.directory, "data");
    const dropIns = join(dataDir, "extensions");
    const cwd = join(f.directory, "work");
    const outputPath = join(cwd, "bridge-output.txt");
    const forbiddenPath = join(cwd, "must-not-exist");
    const helper = new URL("../extensions/provider-bridges/gemini-bridge.ts", import.meta.url)
        .pathname;

    await mkdir(dropIns, { recursive: true });
    await mkdir(cwd);
    await writeFile(
        join(dropIns, "offline-gemini.ts"),
        `/** Offline Gemini subscription bridge and guard fixture. */
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { createGeminiBridgeModule } from ${JSON.stringify(helper)};
const createBridge = createGeminiBridgeModule(${JSON.stringify({ baseUrl: f.baseUrl, configPath: f.configPath })});
export default async (host, web) => [await createBridge(host, web), defineExtension({
    name: "offline-gemini-guard",
    hooks: [hook(ToolTask, { beforeTool: call => call.name === "bash" ? { block: "Offline Pocket guard blocked shell" } : undefined })],
})];
`,
    );

    f.state.respond = (body, response) => {
        if (!body.tools?.length) {
            send(response, { content: "Offline title" });

            return;
        }

        const results = body.messages.filter((m: any) => m.role === "tool");
        const name = results.length ? "bash" : "write";
        const args = results.length
            ? { command: `touch ${forbiddenPath}` }
            : { path: outputPath, content: "Durable owns this tool" };

        if (
            results.some((m: any) =>
                String(m.content).includes("Offline Pocket guard blocked shell"),
            )
        ) {
            send(response, {
                content: "Offline Pocket guard blocked shell; durable tool result received.",
            });
        } else {
            send(
                response,
                {
                    tool_calls: [
                        {
                            index: 0,
                            id: `offline_${name}`,
                            type: "function",
                            function: { name, arguments: JSON.stringify(args) },
                        },
                    ],
                },
                "tool_calls",
            );
        }
    };

    let app = await openApp(scriptedModel(), dataDir);

    t.after(() => app.close());
    assert.equal(app.models.getRegisteredProviderConfig("gemini-bridge"), undefined);
    await app.setExtensionEnabled(owner(app), "offline-gemini.ts", true);
    const provider = app.models.getRegisteredProviderConfig("gemini-bridge");

    assert.equal(provider?.api, "openai-completions");
    assert.equal(provider?.baseUrl, f.baseUrl);
    assert.ok(provider?.models?.some((model) => model.id === MODEL));
    const id = await newSession(app, cwd);

    await app.commands.configure(id, owner(app), {
        model: { provider: "gemini-bridge", modelId: MODEL },
    });
    assert.deepEqual((await app.agentState(id))?.model, {
        provider: "gemini-bridge",
        modelId: MODEL,
    });
    await say(app, id, "offline tool roundtrip");
    assert.equal(await readFile(outputPath, "utf8"), "Durable owns this tool");
    await assert.rejects(readFile(forbiddenPath), { code: "ENOENT" });
    assert.ok(
        (await modelTexts(app, id)).some((text) =>
            text.includes("Offline Pocket guard blocked shell"),
        ),
    );
    await app.close();
    app = await openApp(scriptedModel(), dataDir);
    assert.deepEqual((await app.agentState(id))?.model, {
        provider: "gemini-bridge",
        modelId: MODEL,
    });
    await say(app, id, "continue from committed tool results");
    await assert.rejects(readFile(forbiddenPath), { code: "ENOENT" });
    await app.setExtensionEnabled(owner(app), "offline-gemini.ts", false);
    assert.equal(app.models.getRegisteredProviderConfig("gemini-bridge"), undefined);
});
