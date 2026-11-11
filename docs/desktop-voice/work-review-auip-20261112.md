# Work 验收与 AUIP 应用协作

2026-11-12 临时报告。对应任务清单 F、G，源码对照基准为 Amadeus `be9b97a`。[任务清单](./optimization-backlog.md#f-work-完成评估) · [上游基准](https://github.com/Code-Amadeus/Amadeus/commit/be9b97aef2ac3affb200998f8af3aab72aa22f6c)

## 实际完成

- **F** Work 保留 dsh 执行终态。Host 用提交时声明的交付文件、Attempt 产物记录、当前 SHA-256、验证失败和未解决的权限或输入评估完成度。AUIP 创作任务同时检查已登记的入口、manifest 与资源。完整性结论基于这些可观察的交付条件，任务的业务验收由用户确认。[上游完成评估](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_completion.py) · [本地交付核验](../../apps/host/src/work-delivery.ts)
- **验收入口** 工作任务面板支持声明交付文件、查看缺项、重新校验和确认验收。确认时再次校验当前文件，并核对 Attempt 仍是最新的一次。成功后写入任务 ID、Attempt ID、时间及证据摘要，重复提交返回同一回执。命令行入口为 `host:ctl -- recheck` 和 `host:ctl -- accept`，参数依次是任务 ID 与 Attempt ID。[Work 账本](../../packages/work-core/src/host.ts)
- **G1** 应用入口与同目录的 `auip.manifest.json` 及页面引用资源都要在 Work 中登记。Host 读取并固定这批校验过的字节，按上游 v0 启动片段和应用 WebSocket 接入。一次性票据绑定登记的 manifest。状态修订、声明事件、动作请求与回执都由会话核对。连接断开时使在途动作和租约失效。[上游会话文档](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/docs/auip_application_sessions.md) · [本地应用 Host](../../packages/app-core/src/app-host.ts)
- **G2** 当前状态的 choice、可用动作和网格前置条件参与动作核验。Host 拒绝过期修订或已失效的协作授权。`controller/v1` 的租约在应用接受动作后生效。接管切换到观察模式并发出撤销，收到应用状态后更新控制器显示。可由用户再次恢复协作。[上游运行时](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/auip_runtime.py) · [本地协议校验](../../packages/app-core/src/auip-contract.ts)

## 验证结果

- Luna Max 执行 `node scripts/desktop/auip-smoke.mjs`，构建及 4 项检查通过。探针从固定提交读取原版 2048、弹幕示例和 SDK 字节，用夹具 Provider 登记到临时 Work，再由真实 Electron 加载。观察到了 2048 注册、棋盘变更、动作回执和事件，以及弹幕策略租约生效、接管撤销和应用确认空闲。另验证了显式验收、旧修订拒绝与断线失效。交付版本通过同一探针。[Luna Max 报告](../../outputs/host-validation/deskai-auip-smoke-zDd3sx.json) · [交付验证报告](../../outputs/host-validation/deskai-auip-smoke-How7fw.json) · [探针](../../scripts/desktop/auip-smoke.mjs)
- 11 项相关回归通过。F 的三种交付场景分别落入缺少文件、验证失败和待验收。待验收文件被改动时确认失败，恢复原摘要后确认成功，重开 Host 后读到相同回执。AUIP 测试覆盖 manifest 绑定、票据重复使用、参数校验、旧修订及断线时在途动作失效。
- 复现探针需要带上述提交的 Amadeus Git 仓库。默认读取 `.cache/amadeus-source`，也可用 `DESKAI_AMADEUS_SOURCE` 指定。DeskAI 自带的待办示例展示了新任务可用的 AUIP 文件结构。[待办示例](../../packages/app-core/examples/todo.html)

## 实机与待确认

- 上游样例的运行已在 Electron 中验证，Work 验收由测试调用可信命令。任务面板上的手动点选、配置模型后新生成一个应用的完整过程留待交互验收。
- 本轮覆盖任务和应用协作。实体麦克风、耳机与外放双讲仍按语音验收记录确认。[语音稳定性实施记录](./voice-stability-20261111.md)
