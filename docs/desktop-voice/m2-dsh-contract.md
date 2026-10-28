# M2 dsh Session 契约与限制

本地版本为 `@deepseek-ai/dsh@0.2.1-rc.2`。`session/prompt` 只接受 requestId、sessionId、mode、content、clientTimeZone，回执 `accepted` 不等于生成结束。`session/follow` 的开启快照含 cursor 和 activeAttempt；live `assistant-stream` 由 start、chunk、end 组成，chunk 的 `text-delta` 才能送到回复协议；`reasoning-delta`、工具和 durable assistant/message 均不能再作为朗读增量。

`LocalDshChat` 复用 `LocalDshSpeech` 所属 Node Host、认证 HTTP RPC 和 Mux。`runTurn` 分开返回受理回执与 `completed`，`cancel` 调原生 `session/cancel` 后等 durable `turn/end`。follow 断线、索引缺口及超时显式失败；`(attemptId,index)` 去重，重连快照只作基线，不重播。

原生 prompt RPC 没有按轮 system prompt 或独立 runtime context 字段。专用启动 overlay 使用两个无工具 preset：从 `config/personas/*.json` 经 voice-core 校验与模板生成固定系统前缀；声音和 persona ID 由应用分别管理。每个用户轮次创建新 Session，把可见历史、已播账本和本轮文字结构化投影进单次 prompt；原 Session 日志保留作审计，不编辑历史，也不增加模型摘要调用。voice 模式仅账本标注已播内容，text 模式已显示文字可视为用户可见。此方案保持上下文边界，但模型对投影的语义遵守仍需真实模型回归。

2026-10-28 再次最小真实请求：Web 认证、Session create/prompt/follow 与空工具列表读取成功；attempt 仅返回 `MISSING_CREDENTIAL`，没有可见正文。真实 SPEAK/WAIT/SILENT、取消时机、未播历史语义仍未验收。模拟供应商 fixture 只能证明 transport 映射，不可替代模型行为门禁。

收口验证：本地自建 Gateway-compatible HTTP/Mux fixture 与单元测试共6项通过，覆盖受理/结束分离、原生cancel等待、创建期取消、重复start忽略、重连缺口取消和follow错误保锁。显式取消/失联请求原生cancel后，30秒未得到durable结束就失败并保留busy状态，不能仅关闭观察后放开下一轮。没有执行“真实dsh Host + 模拟模型服务”的完整链路，不能把这些单元fixture描述为该链路通过。
