/** Fully offline: temporary homes, injected login/compiler seams, scripted IPC, and a fake SDK. */
// Helpers must load first to isolate Pi's own install before importing PocketApp.
import {
    cleanUp,
    context as durableContext,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, ProviderDoc, type HookApi } from "@earendil-works/pi-durable";
import type { Context as TaskContext } from "@earendil-works/chord";
import {
    normalizeContext,
    type Api,
    type AssistantMessageEvent,
    type AssistantMessageEventStream,
    type Context,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { assertClaudeLogin } from "../extensions/provider-bridges/_claude-bridge-public/authentication.ts";
import { createClaudeBridgeModule } from "../extensions/provider-bridges/_claude-bridge-public/module.ts";
import {
    assertSubscriptionEnvironment,
    type WorkerInput,
} from "../extensions/provider-bridges/_claude-bridge-public/protocol.ts";
import {
    bridgeModels,
    ClaudeBridgeProvider,
    workerCwd,
} from "../extensions/provider-bridges/_claude-bridge-public/provider.ts";
import { compileBridge } from "../extensions/provider-bridges/_claude-bridge-public/upstream.ts";
import { response } from "./fixtures/claude-bridge-worker.ts";

after(cleanUp);

const fixturePath = join(import.meta.dirname, "fixtures", "claude-bridge-worker.ts");
const model: Model<Api> = {
    ...bridgeModels()[0]!,
    api: "claude-bridge",
    provider: "claude-bridge",
    baseUrl: "claude-bridge",
};

function context(text = "hello"): Context {
    return { messages: [{ role: "user", content: text, timestamp: 1 }] };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Offline bridge stream hung")), 5000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function collect(stream: AssistantMessageEventStream) {
    return bounded(
        (async () => {
            const events: AssistantMessageEvent[] = [];

            for await (const event of stream) {
                events.push(event);
            }

            const message = await stream.result();

            return { events, message };
        })(),
    );
}

async function sandbox(t: TestContext) {
    const directory = await mkdtemp(join(tmpdir(), "pocket-bridge-test-"));
    const saved = { ...process.env };

    // No real CLI, credential, project config, debug log, or Pocket data may be consulted.
    for (const key of Object.keys(process.env)) {
        if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|PI_POCKET_|DEBUG$)/.test(key)) {
            delete process.env[key];
        }
    }

    Object.assign(process.env, {
        HOME: directory,
        CLAUDE_CONFIG_DIR: join(directory, "claude"),
        PI_POCKET_DIR: join(directory, "pocket"),
        PI_POCKET_GUARD: "off",
    });
    await mkdir(join(directory, "work-a"));
    await mkdir(join(directory, "work-b"));
    t.after(async () => {
        for (const key of Object.keys(process.env)) {
            if (!(key in saved)) {
                delete process.env[key];
            }
        }

        Object.assign(process.env, saved);
        await rm(directory, { recursive: true, force: true });
    });

    return directory;
}

async function providerFixture(t: TestContext) {
    const directory = await sandbox(t);
    const children: ChildProcess[] = [];
    const starts: { cwd: string; compiled: string; executable?: string }[] = [];
    let cleaned = 0;
    let logins = 0;
    const provider = new ClaudeBridgeProvider({
        executable: "offline-cli",
        checkLogin: async (executable) => {
            assert.equal(executable, "offline-cli");
            logins++;
        },
        compile: async () => ({
            path: "offline-compiled",
            cleanup: async () => {
                cleaned++;
            },
        }),
        spawn: (compiled, cwd, executable) => {
            starts.push({ compiled, cwd, executable });
            const child = fork(fixturePath, ["scripted-ipc"], {
                cwd,
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
            });

            children.push(child);

            return child;
        },
    });

    await provider.initialize();
    t.after(async () => {
        await provider.close();

        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
            }
        }
    });
    provider.directory("session-a", join(directory, "work-a"));
    provider.directory("session-b", join(directory, "work-b"));

    return { provider, directory, children, starts, cleaned: () => cleaned, logins: () => logins };
}

function textOf(message: Awaited<ReturnType<typeof collect>>["message"]) {
    return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

test("bridge metadata requests 1M for every listed model without asserting entitlement", () => {
    const models = bridgeModels();

    assert.ok(models.length > 0);
    assert.equal(new Set(models.map((entry) => entry.id)).size, models.length);

    for (const entry of models) {
        assert.match(entry.id, /^claude-(opus|sonnet|haiku)-/);
        assert.doesNotMatch(entry.id, /fable|snapshot|-20\d{6}$/i);
        assert.equal(entry.contextWindow, 1_000_000);
        assert.match(entry.name, /Claude Bridge, 1M requested/);
        assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }

    const haiku = models.find((entry) => entry.id === "claude-haiku-5-5");

    assert.ok(haiku);
    assert.equal(haiku.contextWindow, 1_000_000);
    assert.equal(haiku.maxTokens, 128_000);
    assert.equal(haiku.reasoning, true);
});

test("subscription environment rejects credentials/backends by name without disclosing values", () => {
    for (const key of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_API_KEY",
        "CLAUDE_CODE_API_KEY_HELPER",
    ]) {
        assert.throws(
            () => assertSubscriptionEnvironment({ [key]: "secret-never-print-this" }),
            (error) => {
                assert.ok(error instanceof Error);
                assert.ok(error.message.includes(key));
                assert.ok(!error.message.includes("secret-never-print-this"));

                return true;
            },
        );
    }

    assert.doesNotThrow(() =>
        assertSubscriptionEnvironment({ ANTHROPIC_API_KEY: "", HOME: "/offline" }),
    );
});

