/** Gemini subscription models through a local CLIProxyAPI, with all tools executed by Pocket. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    createAssistantMessageEventStream,
    type Api,
    type AssistantMessage,
    type Model,
    type SimpleStreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { defineExtension } from "@earendil-works/pi-durable";
import { Agent, fetch as proxyFetch } from "undici";
import { parse } from "yaml";
import type { ProviderConfigInput, ProviderRegistration } from "./host.ts";

type BridgeModel = Extract<
    NonNullable<ProviderConfigInput["models"]>[number],
    { reasoning: boolean }
>;
type RecordValue = Record<string, unknown>;

export interface GeminiBridgeOptions {
    configPath?: string;
    baseUrl?: string;
}

function record(value: unknown): RecordValue {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as RecordValue)
        : {};
}

/** Reject reviewed config paths for paid backends, credit fallback, and model substitution. */
export function subscriptionProxyKey(value: unknown): string {
    const config = record(value);
    const quota = record(config["quota-exceeded"]);

    for (const flag of ["switch-project", "switch-preview-model", "antigravity-credits"]) {
        if (quota[flag] !== false) {
            throw new Error(`Gemini Bridge requires CLIProxyAPI quota-exceeded.${flag}: false.`);
        }
    }

    for (const group of [
        "gemini-api-key",
        "vertex-api-key",
        "claude-api-key",
        "codex-api-key",
        "openai-compatibility",
        "payload",
    ]) {
        const entries = config[group];

        if (entries && Object.keys(Object(entries)).length) {
            throw new Error(`Gemini Bridge refuses CLIProxyAPI ${group} configuration.`);
        }
    }

    // v8 separates upstream api-keys.<provider> from downstream access.api-keys.
    if (!Array.isArray(config["api-keys"])) {
        const upstreams = record(config["api-keys"]);

        if (
            Object.values(upstreams).some(
                (entries) => entries && Object.keys(Object(entries)).length,
            )
        ) {
            throw new Error("Gemini Bridge refuses CLIProxyAPI upstream api-keys configuration.");
        }
    }

    if (record(config.plugins).enabled !== false) {
        throw new Error(
            "Gemini Bridge requires CLIProxyAPI plugins.enabled: false (unreviewed upstreams).",
        );
    }

    const oauth = record(config.oauth);

    for (const aliases of [config["oauth-model-alias"], oauth["model-alias"]]) {
        if (aliases && Object.keys(Object(aliases)).length) {
            throw new Error(
                "Gemini Bridge refuses OAuth model aliases; use the exact upstream model ID.",
            );
        }
    }

    const payload = record(config.requests).payload;

    if (payload && Object.keys(Object(payload)).length) {
        throw new Error("Gemini Bridge refuses CLIProxyAPI requests.payload configuration.");
    }

    const antigravity = record(record(oauth.providers).antigravity);

    // CLIProxyAPI v8 migrates the legacy credit switch here; the canonical value wins.
    if (
        antigravity["antigravity-credits"] !== undefined &&
        antigravity["antigravity-credits"] !== false
    ) {
        throw new Error(
            "Gemini Bridge requires CLIProxyAPI oauth.providers.antigravity.antigravity-credits: false.",
        );
    }

    const access = record(config.access);
    const keys = Object.hasOwn(access, "api-keys") ? access["api-keys"] : config["api-keys"];
    const key = Array.isArray(keys) ? keys[0] : undefined;

    if (typeof key !== "string" || !key.trim() || /[\r\n]/.test(key)) {
        throw new Error("Gemini Bridge requires a local CLIProxyAPI client key.");
    }

    return key;
}

function localEndpoint(value: string): string {
    const url = new URL(value);

    if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname.replace(/\/$/, "") !== "/v1"
    ) {
        throw new Error("Gemini Bridge requires an HTTP loopback endpoint ending in /v1.");
    }

    return url.href.replace(/\/$/, "");
}

