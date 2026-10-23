---
title: Mistral Voxtral French dictation for Pi Pocket
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

- For dedicated French dictation in Pi Pocket without OpenRouter: call Mistral Studio API directly with `voxtral-mini-transcribe-3-0` (docs also show short name `voxtral-mini-transcribe-3`), `POST /v1/audio/transcriptions`, pin `language=fr`. Prefer Mini ($0.0035/min) over Small ($0.004/min) unless quality tests need Small.
- A legitimate existing `MISTRAL_API_KEY` works independently of the Le Chat UI; keys use the org plan, not a Free-vs-Pro key type. Pro/Education included monthly usage and API credits are shared across Studio, API, and Vibe — speech is billed per minute against that shared pool, not a separate transcription entitlement.
- Keep working local `faster-whisper` `large-v3-turbo` as the offline/privacy fallback; it already fits current free GPU VRAM.

## Tried and ruled out

- Assuming “Voxtral 3” open weights exist for local install: Voxtral Mini/Small Transcribe 3 and Realtime 3 are Premier / Public Preview API models; no official open weights for Transcribe 3 on Hugging Face as of the check date.
- Installing local open-weight Voxtral on a machine with only ~7–8 GB free VRAM: `Voxtral-Mini-3B-2507` needs ~9.5 GB bf16/fp16; `Voxtral-Mini-4B-Realtime-2602` needs ≥16 GB BF16; `Voxtral-Small-24B-2507` needs ~55 GB (TP=2). None fit without freeing GPU memory first.
- Treating Le Chat Pro voice/UI as the product STT path, or inventing model/price names without live docs.mistral.ai pricing.

## Watch out

- Re-verify live prices and API names on https://docs.mistral.ai/inference/pricing.md and https://docs.mistral.ai/studio/audio/overview before shipping; Pro credit dollars on https://mistral.ai/pricing/ can change.
- Open-weight Apache 2.0 repos that do exist (`Voxtral-Mini-3B-2507`, `Voxtral-Small-24B-2507`, `Voxtral-Mini-4B-Realtime-2602`) are older / realtime-oriented generations — not a drop-in for Transcribe 3 quality.
- File transcription docs: segment timestamps only (word-level errors); `diarize` needs `timestamp_granularities=segment`.
