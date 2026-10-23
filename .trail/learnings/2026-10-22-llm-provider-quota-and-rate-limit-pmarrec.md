---
title: LLM provider quota and rate-limit error texts
author: Pmarrec
date: 2026-10-22
branch: main
cost: { minutes: 45, tokens: 232478 }
touches:
    - src/server/usage-reset.ts
    - docs/auto-resume.md
---

## Decided

Provider quota/rate-limit signals must be taken from official docs or live SDK/issue bodies, then labeled confirmed vs not found. Auto-resume may wake only on short resets: Retry-After / retryDelay / resets_at within ~5h, Anthropic unified-5h rejected, Codex 300-minute windows. Never treat billing, spend-cap, weekly/monthly, insufficient_quota, 402 balance, Arrearage, enforced_spend_limit_reached, usage_not_included, Gemini PerDay metrics, FreeUsageLimitError, or OpenRouter credit/key limits (without in-flight Retry-After) as resume triggers. Prefer machine codes and headers over paraphrased prose; several providers reuse HTTP 429 for both short throttles and long/billing stops.

## Tried and ruled out

Guessing exact JSON samples when official pages only give prose (Mistral live 429 body, Together message, Cerebras body, MiMo JSON fields, MiniMax clock windows on the errorcode page). Treating older OpenAI `rate_limit_exceeded` as the only current code — docs now also use `slow_down` / `credit_balance_exhausted` and related spend codes. Treating Anthropic credit exhaustion as documented 402 `billing_error` — live `/v1/messages` still returns 400 `invalid_request_error` with “Your credit balance is too low…”. Relying on Tavily alone this session — DNS to api.tavily.com failed; Cursor WebSearch/WebFetch worked.

## Watch out

Claude Code UI strings differ by version (session/weekly/Opus/Sonnet vs older `Claude AI usage limit reached|<epoch>`). Codex ChatGPT limits use `usage_limit_reached` plus `resets_at` / `resets_in_seconds` and x-codex-* headers, not OpenAI API `insufficient_quota`. MiniMax often returns HTTP 200 with `base_resp.status_code` 2056. Z.ai packs many meanings under HTTP 429 — branch on inner codes 1308/1310/1113/…. OpenCode Go looks for `GoUsageLimitError` / `FreeUsageLimitError` substrings in responseBody. CLIProxyAPI Gemini CLI text is “You have exhausted your capacity on this model. Your quota will reset after …”; duration may be sub-second via quotaResetDelay. Cursor Agents API may return `usage_limit_exceeded` with on-demand messaging even when UI weekly quota remains.