test("initialization and runtime override checks fail closed before any login/compiler/spawn", async (t) => {
    await sandbox(t);
    let touched = 0;
    const provider = new ClaudeBridgeProvider({
        checkLogin: async () => {
            touched++;
        },
        compile: async () => {
            touched++;

            throw new Error("must not compile");
        },
        spawn: () => {
            touched++;

            throw new Error("must not spawn");
        },
    });

    process.env.ANTHROPIC_API_KEY = "secret-never-print-this";
    await assert.rejects(provider.initialize(), /ANTHROPIC_API_KEY/);
    const result = await collect(provider.stream(model, context()));

    assert.equal(result.message.stopReason, "error");
    assert.doesNotMatch(JSON.stringify(result.events), /secret-never-print-this/);
    assert.equal(touched, 0);
    await provider.close();
});

test("subscription mode rejects custom model and long-context overrides before spawning", async (t) => {
    const fixture = await providerFixture(t);

    for (const overridden of [
        { ...model, contextWindow: 2_000_000 },
        { ...model, id: "claude-haiku-5-5", contextWindow: 2_000_000 },
        { ...model, id: `${model.id}[1m]` },
        { ...model, id: "claude-fable-5" },
        { ...model, provider: "anthropic" },
    ]) {
        const { message } = await collect(
            fixture.provider.stream(overridden, context(), { sessionId: "session-a" }),
        );

        assert.equal(message.stopReason, "error");
        assert.match(
            message.errorMessage!,
            /unlisted models or context windows above their reviewed limit/,
        );
    }

    assert.equal(fixture.starts.length, 0);
});

test("API keys, instrumentation callbacks, missing directories and concurrent requests fail closed", async (t) => {
    const f = await providerFixture(t);
    const cases: SimpleStreamOptions[] = [
        { apiKey: "do-not-log-this" },
        {
            onPayload: () => {
                throw new Error("callback executed");
            },
        },
        {
            onResponse: () => {
                throw new Error("callback executed");
            },
        },
        {
            onProviderStreamEvent: () => {
                throw new Error("callback executed");
            },
        },
        { sessionId: "unmapped" },
    ];

    for (const options of cases) {
        const result = await collect(
            f.provider.stream(model, context(), { sessionId: "session-a", ...options }),
        );

        assert.equal(result.message.stopReason, "error");
        assert.deepEqual(
            result.events.map((event) => event.type),
            ["error"],
        );
        assert.doesNotMatch(JSON.stringify(result.events), /do-not-log-this|callback executed/);
    }

    assert.equal(f.children.length, 0);
    const waiting = f.provider.stream(model, context("wait"), { sessionId: "session-a" });
    const concurrent = await collect(
        f.provider.stream(model, context(), { sessionId: "session-a" }),
    );

    assert.match(concurrent.message.errorMessage!, /two generation requests/);
    await f.provider.close();
    assert.equal((await collect(waiting)).message.stopReason, "error");
});

test("text and tool call/result lifecycle reuses a worker and keeps session directories separate", async (t) => {
    const f = await providerFixture(t);
    const first = await collect(
        f.provider.stream(model, context(), { sessionId: "session-a", apiKey: "not-used" }),
    );

    assert.deepEqual(
        first.events.map((event) => event.type),
        ["start", "text_start", "text_delta", "text_end", "done"],
    );
    assert.equal(first.message.stopReason, "stop");
    assert.ok(textOf(first.message).includes(join(f.directory, "work-a")));
    const tool = await collect(
        f.provider.stream(model, context("tool"), { sessionId: "session-a" }),
    );

    assert.deepEqual(
        tool.events.map((event) => event.type),
        ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"],
    );
    assert.equal(tool.message.stopReason, "toolUse");
    const transcript: Context = {
        messages: [
            ...context("tool").messages,
            tool.message,
            {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "read",
                content: [{ type: "text", text: "fixture contents" }],
                isError: false,
                timestamp: 2,
            },
        ],
    };
    const resumed = await collect(f.provider.stream(model, transcript, { sessionId: "session-a" }));

    assert.equal(textOf(resumed.message), textOf(first.message));
    assert.equal(f.children.length, 1);
    const other = await collect(f.provider.stream(model, context(), { sessionId: "session-b" }));

    assert.notEqual(textOf(other.message), textOf(first.message));
    assert.ok(textOf(other.message).includes(join(f.directory, "work-b")));
    assert.equal(f.children.length, 2);
    assert.equal(f.logins(), 1);
    assert.deepEqual(f.starts[0], {
        compiled: "offline-compiled",
        cwd: join(f.directory, "work-a"),
        executable: "offline-cli",
    });
});

test("a changed cwd retires the old worker rather than continuing in the wrong project", async (t) => {
    const f = await providerFixture(t);
    const first = await collect(f.provider.stream(model, context(), { sessionId: "session-a" }));

    f.provider.directory("session-a", join(f.directory, "work-b"));
    const changed = await collect(f.provider.stream(model, context(), { sessionId: "session-a" }));

    assert.equal(f.children.length, 2);
    assert.notEqual(textOf(first.message), textOf(changed.message));
    assert.ok(textOf(changed.message).includes(join(f.directory, "work-b")));
});

