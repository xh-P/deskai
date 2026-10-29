# M3 本地 TTS 接口

`packages/tts-adapter/src/index.ts` 的 `LocalTtsService(root, onStatus?)` 仅拥有自己启动的 Python worker，不复用或终止已有训练、试听和外部 TTS。`root` 是应用代码根目录；设置 `DESKAI_ASSET_ROOT` 可把 assets、runtime、.conda 与模型缓存指向外部工作台，代码始终从应用根目录的 services/tts 加载。`DESKAI_TTS_PYTHON` 可显式指定已有 Python，不安装或升级环境。

- `start(): Promise<VoiceInfo[]>` 启动、认证、加载常态有希 v2 FP16 CUDA、参考预热并返回十声音登记表。默认 `ref-01`，初始 revision 0。失败或退出后需新建 adapter。
- `registry(): VoiceInfo[]` 返回登记表副本。`getStatus(): TtsStatus` 返回状态；回调报告 starting/loading/warming/switching/ready/error/stopped。模型路径与参考音频路径不进入公共登记表。
- `selectVoice(voiceId, referenceId?): Promise<VoiceSelection>` 省略参考则选该声音默认参考；先屏蔽和取消旧合成并等待结束，然后在同一 GPU executor 成套加载 GPT/SoVITS、重置参考缓存、预热。预热成功才增加 `voiceRevision`；失败重新加载并预热旧组合。回滚失败进入 error，不能继续合成。重复选择相同组合不增加 revision。
- `synthesize(request, onPCM, signal?): Promise<SynthesisResult>` 只接受当前选择的 voiceId/referenceId/voiceRevision，文本 1–600 字符，语言 all_zh/all_ja/en，speed 0.5–2。同一 adapter 不排无限队列；并发合成或换声时返回 TTS_BUSY，由上层有限前瞻调度。取消结果 canceled=true；AbortSignal 取消则在 worker 结束后抛出 signal 原因。
- `cancel(): Promise<void>` 本地同步标记取消并立即屏蔽 PCM；认证 IPC 发送取消并等待 worker 终态。取消确认 10 秒、收尾 15 秒超时会关闭自己 worker，避免后台推理与新请求重叠。
- `dispose(): Promise<void>` 幂等清理 WS 与自己启动的进程树。只使用准确子进程 PID，不按可执行文件名清理。

VoiceInfo 包含 id/name/version/defaultReferenceId/references；reference 只含 id/name，形如 ref-01。VoiceSelection 包含 voiceId/referenceId/voiceRevision，调用者在合成参数中直接展开该选择。声音、参考与对话人格无隐式绑定。

每段合成参数另含 sessionId/turnId/generationId/segmentId/text/language/speed。attempt 由上层编码到唯一 segmentId；不要复用同一 generation 下同一个 segmentId 发起重试。PCMChunk 同时携带这五项轮次身份及 voiceId/referenceId/requestId/chunkSeq/sampleRate/channels/format/samples/pcm；pcm 为独立 Uint8Array 的 PCM16LE，支持真实 32000/48000 Hz 单声道。主进程必须保留采样率和身份至播放层，并继续按当前 generation 过滤。

worker 使用随机 loopback 端口和仅环境传入的随机令牌，只允许一个已认证连接。二进制帧是 uint32le JSON header 长度 + UTF-8 JSON + PCM；Node 验证身份、连续序号、长度、格式、采样率与 30 秒上限，发现不一致停止自己服务。请求超时 120 秒，加载/换声 240 秒，单次状态请求 10 秒。合成、加载、换声与预热共用单线程 GPU executor；取消只设停止标记。运行时 stdout 与第三方 stderr 不持久化，避免输出文本和凭据。

确定性验证：`node --experimental-strip-types --test tests/voice/m3-tts.test.ts` 与 `.conda/gsv-v5/python.exe -m unittest discover -s tests/m0 -p test_tts_protocol.py`。覆盖 PCM 身份与 32/48 kHz、并发拒绝、取消迟到音频、后续恢复、坏帧关闭、十声音资源/参考登记与失败回滚。它们不加载 CUDA，不证明十模型可推理或主观语音质量。

真实 GPU 验证入口：`node --experimental-strip-types scripts/m3/tts-voices-probe.mjs [输出目录]`，默认 outputs/desktop-validation/m3/tts。必须与训练、其他推理和模型切换串行；生成十声音短音频、一个备用参考、三次取消及恢复 WAV，报告实际耗时、峰值、RMS 和 SHA256。失败回滚使用单元故障注入验证，不破坏素材来制造真实失败。报告明确不代表主观试听、真实麦克风、扬声器/AEC 已验收。

2026-10-30 本机串行 GPU 探针已通过：[实际报告](../../outputs/desktop-validation/m3/tts/report.json)。十声音均成功生成 32 kHz 非静音短音频（1.08–3.36 秒）；备用参考、三次取消无迟到 PCM、常态有希默认参考恢复均通过。取消的后台推理收尾为 2.69–4.05 秒，播放层仍须在取消当下立即停止和过滤旧 generation。恢复后的常态有希 WAV SHA256 与换声前相同。32/48 kHz 协议处理均有单测；这批 v2 资产的实际输出只有 32 kHz。尚未主观试听，也未进行真实麦克风、扬声器/AEC 验收。
