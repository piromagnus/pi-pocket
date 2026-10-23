/** A read-only dashboard of connected providers' subscription allowances and API-key spending. */
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
    type Cursor,
    defineExtension,
    defineTool,
    section,
    UsageDoc,
    type UsageState,
} from "@earendil-works/pi-durable";
import createArtifacts from "../../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../../src/server/host.ts";
import type { ProviderLimit } from "../../src/server/provider-limits.ts";

type ObjectValue = Record<string, unknown>;
type Window = { label: string; used: number; reset?: string };
type Totals = { tokens: number; cost: number };
export type ProviderUsage = {
    id: string;
    /** `observed`: no usage endpoint answered, but Pi's own latest request to the provider reported limits. */
    status: "ok" | "observed" | "unavailable" | "error";
    message: string;
    windows: Window[];
    facts: string[];
    /** This conversation's usage. */
    tokens?: number;
    cost?: number;
    /** Every Pi Pocket conversation's usage. */
    all?: Totals;
    /** When Pi's latest request to the provider came back, and when one was last refused for a limit. */
    seen?: string;
    limited?: string;
};
/** A refusal for a limit older than this is no longer news. */
const LIMITED_FOR_MS = 7 * 24 * 3600 * 1000;

type Options = {
    fetch?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    claudeDir?: string;
    antigravityDir?: string;
    cursorUsage?: (apiKey: string) => Promise<CursorUsageSummary>;
    now?: number;
};

export type CursorUsageSummary = {
    agents: number;
    tokens: number;
    costCents: number;
    runs: number;
};
const ENV_KEYS: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    mistral: "MISTRAL_API_KEY",
    google: "GEMINI_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    xai: "XAI_API_KEY",
};

function object(value: unknown): ObjectValue {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as ObjectValue)
        : {};
}

function number(value: unknown): number | undefined {
    if (typeof value !== "number" && typeof value !== "string") {
        return undefined;
    }

    if (typeof value === "string" && value.trim() === "") {
        return undefined;
    }

    const result = Number(value);

    return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value.slice(0, 160) : undefined;
}

function reset(value: unknown): string | undefined {
    const milliseconds = typeof value === "number" ? value * 1000 : Date.parse(String(value));

    const date = new Date(milliseconds);

    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

async function readObject(path: string): Promise<ObjectValue> {
    try {
        return object(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }

        // Never return raw parse errors: they can contain a fragment of a secret file.
        throw new Error(
            "A provider configuration file could not be read. Check permissions and JSON.",
        );
    }
}

/** The local CLIProxyAPI Antigravity credentials, one per signed-in account. */
async function antigravityCredentials(dir: string): Promise<ObjectValue[]> {
    let files: string[];

    try {
        files = await readdir(dir);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }

        throw new Error("The Antigravity credential folder could not be read.");
    }

    const accounts: ObjectValue[] = [];

    for (const file of files.sort()) {
        if (!file.endsWith(".json")) {
            continue;
        }

        const value = await readObject(join(dir, file));

        if (
            value.type === "antigravity" &&
            typeof value.access_token === "string" &&
            typeof value.project_id === "string"
        ) {
            const timestamp = number(value.timestamp);
            const expiresIn = number(value.expires_in);

            accounts.push({
                type: "oauth",
                access: value.access_token,
                project: value.project_id,
                ...(timestamp === undefined || expiresIn === undefined
                    ? {}
                    : { expires: timestamp + expiresIn * 1000 }),
            });
        }
    }

    return accounts;
}

