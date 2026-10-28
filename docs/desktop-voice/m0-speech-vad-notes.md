# M0 speech 与 VAD 核对

更新：2026-10-28。ASR Remote 的三语文件转写已通过；前端 VAD 版本、许可与资源路径已按官方资料核对。物理麦克风或 AEC 未验收，完整阶段状态见 [M0 验证](./m0-validation.md)。

## dsh SenseVoiceSmall

本地锁定 dsh `0.2.1-rc.2`。SenseVoice Provider 以本机 CPU 和 INT8 ONNX 运行，运行时来自已安装的 `sherpa-onnx-node`，不用额外安装 Python/ONNX 包。缓存默认位于 DSH home 下的 `speech-to-text/sensevoice`；模型与词表在 `models/sensevoice-onnx/`，Silero VAD 在 `models/silero/`。项目实际启动可受 `DSH_HOME` 覆盖。

缓存检查时，上述 SenseVoice 缓存目录不存在。首次准备预计下载：

| 文件 | 锁定大小 |
| --- | ---: |
| `model.int8.onnx` | 239,233,841 B |
| `tokens.txt` | 315,894 B |
| `silero_vad.onnx` | 1,807,522 B |
| **合计** | **241,357,257 B（约 230.1 MiB）** |

来源是 `node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json`。Provider 会验证固定修订、字节数和 SHA-256；中断后已完整校验的文件可复用。下载模型是 M0/M1 可逆准备工作授权范围；本次不改 package 或 lockfile，也不重训。

### Probe 状态

专用入口：`node scripts/m0/dsh-session-probe.mjs --speech-only`；speech 模块只使用本地类型规定的 `speech/catalog`、`speech/follow`、`speech/prepare`、`speech/cancelPreparation` 和 `speech/transcribe`。音频输入严格检查为规范 WAV / PCM16 / 单声道 / 16 kHz；报告只保留状态、语言、字数统计和耗时，不写转写正文、Base64 或原音频。接口未提供 confidence，本探针不会推造该字段。

第一次运行时 Mux 认证成功，但 `speech/catalog` HTTP 404：临时 profile 未加载默认禁用的 voice-input bundle。主 Agent 将官方 bundle 四项贡献加入 M0 Host patch 后，catalog、follow、prepare 与 transcribe 均可正常调用。缓存完成后模型、词表和 VAD 分别为 239,233,841 / 315,894 / 1,807,522 B，与锁定资产大小一致。

当前报告：[`dsh-speech-probe.json`](../../outputs/desktop-validation/m0/dsh-speech-probe.json)。最终转写探针入口时资源缓存已完整，所以 prepare/wake 的 **1,312 ms 是热缓存路径，不是首次冷下载/冷启动**；首次下载耗时未保留为报告计时。表中第一列是该 Host prepare 后的首条转写 Remote wall time，第二个值是重复中文样本的热复测。

| 语言 | 音频时长 | prepare 后首条转写 wall / Provider inference | 非空文本字符 | 同中文样本热复测 wall / Provider inference |
| --- | ---: | ---: | ---: | ---: |
| 中文 | 6.30 s | 171 ms / 0.133 s | 29 | 172 ms / 0.140 s |
| 英文 | 4.54 s | 148 ms / 0.123 s | 59 | — |
| 日文 | 5.86 s | 170 ms / 0.136 s | 20 | — |

三段转写均非空；自动报告只留字数，不包含转写正文。`cancelPreparation` 在已缓存的 worker 唤醒阶段取消成功（91 ms），之后重新 prepare 返回 ready。转写本身的 AbortSignal 无法通过目前 `dsh-session-probe` 提供的 `call()` 适配器注入，未声称验证了转写取消。M0 Host patch 将 `idleTimeoutMs` 显式设为 `0`，表示保持 worker 到 Provider 释放；本轮没有验证非零 idle 回收。

## PCM16 测试 fixture

