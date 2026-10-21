# Gemini subscription bridge

An **optional owner drop-in** connects Pocket to an already-running, local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It exposes only Gemini chat models advertised by that proxy's **Antigravity** channel. This uses the proxy's existing Google subscription login, not a Gemini API key, Vertex, or the `agy` agent loop. Pocket receives function calls and executes every tool itself, preserving its approvals, plan mode, validation, and durable results.

This is a **third-party, unsupported subscription integration**, not a Google-supported login method or billing guarantee. Review the terms for your account before enabling it; third-party subscription access can carry account restriction or suspension risk. Google's [Gemini CLI terms](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md) explicitly prohibit third-party access to Gemini Code Assist using CLI OAuth. This bridge does **not** use that separate Gemini CLI channel, and that distinction does not establish Google's approval of Antigravity proxies.

## Prerequisites

- CLIProxyAPI is already subscription-authenticated for Antigravity. Perform any sign-in yourself using that proxy's documented flow. The bridge never signs in, obtains Google tokens, changes projects, upgrades a plan, or enables an API backend.
- Its OpenAI-compatible API is bound to loopback and requires a local client key. The default endpoint is `http://127.0.0.1:8317/v1`.
- Its config is readable by the Pocket user, by default `~/.local/share/cliproxyapi/config.yaml`. The bridge reads the first `access.api-keys` entry (v8), or legacy top-level `api-keys` entry, privately; never paste it into a conversation or commit it.
- The selected endpoint must actually use that configuration. A local YAML check is not attestation of the running proxy, its plugins, or Google's billing decisions.

## Subscription-only proxy configuration

Before activation, disable credit fallback and old quota-substitution switches in the **proxy's** configuration. Do not change these settings on a shared proxy without considering its other clients; a dedicated subscription-only instance is preferable.

```yaml
quota-exceeded:
    switch-project: false
    switch-preview-model: false
    antigravity-credits: false

oauth:
    providers:
        antigravity:
            antigravity-credits: false

plugins:
    enabled: false
```

CLIProxyAPI v8 migrates the old credit switch into `oauth.providers.antigravity.antigravity-credits`; a canonical value overrides the legacy value. Both must be safe. The other legacy switches are inert in current v8 source but remain required as `false` for older proxies. Ensure the running proxy has applied your changes. This adapter does not edit or restart it.

The bridge also rejects configured API-key upstream groups, payload transformations, and global OAuth model aliases in both legacy and canonical v8 locations. In v8, upstream `api-keys.<provider>` groups are distinct from the downstream `access.api-keys` client keys. Unreviewed plugins must be disabled (`plugins.enabled: false`); the built-in Antigravity route does not need the separate Gemini CLI plugin. The operator must also verify that the proxy's auth records have no per-account model aliases: this adapter deliberately does not inspect Google credential files. Use real upstream model IDs. No model, account, credential, or API-provider fallback is implemented by Pocket. The supported boundary is a trusted, correctly configured local subscription-only proxy, not an arbitrary OpenAI endpoint; these local checks do not prove the running proxy's effective auth-record state. Disabling those switches is not a guarantee of subscription eligibility or zero provider charges.

## Install and enable

1. Install the checkout's dependencies (`npm install`). Provider-module support must already be loaded by Pocket; if it was just added to this server, finish checks and use **Menu → Restart server** once.
2. Save the complete drop-in below as `~/.pi-pocket/extensions/gemini-bridge.ts`, adjusting the absolute checkout path if needed:

```typescript
/** Gemini subscription models via local CLIProxyAPI, with every tool executed by Pi Pocket. */
import { createGeminiBridgeModule } from "/home/pmarrec/pi-pocket/src/server/gemini-bridge.ts";

const bridge = createGeminiBridgeModule();

export const providers = bridge.providers;
export const dispose = bridge.dispose;
export default bridge.extension;
```