/** Cursor SDK cloud-agent usage: billed tokens and cost, read-only. */
async function cursorUsageFromSdk(apiKey: string): Promise<CursorUsageSummary> {
    const sdk = join(homedir(), ".pi/agent/npm/node_modules/@cursor/sdk/dist/esm/index.js");
    const { Agent } = (await import(sdk)) as {
        Agent: {
            list: (options: {
                runtime: "cloud";
                apiKey: string;
                includeArchived: boolean;
                limit: number;
                cursor?: string;
            }) => Promise<{ items: { agentId: string }[]; nextCursor?: string }>;
            getUsage: (
                agentId: string,
                options: { apiKey: string },
            ) => Promise<{
                usage: { totalTokens: number };
                cost?: { chargedCents: number };
                runs: unknown[];
            }>;
        };
    };
    const summary: CursorUsageSummary = { agents: 0, tokens: 0, costCents: 0, runs: 0 };
    let cursor: string | undefined;

    do {
        const page = await Agent.list({
            runtime: "cloud",
            apiKey,
            includeArchived: true,
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
        });

        for (const agent of page.items) {
            const usage = await Agent.getUsage(agent.agentId, { apiKey });

            summary.agents += 1;
            summary.tokens += usage.usage.totalTokens;
            summary.costCents += usage.cost?.chargedCents ?? 0;
            summary.runs += usage.runs.length;
        }

        cursor = page.nextCursor;
    } while (cursor !== undefined);

    return summary;
}

function addWindow(row: ProviderUsage, label: string, used: unknown, resetsAt: unknown) {
    const percent = number(used);

    if (percent !== undefined) {
        row.windows.push({ label, used: percent, reset: reset(resetsAt) });
    }
}