test("titles and compaction have unique worker keys and do not disturb a live parked query", async (t) => {
    const f = await providerFixture(t);
    const parked = f.provider.stream(model, context("wait"), { sessionId: "session-a" });
    const title = await collect(f.provider.stream(model, context("title")));
    const summary = await collect(
        f.provider.stream(model, context("summary"), {
            sessionId: "session-a",
            cacheRetention: "none",
        }),
    );
    const secondSummary = await collect(
        f.provider.stream(model, context("summary"), {
            sessionId: "session-a",
            cacheRetention: "none",
        }),
    );

    assert.equal(f.children.length, 4);
    assert.notEqual(textOf(summary.message), textOf(secondSummary.message));
    assert.notEqual(textOf(title.message), textOf(summary.message));
    const concurrent = await collect(
        f.provider.stream(model, context(), { sessionId: "session-a" }),
    );

    assert.match(concurrent.message.errorMessage!, /two generation requests/);
    await f.provider.close();
    assert.equal((await collect(parked)).message.stopReason, "error");
});

test("abort, crash, malformed end and explicit worker failure all terminate without hanging", async (t) => {
    const f = await providerFixture(t);
    const preAborted = new AbortController();

    preAborted.abort();
    assert.equal(
        (
            await collect(
                f.provider.stream(model, context(), {
                    sessionId: "session-a",
                    signal: preAborted.signal,
                }),
            )
        ).message.stopReason,
        "aborted",
    );
    assert.equal(f.children.length, 0);
    const controller = new AbortController();
    const waiting = f.provider.stream(model, context("wait"), {
        sessionId: "session-a",
        signal: controller.signal,
    });

    controller.abort();
    assert.equal((await collect(waiting)).message.stopReason, "aborted");

    for (const text of ["crash", "end-only", "failure"]) {
        const result = await collect(
            f.provider.stream(model, context(text), { sessionId: "session-a" }),
        );

        assert.equal(result.message.stopReason, "error", text);
        assert.deepEqual(
            result.events.map((event) => event.type),
            ["error"],
        );
    }

    assert.equal(
        (await collect(f.provider.stream(model, context(), { sessionId: "session-a" }))).message
            .stopReason,
        "stop",
    );
    const disposing = f.provider.stream(model, context("wait"), { sessionId: "session-a" });

    await f.provider.close();
    assert.equal((await collect(disposing)).message.stopReason, "error");
    assert.equal(
        (await collect(f.provider.stream(model, context(), { sessionId: "session-a" }))).message
            .stopReason,
        "error",
    );
    assert.throws(() => f.provider.config(), /not initialized/);
    assert.equal(f.cleaned(), 1);
});

test("child error and IPC send failure produce terminal errors", async (t) => {
    await sandbox(t);

    for (const mode of ["error", "send"] as const) {
        const child = new EventEmitter() as ChildProcess;

        Object.assign(child, {
            connected: true,
            send: (input: WorkerInput, callback: (error?: Error) => void) => {
                if (input.type === "close") {
                    queueMicrotask(() => child.emit("exit", 0));
                } else if (mode === "send") {
                    callback(new Error("offline broken pipe"));
                } else {
                    queueMicrotask(() => child.emit("error", new Error("offline spawn error")));
                }

                return true;
            },
            kill: () => true,
        });
        const provider = new ClaudeBridgeProvider({
            checkLogin: async () => {},
            compile: async () => ({ path: "offline", cleanup: async () => {} }),
            spawn: () => child,
        });

        await provider.initialize();
        provider.directory("s", tmpdir());
        const result = await collect(provider.stream(model, context(), { sessionId: "s" }));

        assert.equal(result.message.stopReason, "error");
        await provider.close();
    }
});

test("public provider registration exposes models and web cleanup closes its worker", async (t) => {
    await sandbox(t);
    let cleaned = 0;
    let config: ReturnType<ClaudeBridgeProvider["config"]> | undefined;
    let cleanup: (() => unknown) | undefined;
    const create = createClaudeBridgeModule({
        checkLogin: async () => {},
        compile: async () => ({
            path: "offline",
            cleanup: async () => {
                cleaned++;
            },
        }),
        spawn: () => {
            throw new Error("no worker expected");
        },
    });

    await create(
        {
            registerModelProvider: (_id: string, value: typeof config) => (
                (config = value),
                () => {
                    throw new Error("unregister failed");
                }
            ),
        } as never,
        { onDispose: (run: () => unknown) => (cleanup = run) } as never,
    );

    assert.ok(config?.models?.length);
    await assert.rejects(async () => cleanup?.(), /unregister failed/);
    assert.equal(cleaned, 1);
    const stream = config!.streamSimple!(model, normalizeContext(context()), {});

    assert.equal((await collect(stream)).message.stopReason, "error");
    const rejected = createClaudeBridgeModule({
        checkLogin: async () => {
            throw new Error("offline login refused");
        },
        compile: async () => {
            throw new Error("must not compile");
        },
    });

    await assert.rejects(rejected({} as never, {} as never), /offline login refused/);
});