const googleModels = googleProvider().getModels();

const antGravityCatalog: Record<
    string,
    Pick<BridgeModel, "contextWindow" | "maxTokens" | "input">
> = {
    "gemini-4-argon-high": {
        contextWindow: 1048576,
        maxTokens: 1048576,
        input: ["text"],
    },
    "claude-opus-5-5-high": {
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image"],
    },
    "claude-sonnet-5-5-high": {
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ["text", "image"],
    },
};

function bridgeModel(id: string): BridgeModel {
    const base = id.replace(/-(low|medium|high)$/, "");
    const known = googleModels.find((model) => model.id === base);
    const catalog = antGravityCatalog[id];
    const effort = id.match(/-(low|medium|high)$/)?.[1];

    return {
        id,
        name: `${id} (Google subscription)`,
        input: known?.input ?? catalog?.input ?? ["text"],
        // Unknown models use conservative Pocket budgeting, not invented upstream specifications.
        contextWindow: known?.contextWindow ?? catalog?.contextWindow ?? 131072,
        maxTokens: known?.maxTokens ?? catalog?.maxTokens ?? 8192,
        reasoning: true,
        ...(effort
            ? {
                  thinkingLevelMap: {
                      off: null,
                      minimal: null,
                      low: effort === "low" ? "low" : null,
                      medium: effort === "medium" ? "medium" : null,
                      high: effort === "high" ? "high" : null,
                      xhigh: null,
                      max: null,
                  },
              }
            : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: !effort,
            maxTokensField: "max_tokens",
        },
    };
}

