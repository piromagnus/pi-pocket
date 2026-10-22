// Web Access Sheet: configure search providers (Tavily, Exa, Brave, Serper, OpenAI, DuckDuckGo),
// manage API keys, test connection latency, set routing order, and run live verification searches.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet, Switch } from "../ui.js";

export function WebAccessSheet() {
    const { me } = store.state;
    const owner = me?.role === "owner";

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [keys, setKeys] = useState({});
    const [showKey, setShowKey] = useState({});
    const [testResults, setTestResults] = useState({});
    const [testing, setTesting] = useState({});

    // Live search testing
    const [searchQuery, setSearchQuery] = useState("");
    const [searching, setSearching] = useState(false);
    const [searchOutput, setSearchOutput] = useState(null);
    const [searchError, setSearchError] = useState("");

    const load = async () => {
        setLoading(true);
        const res = await attempt(() => api("web-access"));

        if (res) {
            setData(res);
        }

        setLoading(false);
    };

    useEffect(() => {
        load();
    }, []);

    const saveKey = async (providerId) => {
        const key = keys[providerId] ?? "";

        setSaving(true);
        const updated = await attempt(() =>
            api("web-access", { apiKey: { provider: providerId, key } }),
        );

        if (updated) {
            setData(updated);
            setKeys((was) => ({ ...was, [providerId]: "" }));
            // Automatically test after saving
            testProvider(providerId);
        }

        setSaving(false);
    };

    const clearKey = async (providerId) => {
        setSaving(true);
        const updated = await attempt(() =>
            api("web-access", { apiKey: { provider: providerId, key: "" } }),
        );

        if (updated) {
            setData(updated);
            setKeys((was) => ({ ...was, [providerId]: "" }));
            setTestResults((was) => ({ ...was, [providerId]: null }));
        }

        setSaving(false);
    };

    const setPrimary = async (providerId) => {
        setSaving(true);
        const updated = await attempt(() => api("web-access", { primaryProvider: providerId }));

        if (updated) {
            setData(updated);
        }

        setSaving(false);
    };

    const toggleEnabled = async (enabled) => {
        setSaving(true);
        const updated = await attempt(() => api("web-access", { enabled }));

        if (updated) {
            setData(updated);
        }

        setSaving(false);
    };

    const updateMaxResults = async (maxResults) => {
        setSaving(true);
        const updated = await attempt(() => api("web-access", { maxResults }));

        if (updated) {
            setData(updated);
        }

        setSaving(false);
    };

    const testProvider = async (providerId) => {
        setTesting((was) => ({ ...was, [providerId]: true }));
        const currentInput = keys[providerId];
        const res = await attempt(() =>
            api("web-access/test", {
                provider: providerId,
                apiKey: currentInput || undefined,
            }),
        );

        if (res) {
            setTestResults((was) => ({ ...was, [providerId]: res }));
        }

        setTesting((was) => ({ ...was, [providerId]: false }));
    };

    const runLiveSearch = async (event) => {
        event?.preventDefault();
        const q = searchQuery.trim();

        if (!q) {
            return;
        }

        setSearching(true);
        setSearchError("");
        setSearchOutput(null);

        try {
            const res = await api("web-access/search", {
                query: q,
                provider: data?.primaryProvider,
                numResults: data?.maxResults ?? 5,
            });

            setSearchOutput(res);
        } catch (err) {
            setSearchError(err?.message || String(err));
        } finally {
            setSearching(false);
        }
    };

    return html`<${Sheet} title="Web Access & Search" onClose=${closeSheet}>
        <div class="web-access-sheet">
            <p class="ext-intro">
                Configure live web access and search providers for Pi. When enabled, Pi can use
                <span class="mono"> web_search</span> and
                <span class="mono"> fetch_content</span> to browse recent documentation, current
                events, and online articles.
            </p>

            ${loading && !data && html`<${Loader} label="Loading web access configuration" />`}

            ${
                data &&
                html`
                    <div class="web-access-global group">
                        <div class="setting">
                            <div class="grow">
                                <div class="small">Enable web tools for Pi</div>
                                <div class="muted small">
                                    Offers <span class="mono">web_search</span> and
                                    <span class="mono">fetch_content</span> in sessions.
                                </div>
                            </div>
                            <${Switch}
                                on=${data.enabled}
                                disabled=${!owner || saving}
                                label=${`Web tools: ${data.enabled ? "on" : "off"}`}
                                onChange=${(e) => toggleEnabled(e.currentTarget.checked)}
                            />
                        </div>

                        <div class="setting">
                            <div class="grow">
                                <div class="small">Primary search provider</div>
                                <div class="muted small">
                                    Preferred provider. If it fails or is rate-limited, Pi
                                    automatically falls back to the next configured provider.
                                </div>
                            </div>
                            <select
                                class="select small"
                                disabled=${!owner || saving}
                                value=${data.primaryProvider}
                                onChange=${(e) => setPrimary(e.currentTarget.value)}
                            >
                                ${data.providers.map(
                                    (p) =>
                                        html`<option key=${p.id} value=${p.id}>
                                            ${p.name}
                                            ${
                                                p.keyConfigured
                                                    ? p.apiKeyRequired
                                                        ? " (configured)"
                                                        : " (ready)"
                                                    : " (no key)"
                                            }
                                        </option>`,
                                )}
                            </select>
                        </div>

                        <div class="setting">
                            <div class="grow">
                                <div class="small">Max search results per query</div>
                                <div class="muted small">
                                    Number of results Pi retrieves (default 5, max 20).
                                </div>
                            </div>
                            <select
                                class="select small"
                                disabled=${!owner || saving}
                                value=${data.maxResults}
                                onChange=${(e) => updateMaxResults(Number(e.currentTarget.value))}
                            >
                                <option value="3">3 results (compact)</option>
                                <option value="5">5 results (balanced)</option>
                                <option value="10">10 results (thorough)</option>
                                <option value="15">15 results (extended)</option>
                            </select>
                        </div>
                    </div>

                    <div class="group">
                        <div class="group-title">Search Providers (${data.providers.length})</div>
                        <div class="web-provider-list">
                            ${data.providers.map((p) => {
                                const isPrimary = data.primaryProvider === p.id;
                                const test = testResults[p.id];
                                const isTesting = testing[p.id];
                                const hasKey = p.keyConfigured;
                                const isShow = showKey[p.id];
                                const inputValue = keys[p.id] ?? "";

                                return html`<div class="web-provider-card" key=${p.id}>
                                    <div class="web-provider-head">
                                        <div class="web-provider-info">
                                            <div class="web-provider-name-row">
                                                <strong class="web-provider-name">${p.name}</strong>
                                                ${
                                                    isPrimary &&
                                                    html`<span class="badge primary">Primary</span>`
                                                }
                                                ${
                                                    hasKey
                                                        ? html`<span class="badge ok">✓ Ready</span>`
                                                        : p.apiKeyRequired
                                                          ? html`<span class="badge warn"
                                                            >Needs Key</span
                                                        >`
                                                          : html`<span class="badge muted"
                                                            >No Key Needed</span
                                                        >`
                                                }
                                            </div>
                                            <p class="muted small">${p.description}</p>
                                            <div class="web-provider-meta small">
                                                <a
                                                    href=${p.website}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    class="link small"
                                                >
                                                    Documentation & Keys
                                                    <${Icon} name="external" size=${11} />
                                                </a>
                                                ${p.keySource && p.keySource !== "none" && html`<span class="muted mono">· source: ${p.keySource}</span>`}
                                                ${p.maskedKey && html`<span class="muted mono">· key: ${p.maskedKey}</span>`}
                                            </div>
                                        </div>

                                        <div class="web-provider-actions">
                                            ${
                                                !isPrimary &&
                                                html`<button
                                                class="button small"
                                                disabled=${!owner || saving}
                                                onClick=${() => setPrimary(p.id)}
                                                title="Set as active provider"
                                            >
                                                Use as primary
                                            </button>`
                                            }
                                            <button
                                                class="button small"
                                                disabled=${isTesting || (!hasKey && !inputValue)}
                                                onClick=${() => testProvider(p.id)}
                                            >
                                                ${
                                                    isTesting
                                                        ? html`<${Loader} label="Testing" />`
                                                        : "Test Connection"
                                                }
                                            </button>
                                        </div>
                                    </div>

                                    ${
                                        test &&
                                        html`<div
                                        class=${`web-test-status small ${test.ok ? "ok" : "warn"}`}
                                    >
                                        ${
                                            test.ok
                                                ? `✓ Connection successful (${test.latencyMs ?? 0} ms)`
                                                : `✗ Error: ${test.error || "Connection failed"}`
                                        }
                                    </div>`
                                    }

                                    ${
                                        owner &&
                                        p.apiKeyRequired &&
                                        html`<div class="web-key-row">
                                        <div class="web-key-input-wrap">
                                            <input
                                                type=${isShow ? "text" : "password"}
                                                class="input small mono"
                                                placeholder=${
                                                    p.maskedKey
                                                        ? `Replace existing key (${p.maskedKey})`
                                                        : `Enter ${p.name} API key`
                                                }
                                                value=${inputValue}
                                                onInput=${(e) =>
                                                    setKeys((was) => ({
                                                        ...was,
                                                        [p.id]: e.currentTarget.value,
                                                    }))}
                                            />
                                            <button
                                                type="button"
                                                class="button icon-only ghost small"
                                                onClick=${() =>
                                                    setShowKey((was) => ({
                                                        ...was,
                                                        [p.id]: !was[p.id],
                                                    }))}
                                                title=${isShow ? "Hide key" : "Show key"}
                                            >
                                                ${isShow ? "Hide" : "Show"}
                                            </button>
                                        </div>
                                        <button
                                            class="button small primary"
                                            disabled=${saving || !inputValue.trim()}
                                            onClick=${() => saveKey(p.id)}
                                        >
                                            Save Key
                                        </button>
                                        ${
                                            hasKey &&
                                            p.keySource === "web-search.json" &&
                                            html`<button
                                            class="button small ghost"
                                            disabled=${saving}
                                            onClick=${() => clearKey(p.id)}
                                            title="Clear stored key"
                                        >
                                            Clear
                                        </button>`
                                        }
                                    </div>`
                                    }
                                </div>`;
                            })}
                        </div>
                    </div>

                    <div class="group">
                        <div class="group-title">Live Search Verification</div>
                        <p class="muted small">
                            Test real search queries right here to verify providers and snippet
                            extraction.
                        </p>

                        <form class="web-live-search-form" onSubmit=${runLiveSearch}>
                            <input
                                type="text"
                                class="input grow"
                                placeholder="Try searching: e.g. Node 24 new features, Pi Pocket, or weather in Paris..."
                                value=${searchQuery}
                                onInput=${(e) => setSearchQuery(e.currentTarget.value)}
                            />
                            <button
                                type="submit"
                                class="button primary"
                                disabled=${searching || !searchQuery.trim()}
                            >
                                ${searching ? html`<${Loader} label="Searching" />` : "Search"}
                            </button>
                        </form>

                        ${searchError && html`<div class="error-box small">${searchError}</div>`}

                        ${
                            searchOutput &&
                            html`<div class="web-search-results">
                            <div class="muted small mono">
                                Provider: ${searchOutput.provider} · Query: "${searchOutput.query}"
                                · ${searchOutput.results.length} results
                            </div>

                            ${
                                searchOutput.synthesis &&
                                html`<div class="web-synthesis-box">
                                <strong>AI Summary</strong>
                                <p class="small">${searchOutput.synthesis}</p>
                            </div>`
                            }

                            <div class="web-results-list">
                                ${searchOutput.results.map(
                                    (item, idx) => html`<div class="web-result-item" key=${idx}>
                                        <div class="web-result-title">
                                            <a
                                                href=${item.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                class="link"
                                            >
                                                ${idx + 1}. ${item.title}
                                            </a>
                                            ${
                                                item.publishedDate &&
                                                html`<span class="muted small"
                                                >· ${item.publishedDate}</span
                                            >`
                                            }
                                        </div>
                                        <div class="web-result-url muted small mono">
                                            ${item.url}
                                        </div>
                                        <div class="web-result-snippet small">
                                            ${item.content}
                                        </div>
                                    </div>`,
                                )}
                            </div>
                        </div>`
                        }
                    </div>
                `
            }
        </div>
    <//>`;
}
