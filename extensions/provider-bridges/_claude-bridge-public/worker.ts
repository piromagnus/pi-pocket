/** One isolated upstream bridge per Pocket session, with a fixed working directory. */
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
    Api,
    AssistantMessageEventStream,
    Context,
    Model,
    SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { assertSubscriptionEnvironment, type WorkerInput, type WorkerOutput } from "./protocol.ts";
import { assertClaudeLogin } from "./authentication.ts";

interface Upstream {
    pocketProvider(executable?: string): {
        streamSimple(
            model: Model<Api>,
            context: Context,
            options: SimpleStreamOptions,
        ): AssistantMessageEventStream;
    };
    pocketDispose(): void;
    __test: { setQuery(fn: typeof query): void };
}

const compiled = process.argv[2];

if (!compiled || !process.send) {
    throw new Error("Claude Bridge worker needs its reviewed compiled provider and an IPC parent.");
}

assertSubscriptionEnvironment(process.env);
const upstream = (await import(pathToFileURL(compiled).href)) as Upstream;

// Do not run the upstream Pi/TUI factory or its opt-in AskClaude path. Loading
// user/project Claude settings could introduce apiKeyHelper, env redirects or
// hooks outside Pocket's approval system, so this provider accepts none of them.
upstream.__test.setQuery((args) => {
    assertSubscriptionEnvironment(process.env);

    if (!Array.isArray(args.options?.tools) || args.options.tools.length !== 0) {
        throw new Error(
            "Claude Bridge worker refuses native Claude tools; Pocket must execute every tool.",
        );
    }

    return query({
        ...args,
        options: {
            ...args.options,
            settingSources: [],
            strictMcpConfig: true,
            settings: {
                ...(typeof args.options.settings === "object" ? args.options.settings : {}),
                autoMemoryEnabled: false,
            },
        },
    });
});
const executable = process.argv[3] || "claude";
const provider = upstream.pocketProvider(executable);
const pending = new Map<number, AbortController>();
let closing = false;

function send(message: WorkerOutput): void {
    if (process.connected) {
        process.send?.(message);
    }
}

function close(): void {
    if (closing) {
        return;
    }

    closing = true;

    for (const controller of pending.values()) {
        controller.abort();
    }

    upstream.pocketDispose();
    process.exitCode = 0;
    // Allow SDK subprocesses to close first; the parent has a final kill timeout.
    const timer = setTimeout(() => process.exit(0), 500);

    timer.unref();

    if (process.connected) {
        process.disconnect?.();
    }
}

process.on("disconnect", close);
process.on("SIGTERM", close);
process.on("message", (input: WorkerInput) => {
    if (input.type === "close") {
        close();

        return;
    }

    if (input.type === "abort") {
        pending.get(input.id)?.abort();
        upstream.pocketDispose();

        return;
    }

    if (closing || pending.size > 0) {
        send({
            type: "failure",
            id: input.id,
            message: "Claude worker is closing or already serving a request.",
        });

        return;
    }

    const controller = new AbortController();

    pending.set(input.id, controller);

    void (async () => {
        try {
            await assertClaudeLogin(executable);
            controller.signal.throwIfAborted();
            const stream = provider.streamSimple(input.model, input.context, {
                ...input.options,
                signal: controller.signal,
            });

            for await (const event of stream) {
                send({ type: "event", id: input.id, event });
            }
        } catch (error) {
            send({
                type: "failure",
                id: input.id,
                message: error instanceof Error ? error.message : "Claude provider failed.",
            });
        } finally {
            pending.delete(input.id);
            send({ type: "end", id: input.id });
        }
    })();
});
