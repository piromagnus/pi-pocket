/** Only data crosses the Claude worker boundary; tools always execute in Pi Durable. */
import type {
    Api,
    AssistantMessageEvent,
    Context,
    Model,
    SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type WorkerOptions = Pick<
    SimpleStreamOptions,
    "sessionId" | "reasoning" | "maxTokens" | "cacheRetention" | "metadata"
>;
export type WorkerInput =
    | { type: "stream"; id: number; model: Model<Api>; context: Context; options: WorkerOptions }
    | { type: "abort"; id: number }
    | { type: "close" };
export type WorkerOutput =
    | { type: "event"; id: number; event: AssistantMessageEvent }
    | { type: "failure"; id: number; message: string }
    | { type: "end"; id: number };

/** Do not silently redirect a subscription request to an API, gateway, Bedrock, or Vertex. */
export function assertSubscriptionEnvironment(env: NodeJS.ProcessEnv): void {
    const blocked = Object.keys(env).filter(
        (key) =>
            env[key] &&
            (key.startsWith("ANTHROPIC_") ||
                /^CLAUDE_CODE_(USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|OAUTH_TOKEN|API_KEY|API_KEY_HELPER)$/.test(
                    key,
                )),
    );

    if (blocked.length > 0) {
        throw new Error(
            `Claude Bridge subscription mode refuses credential/model/backend overrides: ${blocked.join(", ")}. Remove them from the server environment first.`,
        );
    }
}
