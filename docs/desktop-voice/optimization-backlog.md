# Amadeus 整合任务清单

上游核对基准为 Amadeus `be9b97a`。已完成表示 DeskAI2 有当前运行入口和相应验证。设备验收见[验证记录](./verification.md)。[上游基准提交](https://github.com/Code-Amadeus/Amadeus/commit/be9b97aef2ac3affb200998f8af3aab72aa22f6c)

## A. 对话与 Work 控制

- **A1 已完成**。Host 为整轮冻结项目、任务、应用和待答问题，校验身份及版本。歧义交给用户选择，按原话执行。[上游候选目录](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/reference_catalog.py) · [本地协调](../../apps/host/src/conversation-control.ts)
- **A2 已完成**。Work 受理与 Provider 请求共用操作 ID，持久化 Task 和 Attempt 绑定并提供可重放回执。[上游受理](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_intake.py) · [本地账本](../../packages/work-core/src/host.ts)
- **A3 已完成**。Chat 读取 Host 的可用能力、当前对象与本轮事实回执。[本地对话上下文](../../apps/host/src/context.ts)

## B. 语音稳定性

- **B2 已完成**。同步麦克风、AEC 残差和输出参考。结合波形与频带判断回声，WebRTC 档在低残差时可用原始近端信号识别弱首音。[上游 Echo Guard](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/echo_guard.py) · [本地回声判定](../../apps/desktop/renderer/src/echo-guard.ts)
- **B3 已完成**。确认插话后移交首音，清除旧播放代次，并在取消的合成退出后接续下一轮。[上游插话检测](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/barge_in_detector.py) · [本地语音输出](../../apps/desktop/src/speech-output.ts)
- **B4 已完成**。Qwen3-ASR 常驻 worker 使用固定上游提交的 CUDA Graph 解码，记录实际引擎和推理耗时。端点复用候选转写并在续说时作废。[上游静态解码](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/qwen_cuda_graph.py) · [本地 Qwen worker](../../services/asr/qwen_worker.py)
- **B5 已完成**。提前缓冲语音候选回复，正式输入和上下文匹配时放行，续说、打断、超时及 Work 意图使候选作废。[上游投机轮](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/speculative_turn.py) · [本地投机控制](../../packages/voice-core/src/speculative-chat.ts)

B1 已撤下。识别错字样例和准确率评测曾由 DeskAI2 自拟。上游实际提供可选的 ASR_CONTEXT 与提示回显过滤。错字专项暂缓。[上游识别配置](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/config/catalog/voice/conversation_asr.json) · [回显过滤](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/asr/text_filter.py)

## C. 独立 Host

- **C1、C2 已完成**。Node Host 单独运行，桌面与 CLI 共享本机鉴权 API 和状态订阅。[上游本机鉴权](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/local_auth.py) · [本地 Host API](../../apps/host/src/api.ts)

## D. 执行会话与恢复

- **D1、D2 已完成**。原生会话、请求 ID 和游标先持久化。断线或重启时按 dsh 快照和历史恢复原执行，保留无法确认的状态。[上游会话绑定](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/provider_session_binding.py) · [本地 dsh 执行适配](../../packages/dsh-adapter/src/work-provider.ts)

## E. 工作区与产物

- **E1 已完成**。Git Work 有独立工作区和分支，继续与重试沿用。非 Git 项目使用单写者锁。[上游工作区](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/workspace_provisioner.py) · [本地工作区](../../packages/work-core/src/workspace.ts)
- **E2 已完成**。Attempt 有 Diff 与产物归属。预览和导出校验登记摘要并保留回执。[上游产物登记](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_artifact_registry.py) · [本地导出](../../packages/app-core/src/exports.ts)

## F. Work 交付验收

- **F1、F2 已完成**。Host 依据终态、预期文件、交付证据和待处理事项评估。用户复查并确认当前 Attempt 后保存回执。[上游完成评估](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_completion.py) · [本地评估](../../packages/work-core/src/completion.ts)

## G. AUIP 应用协作

- **G1、G2 已完成**。接通上游 AUIP v0 示例、状态与动作回执、控制器租约和用户接管。断开会话时作废在途动作和租约。[上游 AUIP](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/docs/auip_application_sessions.md) · [本地应用 Host](../../packages/app-core/src/app-host.ts)

## H. 角色与知识

- **H1 框架已完成**。可创建和编辑角色版本，归档会话固定角色快照和关系，重开后继续已交付历史。[上游角色存储](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/core/character_profiles.py) · [本地角色存储](../../apps/desktop/src/character-store.ts)
- **H4 框架已完成**。已核对的三条《消失》资料可随本轮检索，按角色与命中阈值带入 Chat。真实模型的开关对照见[验证记录](./verification.md#h1-与-h4-真实对话)。[上游角色知识](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/core/character_rag.py) · [本地语料](../../config/character-knowledge/nagato-mainline-post-disappearance.json)

## I. 角色呈现

- **I1 待实施**。验证 Cubism Web 渲染，选择可用模型并核对授权与参数。
- **I2 待实施**。接入主播式 Live2D 桌宠、角色预览、自然动作与实际播报嘴型。
- **I3 待实施**。用目标模型检查桌宠交互、连续插话和同机性能。壁纸搁置。

[Live2D 设计与验收](./live2d-workbench-plan.md#i-live2d-角色)

## J. 实时 Work 工作台

- **J1 待实施**。用真实 dsh 会话核对 Trajectory、请求档位、缓存用量和可用的成员交流事件。
- **J2 待实施**。以 Host 受理回执和 dsh 原生会话接通调度交流、逐任务增量和指标。
- **J3 待实施**。重做任务导航、执行时间线与详情，支持查看、接手和验收任务。
- **J4 待实施**。验证并行任务、断线恢复、统计归属和 Live2D 同机运行。

[工作台设计与验收](./live2d-workbench-plan.md#j-实时-work-工作台)