/** Only allowlisted scalar fields survive; raw API bodies and credentials never reach the dashboard. */
export function normalizeUsage(id: string, raw: unknown): ProviderUsage {
    const data = object(raw);
    const row: ProviderUsage = { id, status: "ok", message: "", windows: [], facts: [] };

    if (id === "anthropic" || id === "claude-bridge") {
        for (const [key, value] of Object.entries(data)) {
            if (key === "five_hour" || key.startsWith("seven_day")) {
                const window = object(value);

                addWindow(row, key.replaceAll("_", " "), window.utilization, window.resets_at);
            }
        }

        for (const value of Array.isArray(data.limits) ? data.limits : []) {
            const limit = object(value);
            const model = object(object(limit.scope).model);

            if (limit.is_active !== false) {
                addWindow(
                    row,
                    [text(model.display_name), text(limit.kind) ?? text(limit.group)]
                        .filter(Boolean)
                        .join(" · ") || "Allowance",
                    limit.percent,
                    limit.resets_at,
                );
            }
        }

        const extra = object(data.extra_usage);

        if (typeof extra.is_enabled === "boolean") {
            row.facts.push(
                `Extra usage: ${extra.is_enabled ? "enabled — additional charges possible" : "disabled"}`,
            );
        }
    } else if (id === "openai-codex" || id === "openai") {
        const rate = object(data.rate_limit);

        const windows = (value: ObjectValue, prefix: string) => {
            for (const key of ["primary_window", "secondary_window"]) {
                const window = object(value[key]);
                const seconds = number(window.limit_window_seconds);
                const duration =
                    seconds === undefined
                        ? key.replaceAll("_", " ")
                        : `${Math.round(seconds / 3600)}h`;

                addWindow(row, `${prefix}${duration}`, window.used_percent, window.reset_at);
            }
        };

        windows(rate, "Codex · ");

        for (const value of Array.isArray(data.additional_rate_limits)
            ? data.additional_rate_limits
            : []) {
            const limit = object(value);

            windows(object(limit.rate_limit), `${text(limit.limit_name) ?? "Additional"} · `);
        }

        const plan = text(data.plan_type);
        const credits = object(data.credits);
        const balance = number(credits.balance);

        if (plan !== undefined) {
            row.facts.push(`Plan: ${plan}`);
        }

        if (credits.unlimited === true) {
            row.facts.push("Codex credits: unlimited");
        } else if (balance !== undefined) {
            row.facts.push(`Codex credits: ${balance}`);
        }

        row.message = "Codex allowance; not a count of ChatGPT web messages or API spending.";
    } else if (id === "openrouter") {
        const key = object(data.data);
        const usage = number(key.usage);
        const limit = number(key.limit);

        if (usage !== undefined) {
            row.facts.push(`Key spending: $${usage.toFixed(2)}`);
        }

        for (const period of ["daily", "weekly", "monthly"]) {
            const amount = number(key[`usage_${period}`]);

            if (amount !== undefined) {
                row.facts.push(`${period}: $${amount.toFixed(2)}`);
            }
        }

        if (limit !== undefined) {
            row.facts.push(`Key limit: $${limit.toFixed(2)}`);

            const remaining = number(key.limit_remaining);
            const period = text(key.limit_reset);
            const budgetUsage =
                remaining !== undefined
                    ? Math.max(0, limit - remaining)
                    : period === "daily" || period === "weekly" || period === "monthly"
                      ? number(key[`usage_${period}`])
                      : period === undefined
                        ? usage
                        : undefined;

            if (budgetUsage !== undefined && limit > 0) {
                addWindow(row, "Key budget", (budgetUsage / limit) * 100, undefined);
            }

            if (period !== undefined) {
                row.facts.push(`Key budget reset period: ${period}`);
            }
        } else if (key.limit === null && usage !== undefined) {
            row.facts.push("No key spending limit");
        }

        const remaining = number(key.limit_remaining);

        if (remaining !== undefined) {
            row.facts.push(`Key allowance remaining: $${remaining.toFixed(2)}`);
        }

        row.message = "This API key only, not the whole account's credit balance.";
    } else if (id === "cursor-admin") {
        const members = Array.isArray(data.teamMemberSpend) ? data.teamMemberSpend : [];
        let overallCents = 0;
        let onDemandCents = 0;
        let fastPremiumRequests = 0;

        for (const value of members) {
            const member = object(value);

            overallCents += number(member.overallSpendCents) ?? 0;
            onDemandCents += number(member.spendCents) ?? 0;
            fastPremiumRequests += number(member.fastPremiumRequests) ?? 0;
        }

        if (members.length > 0) {
            row.facts.push(`Team members: ${number(data.totalMembers) ?? members.length}`);
            row.facts.push(`On-demand spend: $${(onDemandCents / 100).toFixed(2)}`);
            row.facts.push(`Overall spend: $${(overallCents / 100).toFixed(2)}`);
            row.facts.push(`Fast premium requests: ${fastPremiumRequests}`);

            const cycle = text(data.subscriptionCycleStart);

            if (cycle !== undefined) {
                row.facts.push(`Billing cycle start: ${cycle}`);
            }
        }

        row.message = "Cursor team usage from the Admin API; not individual IDE sessions.";
    } else if (id.startsWith("gemini-bridge")) {
        const groups = Array.isArray(data.groups) ? data.groups : [];

        for (const value of groups) {
            const group = object(value);
            const label = text(group.displayName) ?? "Quota pool";
            const buckets = Array.isArray(group.buckets) ? group.buckets : [];

            for (const bucketValue of buckets) {
                const bucket = object(bucketValue);
                const remaining = number(bucket.remainingFraction);

                if (remaining === undefined) {
                    continue;
                }

                const window = text(bucket.window) ?? text(bucket.displayName) ?? "Allowance";
                const used =
                    Math.round(Math.max(0, Math.min(100, (1 - remaining) * 100)) * 10) / 10;

                addWindow(row, `${label} · ${window}`, used, bucket.resetTime);
            }
        }

        row.message = "Antigravity reports separate Gemini and Claude/GPT quota pools.";
    } else if (id === "github-copilot") {
        const quotas = object(data.quota_snapshots);

        for (const [key, value] of Object.entries(quotas)) {
            const quota = object(value);
            const remaining = number(quota.percent_remaining);

            if (quota.unlimited === true) {
                row.facts.push(`${key.replaceAll("_", " ")}: unlimited`);
            } else if (remaining !== undefined && remaining <= 100) {
                addWindow(row, key.replaceAll("_", " "), 100 - remaining, data.quota_reset_date);
            }
        }

        const plan = text(data.copilot_plan);

        if (plan !== undefined) {
            row.facts.push(`Plan: ${plan}`);
        }
    }

    if (row.windows.length === 0 && row.facts.length === 0) {
        row.status = "unavailable";
        row.message = "The provider returned no recognized usage fields. No allowance is assumed.";
    }

    return row;
}

