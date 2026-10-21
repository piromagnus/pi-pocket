/** Compile the pinned upstream provider without invoking its Pi CLI/TUI extension factory. */
import { readFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bridgeModels } from "./catalogue.ts";

const adapter = `
// Explicit owner-requested 1M mode, not a claim of model/plan entitlement.
// Unsupported requests must fail; never enable Extra Usage or a paid fallback.
function claudeCodeModelId(model, _settings) {
    const id = model.id.replace(/\\[1m\\]$/, "");
    return model.contextWindow > 200000 ? id + "[1m]" : id;
}
export function pocketProvider(executable) {
    providerSettings = {
        plan: "pro", longContextExtraUsage: false, strictMcpConfig: true,
        autoMemoryEnabled: false, pathToClaudeCodeExecutable: executable,
    };
    longContextSettings = { plan: "pro", longContextExtraUsage: false };
    const models = MODELS;
    return {
        models,
        streamSimple(model, transcript, options) {
            const context = toBridgeContext(transcript);
            // Pocket's whole effective prompt is portable input. Do not remove or
            // reword instructions to satisfy the upstream billing guard.
            if (context.systemPrompt) {
                const capture = {
                    append: context.systemPrompt, contextFiles: [], skills: [],
                };
                promptCaptures.record(context.systemPrompt, capture, "pi-pocket");
                // Validate summaries too; the isolated upstream summary path
                // normally skips prompt capture.
                projectPromptCapture(promptCaptures.resolveOrDerive(context.systemPrompt), {
                    skillReadTool: "none",
                });
            }
            const last = context.messages.at(-1);
            const recovering = last?.role === "toolResult" && activeQueryContexts.size === 0;
            // A durable restart loses parked SDK handlers, not the tool results.
            // Rebuild from the committed transcript rather than orphaning them.
            const forwarded = {
                ...options,
                metadata: { ...options?.metadata, pocketDurableRecovery: recovering },
            };
            if (last?.role === "user") {
                const tail = context.messages.slice(context.messages.findLastIndex(m => m.role === "assistant") + 1);
                if (!tail.some(m => m.role === "toolResult")) {
                    for (const query of [...activeQueryContexts]) discardRewrittenQuery(query);
                }
            }
            return streamClaudeAgentSdk(model, transcript, forwarded);
        },
    };
}
export function pocketDispose() {
    for (const query of [...activeQueryContexts]) discardRewrittenQuery(query);
    sharedSessions.clear();
    historyRewrittenBySession.clear();
}
`;

/** Upstream's local .js imports point to .ts sources: plain Node cannot load the npm tarball. */
export async function compileBridge(): Promise<{ path: string; cleanup(): Promise<void> }> {
    const manifest = fileURLToPath(import.meta.resolve("pi-claude-bridge/package.json"));
    const root = dirname(manifest);
    const pkg = JSON.parse(await readFile(manifest, "utf8")) as { version: string };

    if (pkg.version !== "0.9.2") {
        throw new Error(
            "Claude Bridge adapter requires the reviewed pi-claude-bridge version 0.9.2.",
        );
    }

    let source = await readFile(join(root, "src", "index.ts"), "utf8");
    const replacements = [
        // Use identical reviewed metadata in the parent registry and workers.
        [
            'const MODELS = buildModels(getModels("anthropic"));',
            `const MODELS = ${JSON.stringify(bridgeModels())};`,
        ],
        [
            "buildModels, claudeCodeModelId, type LongContextSettings",
            "buildModels, claudeCodeModelId as upstreamClaudeCodeModelId, type LongContextSettings",
        ],
        // Isolated summaries must pass through the same subscription-only SDK
        // boundary as normal turns (and the same offline test injection).
        ["\t\tsdkQuery = query({", "\t\tsdkQuery = queryImpl({"],
        // Never read global/project bridge config on the isolated summary path.
        [
            "const compactProviderSettings = loadConfig(cwd).provider;",
            "const compactProviderSettings = providerSettings;",
        ],
        [
            "const rewrittenUnderQuery = Boolean(resultCtx?.historyStale);",
            "const rewrittenUnderQuery = Boolean(resultCtx?.historyStale) || Boolean(options?.metadata?.pocketDurableRecovery);",
        ],
    ];

    for (const [before, after] of replacements) {
        if (!before || !after || source.split(before).length !== 2) {
            throw new Error(
                "Pinned Claude Bridge source differs from the reviewed adapter boundaries.",
            );
        }

        source = source.replace(before, after);
    }

    const directory = await mkdtemp(join(tmpdir(), "pocket-claude-bridge-"));

    try {
        const modules = dirname(root);

        await symlink(modules, join(directory, "node_modules"), "dir");
        const path = join(directory, "provider.mjs");

        await build({
            stdin: { contents: source + adapter, loader: "ts", resolveDir: join(root, "src") },
            outfile: path,
            bundle: true,
            packages: "external",
            platform: "node",
            format: "esm",
            target: "node22",
            logLevel: "silent",
        });

        return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });

        throw error;
    }
}
