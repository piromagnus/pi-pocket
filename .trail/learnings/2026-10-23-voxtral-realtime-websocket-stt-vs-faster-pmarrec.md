---
title: Voxtral realtime WebSocket STT vs faster-whisper streaming
author: Pmarrec
date: 2026-10-23
branch: main
cost: { minutes: 25 }
touches:
  - AGENTS.md
  - README.md
  - docs-site/src/sidebar.mjs
  - docs/architecture.md
  - docs/auto-resume.md
  - docs/examples/provider-usage.ts
  - docs/extensions/browser-modules.md
  - docs/extensions/policies/api-stability.md
  - docs/extensions/reference/host.md
  - docs/extensions/reference/pocket.md
---

## Decided

- For live incremental dictation, prefer Mistral realtime WebSocket with connect ID `voxtral-mini-transcribe-realtime-3` (model card `voxtral-mini-transcribe-realtime-3-0`, Public Preview as of 2026-10-20). Endpoint: `wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=…`. Price: $0.008/min input ($0.0008 cached); older Realtime `voxtral-mini-transcribe-realtime-2602` remains listed at $0.006/min.
- Audio: base64 PCM in `input_audio.append`; default `pcm_s16le` @ 16000 Hz mono; `target_streaming_delay_ms` 80–1200 or 2400 (start 480). Pin French with `language: "fr"`. Browser clients mint short-lived `rt_*` via `POST /v1/client/sessions`.
- Treat each `transcription.text.delta` as final (append-only). There is no provisional event type; dual sessions are the official path for fast-then-accurate UI. Finish with `input_audio.end` → `transcription.done`.

## Tried and ruled out

- Assuming faster-whisper offers a native realtime stream API: it does not. Official use is file / float32 array `transcribe()`; Whisper’s fixed ~30s window and maintainer issues rule out true low-latency streaming without external wrappers.
- Treating older docs that only name `voxtral-mini-transcribe-realtime-2602` as the current connect ID: the 2026-10 Studio realtime guide and troubleshooting use `-3` / reject non-realtime models with HTTP 403.
- Expecting provisional/interim hypotheses from a single Voxtral realtime session: deltas do not rewrite earlier text.

## Watch out

- Model ID aliases conflict across pages (`-3` vs `-3-0` vs `-2602`); re-check https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-in-realtime and https://docs.mistral.ai/inference/pricing before shipping.
- Realtime 3 supports “45 languages and dialects” but the languages page does not enumerate them; `fr` is documented as a valid pin, not a published dialect matrix.
- Local “incremental” with already-installed faster-whisper means VAD-gated chunks only — higher latency, word-cut risk, silent-chunk VAD errors — not a WebSocket STT substitute. Third-party Whisper streaming stacks add a new runtime.
- Related prior learning covers file/offline Mini Transcribe 3 and local VRAM limits; this note is specifically about realtime incremental dictation.
