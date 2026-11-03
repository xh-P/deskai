# Local TTS inference

The worker uses GPT-SoVITS v2 semantic streaming by default. Set
`DESKAI_TTS_STREAMING=0` before starting the desktop app to use full-sentence
inference. `DESKAI_TTS_MIN_CHUNK_LENGTH` (default `16`) and
`DESKAI_TTS_OVERLAP_LENGTH` (default `2`) configure the runtime's semantic-token
chunk and overlap lengths. Smaller chunks may reduce latency at the cost of
quality or throughput. The playback layer retains the last received piece
until synthesis succeeds, so first audible audio can follow first generated PCM.

Additional local voice pairs can be registered with `DESKAI_TTS_VOICES`, the
path to a UTF-8 JSON array. Paths are absolute or relative to that JSON file:

```json
[
  {
    "id": "example-v3", "name": "Example", "version": "v3",
    "gpt": "model.ckpt", "sovits": "model.pth", "defaultReferenceId": "ref-1",
    "references": [{"id": "ref-1", "name": "Default", "path": "ref.wav", "text": "reference transcription", "language": "all_ja"}]
  }
]
```

The declared version must match the actual SoVITS checkpoint. Runtime base
models and the corresponding vocoder must also be installed. The included v2
voice assets remain available. This runtime does not implement v3 sentence-internal
streaming: v3 uses complete-sentence inference even when streaming is enabled.
