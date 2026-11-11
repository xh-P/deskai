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

### B4｜Qwen3-ASR 推理提速｜已完成

上游在短静音时先转写，正式端点可复用有效结果，续说会作废旧结果。它的 Qwen 后端另有 FlashAttention、静态 CUDA Graph 解码和分段耗时记录。[上游端点与转写](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/manager.py) · [上游 Qwen 推理](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/qwen_inference.py) · [上游 CUDA Graph](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/qwen_cuda_graph.py)

DeskAI2 的常驻 worker 已接入上游 CUDA Graph，保留 160 ms 候选转写和续说重开。同一 RTX 4060 上三段中英日音频的 Graph 推理均提速，9 对转写一致。端点后的等待也用实际 worker 做了对照。[本地 Qwen worker](../../services/asr/qwen_worker.py) · [实施与验证](./voice-latency-20261111.md#b4-已完成)

### B5｜投机 Chat 的确认与作废｜已完成

上游在 Wake 来源且启用受支持的 Hybrid 后端时，可用候选转写启动 pending 轮。正式文本匹配后放行播报。文本不符、投机槽位超时或对话打断时作废。[上游投机轮](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/speculative_turn.py) · [上游 pending 入口](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/handlers/chat_handler.py)

DeskAI2 的 dsh 语音候选可提前请求并缓冲回复。正式输入与 Host 上下文匹配后复用，续说或 Work 分支作废候选。真实 dsh 与 GPU TTS 的模拟采集对照通过，开启时确认一轮并作废两轮。[本地对话控制](../../packages/voice-core/src/dialogue.ts) · [本地协调入口](../../apps/desktop/src/main.ts) · [实施与验证](./voice-latency-20261111.md#b5-已完成)

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

上游把已受理操作绑定到 Work、Attempt 与 Provider run，同一操作重放时投影原回执。DeskAI2 已能由模型委派 dsh 并报告结果。补齐受理、执行归属和回执的持久绑定，验证重复投递只产生一次执行。[上游 Work 受理](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_intake.py) · [上游操作执行](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_effect_executor.py) · [本地工作控制](../../apps/host/src/host.ts)

## C. 独立 Host

### C1/C2｜独立服务入口与桌面连接｜已完成

Node Host 独立持有 Work 账本、dsh 和产物服务。桌面与命令行通过同一套本机鉴权读取状态和发送命令。桌面可启动缺失的 Host，客户端退出后 Host 继续运行。已从命令行启动服务，退出并重开 Electron 后读到相同任务 ID。[上游 Host 入口](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/app.py) · [上游 Electron 启动](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/electron/src/main/index.ts) · [上游本地鉴权](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/local_auth.py) · [本地 Host API](../../apps/host/src/api.ts) · [实施记录](./host-work-20261112.md)

## D. 执行会话与恢复

### D1/D2｜Provider 会话绑定与事件恢复｜已完成

Attempt 在发出请求前持久绑定 dsh 会话、日志游标和请求 ID。断线与 Host 重启时用原生快照和历史页补齐事件，按请求归属确定终态。缺少执行证据时显示状态未知，允许重新连接原执行。真实 dsh 测试在强制退出后读回两条原生中断终态，再通过显式继续命令复用原会话执行成功。[上游会话附着](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/provider_session_binding.py) · [上游事件接收](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/provider_event_ingestion.py) · [上游账本恢复](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_ledger_coordinator.py) · [本地 dsh 适配](../../packages/dsh-adapter/src/work-provider.ts) · [实施记录](./host-work-20261112.md)

## E. 工作区与产物交付

### E1｜按 Work 准备隔离工作区｜已完成

Host 为每个 Git Work 绑定独立分支与 worktree，继续执行和重试沿用该工作区。非 Git 及尚无提交的目录走单写者入口。真实 dsh 并行任务分别写入各自的 worktree，续跑复用了目录和原会话，源工作区的已有修改保留。[上游工作区准备](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/workspace_provisioner.py) · [本地工作区准备](../../packages/work-core/src/workspace.ts) · [实施记录](./host-work-20261112.md)

### E2｜按 Attempt 收集 Diff 与交付文件｜已完成

按 Attempt 保存 Git 执行前后快照，可查看统一 Diff。登记结合本次增量、产物清单与文件摘要，打开和导出时再次校验文件。用户选择导出路径后，Host 保存执行归属、摘要、目的地与结果。已验证执行前的未提交文件未混入 Diff，过期产物版本被拒绝，导出内容与回执一致。[上游产物与基线](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_artifact_registry.py) · [上游 Diff 解析](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/unified_diff.py) · [上游导出服务](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_export_service.py) · [本地产物登记](../../packages/app-core/src/index.ts) · [实施记录](./host-work-20261112.md)

## F. Work 完成评估

### F1/F2｜执行结果、交付证据与人工验收｜已完成

Host 结合执行终态、预期文件、登记摘要、交付验证与待处理输入投影完成度。桌面和命令行可复查交付、确认当前 Attempt 并取得持久回执。已验证正常结束但文件缺失、未归属文件声明被拒绝、交付齐备进入待验收，以及改动文件后拒绝验收。[上游完成评估](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_completion.py) · [上游结果验证](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/outcome_verification.py) · [本地评估](../../packages/work-core/src/completion.ts) · [实施记录](./work-review-auip-20261112.md)

## G. AUIP 应用协作

### G1｜接通上游 AUIP v0 示例｜已完成

Host 校验已登记的入口、manifest 和引用资源，通过一次性票据建立受限的 `amadeus.auip/v0` 连接。固定提交的原版 2048 在 Electron 完成注册、上报棋盘、执行声明滑动、返回回执和语义事件，窗口关闭后会话断开。[上游协议校验](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/auip_contract.py) · [上游应用连接](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/auip_app_connection.py) · [上游 2048 示例](https://github.com/Code-Amadeus/Amadeus/tree/be9b97aef2ac3affb200998f8af3aab72aa22f6c/examples/auip-2048) · [本地应用 Host](../../packages/app-core/src/app-host.ts) · [实施记录](./work-review-auip-20261112.md)

### G2｜控制器租约与用户接管｜已完成

Host 校验当前修订、接管前后的授权版本、参数与应用动作前置条件。声明的控制器策略在应用回执被接受后启用限时租约，用户接管将应用切换到观察模式并发出撤销。已在原版弹幕样例观察到租约生效和接管后双方回到空闲，并验证过期修订和接管后的动作被拒绝。[上游运行时](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/auip_runtime.py) · [上游控制器示例](https://github.com/Code-Amadeus/Amadeus/tree/be9b97aef2ac3affb200998f8af3aab72aa22f6c/examples/auip-bullet-hell) · [本地控制器](../../packages/app-core/src/controller.ts) · [实施记录](./work-review-auip-20261112.md)

## 推进顺序

1. 从 I2 开始验证播放驱动的表现，再接 I1 和 H1。
2. A1、A2 继续补引用与回执。C 至 G 的实施与验证已记在对应条目。
3. H4 和 I3 分别按知识素材和角色场景的准备情况推进。

每轮更新对应条目，附实现提交和实际验证结果。物理设备验收记录在对应实施文档中。
