/** Claude Code as a model provider using its subscription login, with tools executed by Pi Pocket. */
import { createClaudeBridgeModule } from "../../src/server/claude-bridge/module.ts";

// When installing as a drop-in, change this import to the absolute path of
// src/server/claude-bridge/module.ts in your Pi Pocket checkout.
const bridge = createClaudeBridgeModule();

export const providers = bridge.providers;
export const dispose = bridge.dispose;
export default bridge.extension;
