# Amadeus 与 DeskAI2 核心技术方案对照

> DeskAI2 描述是迁移前比较基准；已完成迁移见[上轮历史记录](./amadeus-migration-temporary.md)，后续变化与未完成项见[本轮记录](./iteration-20261104.md)。

**对照基准：**Amadeus `f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e`；DeskAI2 当前工作区源码（2026-11-04）。两者都是 ASR → LLM → TTS 级联，实时策略和桌面表现不同。

> **范围：**前六项比较语音链路与角色呈现；后文补充此前未登记的 Agent、权限、任务恢复、桌面集成和运行配置差异。本文覆盖主要技术边界，不是逐文件盘点。DeskAI2 接入 dsh 的部分能力，不代表桌面应用已经具备 dsh 全部能力，更不等于 Amadeus 的 Host 控制面。总体架构可见 [Amadeus README](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md)。

1. **麦克风监听与唤醒**
   - **DeskAI2：**用户点击开始语音会话后申请麦克风并连续监听，不使用唤醒词；见 [App.tsx](../../apps/desktop/renderer/src/App.tsx#L290)。
   - **Amadeus：**Wake 与 Conversation ASR 分开。Windows + NVIDIA 推荐的 T4 本地配置包含唤醒词能力；T1/T2 等安装档不一定启用本地唤醒。见 [README_ZH.md](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md)。

2. **ASR 与断句时机**
   - **DeskAI2：**dsh SenseVoiceSmall 整段识别。约 600 ms 静音启动候选识别，默认约 1000 ms 后允许提交；明显未完句可等到约 1200 ms。确认前续说会恢复完整 PCM 并重新识别。见 [main.ts](../../apps/desktop/src/main.ts#L81)、[input-endpoint.ts](../../packages/voice-core/src/input-endpoint.ts#L9) 和 [speech.ts](../../packages/dsh-adapter/src/speech.ts)。
   - **Amadeus：**Wake 与对话识别分开，对话默认 Qwen3-ASR；约 160 ms 静音先投机启动转写，VAD／能量端点约 350／450 ms 确认。恢复说话会作废投机结果；若端点确认且投机仍有效，则复用结果。见[两段式端点说明](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/docs/asr_speculative_endpointing.md)。
   - **口径：**160 ms 是 ASR 投机触发点，不是最终端点或端到端响应时间；这些数字单独不能说明哪边更快。

3. **AEC、插话与打断**
   - **DeskAI2：**请求 Chromium 回声消除与降噪；Silero VAD 形成插话候选，再由轮次状态机决定暂停、确认或恢复。见 [App.tsx](../../apps/desktop/renderer/src/App.tsx#L304) 和 [voice-core](../../packages/voice-core/src/index.ts)。
   - **Amadeus：**提供 WebRTC AEC 路径，把 TTS PCM 送入 reverse reference；播放期间结合 AEC residual 与 Silero VAD 检查近端说话，再取消 Chat、TTS 和播放并把麦克风缓冲交给 ASR。AEC 模块需按配置启用。见[插话检测器](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/asr/barge_in_detector.py)和[实时 AEC](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/tts/aec_realtime.py)。
   - **验收边界：**两边的代码路径都不能代替目标设备上的麦克风、扬声器和回声测试。

4. **LLM 与回应策略**
   - **DeskAI2：**复用 dsh Session；一次模型请求输出 `SPEAK / WAIT / SILENT` 决策，并在需要时给出回答正文。见 [prompts.ts](../../packages/voice-core/src/prompts.ts) 和 [dialogue.ts](../../packages/voice-core/src/dialogue.ts)。
   - **Amadeus：**Main Chat 默认远程 DeepSeek，也可配置本地模型；Work 任务走独立 Provider。当前主线普通 Chat 没有与上述三态协议等价的逐轮控制头；投机 LLM 只在特定路由和过滤条件下使用。见 [README_ZH.md](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md)。

5. **TTS、分块与播放**
   - **DeskAI2：**已有 GPT-SoVITS v2 与多个角色音色，默认有希；文本按短句合成。PCM 传输可以分块，但当前推理参数 `streaming_mode=False`，不是句内低延迟生成。见 [speech-output.ts](../../apps/desktop/src/speech-output.ts) 和 [worker.py](../../services/tts/worker.py#L144)。
   - **Amadeus：**T4 本地栈默认 GPT-SoVITS v3，可选实验性 v2Pro；TTS job 可逐块产出并播放 PCM。这里的“流式”指合成音频分块，不是 LLM 每输出一个 token 就立即变成音频。见 [README_ZH.md](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md) 和 [GPT-SoVITS 后端](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/tts/backends/gpt_sovits.py)。

6. **人格配置、音色与角色渲染**
   - **DeskAI2：**人格、声音和语言可分别配置；桌宠以固定位置的立绘为主，嘴部动画跟随播放状态并按定时器开合，未直接按 PCM 振幅或口型时间线驱动。见 [PetApp.tsx](../../apps/desktop/renderer/src/pet/PetApp.tsx#L140)。
   - **Amadeus：**SpriteForge、KTX2 与 PixiJS 运行时把字幕、口型、表情和播放进度结合，角色包可选。长期记忆状态另见第 11 项。

## 补充：桌面 Agent 与系统架构

7. **Host 与进程分工**
   - **DeskAI2：**Electron 主进程负责桌面会话、音频轮次和 ASR/LLM/TTS 调度；dsh 作为独立本地 Web profile，提供认证后的语音 Remote 与 Session RPC；GPT-SoVITS 由另一个本地 Python worker 提供。见 [dsh 适配器](../../packages/dsh-adapter/src/speech.ts)、[会话适配器](../../packages/dsh-adapter/src/session.ts) 和 [桌面主进程](../../apps/desktop/src/main.ts)。
   - **Amadeus：**Electron 前端连接本地 Python 服务；服务端 Host 负责统一身份、任务状态、权限、持久化和恢复，Chat、Provider、Work、ASR/TTS、渲染各有独立模块。见 [仓库结构与系统概览](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#仓库地图) 和 [系统架构](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#系统架构)。
   - **边界：**dsh 给 DeskAI2 提供了 ASR、模型会话和认证等底层能力；当前桌面应用只接入其中一部分。它不自动带来 Amadeus 的任务控制面、权限域和恢复机制。

8. **主对话、模型路由与任务 Provider**
   - **DeskAI2：**语音对话通过 dsh Session 使用当前配置的聊天模型；SenseVoice 通过 dsh Speech Provider 调用，TTS 则走独立 GPT-SoVITS worker。桌面应用当前没有与语音聊天并列的 Work Provider 任务执行面；“接入 dsh”不等同于已经实现一套独立的任务 Agent 层。见 [dsh 会话适配](../../packages/dsh-adapter/src/session.ts) 和 [语音适配](../../packages/dsh-adapter/src/speech.ts)。
   - **Amadeus：**Main Chat 与 Work 执行分开路由：主对话可以使用远程或本地模型；日常任务默认交给 Pi，复杂开发可交给 Codex，另有 Browser 和可选 OpenClaw。MCP/Skills 即使由 Host 统一登记，也不会直接开放给 Main Chat。见 [Amadeus README](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#当前核心能力) 和 [Pi Provider 设计](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/docs/pi-rpc-provider.md)。
   - **影响：**这是从“桌面语音角色”扩展到“能委派并执行桌面工作”的关键差异；对单轮语音的识别速度和合成音质没有直接提升。

9. **长任务状态与中断后恢复**
   - **DeskAI2：**有语音轮次取消、会话历史投影、应用偏好设置和桌宠位置等状态，但没有 Amadeus 式的 Project / Draft / WorkItem / Attempt 任务账本，也没有对应的后台任务重启恢复、继续/重试和产物登记流程。会话或配置的持久化不等于长任务可恢复。
   - **Amadeus：**Host 持有 Work 身份和持久状态；任务以 WorkItem/Attempt 跟踪，可查看进展、继续或重试，重启后恢复任务及其报告、Artifact 和 Diff。模型的口头汇报不能替代 Host 的完成状态与验证证据。见 [Amadeus README](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#当前核心能力) 和 [架构说明](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#系统架构)。
   - **影响：**主要影响长时间桌面任务的可观察性、失败恢复和结果交付，不是语音响应时延。

10. **权限边界与应用协作（AUIP）**
   - **DeskAI2：**有 Electron Renderer/Main 的 IPC 信任边界和受限语音服务接口；当前桌面语音应用没有 Work Provider 的逐项执行审批，也没有让 Agent 继续操作外部应用的 AUIP AppSession 协议。见 [主进程 IPC 校验](../../apps/desktop/src/main.ts)。
   - **Amadeus：**Main Chat、Work Provider 和 AUIP 应用属于不同权限域；Host 校验 Artifact、身份、能力和权限。AUIP 通过短期 ticket、应用声明的状态/事件/动作及有界 AppSession，让角色与 Work 生成的应用协作，但不会顺带获得任意文件或 Work 权限。见 [AUIP 应用会话协议](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/docs/auip_application_sessions.md) 和 [系统架构](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#系统架构)。
   - **影响：**当目标只是语音陪伴时可以暂缓；若要让角色安全地操作应用或承接长任务，就需要这类权限与交互机制。

11. **人格上下文、知识检索与长期记忆**
   - **DeskAI2：**角色卡生成人格 preset；每轮把已接纳的用户输入、已交付的助手正文和交付状态投影到新建的 dsh Session。它提供短期对话上下文，不是长期事实的自动提取、存储与检索。见 [人格 preset](../../packages/dsh-adapter/src/chat-patch.ts) 和 [上下文投影](../../packages/dsh-adapter/src/session.ts#L80)。
   - **Amadeus：**主线有角色定义/提示词组合和可选的角色知识 RAG；Memory & Persona Runtime 仍是规划扩展，个人记忆的形成、存储、更新和生命周期未完成设计；[PR #146](https://github.com/Code-Amadeus/Amadeus/pull/146) 仍未合入。因此要把“角色设定/知识检索”与“长期个人记忆”分开比较。见 [角色 RAG 说明](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/docs/character_rag.md) 和 [系统架构](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#系统架构)。

12. **桌面宿主与外部应用集成**
   - **DeskAI2：**常规 Electron 窗口、托盘和独立置顶透明桌宠窗口；没有把桌面场景托管到壁纸宿主的当前路径。见 [Pet 窗口管理](../../apps/desktop/src/pet-window.ts) 和 [桌面主进程](../../apps/desktop/src/main.ts)。
   - **Amadeus：**除普通窗口外，可由 Lively Wallpaper / Wallpaper Engine 承载桌面场景；另有 VN Player 等专门的外部应用接入。VN Player 集成与通用 AUIP AppSession 是不同路径。角色动画、字幕、口型和情绪与播放时间线的差异见第 6 项。见 [README：壁纸宿主](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#壁纸模式推荐-lively-wallpaper) 和 [VN Player](https://github.com/Code-Amadeus/Amadeus/tree/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/vn_player)。
   - **影响：**如果暂时不做安装和 Agent 工作，角色渲染和桌面宿主体验是系统层最直接关联到你当前目标的部分。

13. **运行配置、安装梯级与外部资产**
   - **DeskAI2：**仓库提供 Electron 桌面开发、构建和打包脚本；运行时组合为 Node/Electron、独立 dsh Web profile 与本地 Python TTS 环境。当前使用既有资源目录和服务发现，没有 Amadeus 那种按能力定义的 T1–T4 安装梯级。见[根 package.json](../../package.json) 和 [dsh 适配器](../../packages/dsh-adapter/src/speech.ts)。
   - **Amadeus：**用 T1–T4 将文字、远程语音、VAD 和本地 ASR/TTS 能力拆成递进的可选依赖；角色、视觉运行时和模型权重可作为独立外部资产包校验、安装。缺少角色包仍可运行 Chat/Work。见 [安装梯级说明](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/TIER_TAXONOMY.md) 和 [Amadeus README](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#外部模型与运行资产)。
   - **影响：**主要影响部署门槛、不同硬件的能力组合和资源管理；若目前不考虑安装发行，可以先登记为后续工程差异。

14. **进度与诊断证据**
   - **DeskAI2：**桌面端记录 ASR、TTS、播放及打断的有界时序诊断；该时间线主要服务于本机语音链路分析，不是跨重启的 Work 活动账本。见 [语音诊断](../../packages/voice-core/src/diagnostics.ts) 和 [桌面主进程](../../apps/desktop/src/main.ts)。
   - **Amadeus：**Host/Work 界面呈现 Provider 活动、权限请求、Artifact、Diff、任务状态和终态报告，目标是让长任务过程可检查、可接管；这与语音链路的时序埋点解决的问题不同。见 [Amadeus README](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/README_ZH.md#当前核心能力)。

**总体差异：**两者同为 ASR → LLM → TTS 级联，但不只是 ASR/TTS 模型不同。语音体验差异集中在端点、AEC/打断、TTS 首包和音画同步；系统架构差异集中在 Amadeus 的独立 Work Provider、Host 权限与持久恢复、AUIP 应用协作、桌面壁纸宿主和分层运行配置。DeskAI2 基于 dsh 的 ASR/会话能力，不意味着这些 Agent 能力已经存在；如果当前只追求语音和角色效果，优先研究前一组语音/渲染技术即可，长期记忆和 Agent 执行则按实际需求评估。端点参数不等同于响应延迟，真实效果仍应按整条链路与实际设备比较。