test("generation and compaction hooks map the Durable session to its current cwd", async (t) => {
    const directory = await sandbox(t);
    const starts: string[] = [];
    const children: ChildProcess[] = [];
    const module = createClaudeBridgeModule({
        checkLogin: async () => {},
        compile: async () => ({ path: "offline", cleanup: async () => {} }),
        spawn: (_compiled, cwd) => {
            starts.push(cwd);
            const child = fork(fixturePath, ["scripted-ipc"], {
                cwd,
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
            });

            children.push(child);

            return child;
        },
    });

    t.after(async () => {
        await dispose?.();

        for (const child of children) {
            child.kill("SIGTERM");
        }
    });
    let cwd = join(directory, "work-a");
    let selectedProvider = "other-provider";
    let config: ReturnType<ClaudeBridgeProvider["config"]> | undefined;
    let dispose: (() => unknown) | undefined;
    const host = {
        cwdOf: (id: string) => {
            assert.equal(id, "durable-conversation");

            return cwd;
        },
        registerModelProvider: (_id: string, value: typeof config) => ((config = value), () => {}),
    };
    const web = { onDispose: (run: () => unknown) => (dispose = run) };
    const extension = await module(host as never, web as never);
    const hooks = extension.hooks as unknown as {
        task: string;
        handlers: Record<
            string,
            (request: unknown, api: HookApi, context: TaskContext) => Promise<unknown>
        >;
    }[];
    const api = {
        conversationId: "durable-conversation",
        snapshot: async (kind: unknown, id: string) => {
            assert.equal(id, "durable-conversation");

            if (kind === AgentDoc) {
                return { model: { provider: selectedProvider } };
            }

            assert.equal(kind, ProviderDoc);

            return { sessionId: "durable-provider-session" };
        },
    } as unknown as HookApi;

    assert.ok(config);
    const generation = hooks.find((entry) => entry.task === "pi.generation")!.handlers
        .beforeRequest!;
    const compaction = hooks.find((entry) => entry.task === "pi.compaction")!.handlers
        .beforeCompact!;

    await generation({}, api, {} as TaskContext);
    const unmapped = await collect(
        config.streamSimple!(model, normalizeContext(context()), {
            sessionId: "durable-provider-session",
        }),
    );

    assert.match(unmapped.message.errorMessage!, /no Durable session directory/);
    assert.deepEqual(starts, []);
    selectedProvider = "claude-bridge";
    await generation({}, api, {} as TaskContext);
    const first = await collect(
        config.streamSimple!(model, normalizeContext(context()), {
            sessionId: "durable-provider-session",
        }),
    );

    assert.ok(textOf(first.message).includes(cwd));
    cwd = join(directory, "work-b");
    await compaction({}, api, {} as TaskContext);
    const changed = await collect(
        config.streamSimple!(model, normalizeContext(context()), {
            sessionId: "durable-provider-session",
        }),
    );

    assert.ok(textOf(changed.message).includes(cwd));
    assert.deepEqual(starts, [join(directory, "work-a"), join(directory, "work-b")]);
});

test("authentication checks CLI metadata only and never reflects failing CLI output", async (t) => {
    const directory = await sandbox(t);
    const executable = join(directory, "fake-claude");

    const script = async (output: string, exit = 0) => {
        await writeFile(
            executable,
            `#!/bin/sh\n[ "$1 $2" = "auth status" ] || exit 99\nprintf '%s' '${output}'\nexit ${exit}\n`,
            { mode: 0o700 },
        );
    };

    await script('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}');
    await assertClaudeLogin(executable);

    for (const output of [
        '{"loggedIn":false,"authMethod":"claude.ai","apiProvider":"firstParty"}',
        '{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}',
        '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"gateway"}',
        "{}",
    ]) {
        await script(output);
        await assert.rejects(assertClaudeLogin(executable), /subscription login/);
    }

    await script("private-cli-diagnostic-never-echo", 1);
    await assert.rejects(assertClaudeLogin(executable), (error) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /private-cli-diagnostic-never-echo/);

        return true;
    });
    await script("not-json");
    await assert.rejects(assertClaudeLogin(executable), /needs Claude Code/);
    await assert.rejects(assertClaudeLogin(join(directory, "missing")), /needs Claude Code/);
});

test("real worker rejects native SDK tools before it can call a real model", async (t) => {
    const directory = await sandbox(t);
    const executable = join(directory, "fake-login-only");

    await writeFile(
        executable,
        '#!/bin/sh\n[ "$1 $2" = "auth status" ] || exit 99\nprintf \'%s\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'\n',
        { mode: 0o700 },
    );
    const provider = new ClaudeBridgeProvider({
        executable,
        checkLogin: async () => {},
        compile: async () => ({ path: fixturePath, cleanup: async () => {} }),
        spawn: (compiled, cwd) =>
            fork(
                new URL(
                    "../extensions/provider-bridges/_claude-bridge-public/worker.ts",
                    import.meta.url,
                ),
                [compiled, executable],
                {
                    cwd,
                    stdio: ["ignore", "ignore", "ignore", "ipc"],
                    execArgv: [
                        "--experimental-strip-types",
                        "--disable-warning=ExperimentalWarning",
                    ],
                },
            ),
    });

    await provider.initialize();
    t.after(() => provider.close());
    provider.directory("s", directory);
    const result = await collect(provider.stream(model, context(), { sessionId: "s" }));

    assert.equal(result.message.stopReason, "error");
    assert.match(result.message.errorMessage!, /refuses native Claude tools/);
});

