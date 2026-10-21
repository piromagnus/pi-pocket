/** A Durable-facing provider: upstream Claude runs in one isolated process per provider session. */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    createAssistantMessageEventStream,
    type Api,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    type Model,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { bridgeModels } from "./catalogue.ts";
export { bridgeModels } from "./catalogue.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertClaudeLogin } from "./authentication.ts";
import { assertSubscriptionEnvironment, type WorkerInput, type WorkerOutput } from "./protocol.ts";
import { compileBridge } from "./upstream.ts";

type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type Pending = {
    stream: AssistantMessageEventStream;
    model: Model<Api>;
    terminal: boolean;
    cleanup(): void;
};
type Worker = {
    child: ChildProcess;
    pending: Map<number, Pending>;
    cwd: string;
    timer?: ReturnType<typeof setTimeout>;
};

export interface ClaudeBridgeOptions {
    executable?: string;
    /** These seams permit fully offline tests, never environment-controlled execution code. */
    compile?: typeof compileBridge;
    checkLogin?: typeof assertClaudeLogin;
    spawn?: (compiled: string, cwd: string, executable?: string) => ChildProcess;
}

function failure(model: Model<Api>, message: string, aborted = false): AssistantMessage {
    return {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: aborted ? "aborted" : "error",
        errorMessage: message,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}

function spawnWorker(compiled: string, cwd: string, executable?: string): ChildProcess {
    return fork(new URL("./worker.ts", import.meta.url), [compiled, executable ?? ""], {
        cwd,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: ["--experimental-strip-types"],
        env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            ENABLE_CLAUDEAI_MCP_SERVERS: "0",
            DISABLE_AUTO_COMPACT: "1",
        },
    });
}

export class ClaudeBridgeProvider {
    readonly #options: ClaudeBridgeOptions;
    readonly #directories = new Map<string, string>();
    readonly #workers = new Map<string, Worker>();
    #compiled?: Awaited<ReturnType<typeof compileBridge>>;
    #nextId = 0;
    #closed = false;

    constructor(options: ClaudeBridgeOptions = {}) {
        this.#options = options;
    }

