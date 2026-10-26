/** Requested model limits; registration is not proof of support or subscription entitlement. */
import { getModels } from "@earendil-works/pi-ai/compat";

export const HAIKU_55 = "claude-haiku-5-5";

/** Haiku 5.5 specs: https://platform.claude.com/docs/en/about-claude/models/overview */
export function bridgeModels() {
    const catalog = getModels("anthropic");
    const haiku = catalog.find((model) => model.id === "claude-haiku-4-5");
    const models = [...catalog];

    // The installed pi-ai catalog predates Haiku 5.5. Use the published model
    // ID/capabilities without making a discovery or model request. A future
    // catalog entry wins, so this never adds a duplicate.
    if (!models.some((model) => model.id === HAIKU_55) && haiku) {
        models.push({
            ...haiku,
            id: HAIKU_55,
            name: "Claude Haiku 5.5",
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            reasoning: true,
            input: ["text", "image"],
            thinkingLevelMap: undefined,
        });
    }

    return models
        .filter(
            (model) => /^claude-(opus|sonnet|haiku)-/.test(model.id) && !/-20\d{6}$/.test(model.id),
        )
        .map((model) => {
            // Owner-requested ceiling, not a discovery result. Claude Code must
            // reject models/plans that cannot serve this window; no paid fallback.
            const contextWindow = 1_000_000;

            return {
                id: model.id,
                name: `${model.name} (Claude Bridge, 1M requested)`,
                reasoning: model.reasoning,
                input: model.input,
                contextWindow,
                maxTokens: model.maxTokens,
                thinkingLevelMap: model.thinkingLevelMap,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
        });
}
