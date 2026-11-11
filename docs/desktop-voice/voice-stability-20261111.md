# 语音稳定性实施记录（2026-11-11）

## 已完成

- 统一采集 Worklet 在同一个 48 kHz AudioContext 中取得麦克风和播放器音量后的 PCM，按 16 kHz、512 样本送入 Silero。WebRTC 档按 WASM 报告的处理延时对齐原始麦克风、残差和参考。默认档为 `browser-ns`，其麦克风信号由 Chromium 处理。[采集 Worklet](../../apps/desktop/renderer/public/worklets/voice-capture.js)
- 播报期间优先用残差判断近端。WebRTC 残差过低、原始麦克风有足够能量时，对原始信号运行 VAD。回声判定参考 Amadeus 的 Hann 窗和八频段对数功率，并用归一化波形相关定位参考延时。实录里，同一角色的独立片段也能得到较高的频段相似度，因此本地回声判定要求波形与频段证据同时成立。[本地回声判定](../../apps/desktop/renderer/src/echo-guard.ts) · [Amadeus echo_guard.py](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/asr/echo_guard.py)
- 使用实际播放参考触发 350 ms 起播保护。常态候选窗口为 96 ms，窗口内累计至少 64 ms 达到门槛。确认前播放器继续播报，确认时把首音和最多 160 ms 的前导帧交给识别。原始前导帧也经过回声筛选。参数集中在语音输入配置。[本地插话判定](../../apps/desktop/renderer/src/barge-in.ts) · [输入配置](../../config/voice/input-runtime.json) · [Amadeus barge_in_detector.py](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/asr/barge_in_detector.py)
- 播放器从实际渲染起点标记轮次。主进程按轮次确认取消，清理旧 PCM，等待已发出取消信号的 v2 合成请求退出后启动下一轮。插话后的识别期间暂缓 Host 语音通知。暂停麦克风时作废旧采集回调。[播放器](../../apps/desktop/renderer/src/player.ts) · [主进程](../../apps/desktop/src/main.ts) · [语音输出](../../apps/desktop/src/speech-output.ts)

## 验证结果

- Luna Max 的 38 项基础检查通过。最终复查连同既有语音输出共 51 项通过，覆盖自播回声、短促单帧候选、近端弱首音移交，以及连续三次取消后新一代 PCM 等待旧请求退出。
- `npm run desktop:smoke` 通过。Electron 模拟麦克风完成两次启动与转写，主进程收到 204 帧与模拟播放重叠的输入。合成首音波形对照相关度为 0.918460，首音前保留约 0.676 秒。本机报告位于 `outputs/desktop-validation/m1/audio-smoke-1794401646641.json`。
- 离线复用专项记录的 `.cache/aec-mic.f32` 和 `.cache/aec-ref.f32`，参考从 1.5 秒开始送入同一 Worklet 和 WASM，再运行实际 Silero。麦克风第 3–4 秒原始 RMS 为 0.12026，AEC 残差为 0.000294。判定器在采样位置 3.136 秒的原始帧标记一次确认，交给端点的样本位置连续。以绝对幅值 0.01 为测量门槛，原始麦克风和移交 PCM 的首音都在 3.0257 秒，移交保留了该原始帧。[既有录音来源](./aec-study-20261104.md#独立声源的离线复现)

## 待物理设备验收

- 在默认 `browser-ns` 和可选 `webrtc` 档分别用耳机、内置扬声器和常用外放设备检查纯播报、近端双讲、弱首字和短应答。重点记录误打断和漏打断。参考窗口与相关阈值以这轮配置作为起点。
- 播放长回复时连续插话三次，逐轮确认旧音频及时停止、首字完整、下一轮可听见。加测换音色和暂停后重开麦克风。诊断中的 `interruption-confirmed`、`output-cleared` 和下一代 `playback-enqueued` 可用于定位。
- 本轮按声学确认立即取消，达到门槛的短应声也可能触发取消。短应声灵敏度、不同设备的尾回声和真实 v2 取消后播报恢复仍待实机确认。
