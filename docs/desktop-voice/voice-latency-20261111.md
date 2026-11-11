# B4、B5 语音延迟实施记录（2026-11-11）

## B4 已完成

- `npm run desktop:prepare-asr` 准备 Amadeus 固定提交 `be9b97a` 的推理模块。本机常驻 Qwen worker 直接使用上游的单 token 静态解码，预捕获容量为 512 token 的图。继续用原有 FP16 和 256 输出 token 预算，按请求容量选择 Graph 或官方解码。语音时序记录实际引擎、回退原因、重放步数和分段耗时。[配置与复测命令](../../services/asr/README.md) · [上游推理源码](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/qwen_inference.py) · [上游静态解码](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/qwen_cuda_graph.py)
- RTX 4060 Laptop、PyTorch 2.10.0+cu130、Qwen3-ASR-0.6B 上使用 SDPA。三段合成音频分别预热后交替测 3 次，推理中位数为中文 1194 → 254 ms、英文 797 → 270 ms、日文 624 → 211 ms。9 对转写全部一致，Graph 请求均有实际重放。图额外分配约 64 MiB。本机报告在 `outputs/desktop-validation/b4-b5/qwen-asr-bench.json`。
- 用同一段中文 PCM、实际 Qwen worker 和 InputController 的模拟采样时钟，比较 350 ms 端点后的等待。单次对照为 1883 → 366 ms，转写一致。本机报告在 `outputs/desktop-validation/b4-b5/qwen-endpoint.json`。

## B5 已完成

- 语音候选可提前启动一条独立 dsh 对话请求。Work 规划按正式输入运行。输入修订、正式文本、角色和 Host 上下文匹配时，接纳原模型请求并放行缓冲的回复。续说、超时、取消或 Work 分支都会作废候选。确认之前候选事件不进入对话历史、TTS 或 Work 执行。[上游投机轮](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/speculative_turn.py) · [本地投机槽](../../packages/voice-core/src/speculative-chat.ts) · [Host 确认入口](../../apps/desktop/src/main.ts)
- 默认在 dsh 语音对话启用，候选最多保留 12 秒。删除 `chat-runtime.json` 的 `speculativeVoice` 即可关闭。已经发出的候选在作废前仍可能消耗一次 dsh 模型请求。[对话配置](../../config/voice/chat-runtime.json)
- 使用同一段模拟麦克风音频，两次 `npm run m3:smoke -- --real-model` 均通过，实际运行 Qwen、dsh 规划和对话及 GPU TTS v2。关闭和开启投机时，正式输入就绪到首文本为 2.20 → 1.55 秒，到首段 PCM 为 4.59 → 4.00 秒。开启时有 3 次候选启动、2 次作废、1 次确认，正式交付一次。两次试跑的采样边界相差一帧，模型回复长度有差异。报告在 `outputs/desktop-validation/m3/desktop-smoke-1794411904958.json`（关闭）和 `desktop-smoke-1794411803902.json`（开启）。
- `npm run desktop:test` 121 项通过。新增用例覆盖续说后的旧候选、Host 回执改变、等待原生受理回执期间撤销，以及最终只触发一次合成。

## 待实机验收

日常麦克风短句、长句和中途停顿下的体感延迟，以及真实播报与续说时的作废频率。当前数值来自本机录音回放与模拟采集。