The file loads `src/server/gemini-bridge.ts` with the owner's rights. It reads the proxy config, makes authenticated model-list and generation requests to a fixed loopback API, and forwards Pocket's effective instructions, transcript, tool schemas, and results through that proxy to Google. It does not execute `agy`, shell commands, native Google tools, MCP servers, or hooks; Google function calls return to Pocket. Google credentials remain managed by the proxy. Only the local client key is used here, never printed or persisted into Pocket's session data.

3. The owner enables **gemini-bridge.ts** in **Menu → Extensions**. It starts off. Enabling checks config and reads `/v1/models`, but does not make a generation request or query account usage. Unsafe config, unreachable proxy, invalid local key, or an empty Gemini catalog fails activation.
4. Select a `gemini-bridge/…` model in a conversation's model picker. This changes only that conversation. Reload the extension after changing the proxy's account/catalog if a new model has not appeared.

A different local config or endpoint can be supplied explicitly in the drop-in:

```typescript
const bridge = createGeminiBridgeModule({
    configPath: "/absolute/path/to/subscription-proxy.yaml",
    baseUrl: "http://127.0.0.1:8318/v1",
});
```

Only numeric loopback HTTP endpoints ending in `/v1` are accepted. Redirects, URL credentials, model endpoint overrides, custom request transports, and request-payload model substitutions are rejected. A dedicated direct dispatcher bypasses environment HTTP proxies so the local key and transcript do not travel through them. Custom request headers/API-key overrides are not forwarded; ordinary payload, response-header, and provider-stream observation callbacks remain supported.

## Gemini 4 Argon and Claude 5.5

The bridge also accepts the proxy's Antigravity **Claude Opus 5.5** and **Claude Sonnet 5.5** models when advertised, so Pocket can use those Google subscription models without pretending they are Gemini IDs. Both use their documented 1,048,576-token context, 65,536-token output ceiling, and text+image input.

Argon appears **only if the proxy advertises its exact ID**, such as `gemini-4-argon-high`, with `owned_by: antigravity`. That advertisement cannot attest the underlying model if the operator left per-account aliases in the proxy's auth records; remove those before activation. Pocket checks and forwards the advertised ID, not the proxy's private auth-record routing. The bridge does not manufacture an Argon entry, map it to Gemini 3.8, or claim that a CLI/model catalog proves account entitlement. Resolve proxy version, catalog, and account eligibility upstream; this adapter does not upgrade the shared proxy automatically.

Known Gemini models reuse Pi's input/context/output metadata with subscription cost metadata set to zero. The Antigravity catalog's `gemini-4-argon-high` uses its documented 1,048,576-token context and output ceiling, text input, and low/medium/high effort. Other unknown IDs use conservative Pocket budgets (128K context, 8K output, text-only); these are not claimed upstream maximum specifications. Fixed-effort model IDs expose their corresponding thinking level. Other IDs pass the standard `reasoning_effort` field through CLIProxyAPI. Zero-dollar Pocket metadata is not a billing guarantee; requests, titles, and compactions consume allowance.

## Lifecycle and checks

Every generation, title, and compaction rechecks the proxy configuration and exact advertised model. Calls use Pi's existing OpenAI Chat Completions conversion and streaming implementation, including Unicode, tool results, cancellation, and usage accounting. No native agent session needs reconstruction: after restart or fork, Pocket sends the committed transcript. The bridge performs no automatic request retries or fallback.

Disabling/reloading/removing the module unregisters its provider, aborts its pending work, and destroys its HTTP dispatcher. A failed replacement preserves the previous module. Sessions keep their selected provider/model reference but cannot use a disabled provider. Editing the imported helper needs a server restart; reload of the drop-in alone does not invalidate helper-module caches.

```sh
node --test test/gemini-bridge.test.ts test/provider-modules.test.ts test/docs-examples.test.ts
npm run check
npm run lint
npm test
```

Tests use temporary configs, throwaway Pocket data, and a fake loopback OpenAI server. They prove streamed function calls stay under Durable's guard and survive reopening; they do not spend quota, validate live eligibility, or test with real Google credentials. No live generation is required to install this optional bridge.
