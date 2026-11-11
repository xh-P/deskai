# GPT-SoVITS v2 本地服务

默认使用 [输出清单](../../config/voice/output-runtime.json)。可通过 `DESKAI_TTS_CONFIG` 指定另一份同结构 JSON，资源路径基于 `DESKAI_ASSET_ROOT`，默认是仓库根。

- `python`、`repository`、`ffmpegBin` 指向带 PyTorch/CUDA 和 websockets 的 Python 环境、GPT-SoVITS 和 FFmpeg。
- `modelDirectory`、`referenceDirectory` 指向本地 v2 模型和参考音频。`registry` 是模型目录内的角色清单。每个条目包括 `name`、`gpt`、`sovits` 和 `refs`。参考音频条目包括 `name`、`file`、`text` 和可选 `language`。
- `voiceIds` 将 GPT 权重相对路径映射到稳定声音 ID。`defaultVoiceId` 必须在声音清单中。按清单顺序分配参考音频 ID。
- `streaming` 管理语义流式开关、最小分块和重叠长度。

桌面通过私有本机 WebSocket 获取目录、选择声音、合成和取消。worker 预热所选音色后报告就绪。音色切换通过修订号隔离，PCM 帧同时带会话、回复代次、句子和音色身份。
