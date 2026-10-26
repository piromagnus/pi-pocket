/** Offline IPC script and deliberately unsafe upstream double for the real worker's guard. */
import { type Api, type AssistantMessage, type Model, type ToolCall } from "@earendil-works/pi-ai";
import type {
    WorkerInput,
    WorkerOutput,
} from "../../extensions/provider-bridges/_claude-bridge-public/protocol.ts";

export function response(model: Model<Api>, text: string): AssistantMessage {
    return {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 1,
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}

let injected: ((args: { options: { tools: string[] } }) => unknown) | undefined;

export const __test = {
    setQuery(fn: typeof injected) {
        injected = fn;
    },
};

export function pocketProvider() {
    return {
        streamSimple() {
            // The production worker must refuse this before reaching its real SDK query.
            injected!({ options: { tools: ["Bash"] } });

            throw new Error("Native tool guard failed closed incorrectly");
        },
    };
}

export function pocketDispose() {}

if (["scripted-ipc", "integration-ipc"].includes(process.argv[2] ?? "")) {
    const send = (message: WorkerOutput) => process.send?.(message);

    process.on("message", (input: WorkerInput) => {
        if (input.type === "close") {
            process.disconnect?.();

            return;
        }

        if (input.type !== "stream") {
            return;
        }

        if (process.argv[2] === "integration-ipc") {
            const currentTurn = input.context.messages.slice(
                input.context.messages.findLastIndex((message) => message.role === "user") + 1,
            );
            const results = currentTurn.filter((message) => message.role === "toolResult");
            const steps: Pick<ToolCall, "name" | "arguments">[] = [
                {
                    name: "write",
                    arguments: { path: "bridge-output.txt", content: "bridge durable fixture" },
                },
                { name: "read", arguments: { path: "bridge-output.txt" } },
                { name: "bash", arguments: { command: "printf unsafe > must-not-exist" } },
            ];
            const step = steps[results.length];
            const message = response(
                input.model,
                `pid=${process.pid};cwd=${process.cwd()};results=${JSON.stringify(results)}`,
            );

            if (step) {
                message.content = [
                    { type: "toolCall", id: `durable-call-${results.length}`, ...step },
                ];
                message.stopReason = "toolUse";
            }

            send({ type: "event", id: input.id, event: { type: "start", partial: message } });

            if (step) {
                const call = message.content[0];

                if (call?.type !== "toolCall") {
                    throw new Error("Offline fixture expected a tool call");
                }

                send({
                    type: "event",
                    id: input.id,
                    event: { type: "toolcall_start", contentIndex: 0, partial: message },
                });
                send({
                    type: "event",
                    id: input.id,
                    event: {
                        type: "toolcall_end",
                        contentIndex: 0,
                        toolCall: call,
                        partial: message,
                    },
                });
            }

            send({
                type: "event",
                id: input.id,
                event: { type: "done", reason: step ? "toolUse" : "stop", message },
            });
            send({ type: "end", id: input.id });

            return;
        }

        const last = input.context.messages.at(-1);
        const text =
            last && "content" in last && typeof last.content === "string" ? last.content : "";

        if (text === "wait") {
            return;
        }

        if (text === "crash") {
            process.exit(17);
        }

        if (text === "failure") {
            send({ type: "failure", id: input.id, message: "Scripted failure" });
        } else if (text !== "end-only") {
            const message = response(input.model, `pid=${process.pid};cwd=${process.cwd()}`);

            send({ type: "event", id: input.id, event: { type: "start", partial: message } });

            if (text === "tool") {
                const call = {
                    type: "toolCall" as const,
                    id: "call-1",
                    name: "read",
                    arguments: { path: "offline.txt" },
                };

                message.content.push(call);
                message.stopReason = "toolUse";
                send({
                    type: "event",
                    id: input.id,
                    event: { type: "toolcall_start", contentIndex: 1, partial: message },
                });
                send({
                    type: "event",
                    id: input.id,
                    event: {
                        type: "toolcall_delta",
                        contentIndex: 1,
                        delta: '{"path":"offline.txt"}',
                        partial: message,
                    },
                });
                send({
                    type: "event",
                    id: input.id,
                    event: {
                        type: "toolcall_end",
                        contentIndex: 1,
                        toolCall: call,
                        partial: message,
                    },
                });
            } else {
                send({
                    type: "event",
                    id: input.id,
                    event: { type: "text_start", contentIndex: 0, partial: message },
                });
                send({
                    type: "event",
                    id: input.id,
                    event: {
                        type: "text_delta",
                        contentIndex: 0,
                        delta: "offline",
                        partial: message,
                    },
                });
                send({
                    type: "event",
                    id: input.id,
                    event: {
                        type: "text_end",
                        contentIndex: 0,
                        content: "offline",
                        partial: message,
                    },
                });
            }

            send({
                type: "event",
                id: input.id,
                event: { type: "done", reason: message.stopReason as "stop" | "toolUse", message },
            });
        }

        send({ type: "end", id: input.id });
    });
}
