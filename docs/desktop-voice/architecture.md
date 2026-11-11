# DeskAI2 架构

![DeskAI2 桌面、语音服务与独立 Host](./architecture.png)

[架构图源文件](./architecture.mmd)

## 进程与职责

- **Electron Renderer** 提供对话、工作与角色三页。Work 工作台按任务显示执行时间线，按 Attempt 查看模型指标、输入请求和交付。麦克风、输出参考、AEC、Silero VAD、插话确认及 PCM 播放在本地 AudioWorklet 和音频图中运行。Preload 暴露有限 IPC，主进程检查调用窗口与来源。[桌面入口](../../apps/desktop/src/main.ts) · [工作台](../../apps/desktop/renderer/src/workbench/Workbench.tsx) · [Preload](../../apps/desktop/src/preload.cts) · [采集](../../apps/desktop/renderer/public/worklets/voice-capture.js) · [播放器](../../apps/desktop/renderer/src/player.ts)
- **Electron Main** 装配会话和服务。TurnCoordinator 绑定采集会话与归档会话，管理规划生命周期、引用选择和取消。CharacterStore 保存角色版本，ConversationArchive 固定每个会话的角色快照和关系。SpeechOutput 按句调度合成、控制前视量，并把播放回执交给对话控制器。[会话协调](../../apps/desktop/src/turn-coordinator.ts) · [角色与会话存储](../../apps/desktop/src/character-store.ts) · [语音输出](../../apps/desktop/src/speech-output.ts)
- **语音核心与适配器** 将分段、端点、投机确认、文本投影、交付状态与模型调用分开。dsh 和 OpenAI-compatible 实现同一 Chat 端口。桌面拥有 SenseVoice/规划用的 dsh 进程、Qwen 子进程、知识检索子进程和 TTS 子进程。Qwen 与知识检索使用私有标准流，TTS 使用本机鉴权 WebSocket。[对话核心](../../packages/voice-core/src/dialogue.ts) · [Chat 端口](../../packages/voice-core/src/chat-contract.ts) · [识别路由](../../apps/desktop/src/speech-runtime.ts) · [TTS 适配器](../../packages/tts-adapter/src/index.ts)
- **独立 Node Host** 提供本机鉴权 API、状态订阅和命令行入口。Host 持有 Work 账本、dsh 执行运行时、工作区、产物和 AUIP 会话。关闭桌面时 Work 可继续运行，桌面和 CLI 重新连接读取同一状态目录。[Host 入口](../../apps/host/src/server.ts) · [本机 API](../../apps/host/src/api.ts) · [Work 账本](../../packages/work-core/src/host.ts) · [AUIP](../../packages/app-core/src/app-host.ts)

## 从输入到交付

1. 语音帧先按当前采集会话和输出代次进入分段。待机使用 SenseVoice 识别唤醒词，连续会话默认使用 Qwen3-ASR。短静音允许候选转写及候选回复，续说和插话让旧候选失效。
2. 正式输入使用当前归档会话。规划器读取 Host 本轮冻结的候选和能力。普通对话走 Chat。涉及任务或应用时，Host 校验候选、消歧并返回实际回执。切换角色或会话会撤销尚未受理的规划，已受理 Work 仍按操作 ID 可查。[对话引用](../../apps/host/src/conversation-control.ts)
3. Chat 使用角色快照、关系和已交付历史。启用知识检索时，按角色 ID 查询对应索引，将命中的片段和定位送入本轮。候选回复只在正式文本、角色和 Host 上下文匹配后放行。语音回复由 TTS v2 合成并回传 PCM，文字回复由界面确认显示。[对话投影](../../packages/voice-core/src/chat-context.ts) · [投机回复](../../packages/voice-core/src/speculative-chat.ts) · [知识检索](../../apps/desktop/src/character-knowledge.ts)
4. 输出以会话、代次、Attempt、句子和音色修订校验身份。打断时清掉旧 PCM，等待已取消的合成退出。语音历史只收录完整播放的句子，文字历史收录界面确认过的正文。[交付账本](../../packages/voice-core/src/delivery.ts)

## Work 的持久化与验收

1. 操作先进入 WorkHost 的受理入口。操作 ID 和指纹绑定 Work 与 Attempt，并在 Provider 调用前持久化。相同 ID 和请求取回原回执，请求内容冲突时拒绝。dsh 使用同一操作 ID 绑定原生提示请求。[操作协议](../../packages/work-core/src/operations.ts)
2. Git 项目从已提交 HEAD 创建任务分支与 worktree。继续和重试沿用任务工作区。非 Git 或无提交项目在 Host 内用目录写入锁。Attempt 保存执行前后快照，断线时通过原生快照和日志恢复。[工作区](../../packages/work-core/src/workspace.ts) · [dsh 恢复](../../packages/dsh-adapter/src/work-provider.ts)
3. Host 结合终态、预期文件、变更归属、当前摘要和待处理输入评估交付。用户确认前重新核验，保存验收回执。产物登记、预览和导出均绑定 Attempt。应用通过登记的 manifest 进入 AUIP 会话，状态修订、动作回执、协作租约和断线由 Host 核对。[交付核验](../../apps/host/src/work-delivery.ts) · [完成评估](../../packages/work-core/src/completion.ts) · [导出](../../packages/app-core/src/exports.ts)

## Work 轨迹

1. 桌面规划器读本轮 dsh 请求记录。Host 受理动作时，把用户原话、选中的目标和规划用量绑定到操作、Task 和 Attempt。待消歧的意图在用户选定目标后归入对应执行。[规划器](../../apps/desktop/src/work-planner.ts) · [受理与消歧](../../apps/host/src/conversation-control.ts)
2. Work Provider 用已受理的请求 ID 和原生轮次识别本次执行。工具调用、模型消息和用量由 dsh 会话日志提供。模型可见文本分批更新内存中的活动行，原生完成记录用同一行 ID 结算并写入 Work 账本。首 token 时间可从 dsh 的压缩流记录还原。模型请求的缓存分母使用已知的未缓存输入、缓存读取与缓存写入之和。[原生跟踪](../../packages/dsh-adapter/src/session-feed.ts) · [指标投影](../../packages/dsh-adapter/src/work-telemetry.ts) · [用量口径](../../packages/work-core/src/telemetry.ts)
3. Electron Main 使用本机鉴权 WebSocket `/work-events` 跟踪当前 Task，Preload 暴露订阅、分页和操作。Host 返回最近 160 行与 Attempt 累计统计，按游标续传最多 96 批增量。游标过期或 Host 重启时从持久化证据重建快照。向前分页由时间线上的行 ID 定位。[轨迹订阅](../../apps/host/src/work-trace.ts) · [Host 客户端](../../apps/host/src/client.ts)
4. Work 预设从锁定版 dsh Standard 生成，使用原生限时问答。工具在前台等待期间可从原生会话接手，进入 continued 后可在工作台提交结构化答复。原生答复进入新轮次时沿用同一 Attempt，后续执行仍归属该任务。权限通过原生会话处理。[Work 运行时](../../packages/dsh-adapter/src/work-runtime.ts) · [执行器](../../packages/dsh-adapter/src/work-provider.ts)

## 配置和所有权

`config/` 是源码配置入口。输入、Chat、TTS、Work 和角色语料分别有独立清单。桌面目录保存界面设置、角色与会话。Host 目录保存执行和交付。模型资源与派生索引由各自进程加载。运行、配置覆盖与数据位置见[运行说明](./operations.md)。
