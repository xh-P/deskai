# 对话引用与 Work 回执

2026-11-12 完成任务 A1、A2、A3。[实现提交 24e2842](https://github.com/xh-P/deskai/commit/24e2842c55384268ed09ace43edd21cd0a1f0708) · [Amadeus 整合任务清单](./optimization-backlog.md#a-对话与-work-控制)

## 实际完成

- **A1** Host 为每轮冻结项目、Work、应用会话和待回答问题的带类型候选，并记录任务所属项目、最新 Attempt 和应用状态版本。规划器提交目录中的引用，Host 校验后受理。存在歧义时，桌面显示带所属项目的选择卡，用户可点击或用文字和语音选择。确认后使用原话和所选对象执行。待选卡有效期为五分钟。DeskAI2 每轮处理一个控制意图。[本地候选目录](../../apps/host/src/reference-catalog.ts) · [本地整轮控制](../../apps/host/src/conversation-control.ts) · [上游候选目录](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/reference_catalog.py) · [上游消歧](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/reference_clarification.py)
- **A2** Work 受理时持久化操作 ID、任务和执行绑定，先保存再启动执行或发原生请求。本地 run 用 Attempt ID 标识，dsh 提示请求使用同一操作 ID，回执列出可查的原生会话和请求标识。重放相同操作 ID 和内容会返回绑定的执行状态，跨 Host 重启也能查询。同 ID 的不同请求会被拒绝。确认中断时标记待确认，后续可按原生事件补齐证据。CLI 可用 `npm run host:ctl -- receipt <操作ID>` 查询。[本地账本](../../packages/work-core/src/host.ts) · [上游 Work 受理](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_intake.py) · [上游操作执行](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/server/work_effect_executor.py)
- **A3** 普通对话读取 Host 的实际能力和本轮回执，分别说明操作受理、执行进度与交付验收。一般能力询问走普通对话，明确委派由 Host 按需启动 dsh。[Host 对话上下文](../../apps/host/src/context.ts)

## 验证结果

- Work、dsh、对话和投机回复相关的 25 项检查通过。覆盖同项目歧义、同名跨项目定位、原话继续、并发重复追加，以及重启后重放同一执行。[协调检查](../../tests/voice/coordination.test.ts) · [Work 检查](../../tests/voice/work-host.test.ts)
- 真实规划器在临时项目中先对「继续这个」给出两个本项目候选，再按「选第二个」绑定日报。明确指定「继续乙项目的日报」选中了乙项目的同名任务。该轮 Work 执行使用夹具。[规划验证](../../outputs/host-validation/work-reference-e2e.json)
- 真实规划器与 dsh 执行验证通过。两条能力询问均返回委派能力，任务数保持为零。随后提交的文件任务重复投递只产生一个任务和一个 Attempt，原生请求 ID 与受理 ID 一致，文件内容读回正确，普通对话根据受理回执说明排队状态。[真实 dsh 报告](../../outputs/host-validation/capabilities-e2e.json) · [复现入口](../../scripts/desktop/host-e2e.mjs)
- Luna Max 在隔离目录完成 Electron 基础冒烟，构建和 11 项对话检查通过，包含 Host 面板。报告使用本地对话夹具，麦克风帧为零。[冒烟报告](../../outputs/desktop-validation/m2/desktop-smoke-1794420159993.json)

## 仍需设备验收

用麦克风说出模糊指代与简短序号，检查识别结果、候选卡、澄清播报和执行回执的连贯性。

验收入口为 `npm run desktop:dev`。若有上一版本的独立 Host 正在运行，等当前任务结束后用 `npm run host:ctl -- shutdown` 关闭，再启动桌面加载本轮控制接口。