test("owner-enabled PocketApp bridge runs Durable tools and preserves model choice across reopen", async (t) => {
    const directory = await sandbox(t);
    const dataDir = join(directory, "app-data");
    const dropIns = join(dataDir, "extensions");
    const cwd = join(directory, "work-a");
    const observations = join(directory, "worker-observations.jsonl");
    const modulePath = new URL(
        "../extensions/provider-bridges/_claude-bridge-public/module.ts",
        import.meta.url,
    ).pathname;
    const dropIn = `/** Offline Claude Bridge integration fixture. */
import { fork } from "node:child_process";
import { appendFileSync } from "node:fs";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { createClaudeBridgeModule } from ${JSON.stringify(modulePath)};
const createBridge = createClaudeBridgeModule({
    checkLogin: async () => {},
    compile: async () => ({ path: "offline", cleanup: async () => {} }),
    spawn: (_compiled, cwd) => {
        appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ type: "spawn", cwd }) + "\\n");
        const child = fork(${JSON.stringify(fixturePath)}, ["integration-ipc"], {
            cwd, stdio: ["ignore", "ignore", "ignore", "ipc"],
            execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
        });
        const send = child.send.bind(child);
        child.send = (input, callback) => {
            if (input.type === "stream") {
                appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ type: "request", cwd, sessionId: input.options.sessionId, roles: input.context.messages.map(m => m.role) }) + "\\n");
            }
            return send(input, callback);
        };
        return child;
    },
});
export default async (host, web) => [await createBridge(host, web), defineExtension({
    name: "offline-bridge-guard",
    hooks: [hook(ToolTask, { beforeTool: call => call.name === "bash" ? { block: "Offline guard blocked shell" } : undefined })],
})];
`;

    await mkdir(dropIns, { recursive: true });
    await writeFile(join(dropIns, "offline-bridge.ts"), dropIn);
    let app: App | undefined = await openApp(scriptedModel(), dataDir);

    t.after(async () => {
        await app?.close();
    });
    assert.equal(app.models.getRegisteredProviderConfig("claude-bridge"), undefined);
    await app.setExtensionEnabled(owner(app), "offline-bridge.ts", true);
    assert.ok(app.models.getRegisteredProviderConfig("claude-bridge"));
    const id = await newSession(app, cwd);

    await app.commands.configure(id, owner(app), {
        model: { provider: "claude-bridge", modelId: model.id },
        thinkingLevel: "off",
    });
    await bounded(say(app, id, "offline roundtrip"));
    assert.equal(await readFile(join(cwd, "bridge-output.txt"), "utf8"), "bridge durable fixture");
    await assert.rejects(readFile(join(cwd, "must-not-exist")), { code: "ENOENT" });
    const firstTexts = await modelTexts(app, id);

    assert.ok(firstTexts.some((text) => text.includes("bridge durable fixture")));
    assert.ok(firstTexts.some((text) => text.includes("Offline guard blocked shell")));
    const providerState = await app.harness.snapshot(ProviderDoc, id, durableContext);
    const events = (await readFile(observations, "utf8"))
        .trim()
        .split("\n")
        .map(
            (line) =>
                JSON.parse(line) as {
                    type: string;
                    cwd: string;
                    sessionId?: string;
                    roles?: string[];
                },
        );

    assert.ok(providerState);
    assert.ok(
        events.some(
            (event) =>
                event.type === "request" &&
                event.sessionId === providerState.sessionId &&
                event.cwd === cwd,
        ),
    );
    assert.equal(
        events.filter((event) => event.type === "spawn" && event.cwd === cwd).length,
        1,
        "All tool turns must reuse the mapped worker",
    );
    assert.ok(events.some((event) => event.roles?.at(-1) === "toolResult"));
    await app.close();
    app = await openApp(scriptedModel(), dataDir);
    assert.ok(app.models.getRegisteredProviderConfig("claude-bridge"));
    assert.deepEqual((await app.agentState(id))?.model, {
        provider: "claude-bridge",
        modelId: model.id,
    });
    assert.deepEqual(await modelTexts(app, id), firstTexts);
    await bounded(say(app, id, "offline after reopen"));
    assert.equal(await readFile(join(cwd, "bridge-output.txt"), "utf8"), "bridge durable fixture");
    await assert.rejects(readFile(join(cwd, "must-not-exist")), { code: "ENOENT" });
    const reopenedEvents = (await readFile(observations, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; cwd: string });

    assert.equal(
        reopenedEvents.filter((event) => event.type === "spawn" && event.cwd === cwd).length,
        2,
    );
    await app.close();
    app = undefined;
});

interface CompiledBridge {
    pocketProvider(executable?: string): {
        models: Model<Api>[];
        streamSimple(
            model: Model<Api>,
            context: Context,
            options?: SimpleStreamOptions,
        ): AssistantMessageEventStream;
    };
    pocketDispose(): void;
    __test: {
        setQuery(fn: typeof query): void;
        activeQueryContexts: Set<unknown>;
        getSharedSession(id: string): { jsonlPath?: string; sessionId: string } | null;
    };
}