    async initialize(): Promise<void> {
        assertSubscriptionEnvironment(process.env);
        await (this.#options.checkLogin ?? assertClaudeLogin)(this.#options.executable);
        this.#compiled = await (this.#options.compile ?? compileBridge)();
    }

    /** Called from a Durable hook before every attempt, including after a server restart. */
    directory(sessionId: string, cwd: string): void {
        this.#directories.set(sessionId, cwd);
    }

    config(): ProviderConfig {
        if (!this.#compiled || this.#closed) {
            throw new Error("Claude Bridge is not initialized.");
        }

        return {
            baseUrl: "claude-bridge",
            apiKey: "not-used",
            api: "claude-bridge",
            models: bridgeModels(),
            streamSimple: (model, context, options) => this.stream(model, context, options),
        };
    }

    stream(
        model: Model<Api>,
        context: Context,
        options: SimpleStreamOptions = {},
    ): AssistantMessageEventStream {
        const stream = createAssistantMessageEventStream();

        try {
            assertSubscriptionEnvironment(process.env);

            if (!this.#compiled || this.#closed) {
                throw new Error("Claude Bridge was disabled or is not initialized.");
            }

            const listed = bridgeModels().find((entry) => entry.id === model.id);

            if (
                model.provider !== "claude-bridge" ||
                !listed ||
                model.contextWindow > listed.contextWindow
            ) {
                throw new Error(
                    "Claude Bridge subscription mode refuses unlisted models or context windows above their reviewed limit.",
                );
            }

            if (options.apiKey && options.apiKey !== "not-used") {
                throw new Error("Claude Bridge subscription mode refuses API-key overrides.");
            }

            if (options.onPayload || options.onResponse || options.onProviderStreamEvent) {
                throw new Error(
                    "Claude Bridge does not support request instrumentation callbacks across its isolated worker boundary.",
                );
            }

            if (options.signal?.aborted) {
                throw new Error("Operation aborted");
            }

            // Summaries and titles never share the live parked query. They have no
            // tools or project settings, so an unmapped summary directory is safe.
            const isolated = options.cacheRetention === "none" || !options.sessionId;
            const key = isolated ? `isolated:${randomUUID()}` : options.sessionId!;
            const cwd = options.sessionId ? this.#directories.get(options.sessionId) : undefined;

            if (!isolated && !cwd) {
                throw new Error(
                    "Claude Bridge has no Durable session directory. Enable its extension in this session before selecting the model.",
                );
            }

            let worker = this.#workers.get(key);

            if (worker && worker.cwd !== cwd) {
                this.#stop(key, worker);
                worker = undefined;
            }

            if (!worker) {
                worker = this.#start(key, cwd ?? process.cwd());
            }

            clearTimeout(worker.timer);

            if (worker.pending.size > 0) {
                throw new Error(
                    "Claude Bridge cannot run two generation requests in one session at once.",
                );
            }

            const id = ++this.#nextId;
            const current = worker;

            const abort = () => {
                this.#fail(current, id, "Operation aborted", true);
                this.#stop(key, current);
            };

            const pending: Pending = {
                stream,
                model,
                terminal: false,
                cleanup: () => options.signal?.removeEventListener("abort", abort),
            };

            current.pending.set(id, pending);
            options.signal?.addEventListener("abort", abort, { once: true });
            const input: WorkerInput = {
                type: "stream",
                id,
                model,
                context,
                options: {
                    sessionId: options.sessionId,
                    reasoning: options.reasoning,
                    maxTokens: options.maxTokens,
                    cacheRetention: isolated ? "none" : options.cacheRetention,
                    metadata: options.metadata,
                },
            };

            current.child.send(input, (error) => {
                if (error) {
                    this.#fail(current, id, "Claude Bridge worker could not receive its request.");
                    this.#stop(key, current);
                }
            });
        } catch (error) {
            const output = failure(
                model,
                error instanceof Error ? error.message : "Claude Bridge failed.",
                options.signal?.aborted,
            );

            queueMicrotask(() => {
                stream.push({
                    type: "error",
                    reason: output.stopReason === "aborted" ? "aborted" : "error",
                    error: output,
                });
                stream.end();
            });
        }

        return stream;
    }

    #start(key: string, cwd: string): Worker {
        const child = (this.#options.spawn ?? spawnWorker)(
            this.#compiled!.path,
            cwd,
            this.#options.executable,
        );
        const worker: Worker = { child, cwd, pending: new Map() };

        this.#workers.set(key, worker);
        child.on("message", (message: WorkerOutput) => {
            const pending = worker.pending.get(message.id);

            if (!pending) {
                return;
            }

            if (message.type === "event") {
                if (!pending.terminal) {
                    pending.stream.push(message.event);

                    if (message.event.type === "done" || message.event.type === "error") {
                        pending.terminal = true;
                        pending.cleanup();
                        pending.stream.end();
                        worker.pending.delete(message.id);

                        if (key.startsWith("isolated:") || message.event.type === "error") {
                            this.#stop(key, worker);
                        } else {
                            // A long approval wait can rebuild the parked query
                            // from Durable history later, rather than leak it.
                            worker.timer = setTimeout(() => this.#stop(key, worker), 15 * 60_000);
                            worker.timer.unref();
                        }
                    }
                }
            } else {
                this.#fail(
                    worker,
                    message.id,
                    message.type === "failure"
                        ? message.message
                        : "Claude Bridge worker ended without a terminal response.",
                );
                this.#stop(key, worker);
            }
        });

        const lost = () => {
            for (const id of worker.pending.keys()) {
                this.#fail(
                    worker,
                    id,
                    "Claude Bridge worker exited; committed history is preserved. Retry the request.",
                );
            }

            if (this.#workers.get(key) === worker) {
                this.#workers.delete(key);
            }

            clearTimeout(worker.timer);
        };

        child.once("error", lost);
        child.once("exit", lost);

        return worker;
    }

    #fail(worker: Worker, id: number, message: string, aborted = false): void {
        const pending = worker.pending.get(id);

        if (!pending) {
            return;
        }

        if (!pending.terminal) {
            pending.stream.push({
                type: "error",
                reason: aborted ? "aborted" : "error",
                error: failure(pending.model, message, aborted),
            });
        }

        pending.stream.end();
        pending.cleanup();
        worker.pending.delete(id);
    }

    #stop(key: string, worker: Worker): void {
        if (this.#workers.get(key) === worker) {
            this.#workers.delete(key);
        }

        clearTimeout(worker.timer);

        for (const id of worker.pending.keys()) {
            this.#fail(
                worker,
                id,
                "Claude Bridge provider was disabled or its session directory changed.",
            );
        }

        if (worker.child.connected) {
            worker.child.send({ type: "close" }, () => {});
        }

        const kill = setTimeout(() => worker.child.kill("SIGTERM"), 2000);

        kill.unref();
        worker.child.once("exit", () => clearTimeout(kill));
    }

    async close(): Promise<void> {
        this.#closed = true;

        for (const [key, worker] of this.#workers) {
            this.#stop(key, worker);
        }

        this.#directories.clear();
        await this.#compiled?.cleanup();
    }
}
