/** Owner-enabled Claude Bridge module; model selection remains per conversation. */
import {
    AgentDoc,
    CompactionTask,
    defineExtension,
    GenerationTask,
    hook,
    ProviderDoc,
    type HookApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { PocketHost } from "../host.ts";
import { ClaudeBridgeProvider, type ClaudeBridgeOptions } from "./provider.ts";

export function createClaudeBridgeModule(options: ClaudeBridgeOptions = {}) {
    let bridge: ClaudeBridgeProvider | undefined;

    async function remember(host: PocketHost, api: HookApi, context: Context): Promise<void> {
        const agent = await api.snapshot(AgentDoc, api.conversationId, context);

        if (agent?.model?.provider !== "claude-bridge") {
            return;
        }

        const provider = await api.snapshot(ProviderDoc, api.conversationId, context);

        if (provider) {
            bridge?.directory(provider.sessionId, host.cwdOf(api.conversationId));
        }
    }

    return {
        extension(host: PocketHost) {
            return defineExtension({
                name: "claude-code-bridge",
                hooks: [
                    hook(GenerationTask, {
                        beforeRequest: async (_request, api, context) => {
                            await remember(host, api, context);

                            return undefined;
                        },
                    }),
                    hook(CompactionTask, {
                        beforeCompact: async (_request, api, context) => {
                            await remember(host, api, context);

                            return undefined;
                        },
                    }),
                ],
            });
        },
        async providers() {
            bridge = new ClaudeBridgeProvider({
                executable: process.env.PI_POCKET_CLAUDE_EXECUTABLE,
                ...options,
            });

            try {
                await bridge.initialize();

                return [{ id: "claude-bridge", config: bridge.config() }];
            } catch (error) {
                await bridge.close();

                throw error;
            }
        },
        async dispose() {
            await bridge?.close();
        },
    };
}