function failure(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
    return {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: aborted ? "aborted" : "error",
        errorMessage: aborted
            ? "Gemini Bridge request aborted."
            : error instanceof Error
              ? error.message
              : "Gemini Bridge request failed.",
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

export class GeminiBridge {
    readonly #configPath: string;
    readonly #baseUrl: string;
    readonly #lifetime = new AbortController();
    // Never send the local proxy key or prompt through HTTP_PROXY/HTTPS_PROXY.
    readonly #dispatcher: Agent;

    constructor(options: GeminiBridgeOptions = {}) {
        this.#configPath =
            options.configPath ?? join(homedir(), ".local/share/cliproxyapi/config.yaml");
        this.#baseUrl = localEndpoint(options.baseUrl ?? "http://127.0.0.1:8317/v1");
        this.#dispatcher = new Agent({ headersTimeout: 300000, bodyTimeout: 300000 });
    }

    async #key(signal: AbortSignal): Promise<string> {
        signal.throwIfAborted();

        let config: unknown;

        try {
            config = parse(await readFile(this.#configPath, { encoding: "utf8", signal }));
        } catch {
            // YAML diagnostics can quote nearby secrets. Never expose them to the transcript.
            throw new Error("Gemini Bridge cannot read a valid CLIProxyAPI configuration.");
        }

        return subscriptionProxyKey(config);
    }

    async models(signal = this.#lifetime.signal): Promise<BridgeModel[]> {
        const combined = AbortSignal.any([
            signal,
            this.#lifetime.signal,
            AbortSignal.timeout(15000),
        ]);
        const key = await this.#key(combined);
        const request = {
            headers: { Authorization: `Bearer ${key}` },
            signal: combined,
            redirect: "error" as const,
            dispatcher: this.#dispatcher,
        };
        const response = await proxyFetch(`${this.#baseUrl}/models`, request);

        if (!response.ok) {
            throw new Error(`Gemini Bridge model discovery failed (HTTP ${response.status}).`);
        }

        const body = record(await response.json());
        const entries = Array.isArray(body.data) ? body.data : [];
        const ids = new Set<string>();

        for (const entry of entries) {
            const model = record(entry);

            if (
                model.owned_by === "antigravity" &&
                typeof model.id === "string" &&
                /^(gemini-[a-z0-9.-]+|claude-(opus|sonnet)-5-5[a-z0-9.-]*)$/.test(model.id) &&
                !/(image|audio|tts|embedding|live)/.test(model.id)
            ) {
                ids.add(model.id);
            }
        }

        if (!ids.size) {
            throw new Error(
                "CLIProxyAPI advertises no Antigravity subscription Gemini chat models.",
            );
        }

        return [...ids].sort().map(bridgeModel);
    }

    async registration(): Promise<ProviderRegistration> {
        const models = await this.models();

        return {
            id: "gemini-bridge",
            config: {
                name: "Gemini subscription (local CLIProxyAPI)",
                api: "openai-completions",
                baseUrl: this.#baseUrl,
                // Availability marker only. The actual local key is read privately on every request.
                apiKey: "local-subscription-proxy",
                models,
                refreshModels: ({ signal }) => this.models(signal),
                streamSimple: (model, context, options) => this.stream(model, context, options),
            },
        };
    }

    stream(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}) {
        const output = createAssistantMessageEventStream();
        const signal = AbortSignal.any(
            [options.signal, this.#lifetime.signal].filter((item) => item !== undefined),
        );

        void (async () => {
            try {
                if (options.fetch) {
                    throw new Error("Gemini Bridge does not accept custom request transports.");
                }

                if (model.api !== "openai-completions" || model.baseUrl !== this.#baseUrl) {
                    throw new Error("Gemini Bridge refuses a model API or endpoint override.");
                }

                const available = await this.models(signal);
                const listed = available.find((candidate) => candidate.id === model.id);

                if (!listed) {
                    throw new Error(
                        `Gemini Bridge model ${model.id} is not advertised by CLIProxyAPI.`,
                    );
                }

                const key = await this.#key(signal);

                const guardedFetch: typeof fetch = async (input, init) => {
                    const request = new Request(input, init);

                    if (request.url !== `${this.#baseUrl}/chat/completions`) {
                        throw new Error(
                            "Gemini Bridge refuses a request outside its local chat endpoint.",
                        );
                    }

                    await this.#key(signal);

                    const localOptions = {
                        method: request.method,
                        headers: Object.fromEntries(request.headers),
                        body: await request.text(),
                        redirect: "error" as const,
                        signal,
                        dispatcher: this.#dispatcher,
                    };

                    // Node's bundled fetch can use a different Undici dispatcher ABI. Use the
                    // installed Undici for both transport and dispatcher; its Response is Fetch-compatible.
                    return (await proxyFetch(request.url, localOptions)) as unknown as Response;
                };

                const inner = streamSimple(
                    { ...model, ...listed, api: "openai-completions", headers: undefined },
                    context,
                    {
                        ...options,
                        signal,
                        apiKey: key,
                        headers: { Authorization: `Bearer ${key}` },
                        fetch: guardedFetch,
                        maxRetries: 0,
                        onPayload: async (payload, target) => {
                            const replacement =
                                (await options.onPayload?.(payload, target)) ?? payload;

                            if (record(replacement).model !== model.id) {
                                throw new Error(
                                    "Gemini Bridge refuses a payload model substitution.",
                                );
                            }

                            return replacement;
                        },
                    },
                );

                for await (const event of inner) {
                    output.push(event);
                }
            } catch (error) {
                const message = failure(model, error, signal.aborted);

                output.push({
                    type: "error",
                    reason: message.stopReason as "error" | "aborted",
                    error: message,
                });
            } finally {
                output.end();
            }
        })();

        return output;
    }

    async close(): Promise<void> {
        this.#lifetime.abort();
        await this.#dispatcher.destroy();
    }
}

export function createGeminiBridgeModule(options: GeminiBridgeOptions = {}) {
    const bridge = new GeminiBridge(options);

    return {
        extension: () => defineExtension({ name: "gemini-subscription-bridge" }),
        providers: async () => [await bridge.registration()],
        dispose: () => bridge.close(),
    };
}
