---
title: OpenAlex and alphaXiv official API budget docs
author: Pmarrec
date: 2026-10-22
branch: main
cost: { minutes: 15 }
touches:
    - AGENTS.md
    - docs-site/src/sidebar.mjs
    - docs/architecture.md
    - docs/auto-resume.md
    - docs/examples/provider-usage.ts
    - docs/features.md
    - docs/map.md
    - docs/provider-usage.md
    - src/server/app.ts
    - src/server/config.ts
---

## Decided

- OpenAlex free `$1`/day budget is per account (sign-in), not per key. Agent keys spend the person's daily budget; the account key stays separate. Copy the key from `https://openalex.org/settings/api`.
- Official MCP at `https://mcp.openalex.org/mcp` uses the same key, daily budget, and usage dashboard as REST.
- Remaining budget: `GET https://api.openalex.org/rate-limit?api_key=…` plus response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Credits-Used`, `X-RateLimit-Reset`. Auth: `?api_key=` or `Authorization: Bearer`.
- alphaXiv's published public docs cover MCP (`https://api.alphaxiv.org/mcp/v1`, docs at `https://www.alphaxiv.org/docs/mcp`): search/analysis tools use assistant quota; feed tools do not. Settings > API Keys with `Authorization: Bearer`.
- Official public REST endpoint catalog, REST rate limits, and any REST-vs-MCP quota comparison for alphaXiv are unverified — do not invent them.

## Tried and ruled out

- Treating third-party endpoint inventories (e.g. github alphaxiv-py api-inventory) as official contracts.
- Relying on `api-docs.alphaxiv.org` or `api.alphaxiv.org/openapi.json` as public REST docs (500 / 404 when checked).
- Assuming REST paper-read calls are cheaper or more numerous per day than MCP `get_paper_content` / `answer_pdf_queries` without an official statement.

## Watch out

- OpenAlex docs also list Settings → API key and login redirect `/settings/api-key`; canonical free-key URL in LLM quickref is `/settings/api`.
- MCP connector org owners spend the organization key/budget, not a personal chooser.
- Mark missing alphaXiv REST facts unverified; production hosts may exist without a published contract.
