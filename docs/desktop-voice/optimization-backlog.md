# Amadeus 整合任务清单

2026-11-11 核对。上游以 Amadeus `main` 的 `be9b97a` 为基准，DeskAI2 以 `7cf4bbf` 为基准。下面的接入任务都对应可定位的上游实现。优先复用可直接接入的模块、协议和示例，DeskAI2 的适配与验证随条目记录。当前执行器接 dsh，语音输出用 GPT-SoVITS v2。[上游基准提交](https://github.com/Code-Amadeus/Amadeus/commit/be9b97aef2ac3affb200998f8af3aab72aa22f6c) · [当前项目方向](./current-direction.md)

## 旧条目核对

- **B1 已撤下。** 旧条目的错字样例与准确率评测是 DeskAI2 自拟工作。Amadeus 的对话识别有默认留空的 `ASR_CONTEXT`，会把领域术语提示传给 Qwen3-ASR，并过滤提示词回显。Wake 的识别调用传空 context。[识别配置](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/config/catalog/voice/conversation_asr.json) · [对话识别](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/manager.py) · [回显过滤](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/text_filter.py) · [唤醒识别](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/wake_service.py)
- **旧 H2、H3 的个人记忆移出清单。** 上游架构把个人记忆形成、存储和生命周期列在路线图中。现有可接入的是角色定义和角色知识检索。[架构说明](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/README.md#architecture) · [角色知识实现](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/core/character_rag.py)
- **旧 G3 收敛为断线后的 AppSession 状态处理。** 上游 v0 在连接丢失时标记断开并作废在途动作。旧条目中的自动重连与跨 Host 重启恢复已撤下。[AUIP 断线行为](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/docs/auip_application_sessions.md#disconnect-and-recovery-behavior) · [AppSession 运行时](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/auip_runtime.py)
- **旧 D3、E3、F3 收敛到实际入口。** dsh 原生界面接管是本地适配，接入时以 dsh 可观察的事件为准。上游 Work 有 Diff 查看与产物交付，以及针对仅有进度回报和 AUIP 验证失败的有限恢复。旧条目中的通用 Diff 采纳和通用失败自修复已撤下。[Work 产物交付](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/docs/work_artifact_delivery.md) · [Work 恢复分支](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_ledger_coordinator.py)

## B. 语音稳定性

### B2｜AEC 双讲与近端保护｜已完成

同步采集麦克风、AEC 残差和实际播放参考，加入回声判定与 WebRTC 原始麦克风回退。离线回放保住了被压低的弱首音。耳机和外放双讲仍待设备验收。实现提交为 `b95b109`。[上游回声判定](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/echo_guard.py) · [上游实时 AEC](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/tts/aec_realtime.py) · [实施记录](./voice-stability-20261111.md)

### B3｜持续对话与插话恢复｜已完成

确认插话后移交首音，按播放轮次清除旧音频，旧合成退出后接续下一轮。连续三次打断的模拟已通过。真实播报恢复和短应答仍待设备验收。实现提交为 `b95b109`。[上游插话检测](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/barge_in_detector.py) · [上游中断流程](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/interrupt_flow.py) · [实施记录](./voice-stability-20261111.md)

### B4｜Qwen3-ASR 推理提速｜待接入

上游在短静音时先转写，正式端点可复用有效结果，续说会作废旧结果。它的 Qwen 后端另有 FlashAttention、静态 CUDA Graph 解码和分段耗时记录。[上游端点与转写](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/manager.py) · [上游 Qwen 推理](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/qwen_inference.py) · [上游 CUDA Graph](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/qwen_cuda_graph.py)

DeskAI2 已有 160 ms 候选转写、续说重开和常驻 Qwen。本项复用现有端点，在本地 worker 接入上游可用的加速路径。用同一设备和音频比较识别耗时、端点后的等待与转写一致性。[现有端点](../../packages/voice-core/src/index.ts) · [现有 Qwen worker](../../services/asr/qwen_worker.py)

### B5｜投机 Chat 的确认与作废｜待适配

上游在 Wake 来源且启用受支持的 Hybrid 后端时，可用候选转写启动 pending 轮。正式文本匹配后放行播报。文本不符、投机槽位超时或对话打断时作废。[上游投机轮](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/speculative_turn.py) · [上游 pending 入口](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/handlers/chat_handler.py)

本地在确认后才提交模型轮次。先用 dsh 跑通可缓冲、可取消的单轮语音路径，再对照端点到首段 PCM 的耗时。验收覆盖续说后旧轮作废、正式轮只交付一次，以及待确认轮尚未播报或发出任务。[本地对话控制](../../packages/voice-core/src/dialogue.ts) · [本地协调入口](../../apps/desktop/src/main.ts)

## I. 角色呈现

### I2｜播报驱动字幕、口型与表情｜待接入

上游在播放过程中发布基于 PCM RMS 的嘴部开合值，并在句子开始时更新字幕和角色表现。DeskAI2 已有播放回执和桌宠状态，嘴部目前按定时器开合。先接实际渲染 PCM 的幅度和句子身份，让字幕与表情随播放推进，验收中断后上一轮字幕、口型和表情及时退出。[上游播放](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/tts/playback.py) · [上游字幕](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/tts/subtitle.py) · [上游角色表现](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/character_presentation.py) · [本地桌宠](../../apps/desktop/renderer/src/pet/PetApp.tsx)

### I1｜SpriteForge 角色包与动画状态｜待接入

上游角色包装载器校验 manifest、KTX2 片段和嘴部覆盖层，动画器按状态和意图切换片段。DeskAI2 当前使用 PNG 立绘。选一套可用资源验证载入、待机、说话和中断回到待机，再接 I2 的播放信号。[上游角色包](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/render/character_pack.py) · [上游动画器](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/render/spriteforge_animator.py) · [上游角色包格式示例](https://github.com/Code-Amadeus/Amadeus/tree/be9b97aef2ac3affb200998f8af3aab72aa22f6c/examples/character-pack-minimal)

### I3｜Windows 桌面场景挂载与恢复｜待接入

上游 Windows 端用 helper 管理 Lively 场景的挂载、停止与原壁纸恢复，壁纸页渲染角色与字幕。DeskAI2 已有独立桌宠窗口。角色场景跑通后再接入壁纸宿主，验证打开主窗口、退出、挂载失败时的场景和壁纸状态。[上游 Windows 挂载](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/electron/src/main/windowsWallpaper.ts) · [上游 helper](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/electron/resources/windows-wallpaper/helper.py) · [生命周期说明](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/docs/windows_wallpaper_lifecycle.md)

## H. 角色定义与知识

### H1｜可编辑角色定义与会话归属｜部分接入

上游校验、创建和更新角色定义，构建角色提示词，并用角色 ID 约束会话归属。DeskAI2 已有 JSON 角色卡、关系模式和 dsh 人格 preset。移植角色校验与会话归属行为，验证旧会话能识别其角色，切换角色后用对应设定回复。[上游角色存储](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/core/character_profiles.py) · [上游角色提示词](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/llm/character_prompts.py) · [上游会话处理](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/handlers/session_handler.py) · [本地 preset](../../packages/dsh-adapter/src/chat-patch.ts)

### H4｜角色知识 RAG｜待接入

上游可选地加载本地 FAISS 角色知识索引，用距离阈值选取片段注入对话。现有运行入口限定默认角色。DeskAI2 接入这一检索和注入路径时，先用一套现有角色知识验证命中、无命中和缺资源时的对话表现。[上游角色知识实现](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/core/character_rag.py) · [上游示例语料](https://github.com/Code-Amadeus/Amadeus/tree/be9b97aef2ac3affb200998f8af3aab72aa22f6c/examples/character-rag)

## A. 对话与 Work 控制

### A3｜对话可见的 Host 能力｜基础已交付

DeskAI2 已在 `d5c3ae2` 把 Host 能力和真实回执注入普通对话。已有验证覆盖能力询问与实际 dsh 委派。[本地实施记录](./host-architecture-20261110.md#角色误称只能对话修复2026-11-11)

### A1｜Host 提供候选并消歧｜部分接入

上游从 Host 状态生成带类型的引用候选，整轮控制解析 Work 意图，歧义时可生成可选项。DeskAI2 规划器已有最近意图和当前项目、任务、应用上下文。下一步让模型从 Host 候选选择明确 ID。验收同项目有多个任务时的「继续这个」和跨项目指代。[上游候选目录](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/reference_catalog.py) · [上游整轮控制](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/whole_turn_control.py) · [上游消歧](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/reference_clarification.py) · [本地规划器](../../apps/desktop/src/work-planner.ts)

### A2｜已受理 Work 的绑定与回执｜部分接入

上游把已受理操作绑定到 Work、Attempt 与 Provider run，同一操作重放时投影原回执。DeskAI2 已能由模型委派 dsh 并报告结果。补齐受理、执行归属和回执的持久绑定，验证重复投递只产生一次执行。[上游 Work 受理](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_intake.py) · [上游操作执行](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_effect_executor.py) · [本地工作控制](../../apps/desktop/src/desktop-host.ts)

## C. 独立 Host

### C1/C2｜独立服务入口与桌面连接｜部分接入

上游 `server.app` 可独立运行，Electron 管理后端进程并通过本机 WebSocket 连接，Host 执行本地鉴权。DeskAI2 已有随桌面运行的 Host 和认证 HTTP API。将现有工作控制和存储交给独立服务，桌面与无界面客户端通过认证连接同一 Host。验收从命令行启动 Host 后提交任务，退出并重连桌面客户端时仍可查看该任务。[上游 Host 入口](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/app.py) · [上游 Electron 启动](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/electron/src/main/index.ts) · [上游本地鉴权](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/local_auth.py) · [本地 Host API](../../apps/desktop/src/host-api.ts)

## D. 执行会话与恢复

### D1/D2｜Provider 会话绑定与事件恢复｜部分接入

上游按前序 Attempt 和 Provider 能力解析会话附着，用执行身份归属事件并恢复尚未投影的终态。DeskAI2 已保存 dsh 会话 ID 并订阅事件，Host 重启时活动记录先标记中断。将持久 Attempt 与实际 dsh 会话快照、事件和终态对齐，验证断线重连和重启后能够识别可续接与结果未知的任务。[上游会话附着](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/provider_session_binding.py) · [上游事件接收](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/provider_event_ingestion.py) · [上游账本恢复](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_ledger_coordinator.py) · [本地 dsh 适配](../../packages/dsh-adapter/src/work-provider.ts)

## E. 工作区与产物交付

### E1｜按 Work 准备隔离工作区｜待接入

上游为 Git 项目准备并复用任务分支与 worktree，并保留非 Git 的工作区入口。DeskAI2 当前把项目目录交给 dsh。移植 Work 与工作区绑定，在两个任务并行修改时验证执行目录、归属和继续执行的工作区。[上游工作区准备](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/workspace_provisioner.py) · [本地 Work 账本](../../packages/work-core/src/host.ts)

### E2｜按 Attempt 收集 Diff 与交付文件｜部分接入

上游按 Git 基线收集变更，登记归属本次 Attempt 的文件，支持查看统一 Diff、预览文件和经批准的产物导出。DeskAI2 已按执行清单登记、校验和预览产物。补上基线与差异展示，并接入基于已校验产物的导出回执。验收执行前的改动与本次产物能正确归属，批准的导出可追溯。[上游产物与基线](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_artifact_registry.py) · [上游 Diff 解析](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/unified_diff.py) · [上游导出服务](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_export_service.py) · [本地产物登记](../../packages/app-core/src/index.ts)

## F. Work 完成评估

### F1/F2｜执行结果、交付证据与人工验收｜待接入

上游用执行终态、登记产物、验证结果和待处理输入等证据得出完成度与待审状态，并保留用户确认入口。DeskAI2 目前把 dsh 终态写入任务状态，产物校验独立进行。接入评估后，用执行成功但缺少产物、验证失败、交付齐备三个场景检查显示和回执。[上游完成评估](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_completion.py) · [上游结果验证](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/outcome_verification.py) · [本地 Work 账本](../../packages/work-core/src/host.ts)

## G. AUIP 应用协作

### G1｜接通上游 AUIP v0 示例｜部分接入

上游验证产物绑定、一次性票据、manifest、状态修订和动作回执。DeskAI2 已有精简应用协议。按固定提交的协议接通一份上游示例，验证注册、状态上报、声明动作、回执和断线失效。[上游协议校验](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/auip_contract.py) · [上游应用连接](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/auip_app_connection.py) · [上游 2048 示例](https://github.com/Code-Amadeus/Amadeus/tree/be9b97aef2ac3affb200998f8af3aab72aa22f6c/examples/auip-2048) · [本地应用 Host](../../packages/app-core/src/index.ts)

### G2｜控制器租约与用户接管｜待接入

上游 AppSession 校验动作前置条件，并为声明 `controller/v1` 的应用维护租约与用户接管状态。DeskAI2 已按声明动作校验请求。接通 G1 后用带控制器的样例验证动作取得租约、用户接管撤销租约，以及过期修订上的请求被拒绝。[上游运行时](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/auip_runtime.py) · [上游控制器示例](https://github.com/Code-Amadeus/Amadeus/tree/be9b97aef2ac3affb200998f8af3aab72aa22f6c/examples/auip-bullet-hell)

## 推进顺序

1. 从 B4 和 I2 开始验证用户能感知的延迟与表现，再接 I1 和 H1。
2. 先补 A1、A2 的引用与回执，再推进 C1/C2 和 D1/D2。E1、E2 提供工作区与交付事实，F1/F2 用这些证据更新任务完成度。
3. G1 跑通上游样例后再做 G2。B5、H4、I3 分别按对话适配、知识素材和角色场景的准备情况推进。

每轮更新对应条目，附实现提交和实际验证结果。物理设备验收记录在对应实施文档中。
