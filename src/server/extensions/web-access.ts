/**
 * Web Access extension: gives Pi tools to search the web and read public pages.
 * Supports Tavily, Exa, Brave Search, Serper (Google), OpenAI Responses, and DuckDuckGo.
 * Configured through the Pi Pocket Web Access sheet or ~/.pi/web-search.json.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { WebAccessManager } from "../web-access.ts";

export default function createWebAccessExtension() {
    const manager = new WebAccessManager();

    const searchTool = defineTool({
        name: "web_search",
        description:
            "Search the live web for documentation, recent articles, news, and technical information using configured search providers (Tavily, Exa, Brave, Serper, OpenAI, DuckDuckGo). Returns structured results with titles, URLs, snippets, and synthesis.",
        parameters: Type.Object({
            query: Type.String({ description: "The search query" }),
            numResults: Type.Optional(
                Type.Number({ description: "Number of results to return (1-20, default 5)" }),
            ),
            provider: Type.Optional(
                Type.String({
                    description:
                        "Optional preferred provider: auto, tavily, exa, brave, serper, openai, duckduckgo",
                }),
            ),
        }),
        replay: "safe",
        execute: async (args) => {
            const query = (args.query || "").trim();

            if (!query) {
                return {
                    output: [{ type: "text" as const, text: "Search query cannot be empty." }],
                };
            }

            try {
                const response = await manager.search(query, args.provider, args.numResults);
                let text = "";

                if (response.synthesis) {
                    text += `### Summary (${response.provider})\n${response.synthesis}\n\n`;
                }

                if (response.results.length > 0) {
                    text += response.results
                        .map(
                            (r, i) =>
                                `### [${i + 1}] [${r.title}](${r.url})\n- URL: ${r.url}${
                                    r.publishedDate ? `\n- Date: ${r.publishedDate}` : ""
                                }\n- Excerpt: ${r.content}`,
                        )
                        .join("\n\n");
                } else if (!response.synthesis) {
                    text = `No web search results found for query: "${query}" (provider: ${response.provider})`;
                }

                return { output: [{ type: "text" as const, text: text.trim() }] };
            } catch (err: any) {
                return {
                    output: [
                        {
                            type: "text" as const,
                            text: `Web search error: ${err.message || String(err)}. You can configure API keys in Menu → Web access.`,
                        },
                    ],
                };
            }
        },
    });

    const fetchTool = defineTool({
        name: "fetch_content",
        description:
            "Fetch and read the readable text content of a public URL (HTTP/HTTPS) without HTML scripts or markup.",
        parameters: Type.Object({
            url: Type.String({ description: "The public URL to fetch" }),
            maxChars: Type.Optional(
                Type.Number({ description: "Maximum characters to return (default 20000)" }),
            ),
        }),
        replay: "safe",
        execute: async (args) => {
            const url = (args.url || "").trim();

            if (!url) {
                return { output: [{ type: "text" as const, text: "URL cannot be empty." }] };
            }

            try {
                const res = await manager.fetchContent(url, args.maxChars);
                const text = `${res.text}${
                    res.truncated
                        ? `\n\n[Content truncated at ${res.text.length} of ${res.length} characters]`
                        : ""
                }`;

                return { output: [{ type: "text" as const, text }] };
            } catch (err: any) {
                return {
                    output: [
                        {
                            type: "text" as const,
                            text: `Failed to fetch URL ${url}: ${err.message || String(err)}`,
                        },
                    ],
                };
            }
        },
    });

    return defineExtension({
        name: "web-access",
        tools: [searchTool, fetchTool],
    });
}
