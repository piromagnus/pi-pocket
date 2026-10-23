---
title: French voice STT API options
author: Pmarrec
date: 2026-10-22
branch: main
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

- For French voice-message transcription, use a paid developer STT API or local Whisper. ChatGPT Plus/Pro, Claude Pro, Cursor, and Google AI Pro/Ultra do not include a legitimate reusable transcription API for apps; chat/UI billing stays separate from API billing.
- Cheap official options (checked Oct 2026): Groq `whisper-large-v3-turbo` at $0.04/h (~$0.00067/min, min bill 10s); OpenAI `gpt-4o-mini-transcribe` ~$0.003/min estimate ($1.25/$5 per 1M audio in/out tokens, deprecated remove 26 Feb 2027); Mistral Voxtral Mini Transcribe 3 $0.0035/min, Small $0.004/min, Realtime Mini $0.008/min.
- Local: faster-whisper / whisper.cpp with `language=fr` (or FR fine-tunes); cost is hardware only.
- Claude has no dedicated STT API; cookbooks use third-party STT. Cursor voice only fills chat. Google AI plan benefits apply to AI Studio UI only; Gemini API is separate Cloud billing.

## Tried and ruled out

- Treating ChatGPT / Claude / Cursor / Google AI subscriptions or in-app voice as a reusable STT API for product code.
- OpenRouter as a transcription route (explicitly out of scope).
- Ranking French quality without vendor-stated evidence; only cite official claims (e.g. Mistral Small Transcribe 3 SOTA on FLEURS including French; OpenAI “better than Whisper” without FR numbers; Groq multilingual WER table not FR-only).
- Using third-party price blogs as source of truth when vendor pricing pages exist.

## Watch out

- OpenAI mini-transcribe $/min is an estimate; real bill is tokens. Prefer `gpt-transcribe` ($0.0045/min) for new OpenAI integrations before the Feb 2027 cutoff.
- Groq turbo has no translation endpoint; set `language=fr` for accuracy/latency.
- Do not assume subscription web endpoints are callable; verify official API docs and separate API billing before wiring.
- Official vendor URLs to re-check: platform.openai.com / developers.openai.com pricing; console.groq.com/docs/speech-to-text; docs.mistral.ai/inference/pricing; ai.google.dev/gemini-api/docs/google-ai-plans; Anthropic Help Center Pro vs API.
