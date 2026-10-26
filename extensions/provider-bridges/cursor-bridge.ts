/** Cursor models through the Cursor SDK agent, with tools bridged to Pocket. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineExtension } from "@earendil-works/pi-durable";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { Host, Web } from "./_pocket.d.ts";
import { withCursorLimits } from "./_cursor-bridge-limits.ts";

export default async function createCursorBridge(host: Host, web: Web) {
    const sdk = join(getAgentDir(), "npm/node_modules/pi-cursor-sdk/dist");
    const [{ discoverModels }, { streamCursorLazy }, { CURSOR_API_KEY_CONFIG_VALUE }] =
        await Promise.all([
            import(pathToFileURL(join(sdk, "model-discovery.js")).href),
            import(pathToFileURL(join(sdk, "cursor-provider-lazy.js")).href),
            import(pathToFileURL(join(sdk, "cursor-api-key.js")).href),
        ]);

    // The API key is stored in Pi's auth.json by the SDK login.
    const credential = readStoredCredential("cursor");

    if (!credential || credential.type !== "api_key") {
        throw new Error("Cursor: no API key. Run Cursor.auth.login() or store one via /login.");
    }

    const models = await discoverModels({ apiKey: credential.key });

    if (!models.length) {
        throw new Error("Cursor: no models discovered. Check your API key and account.");
    }

    host.notice("info", `Cursor: ${models.length} models available.`);
    const unregister = host.registerModelProvider("cursor", {
        name: "Cursor",
        baseUrl: "https://cursor.com",
        apiKey: CURSOR_API_KEY_CONFIG_VALUE,
        api: "cursor-sdk",
        models,
        refreshModels: async ({ signal }) =>
            discoverModels({ apiKey: credential.key, forceRefresh: true, signal }),
        streamSimple: (model, context, options) =>
            withCursorLimits(streamCursorLazy(model, context, options)),
    });

    web.onDispose(unregister);

    return defineExtension({ name: "cursor-sdk-bridge" });
}