async function requestUsage(
    url: string,
    headers: Record<string, string>,
    options: Options,
    request: { method?: "GET" | "POST"; body?: string } = {},
) {
    try {
        const response = await (options.fetch ?? fetch)(url, {
            method: request.method ?? "GET",
            headers: { Accept: "application/json", ...headers },
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            ...(request.body === undefined ? {} : { body: request.body }),
        });

        if (!response.ok) {
            const hint =
                response.status === 401 || response.status === 403
                    ? "Sign in again or check this credential's usage permissions."
                    : response.status === 429
                      ? "Rate limited; wait a few minutes before refreshing."
                      : "The usage service is unavailable.";

            throw new Error(`HTTP ${response.status}. ${hint}`);
        }

        // Bound response size. Do not read or echo errors, headers, or arbitrary provider bodies.
        const reader = response.body?.getReader();

        if (reader === undefined) {
            throw new Error("Empty usage response.");
        }

        const chunks: Uint8Array[] = [];
        let bytes = 0;

        try {
            while (true) {
                const chunk = await reader.read();

                if (chunk.done) {
                    break;
                }

                bytes += chunk.value.length;

                if (bytes > 256_000) {
                    throw new Error("Usage response exceeded the size limit.");
                }

                chunks.push(chunk.value);
            }
        } finally {
            await reader.cancel();
        }

        try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
            throw new Error("Invalid JSON from the usage service.");
        }
    } catch (error) {
        // Network errors can include request details. Only our known messages are safe.
        const message = error instanceof Error ? error.message : "";

        if (
            /^HTTP \d{3}\./.test(message) ||
            message === "Empty usage response." ||
            message === "Usage response exceeded the size limit." ||
            message === "Invalid JSON from the usage service."
        ) {
            throw new Error(message);
        }

        throw new Error("Usage request failed or timed out. Try again later.");
    }
}

function unavailable(id: string, message: string): ProviderUsage {
    return { id, status: "unavailable", message, windows: [], facts: [] };
}

const WINDOW_NAMES: Record<string, string> = {
    minute: "per minute",
    hour: "per hour",
    day: "per day",
    month: "per month",
    "5h": "5h",
    "7d": "7d",
};

function windowLabel(name: string): string {
    const parts = name.split("-");
    const last = parts.at(-1)!;
    const unit = (parts.length > 1 && WINDOW_NAMES[last] ? parts.slice(0, -1) : parts).join(" ");
    const noun = unit.replace(/^req$/, "requests");

    return parts.length > 1 && WINDOW_NAMES[last]
        ? `${noun[0]!.toUpperCase()}${noun.slice(1)} ${WINDOW_NAMES[last]}`
        : `${noun[0]!.toUpperCase()}${noun.slice(1)}`;
}

/** Seconds (`12`, `1.5`), a Unix time, or a date, after the response came at `at`. */
function resetAfter(value: string | undefined, at: number): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    const seconds = number(value);

    if (seconds !== undefined) {
        return reset(seconds > 1e9 ? seconds : at / 1000 + seconds);
    }

    return reset(value);
}

/**
 * Windows from the rate-limit headers of Pi's latest request: `x-ratelimit-limit-tokens-minute` with its `remaining`
 * (Mistral, OpenAI API keys), `anthropic-ratelimit-tokens-limit` with its `remaining`, Anthropic's unified
 * utilization, and Codex's used percents.
 */
