// Web Access & Search provider management tests
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cleanUp, openApp, scriptedModel } from "./helpers.ts";
import { WebAccessManager } from "../src/server/web-access.ts";

after(cleanUp);

test("WebAccessManager reports all supported providers and default configuration", async () => {
    const manager = new WebAccessManager();
    const state = await manager.getState();

    assert.equal(typeof state.enabled, "boolean");
    assert.ok(state.providers.length >= 6);

    const ids = state.providers.map((p) => p.id);

    assert.ok(ids.includes("tavily"));
    assert.ok(ids.includes("exa"));
    assert.ok(ids.includes("brave"));
    assert.ok(ids.includes("serper"));
    assert.ok(ids.includes("openai"));
    assert.ok(ids.includes("duckduckgo"));

    const ddg = state.providers.find((p) => p.id === "duckduckgo");

    assert.equal(ddg?.apiKeyRequired, false);
    assert.equal(ddg?.keyConfigured, true);
});

test("WebAccessManager rejects local loopback addresses in fetchContent", async () => {
    const manager = new WebAccessManager();

    await assert.rejects(
        () => manager.fetchContent("http://localhost:8080/secret"),
        /Local loopback addresses cannot be fetched/,
    );
    await assert.rejects(
        () => manager.fetchContent("http://127.0.0.1:3000/api"),
        /Local loopback addresses cannot be fetched/,
    );
});

test("WebAccessManager testConnection fails fast on missing key for keyed providers", async () => {
    const manager = new WebAccessManager();
    const result = await manager.testConnection("tavily", "");

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("No API key"));
});

test("Web access HTTP routes allow configuring keys, settings, and testing", async () => {
    const app = await openApp(scriptedModel());

    try {
        const state = await app.webAccess.getState();

        assert.ok(Array.isArray(state.providers));

        // Test updating primary provider and max results
        await app.webAccess.saveConfig({
            provider: "duckduckgo",
            maxResults: 10,
        });

        const updated = await app.webAccess.getState();

        assert.equal(updated.primaryProvider, "duckduckgo");
        assert.equal(updated.maxResults, 10);
    } finally {
        await app.close();
    }
});
