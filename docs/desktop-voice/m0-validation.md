# M0 验证状态

更新：2026-10-28。M0 部分通过，尚未达到完整门禁；M1 在已经实测的本地语音接口上实现，不把缺失的真实模型验证补成“已通过”。

## 已有证据

- Gateway：独立 `deskai2-voice-m0` profile 的 Web 认证、Mux、session create/prompt 接受回执和重连 snapshot 已有脱敏 [会话探针](../../outputs/desktop-validation/m0/dsh-session-probe.json)。该记录的模型 attempt 为 `MISSING_CREDENTIAL`，正常模型正文流未验证。工具表探针的早期断言未正确完成；虽专用 overlay 已禁用全局 `cd` 和额外标题 LLM，零工具表仍须重做可靠的实际断言。
- ASR：`speech/catalog/follow/prepare/transcribe`、缓存唤醒时 `cancelPreparation` 与恢复已通过。中/英/日合成语音文件均返回非空文字；接口没有 confidence。热缓存准备/唤醒约1.312秒，中文热转写 Remote wall 172ms，详见 [原始报告](../../outputs/desktop-validation/m0/dsh-speech-probe.json) 和 [接口说明](./m0-speech-vad-notes.md)。这些数值不等于真实麦克风的识别延迟或人工语义准确度。
- TTS：使用已有常态有希 v2 GPT/SoVITS、`01_平静` 日语参考，显式 v2、FP16、CUDA Graph、batch1、cut0、fragment_interval0。认证 loopback WebSocket 的控制JSON/二进制PCM、取消握手、取消后恢复与退出通过，[报告](../../outputs/desktop-validation/m0/tts/report.json)。只允许白名单 voiceId，控制 token 由父进程在环境变量中传入，不写报告。
- 本次 v2 模型加载38.031秒，第一条短句首 PCM5.927秒、32kHz 非静音音频1.32秒；这是冷请求，不是热启动性能，更不是端到端响应。取消接受0.65ms，但 GPU 合成结束约5.057秒；不能将前一个数值宣称“停止计算延迟”。没有重新训练，未做主观听校。
- Electron/Silero：本地资源与 AudioWorklet 已在 M1 模拟回放中验证；实际设备部分未完成。

## 接口差异与适配

实现前已核对本地 `0.2.1-rc.2`，差异与处理写在 [架构](./architecture.md)：语音包安装后默认未挂载 Remote（404），专用 overlay 需显式加载；Electron45 stable 的运行时指纹不被 dsh 原生扩展接受，Host 改为已有独立 Node24.16 进程；默认 MicVAD 封装积累整句音频，M1 改用有界逐帧适配。不改 node_modules，不升级 dsh/Torch/CUDA。

TTS 固定为带随机 token 的 `127.0.0.1` WebSocket，PCM帧为 `uint32le头长 + JSON头 + PCM16LE`。任务带 session/turn/generation/voiceRevision/segment/chunkSeq，独立控制协程在推理线程工作期间接收 cancel；当前 worker 只加载默认声音，十角色换声属于 M3。

## 未完成门禁

真实模型 SPEAK/WAIT/SILENT 稳定性、reasoning/text 区分、生成前/中/后取消历史样本、durable/live 重放去重与 deliveryState/上下文投影语义均未通过。此前 `MISSING_CREDENTIAL` 不能用模拟供应商结果替代；需在现有 dsh 设置中配置模型后继续，不在聊天传密钥。非零 idle 回收未测；物理麦克风、耳机、扬声器和 AEC 都未验收。

复现命令：`npm run m0:speech`；TTS 使用 `.\.conda\gsv-v5\python.exe scripts/m0/tts_probe.py`，独占GPU执行。原始素材和模型目录未改动。