export function headerWindows(limit: Pick<ProviderLimit, "at" | "headers">): Window[] {
    const { at, headers } = limit;
    const windows: Window[] = [];

    for (const [name, value] of Object.entries(headers)) {
        let match = /^x-ratelimit-limit-(.+)$/.exec(name);

        if (match !== null) {
            const max = number(value);
            const left = number(headers[`x-ratelimit-remaining-${match[1]}`]);

            if (max !== undefined && max > 0 && left !== undefined) {
                windows.push({
                    label: windowLabel(match[1]!),
                    used: ((max - Math.min(left, max)) / max) * 100,
                    reset: resetAfter(headers[`x-ratelimit-reset-${match[1]}`], at),
                });
            }

            continue;
        }

        match = /^anthropic-ratelimit-(?!unified)(.+)-limit$/.exec(name);

        if (match !== null) {
            const max = number(value);
            const left = number(headers[`anthropic-ratelimit-${match[1]}-remaining`]);

            if (max !== undefined && max > 0 && left !== undefined) {
                windows.push({
                    label: windowLabel(`${match[1]}-minute`),
                    used: ((max - Math.min(left, max)) / max) * 100,
                    reset: resetAfter(headers[`anthropic-ratelimit-${match[1]}-reset`], at),
                });
            }

            continue;
        }

        match = /^anthropic-ratelimit-unified-(\w+)-utilization$/.exec(name);

        if (match !== null) {
            const used = number(value);

            if (used !== undefined) {
                windows.push({
                    label: match[1]!,
                    used: used <= 1 ? used * 100 : used,
                    reset: resetAfter(headers[`anthropic-ratelimit-unified-${match[1]}-reset`], at),
                });
            }

            continue;
        }

        match = /^x-codex-(primary|secondary)-used-percent$/.exec(name);

        if (match !== null) {
            const used = number(value);
            const minutes = number(headers[`x-codex-${match[1]}-window-minutes`]);

            if (used !== undefined) {
                windows.push({
                    label:
                        minutes === undefined
                            ? `Codex · ${match[1]}`
                            : `Codex · ${Math.round(minutes / 60)}h`,
                    used,
                    reset: resetAfter(
                        headers[`x-codex-${match[1]}-reset-at`] ??
                            headers[`x-codex-${match[1]}-reset-after-seconds`],
                        at,
                    ),
                });
            }
        }
    }

    return windows;
}

/** Add what Pi's own requests saw to a provider whose usage endpoint gave nothing. */
function observe(row: ProviderUsage, limit: ProviderLimit | undefined, now: number): ProviderUsage {
    if (limit === undefined || row.status === "ok") {
        return row;
    }

    const windows = headerWindows(limit);
    const limited =
        limit.limited !== undefined && now - limit.limited.at < LIMITED_FOR_MS
            ? new Date(limit.limited.at).toISOString()
            : undefined;

    if (windows.length === 0 && limited === undefined) {
        return row;
    }

    return {
        ...row,
        status: "observed",
        message: `${row.message} Shown instead: the limits this provider reported on Pi's latest request to it; they change with every request.`,
        windows,
        seen: new Date(limit.at).toISOString(),
        ...(limited === undefined ? {} : { limited }),
    };
}

/** Tokens and estimated cost by provider, from a usage ledger's `provider/modelId` keys. */
export function providerTotals(usage: UsageState | undefined): Record<string, Totals> {
    const totals: Record<string, Totals> = {};

    for (const [model, value] of Object.entries(usage?.models ?? {})) {
        const id = model.split("/")[0]!;
        const total = (totals[id] ??= { tokens: 0, cost: 0 });

        total.tokens += value.totalTokens;
        total.cost += value.cost.total;
    }

    return totals;
}