async function compiledFixture(t: TestContext) {
    const directory = await sandbox(t);
    const compiled = await compileBridge();
    const upstream = (await import(pathToFileURL(compiled.path).href)) as CompiledBridge;
    const calls: Parameters<typeof query>[0][] = [];
    const prompts: unknown[] = [];
    const fake = ((args: Parameters<typeof query>[0]) => {
        calls.push(args);
        const generator = (async function* () {
            if (typeof args.prompt === "string") {
                prompts.push(args.prompt);
            } else {
                const first = await args.prompt[Symbol.asyncIterator]().next();

                prompts.push(first.value);
            }

            for (const event of [
                {
                    type: "message_start",
                    message: {
                        id: "offline-message",
                        usage: { input_tokens: 1, output_tokens: 0 },
                    },
                },
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                },
                {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "offline SDK " },
                },
                {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "answer" },
                },
                { type: "content_block_stop", index: 0 },
                {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 2 },
                },
                { type: "message_stop" },
            ]) {
                yield { type: "stream_event", event };
            }

            yield {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "offline SDK answer",
                usage: { input_tokens: 1, output_tokens: 2 },
                total_cost_usd: 0,
            };
        })();

        return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
    }) as unknown as typeof query;

    upstream.__test.setQuery(fake);
    const provider = upstream.pocketProvider("offline-never-executed");

    t.after(async () => {
        upstream.pocketDispose();
        await compiled.cleanup();
    });

    return { upstream, provider, calls, prompts, compiled, directory };
}

test("compiled pinned upstream imports offline and forwards Pocket's entire effective prompt", async (t) => {
    const f = await compiledFixture(t);
    const prompt =
        "You are Pi, a coding agent running inside Pi Pocket.\n<guidelines>Keep replies short.</guidelines>\n<project_context>Offline fixture instructions.</project_context>\nDo not remove this final instruction.";
    const transcript = normalizeContext({ ...context("whole prompt test"), systemPrompt: prompt });
    const result = await collect(
        f.provider.streamSimple(model, transcript, { sessionId: "upstream-a" }),
    );

    assert.equal(result.message.stopReason, "stop");
    assert.equal(textOf(result.message), "offline SDK answer");
    assert.deepEqual(
        result.events.filter((event) => event.type === "text_delta").map((event) => event.delta),
        ["offline SDK ", "answer"],
    );
    assert.deepEqual(
        result.events.map((event) => event.type),
        ["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
    );
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0]);
    assert.deepEqual(f.calls[0].options?.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: prompt,
    });
    assert.deepEqual(f.calls[0].options?.tools, []);
    assert.ok("strict-mcp-config" in (f.calls[0].options?.extraArgs ?? {}));
    assert.equal(f.calls[0].options?.pathToClaudeCodeExecutable, "offline-never-executed");
    assert.equal(
        (f.calls[0].options?.settings as { autoMemoryEnabled: boolean }).autoMemoryEnabled,
        false,
    );
    assert.ok(JSON.stringify(f.prompts).includes("whole prompt test"));
    assert.ok(
        f.provider.models.every(
            (entry) => entry.contextWindow === 1_000_000 && !/fable/i.test(entry.id),
        ),
    );
});

test("every bridge model requests the 1M CLI suffix for turns and isolated summaries", async (t) => {
    const f = await compiledFixture(t);

    for (const definition of bridgeModels()) {
        const current: Model<Api> = { ...model, ...definition };

        for (const cacheRetention of [undefined, "none"] as const) {
            const result = await collect(
                f.provider.streamSimple(
                    current,
                    { ...context("offline 1M request"), systemPrompt: "Retain Pocket safeguards." },
                    { sessionId: `all-1m-${definition.id}-${cacheRetention}`, cacheRetention },
                ),
            );
            const request = f.calls.at(-1)?.options;

            assert.equal(result.message.stopReason, "stop");
            assert.equal(request?.extraArgs?.model ?? request?.model, `${definition.id}[1m]`);
            assert.deepEqual(request?.tools, []);
        }
    }

    assert.equal(f.calls.length, bridgeModels().length * 2);
});

test("a rejected 1M request remains an error without a second model or smaller-window request", async (t) => {
    const f = await compiledFixture(t);
    let calls = 0;

    f.upstream.__test.setQuery(((args: Parameters<typeof query>[0]) => {
        calls++;
        assert.equal(args.options?.model, `${model.id}[1m]`);
        const generator = (async function* () {
            yield {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                errors: ["The model or subscription does not support the requested 1M context."],
            };
        })();

        return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
    }) as unknown as typeof query);
    const result = await collect(
        f.provider.streamSimple(model, context("offline rejection"), {
            sessionId: "rejected-1m",
            cacheRetention: "none",
        }),
    );

    assert.equal(result.message.stopReason, "error");
    assert.match(result.message.errorMessage!, /does not support the requested 1M/);
    assert.equal(calls, 1);
});

