# GPT-SoVITS v2 本地服务

默认使用 [输出清单](../../config/voice/output-runtime.json)。可通过 `DESKAI_TTS_CONFIG` 指定另一份同结构 JSON，资源路径基于 `DESKAI_ASSET_ROOT`，默认是仓库根。

- `python`、`repository`、`ffmpegBin` 指向带 PyTorch/CUDA 和 websockets 的 Python 环境、GPT-SoVITS 和 FFmpeg。
- `modelDirectory`、`referenceDirectory` 指向本地 v2 模型和参考音频。`registry` 是模型目录内的角色清单。每个条目包括 `name`、`gpt`、`sovits` 和 `refs`。参考音频条目包括 `name`、`file`、`text` 和可选 `language`。
- `voiceIds` 将 GPT 权重相对路径映射到稳定声音 ID。`defaultVoiceId` 必须在声音清单中。按清单顺序分配参考音频 ID。
- `streaming` 管理语义流式开关、最小分块和重叠长度。
- `phraseEnding` 配置每次合成的 PCM 收尾。默认保留最后 16 毫秒做淡出，再补 85 毫秒停顿。片段内部的 PCM 继续流式回传。

桌面通过私有本机 WebSocket 获取目录、选择声音、合成和取消。worker 预热所选音色后报告就绪。音色切换通过修订号隔离，PCM 帧同时带会话、回复代次、句子和音色身份。

桌面将少于五个可读字符的完整短句暂存最多 220 毫秒，同语言的下一句及时到达时合成一段。正文结束时立即处理尾句。纯标点、引号或其他无文字片段在合成前跳过，原文仍可显示。worker 将没有语音的结果报告为 `TTS_NO_AUDIO`，采样或时长越界报告为 `TTS_INVALID_PCM`。
