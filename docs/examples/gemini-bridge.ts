/** Gemini subscription models via local CLIProxyAPI, with every tool executed by Pi Pocket. */
import { createGeminiBridgeModule } from "../../src/server/gemini-bridge.ts";

// When installing, use the absolute path to src/server/gemini-bridge.ts in your checkout.
const bridge = createGeminiBridgeModule();

export const providers = bridge.providers;
export const dispose = bridge.dispose;
export default bridge.extension;