test("Haiku 5.5 requests 1M explicitly for turns and summaries without enabling paid fallback", async (t) => {
    const f = await compiledFixture(t);
    const definition = bridgeModels().find((entry) => entry.id === "claude-haiku-5-5")!;
    const haiku: Model<Api> = { ...model, ...definition };

    assert.equal(
        f.provider.models.find((entry) => entry.id === haiku.id)?.contextWindow,
        1_000_000,
    );

    for (const cacheRetention of [undefined, "none"] as const) {
        const result = await collect(
            f.provider.streamSimple(
                haiku,
                { ...context("offline Haiku 5.5"), systemPrompt: "Retain Pocket safeguards." },
                { sessionId: `haiku-${cacheRetention}`, cacheRetention },
            ),
        );

        assert.equal(result.message.stopReason, "stop");
        const request = f.calls.at(-1)?.options;

        assert.equal(request?.extraArgs?.model ?? request?.model, "claude-haiku-5-5[1m]");
        assert.deepEqual(f.calls.at(-1)?.options?.tools, []);
    }

    assert.equal(f.calls[0]?.options?.extraArgs?.model, "claude-haiku-5-5[1m]");
    const result = await collect(
        f.provider.streamSimple(
            { ...haiku, contextWindow: 200_000 },
            context("offline narrow context"),
            { sessionId: "haiku-200k", cacheRetention: "none" },
        ),
    );

    assert.equal(result.message.stopReason, "stop");
    assert.equal(f.calls.at(-1)?.options?.model, "claude-haiku-5-5");
});

test("compiled upstream preserves its prompt billing guard for normal and summary requests", async (t) => {
    const f = await compiledFixture(t);

    for (const systemPrompt of [
        "You are an expert coding assistant operating inside pi. Do not silently strip this.",
        "Read docs/custom-provider.md and docs/packages.md before continuing.",
    ]) {
        for (const cacheRetention of [undefined, "none"] as const) {
            assert.throws(
                () =>
                    f.provider.streamSimple(
                        model,
                        { ...context(), systemPrompt },
                        { sessionId: "guard", cacheRetention },
                    ),
                /prompt-capture: refusing to send/,
            );
        }
    }

    assert.equal(f.calls.length, 0);
});

test("compiled summaries use injected SDK, no tools/settings sources, and no durable session mirror", async (t) => {
    const f = await compiledFixture(t);
    const source = await readFile(f.compiled.path, "utf8");

    // Hard fail BEFORE invoking a summary if the pinned adapter bypasses setQuery.
    // This assertion prevents a broken implementation from starting a real SDK/model.
    const summary = source.slice(
        source.indexOf("async function runIsolatedSummary("),
        source.indexOf("function syncSharedSession("),
    );

    assert.ok(
        /sdkQuery = queryImpl\(/.test(summary),
        "Summary bypasses __test.setQuery; unsafe to execute offline",
    );
    const result = await collect(
        f.provider.streamSimple(
            model,
            {
                ...context("summarize this fixture"),
                systemPrompt: "Preserve this entire summary instruction.",
            },
            { sessionId: "summary", cacheRetention: "none" },
        ),
    );

    assert.equal(textOf(result.message), "offline SDK answer");
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0]);
    assert.deepEqual(f.calls[0].options?.tools, []);
    assert.deepEqual(f.calls[0].options?.settingSources, []);
    assert.deepEqual(f.calls[0].options?.skills, []);
    assert.equal(f.calls[0].options?.persistSession, false);
    assert.equal(f.calls[0].options?.strictMcpConfig, true);
    assert.equal(f.calls[0].options?.systemPrompt, "Preserve this entire summary instruction.");
    assert.equal(f.calls[0].options?.pathToClaudeCodeExecutable, "offline-never-executed");
    assert.equal(f.upstream.__test.getSharedSession("summary"), null);
});

test("durable recovery ending in a committed toolResult rebuilds instead of orphaning it", async (t) => {
    const f = await compiledFixture(t);
    const assistant = response(model, "I will read the fixture.");

    assistant.content.push({
        type: "toolCall",
        id: "recovered-call",
        name: "read",
        arguments: { path: "offline.txt" },
    });
    assistant.stopReason = "toolUse";
    const transcript: Context = {
        systemPrompt: "You are Pi inside Pi Pocket. Continue from committed results.",
        messages: [
            ...context("read fixture").messages,
            assistant,
            {
                role: "toolResult",
                toolCallId: "recovered-call",
                toolName: "read",
                content: [{ type: "text", text: "committed fixture result" }],
                isError: false,
                timestamp: 3,
            },
        ],
    };

    assert.equal(f.upstream.__test.activeQueryContexts.size, 0);
    const result = await collect(
        f.provider.streamSimple(model, normalizeContext(transcript), {
            sessionId: "recovered-session",
        }),
    );

    assert.equal(result.message.stopReason, "stop");
    assert.equal(textOf(result.message), "offline SDK answer");
    assert.equal(
        f.calls.length,
        1,
        "Orphan handling would silently return empty text without starting a query",
    );
    assert.ok(f.calls[0]?.options?.resume, "Recovery must resume the rebuilt committed transcript");
    const mirror = f.upstream.__test.getSharedSession("recovered-session");

    assert.ok(mirror);
    assert.equal(f.calls[0]?.options?.resume, mirror.sessionId);
    const { readdir } = await import("node:fs/promises");
    const projects = join(f.directory, "claude", "projects");
    const project = (await readdir(projects))[0];

    assert.ok(project);
    const durableMirror = await readFile(
        join(projects, project, `${mirror.sessionId}.jsonl`),
        "utf8",
    );

    assert.ok(durableMirror.includes("committed fixture result"));
    assert.ok(durableMirror.includes("recovered-call"));
    assert.equal(f.upstream.__test.activeQueryContexts.size, 0);
});