/** Read credentials, but never refresh, execute configured key commands, or send a model request. */
export async function collectUsage(
    host: Pick<PocketHost, "agentDir"> & Partial<Pick<PocketHost, "providerLimits">>,
    usage?: UsageState,
    options: Options = {},
    everywhere?: Record<string, Totals>,
): Promise<ProviderUsage[]> {
    const now = options.now ?? Date.now();
    const limits = host.providerLimits?.() ?? {};
    const env = options.env ?? process.env;
    const credentials = await readObject(join(host.agentDir, "auth.json"));
    const models = object((await readObject(join(host.agentDir, "models.json"))).providers);
    const claude = object(
        (
            await readObject(
                join(
                    options.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
                    ".credentials.json",
                ),
            )
        ).claudeAiOauth,
    );

    for (const [id, key] of Object.entries(ENV_KEYS)) {
        if (credentials[id] === undefined && env[key]) {
            credentials[id] = { type: "api_key", key: env[key] };
        }
    }

    if (typeof claude.accessToken === "string") {
        credentials["claude-bridge"] = {
            type: "oauth",
            access: claude.accessToken,
            expires: claude.expiresAt,
        };
    }

    const cursorCredential = object(credentials.cursor);

    if (cursorCredential.type === "api_key") {
        credentials["cursor-admin"] = cursorCredential;
    }

    const antigravity = await antigravityCredentials(
        options.antigravityDir ?? join(homedir(), ".local/share/cliproxyapi/auths"),
    );

    antigravity.forEach((account, index) => {
        credentials[index === 0 ? "gemini-bridge" : `gemini-bridge-${index + 1}`] = account;
    });

    const totals = providerTotals(usage);
    const ids = [
        ...new Set([
            ...Object.keys(credentials),
            ...Object.keys(models),
            ...Object.keys(totals),
            ...Object.keys(everywhere ?? {}),
        ]),
    ].sort();

    return Promise.all(
        ids.map(async (id) => {
            const credential = object(credentials[id]);
            let row = unavailable(
                id,
                "No supported account-usage endpoint for this credential. Use the provider's billing page.",
            );
            const oauth = credential.type === "oauth";
            const token = typeof credential.access === "string" ? credential.access : undefined;
            const keyValue = typeof credential.key === "string" ? credential.key : undefined;
            const key =
                keyValue === undefined || keyValue.startsWith("!")
                    ? undefined
                    : (env[keyValue] ??
                      (/^[A-Z][A-Z0-9_]+$/.test(keyValue) ? undefined : keyValue));
            const expires = number(credential.expires);
            let url: string | undefined;
            let headers: Record<string, string> = {};
            let request: { method?: "GET" | "POST"; body?: string } = {};

            if (oauth && token && (id === "anthropic" || id === "claude-bridge")) {
                url = "https://api.anthropic.com/api/oauth/usage";
                headers = {
                    Authorization: `Bearer ${token}`,
                    "anthropic-beta": "oauth-2025-04-20",
                };
            } else if (
                oauth &&
                token &&
                (id === "openai-codex" || id === "openai") &&
                typeof credential.accountId === "string"
            ) {
                // A ChatGPT (Codex) login. Sign in with ChatGPT token sharing has no account id, and this
                // endpoint refuses its api.openai.com tokens.
                url = "https://chatgpt.com/backend-api/wham/usage";
                headers = {
                    Authorization: `Bearer ${token}`,
                    "ChatGPT-Account-Id": credential.accountId,
                };
            } else if (oauth && id === "openai") {
                row = unavailable(
                    id,
                    "Sign in with ChatGPT token sharing draws on your ChatGPT plan's Subscription Sharing allowance, which OpenAI publishes no usage endpoint for.",
                );
            } else if (id === "mistral" && key) {
                row = unavailable(
                    id,
                    "Mistral API keys have no account usage endpoint; standard keys cannot read spend. See console.mistral.ai for the bill.",
                );
            } else if (id === "openrouter" && key) {
                url = "https://openrouter.ai/api/v1/key";
                headers = { Authorization: `Bearer ${key}` };
            } else if (id.startsWith("gemini-bridge") && oauth && token) {
                url =
                    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
                headers = { Authorization: `Bearer ${token}` };
                request = {
                    method: "POST",
                    body: JSON.stringify({ project: credential.project }),
                };
            } else if (
                id === "github-copilot" &&
                oauth &&
                typeof credential.refresh === "string" &&
                !credential.enterpriseUrl
            ) {
                url = "https://api.github.com/copilot_internal/user";
                headers = {
                    Authorization: `token ${credential.refresh}`,
                    "User-Agent": "Pi-Pocket-Usage",
                    "X-GitHub-Api-Version": "2022-11-28",
                };
            }

            if (id === "cursor-admin" && key) {
                url = "https://api.cursor.com/teams/spend";
                headers = {
                    Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
                };
                request = { method: "POST", body: JSON.stringify({}) };
            }

            if (id === "cursor" && key) {
                try {
                    const summary = await (options.cursorUsage ?? cursorUsageFromSdk)(key);

                    row =
                        summary.agents === 0
                            ? unavailable(id, "No Cursor cloud agents found for this API key.")
                            : {
                                  id,
                                  status: "ok",
                                  message: "Cursor SDK cloud-agent usage; not IDE usage.",
                                  windows: [],
                                  facts: [
                                      `Cloud agents: ${summary.agents}`,
                                      `Billed tokens: ${summary.tokens.toLocaleString("en-US")}`,
                                      `Billed cost: $${(summary.costCents / 100).toFixed(2)}`,
                                      `Runs: ${summary.runs}`,
                                  ],
                              };
                } catch {
                    row = unavailable(
                        id,
                        "Cursor usage could not be read with the SDK. Check the API key and network.",
                    );
                }
            }

            if (url !== undefined) {
                if (
                    oauth &&
                    id !== "github-copilot" &&
                    expires !== undefined &&
                    expires <= (options.now ?? Date.now())
                ) {
                    row = unavailable(
                        id,
                        "Login token expired. Sign in again or use the provider normally to refresh it, then request usage again.",
                    );
                } else {
                    try {
                        row = normalizeUsage(
                            id,
                            await requestUsage(url, headers, options, request),
                        );
                    } catch (error) {
                        const message = (error as Error).message;

                        if (id === "cursor-admin" && /^HTTP (401|403)\./.test(message)) {
                            row = unavailable(id, "Cursor IDE usage needs a team admin API key.");
                        } else {
                            row = { ...row, status: "error", message };
                        }
                    }
                }
            }

            return {
                ...observe(row, limits[id], now),
                ...(totals[id] ?? {}),
                ...(everywhere?.[id] === undefined ? {} : { all: everywhere[id] }),
            };
        }),
    );
}

