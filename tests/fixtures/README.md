# WebM fixtures

Short (~3 s) 320×240 recordings produced by Chromium's `MediaRecorder` with
`timeslice = 1000` from a canvas + oscillator stream:

| File | Codecs | Notes |
| --- | --- | --- |
| `vp9.webm` | VP9 + Opus | continuous |
| `vp8.webm` | VP8 + Opus | continuous |
| `vp9-pause.webm` | VP9 + Opus | 1.5 s record, 1.5 s `pause()`, 1.5 s record |
| `vp8-pause.webm` | VP8 + Opus | same as above |

They are live WebM (unknown Segment size, no Duration) exactly as the
extension receives them, and are used by `duration-patch.test.ts`.