输入来自已有常态有希 v2 合成 audition 输出，仅为可复现的合成语音样本，不是麦克风录音。原始源 WAV 未改动。使用 FFmpeg 8.0.1 转成单声道 16 kHz `pcm_s16le`。Probe 首次发现 FFmpeg 默认在 WAV 头中附加 LIST/ISFT chunk：尽管 `ffprobe` 显示 PCM16/16 kHz，dsh 的规范输入检查仍会拒绝。已在输出阶段添加 `-fflags +bitexact` 移除附加 chunk，使 `fmt ` 固定在 RIFF offset 12、`data` 固定在 offset 36；probe 也在提交前检查 RIFF 头、格式与长度。源文件路径、转换参数、时长、字节数及 fixture SHA-256 见 [`m0-sensevoice-fixtures.json`](../../tests/voice/fixtures/m0-sensevoice-fixtures.json)。

| Fixture | 源样本语言 | 时长 | 字节数 |
| --- | --- | ---: | ---: |
| `tests/voice/fixtures/m0-sensevoice-zh.wav` | 中文 | 6.30 s | 201,644 |
| `tests/voice/fixtures/m0-sensevoice-en.wav` | 英文 | 4.54 s | 145,324 |
| `tests/voice/fixtures/m0-sensevoice-ja.wav` | 日文 | 5.86 s | 187,564 |

已用 `ffprobe` 核对三段均为 PCM16 / 单声道 / 16 kHz，并由 dsh Remote 接受并输出了非空文字。ASR 样本是已有 TTS 合成音，字数统计无法证明语义准确度；不以这些机器检查替代人工听校或真实麦克风测试。

## 前端 VAD 方案与许可

官方 `@ricky0123/vad-web` 仓库当前 stable 包版本为 `0.0.31`，包许可为 ISC，包中包含 Silero VAD v5 ONNX。官方示例使用 `onnxruntime-web@1.22.0`；`vad-web` 的包依赖范围为 `^1.17.0`，故 1.22.0 是官方 Quick Start 的复现固定值，并非硬性 peer 版本要求。建议新桌面应用将 vad-web 与 ORT Web 精确 pin 到官方示例的 0.0.31 / 1.22.0 组合，再由主 Agent 统一修改 manifest 与 lockfile。dsh 使用的 sherpa Node ONNX Runtime 是独立依赖，不可替代 renderer 的 ORT Web / WASM 运行时。

Silero VAD 上游模型许可证为 MIT。打包时仍应随发行包保留第三方许可文本；vad-web 的 ISC 许可与内含 Silero 模型许可需要分别记录。

官方浏览器指南要求通过 `baseAssetPath` 加载 worklet 和 ONNX 模型，通过 `onnxWASMBasePath` 加载 ORT 运行文件。Vite / Electron 建议把下列文件拷到应用自身静态资源目录，并显式配置两个路径，避免生产环境运行时依赖 CDN：

- `node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js`
- `node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx`
- `node_modules/onnxruntime-web/dist/*.wasm` 与 `*.mjs`

例如分别部署在 `public/vad/` 与 `public/ort/`，初始化时使用 `/vad/`、`/ort/`。官方文档明确指出，较新 ORT 版本除 WASM 外还需 `.mjs` JS binding。VAD 的流式麦克风能力不等于已经验证物理设备的 AEC 效果；输入持续采集、插话和回声验收仍需真实设备。

官方资料：

- [`@ricky0123/vad-web` Browser Guide](https://github.com/ricky0123/vad/blob/master/docs/user-guide/browser.md)
- [`vad-web` package manifest](https://github.com/ricky0123/vad/blob/master/packages/web/package.json)
- [`vad-web` ISC License](https://github.com/ricky0123/vad/blob/master/LICENSE)
- [Silero VAD MIT License](https://github.com/snakers4/silero-vad/blob/master/LICENSE)
