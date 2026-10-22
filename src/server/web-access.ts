/**
 * Web Access & Search manager for Pi Pocket.
 * Coordinates web search providers (Tavily, Exa, Brave, Serper, OpenAI, DuckDuckGo),
 * manages API keys and routing configuration in ~/.pi/web-search.json,
 * tests connectivity, and executes live searches and web fetches.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SearchResult {
    title: string;
    url: string;
    content: string;
    publishedDate?: string;
}

export interface SearchResponse {
    provider: string;
    query: string;
    synthesis?: string;
    results: SearchResult[];
}

export interface WebProviderDescriptor {
    id: string;
    name: string;
    description: string;
    website: string;
    apiKeyRequired: boolean;
    keyConfigured: boolean;
    keySource?: "env" | "web-search.json" | "auth.json" | "none";
    maskedKey?: string;
    connected?: boolean;
    latencyMs?: number;
    error?: string;
}

export interface WebSearchConfig {
    enabled?: boolean;
    provider?: string;
    searchRouting?: {
        providers?: string[];
        fallbackOn?: string[];
    };
    maxResults?: number;
    tavilyApiKey?: string;
    tavily?: { apiKey?: string; key?: string };
    exaApiKey?: string;
    exa?: { apiKey?: string; key?: string };
    braveApiKey?: string;
    brave?: { apiKey?: string; key?: string };
    serperApiKey?: string;
    serper?: { apiKey?: string; key?: string };
    openaiApiKey?: string;
    openai?: { apiKey?: string; key?: string };
}

export interface WebAccessState {
    enabled: boolean;
    primaryProvider: string;
    providerOrder: string[];
    maxResults: number;
    providers: WebProviderDescriptor[];
}

const PROVIDER_METADATA: Record<
    string,
    { name: string; description: string; website: string; apiKeyRequired: boolean }
> = {
    tavily: {
        name: "Tavily Search",
        description: "Optimized for LLMs with fast search, AI summaries, and direct answers.",
        website: "https://tavily.com",
        apiKeyRequired: true,
    },
    exa: {
        name: "Exa Neural Search",
        description: "Embeddings-based neural search with rich text snippets and highlights.",
        website: "https://exa.ai",
        apiKeyRequired: true,
    },
    brave: {
        name: "Brave Search",
        description: "Independent web search index with privacy focus and high rate limits.",
        website: "https://brave.com/search/api/",
        apiKeyRequired: true,
    },
    serper: {
        name: "Serper (Google Search)",
        description: "Google Search API for real-time web results, snippets, and knowledge graph.",
        website: "https://serper.dev",
        apiKeyRequired: true,
    },
    openai: {
        name: "OpenAI Web Preview",
        description: "OpenAI search preview using configured OpenAI credentials.",
        website: "https://platform.openai.com",
        apiKeyRequired: true,
    },
    duckduckgo: {
        name: "DuckDuckGo (Free)",
        description: "Zero-configuration search without any API key or account.",
        website: "https://duckduckgo.com",
        apiKeyRequired: false,
    },
};

const ALL_PROVIDER_IDS = ["tavily", "exa", "brave", "serper", "openai", "duckduckgo"];

function maskKey(key: string): string {
    if (!key || key.length < 8) {
        return "••••••••";
    }

    const prefix = key.slice(0, 4);
    const suffix = key.slice(-4);

    return `${prefix}••••${suffix}`;
}

function cleanHtml(html: string): string {
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
        .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
        .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
}

export class WebAccessManager {
    readonly #configPath = join(homedir(), ".pi", "web-search.json");
    readonly #authPath = join(homedir(), ".pi", "agent", "auth.json");
    #testCache = new Map<string, { ok: boolean; latencyMs?: number; error?: string; at: number }>();

    async loadConfig(): Promise<WebSearchConfig> {
        try {
            const raw = await readFile(this.#configPath, "utf-8");

            return JSON.parse(raw);
        } catch {
            return {
                enabled: true,
                provider: "tavily",
                searchRouting: {
                    providers: ["tavily", "exa", "brave", "serper", "openai", "duckduckgo"],
                    fallbackOn: ["transient", "quota", "network", "invalid-response"],
                },
                maxResults: 5,
            };
        }
    }

    async saveConfig(updates: Partial<WebSearchConfig>): Promise<WebSearchConfig> {
        const current = await this.loadConfig();
        const merged: WebSearchConfig = {
            ...current,
            ...updates,
            searchRouting: {
                ...current.searchRouting,
                ...updates.searchRouting,
            },
        };

        const dir = join(homedir(), ".pi");

        await mkdir(dir, { recursive: true }).catch(() => {});
        await writeFile(this.#configPath, JSON.stringify(merged, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        });

        return merged;
    }

    async loadAuth(): Promise<Record<string, any>> {
        try {
            const raw = await readFile(this.#authPath, "utf-8");

            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    async resolveKey(
        providerId: string,
    ): Promise<{ key?: string; source: "env" | "web-search.json" | "auth.json" | "none" }> {
        const envKeyName = `${providerId.toUpperCase()}_API_KEY`;

        if (process.env[envKeyName]) {
            return { key: process.env[envKeyName], source: "env" };
        }

        const config = await this.loadConfig();
        const configKey =
            (config as Record<string, any>)[`${providerId}ApiKey`] ||
            (config as Record<string, any>)[providerId]?.apiKey ||
            (config as Record<string, any>)[providerId]?.key;

        if (typeof configKey === "string" && configKey.trim()) {
            return { key: configKey.trim(), source: "web-search.json" };
        }

        const auth = await this.loadAuth();
        const authEntry =
            auth[providerId] || (providerId === "openai" ? auth["openai-codex"] : undefined);
        const authKey =
            typeof authEntry === "string"
                ? authEntry
                : authEntry?.apiKey || authEntry?.key || authEntry?.access;

        if (typeof authKey === "string" && authKey.trim()) {
            return { key: authKey.trim(), source: "auth.json" };
        }

        return { source: "none" };
    }

    async getState(): Promise<WebAccessState> {
        const config = await this.loadConfig();
        const providers: WebProviderDescriptor[] = [];

        for (const id of ALL_PROVIDER_IDS) {
            const meta = PROVIDER_METADATA[id] ?? {
                name: id,
                description: "",
                website: "",
                apiKeyRequired: true,
            };
            const { key, source } = await this.resolveKey(id);
            const cached = this.#testCache.get(id);

            providers.push({
                id,
                name: meta.name,
                description: meta.description,
                website: meta.website,
                apiKeyRequired: meta.apiKeyRequired,
                keyConfigured: !meta.apiKeyRequired || Boolean(key),
                keySource: source,
                maskedKey: key ? maskKey(key) : undefined,
                connected: cached?.ok,
                latencyMs: cached?.latencyMs,
                error: cached?.error,
            });
        }

        const primary = config.provider || "tavily";
        const order = config.searchRouting?.providers?.length
            ? config.searchRouting.providers
            : ALL_PROVIDER_IDS;

        return {
            enabled: config.enabled ?? true,
            primaryProvider: primary,
            providerOrder: order,
            maxResults: config.maxResults ?? 5,
            providers,
        };
    }

    async setApiKey(providerId: string, apiKey: string): Promise<void> {
        const trimmed = apiKey.trim();
        const config = await this.loadConfig();
        const keyField = `${providerId}ApiKey`;

        if (trimmed) {
            (config as any)[keyField] = trimmed;
        } else {
            delete (config as any)[keyField];

            if ((config as any)[providerId]?.apiKey) {
                delete (config as any)[providerId].apiKey;
            }
        }

        await this.saveConfig(config);
        this.#testCache.delete(providerId);
    }

    async testConnection(
        providerId: string,
        explicitKey?: string,
    ): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
        const key = explicitKey?.trim() || (await this.resolveKey(providerId)).key;
        const meta = PROVIDER_METADATA[providerId];

        if (meta?.apiKeyRequired && !key) {
            const res = {
                ok: false,
                error: `No API key configured for ${meta?.name || providerId}`,
            };

            this.#testCache.set(providerId, { ...res, at: Date.now() });

            return res;
        }

        const start = Date.now();

        try {
            switch (providerId) {
                case "tavily": {
                    const res = await fetch("https://api.tavily.com/search", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ api_key: key, query: "ping", max_results: 1 }),
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "exa": {
                    const res = await fetch("https://api.exa.ai/search", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "x-api-key": key! },
                        body: JSON.stringify({ query: "ping", numResults: 1 }),
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "brave": {
                    const res = await fetch(
                        "https://api.search.brave.com/res/v1/web/search?q=ping&count=1",
                        {
                            headers: {
                                Accept: "application/json",
                                "X-Subscription-Token": key!,
                            },
                            signal: AbortSignal.timeout(8000),
                        },
                    );

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "serper": {
                    const res = await fetch("https://google.serper.dev/search", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-API-KEY": key!,
                        },
                        body: JSON.stringify({ q: "ping", num: 1 }),
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "openai": {
                    const res = await fetch("https://api.openai.com/v1/models", {
                        headers: { Authorization: `Bearer ${key!}` },
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok) {
                        const errText = await res.text().catch(() => "");

                        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
                    }

                    break;
                }

                case "duckduckgo": {
                    const res = await fetch("https://html.duckduckgo.com/html/?q=ping", {
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        },
                        signal: AbortSignal.timeout(8000),
                    });

                    if (!res.ok && res.status !== 200) {
                        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                    }

                    break;
                }

                default:
                    throw new Error(`Unknown provider: ${providerId}`);
            }

            const latencyMs = Date.now() - start;
            const outcome = { ok: true, latencyMs };

            this.#testCache.set(providerId, { ...outcome, at: Date.now() });

            return outcome;
        } catch (err: any) {
            const outcome = { ok: false, error: err.message || String(err) };

            this.#testCache.set(providerId, { ...outcome, at: Date.now() });

            return outcome;
        }
    }

    async search(
        query: string,
        preferredProvider?: string,
        requestedResults?: number,
    ): Promise<SearchResponse> {
        const config = await this.loadConfig();
        const max = Math.min(Math.max(requestedResults ?? config.maxResults ?? 5, 1), 20);
        const order =
            preferredProvider && preferredProvider !== "auto"
                ? [preferredProvider]
                : [
                      config.provider || "tavily",
                      ...(config.searchRouting?.providers || ALL_PROVIDER_IDS),
                  ].filter((v, i, a) => a.indexOf(v) === i);

        let lastError: Error | null = null;

        for (const pid of order) {
            try {
                const { key } = await this.resolveKey(pid);
                const meta = PROVIDER_METADATA[pid];

                if (meta?.apiKeyRequired && !key) {
                    continue;
                }

                const response = await this.#executeProviderSearch(pid, query, max, key);

                if (response.results.length > 0 || response.synthesis) {
                    return response;
                }
            } catch (err: any) {
                lastError = err;
            }
        }

        if (lastError) {
            throw new Error(`Web search failed: ${lastError.message}`);
        }

        return {
            provider: order[0] || "none",
            query,
            results: [],
        };
    }

    async #executeProviderSearch(
        provider: string,
        query: string,
        maxResults: number,
        apiKey?: string,
    ): Promise<SearchResponse> {
        switch (provider) {
            case "tavily": {
                const res = await fetch("https://api.tavily.com/search", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        api_key: apiKey,
                        query,
                        max_results: maxResults,
                        include_answer: true,
                        search_depth: "basic",
                    }),
                    signal: AbortSignal.timeout(15000),
                });

                if (!res.ok) {
                    throw new Error(`Tavily HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const results: SearchResult[] = (data.results || []).map((r: any) => ({
                    title: r.title || "Untitled",
                    url: r.url,
                    content: r.content || "",
                    publishedDate: r.published_date,
                }));

                return {
                    provider: "tavily",
                    query,
                    synthesis: data.answer,
                    results,
                };
            }

            case "exa": {
                const res = await fetch("https://api.exa.ai/search", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey!,
                    },
                    body: JSON.stringify({
                        query,
                        numResults: maxResults,
                        useAutoprompt: true,
                        contents: { text: { maxCharacters: 1200 } },
                    }),
                    signal: AbortSignal.timeout(15000),
                });

                if (!res.ok) {
                    throw new Error(`Exa HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const results: SearchResult[] = (data.results || []).map((r: any) => ({
                    title: r.title || "Untitled",
                    url: r.url,
                    content: r.text || "",
                    publishedDate: r.publishedDate,
                }));

                return { provider: "exa", query, results };
            }

            case "brave": {
                const res = await fetch(
                    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
                    {
                        headers: {
                            Accept: "application/json",
                            "X-Subscription-Token": apiKey!,
                        },
                        signal: AbortSignal.timeout(15000),
                    },
                );

                if (!res.ok) {
                    throw new Error(`Brave HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const results: SearchResult[] = (data.web?.results || []).map((r: any) => ({
                    title: r.title || "Untitled",
                    url: r.url,
                    content: r.description || "",
                    publishedDate: r.page_age,
                }));

                return { provider: "brave", query, results };
            }

            case "serper": {
                const res = await fetch("https://google.serper.dev/search", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-KEY": apiKey!,
                    },
                    body: JSON.stringify({ q: query, num: maxResults }),
                    signal: AbortSignal.timeout(15000),
                });

                if (!res.ok) {
                    throw new Error(`Serper HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const results: SearchResult[] = (data.organic || []).map((r: any) => ({
                    title: r.title || "Untitled",
                    url: r.link,
                    content: r.snippet || "",
                    publishedDate: r.date,
                }));
                const synthesis = data.knowledgeGraph
                    ? `${data.knowledgeGraph.title || ""}: ${data.knowledgeGraph.description || ""}`.trim()
                    : undefined;

                return { provider: "serper", query, synthesis, results };
            }

            case "openai": {
                const res = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${apiKey!}`,
                    },
                    body: JSON.stringify({
                        model: "gpt-4o-mini",
                        messages: [
                            {
                                role: "system",
                                content:
                                    "You are a helpful assistant. Synthesize a concise answer with real-world knowledge for the query.",
                            },
                            { role: "user", content: query },
                        ],
                        max_tokens: 500,
                    }),
                    signal: AbortSignal.timeout(15000),
                });

                if (!res.ok) {
                    throw new Error(`OpenAI HTTP ${res.status}`);
                }

                const data = (await res.json()) as any;
                const answer = data.choices?.[0]?.message?.content || "";

                return {
                    provider: "openai",
                    query,
                    synthesis: answer,
                    results: [
                        {
                            title: `OpenAI Knowledge: ${query}`,
                            url: "https://platform.openai.com",
                            content: answer,
                        },
                    ],
                };
            }

            case "duckduckgo": {
                const res = await fetch(
                    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
                    {
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        },
                        signal: AbortSignal.timeout(15000),
                    },
                );

                if (!res.ok) {
                    throw new Error(`DuckDuckGo HTTP ${res.status}`);
                }

                const html = await res.text();
                const results: SearchResult[] = [];
                const blocks = html.split(/class="result__body/g).slice(1);

                for (const block of blocks.slice(0, maxResults)) {
                    const titleMatch = block.match(/<a class="result__url"[^>]*>(.*?)<\/a>/i);
                    const snippetMatch = block.match(/<a class="result__snippet[^>]*>(.*?)<\/a>/i);
                    const linkMatch = block.match(/href="([^"]+)"/i);

                    if (snippetMatch || titleMatch) {
                        let link = linkMatch && linkMatch[1] ? linkMatch[1] : "";

                        if (link && link.includes("uddg=")) {
                            try {
                                const urlParam = new URL(
                                    link,
                                    "https://duckduckgo.com",
                                ).searchParams.get("uddg");

                                if (urlParam) {
                                    link = decodeURIComponent(urlParam);
                                }
                            } catch {}
                        }

                        const titleText =
                            titleMatch && titleMatch[1] ? titleMatch[1] : "DuckDuckGo Result";
                        const snippetText = snippetMatch && snippetMatch[1] ? snippetMatch[1] : "";

                        results.push({
                            title: cleanHtml(titleText),
                            url: link || "https://duckduckgo.com",
                            content: cleanHtml(snippetText),
                        });
                    }
                }

                return { provider: "duckduckgo", query, results };
            }

            default:
                throw new Error(`Unknown provider: ${provider}`);
        }
    }

    async fetchContent(
        url: string,
        maxChars = 20000,
    ): Promise<{ text: string; truncated: boolean; length: number }> {
        const parsed = new URL(url);

        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            throw new Error("Only HTTP and HTTPS protocols are supported.");
        }

        if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname)) {
            throw new Error("Local loopback addresses cannot be fetched via fetch_content.");
        }

        const limit = Math.min(Math.max(maxChars, 500), 200000);
        const response = await fetch(parsed.toString(), {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; PiPocket-WebAccess/1.0)",
                Accept: "text/html,application/xhtml+xml,text/plain,application/pdf,*/*",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch ${url} (HTTP ${response.status})`);
        }

        const raw = await response.text();
        const cleaned = cleanHtml(raw);
        const truncated = cleaned.slice(0, limit);

        return {
            text: truncated,
            truncated: cleaned.length > limit,
            length: cleaned.length,
        };
    }
}