function escape(value: string): string {
    return value.replace(
        /[&<>"']/g,
        (character) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
    );
}

export function renderDashboard(rows: ProviderUsage[], at = Date.now()): string {
    const cards = rows
        .map(
            (row) => `<article>
        <header><h2>${escape(row.id)}</h2><span class="badge ${row.status}">${row.status === "ok" ? "Connected" : row.status === "observed" ? "From Pi's requests" : row.status === "error" ? "Request failed" : "Unavailable"}</span></header>
        ${row.message ? `<p class="muted">${escape(row.message)}</p>` : ""}
        ${row.limited ? `<p class="warn">A request was refused for a usage limit at <time datetime="${escape(row.limited)}">${escape(row.limited)}</time>.</p>` : ""}
        ${row.seen ? `<p class="muted">Pi's latest request: <time datetime="${escape(row.seen)}">${escape(row.seen)}</time></p>` : ""}
        ${row.windows.map((window) => `<section><div class="metric"><span>${escape(window.label)}</span><strong>${window.used.toFixed(1)}% used</strong></div><progress max="100" value="${Math.min(100, window.used)}" aria-label="${escape(window.label)}"></progress>${window.reset ? `<p class="muted">Resets <time datetime="${escape(window.reset)}">${escape(window.reset)}</time></p>` : ""}</section>`).join("")}
        ${row.facts.map((fact) => `<p>${escape(fact)}</p>`).join("")}
        ${
            row.tokens === undefined && row.all === undefined
                ? ""
                : `<footer>${row.all === undefined ? "" : `<div>All Pi Pocket sessions: ${row.all.tokens.toLocaleString("en-US")} tokens · $${row.all.cost.toFixed(4)} estimated API cost</div>`}${row.tokens === undefined ? "" : `<div>This session: ${row.tokens.toLocaleString("en-US")} tokens · $${(row.cost ?? 0).toFixed(4)} estimated API cost</div>`}</footer>`
        }
    </article>`,
        )
        .join("");

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Provider usage</title><style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb}*{box-sizing:border-box}body{margin:0;padding:24px 16px;max-width:1100px;margin-inline:auto}h1{margin:0 0 8px;font-size:28px}h2{margin:0;font-size:19px;overflow-wrap:anywhere}.muted,footer{color:#a7b3c9;font-size:14px;line-height:1.6}.intro{max-width:720px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:16px;margin-top:24px}article{background:#1b2537;border:1px solid #344259;border-radius:16px;padding:20px;min-width:0}header,.metric{display:flex;align-items:center;justify-content:space-between;gap:12px}header{flex-wrap:wrap}.badge{font-size:12px;padding:6px 10px;border-radius:99px;background:#374151;white-space:nowrap}.ok{background:#164e3c;color:#a7f3d0}.observed{background:#1e3a5f;color:#bfdbfe}.error{background:#652b30;color:#fecaca}.warn{color:#fcd34d;font-size:14px;line-height:1.6}section{margin-top:20px}.metric{font-size:14px;align-items:baseline}.metric strong{white-space:nowrap}progress{width:100%;height:10px;accent-color:#6ee7b7;margin-top:10px}footer{border-top:1px solid #344259;margin-top:20px;padding-top:12px}button{background:#334155;color:#fff;border:1px solid #64748b;border-radius:10px;min-height:44px;padding:10px 16px;font:inherit;cursor:pointer}#notice{min-height:24px}
    </style></head><body><h1>Provider usage</h1><p class="muted intro">One view of your connected subscriptions and API providers. Snapshot: <time datetime="${new Date(at).toISOString()}">${new Date(at).toISOString()}</time>.</p><p class="muted intro">Allowances are account-wide and may be shared between providers; do not add them together. Token totals count only Pi Pocket's own requests and are local estimates, not subscription percentages. A $0 estimate does not guarantee no charges.</p><button id="refresh" type="button">How to refresh</button><p class="muted" id="notice" role="status">Ask Pi: “show provider usage” to fetch a new snapshot in this same dashboard.</p><main class="grid">${cards || "<article><h2>No providers found</h2><p>Connect a provider in Pi Pocket, then ask for usage again.</p></article>"}</main><script>
    document.getElementById('refresh').onclick=()=>{document.getElementById('notice').textContent='Return to the chat and ask Pi: show provider usage. This sandboxed snapshot cannot read credentials or call Pi Pocket.'};
    for(const element of document.querySelectorAll('time')){element.textContent=new Date(element.dateTime).toLocaleString()}
    window.onerror=()=>{document.getElementById('notice').textContent='A display error occurred. Request a fresh dashboard in chat.'};
    </script></body></html>`;
}

export default function createProviderUsage(host: PocketHost, options: Options = {}) {
    const artifact = createArtifacts(host).tools![0]!;
    const tool = defineTool({
        name: "subscription_usage",
        description:
            "Show connected provider subscription allowances, reset times, and API-key spending in one dashboard. Available to everyone who can steer Pi; read-only requests. Refresh by calling again.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
            const usage = await api.snapshot(UsageDoc, api.conversationId, context);
            const everywhere: Record<string, Totals> = {};
            let cursor: Cursor | undefined;

            // Every conversation's ledger, subagents' included: what Pi Pocket spent per provider, all time.
            do {
                const page = await api.commit(
                    (tx) => tx.scanConversations({}, 256, cursor),
                    context,
                );

                for (const { id } of page.items) {
                    const ledger = await api.snapshot(UsageDoc, id, context);

                    for (const [provider, total] of Object.entries(providerTotals(ledger))) {
                        const sum = (everywhere[provider] ??= { tokens: 0, cost: 0 });

                        sum.tokens += total.tokens;
                        sum.cost += total.cost;
                    }
                }

                cursor = page.next;
            } while (cursor !== undefined);

            const rows = await collectUsage(host, usage, options, everywhere);

            const result = await artifact.execute(
                {
                    id: "provider-usage",
                    title: "Provider usage",
                    type: "html",
                    content: renderDashboard(rows),
                },
                api,
                context,
            );

            return {
                ...result,
                content: [
                    {
                        type: "text" as const,
                        text: "Updated the Provider usage dashboard (artifact provider-usage). Open it from Menu → Artifacts → Provider usage, or run /all-usage in this conversation. Ask for provider usage again to refresh this same dashboard.",
                    },
                ],
            };
        },
    });

    return defineExtension({
        name: "subscriptions-usage-dashboard",
        tools: [tool],
        sections: [
            section(
                "provider_usage",
                () =>
                    "When someone asks about subscription usage, remaining allowance, provider limits, or provider spending, call subscription_usage to show one dashboard. Each call refreshes its snapshot. Never describe unavailable usage as zero. The dashboard is visible to participants in this conversation; do not proactively fetch private account usage. The /all-usage command opens the latest snapshot without a new fetch.",
            ),
        ],
    });
}