test("mock SDK MCP tool calls/results roundtrip on one parked upstream query", async (t) => {
    const f = await compiledFixture(t);
    const tools = [
        {
            name: "read",
            description: "Read an offline fixture",
            parameters: Type.Object({ path: Type.String() }),
        },
    ];
    const sdkCalls: Parameters<typeof query>[0][] = [];
    const mcpResults: unknown[] = [];
    const clients: Client[] = [];
    const fakeQuery = ((args: Parameters<typeof query>[0]) => {
        sdkCalls.push(args);
        const generator = (async function* () {
            assert.notEqual(typeof args.prompt, "string");
            await (args.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
            const server = args.options?.mcpServers?.["custom-tools"];

            assert.ok(server && server.type === "sdk");
            const client = new Client({ name: "offline-sdk", version: "1" });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            clients.push(client);
            await server.instance.connect(serverTransport);
            await client.connect(clientTransport);
            const listed = await client.listTools();

            assert.deepEqual(
                listed.tools.map((tool) => tool.name),
                ["read"],
            );

            // Two separate tool boundaries must both keep this SAME SDK query parked.
            for (const id of ["sdk-call-1", "sdk-call-2"]) {
                const delivered = client.callTool({
                    name: "read",
                    arguments: { path: "offline.txt" },
                    _meta: { "claudecode/toolUseId": id },
                });

                if (id === "sdk-call-1") {
                    for (const event of [
                        { type: "message_start", message: { id: `assistant-${id}` } },
                        {
                            type: "content_block_start",
                            index: 0,
                            content_block: {
                                type: "tool_use",
                                id,
                                name: "mcp__custom-tools__read",
                                input: {},
                            },
                        },
                        {
                            type: "content_block_delta",
                            index: 0,
                            delta: { type: "input_json_delta", partial_json: '{"file_path":' },
                        },
                        {
                            type: "content_block_delta",
                            index: 0,
                            delta: { type: "input_json_delta", partial_json: '"offline.txt"}' },
                        },
                        { type: "content_block_stop", index: 0 },
                        { type: "message_delta", delta: { stop_reason: "tool_use" } },
                        { type: "message_stop" },
                    ]) {
                        yield { type: "stream_event", event };
                    }
                }

                // Completed assistant echo must not duplicate the streamed first call;
                // the second boundary exercises SDK's non-streaming fallback path.
                yield {
                    type: "assistant",
                    message: {
                        id: `assistant-${id}`,
                        model: model.id,
                        content: [
                            {
                                type: "tool_use",
                                id,
                                name: "mcp__custom-tools__read",
                                input: { file_path: "offline.txt" },
                            },
                        ],
                        usage: { input_tokens: 1, output_tokens: 1 },
                    },
                };
                mcpResults.push(await delivered);
            }

            yield {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "finished after two Pocket results",
                usage: { input_tokens: 1, output_tokens: 1 },
                total_cost_usd: 0,
            };
        })();

        return Object.assign(generator, { interrupt: async () => {}, close: () => {} });
    }) as unknown as typeof query;

    f.upstream.__test.setQuery(fakeQuery);
    t.after(async () => {
        for (const client of clients) {
            await client.close();
        }
    });
    const transcript: Context = {
        ...context("read twice"),
        systemPrompt: "You are Pi inside Pi Pocket. All tool execution belongs to Pocket.",
        tools,
    };

    for (const id of ["sdk-call-1", "sdk-call-2"]) {
        const turn = await collect(
            f.provider.streamSimple(model, normalizeContext(transcript), {
                sessionId: "sdk-roundtrip",
            }),
        );

        assert.equal(turn.message.stopReason, "toolUse");
        assert.deepEqual(
            turn.message.content.filter((block) => block.type === "toolCall"),
            [{ type: "toolCall", id, name: "read", arguments: { path: "offline.txt" } }],
        );
        assert.equal(turn.events[0]?.type, "start");
        assert.equal(turn.events.at(-1)?.type, "done");
        assert.equal(
            turn.events.filter((event) => event.type === "toolcall_delta").length,
            id === "sdk-call-1" ? 2 : 0,
        );
        assert.equal(sdkCalls.length, 1);
        assert.equal(f.upstream.__test.activeQueryContexts.size, 1);
        transcript.messages.push(turn.message, {
            role: "toolResult",
            toolCallId: id,
            toolName: "read",
            content: [{ type: "text", text: `Pocket executed ${id}` }],
            isError: false,
            timestamp: 4,
        });
    }

    const final = await collect(
        f.provider.streamSimple(model, normalizeContext(transcript), {
            sessionId: "sdk-roundtrip",
        }),
    );

    assert.equal(final.message.stopReason, "stop");
    assert.equal(textOf(final.message), "finished after two Pocket results");
    assert.equal(sdkCalls.length, 1);
    assert.deepEqual(mcpResults, [
        { content: [{ type: "text", text: "Pocket executed sdk-call-1" }], isError: false },
        { content: [{ type: "text", text: "Pocket executed sdk-call-2" }], isError: false },
    ]);
    assert.equal(f.upstream.__test.activeQueryContexts.size, 0);
});

test("a remote session's folder (ssh://host/path) starts its worker in a local folder, never in the URI", () => {
    const local = workerCwd("ssh://hextech/home/pierre");

    assert.ok(!local.includes("://"));
    assert.equal(
        fork("-e", [], { cwd: local, stdio: ["ignore", "ignore", "ignore", "ipc"] }).kill(),
        true,
    );
    assert.equal(workerCwd("/home/pierre/project"), "/home/pierre/project");
});
