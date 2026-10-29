# M2 真实模型验证（2026-10-30）

## 结果

首次运行时，隔离的 `deskai2-voice-m1` dsh Host 的首个模型请求返回 `MISSING_CREDENTIAL`，脚本按设计停止；当时 `57` 条案例均为 `UNTESTED`。随后修复了桌面启动 overlay 对已保存 provider/model 选择的读取，本次按修复后的路由只复测一次。

路由修复后、EOF 解析修复前的中间复测中，`missingCredential=false`，观察到 `39` 条案例结果，其中实际模型调用 `27` 次。报告为 `PASS=24`、`FAIL=1`、`INVALID=14`、`UNTESTED=18`、`UNEXPECTED=0`。账号路由已能发出真实请求，但当时的模型语义门禁未通过：存在一条语义不匹配和十四条协议格式错误；未改预期来迁就模型。

按语言统计：中文 `10 PASS / 3 INVALID / 6 UNTESTED`；日文 `7 PASS / 1 FAIL / 5 INVALID / 6 UNTESTED`；英文 `7 PASS / 6 INVALID / 6 UNTESTED`。

逐例异常如下，完整预期与实际结果保留在报告中：

- `ja-no-to-continue`：预期 `SILENT/model`，实际 `SPEAK/model`。
- `PROTOCOL_FORMAT`：`zh-嗯-unplayed-question`、`zh-not-addressed`、`zh-private-note`、`ja-unfinished-think`、`ja-はい-unplayed-question`、`ja-closing`、`ja-not-addressed`、`ja-private-note`、`en-unfinished-think`、`en-yes-unplayed-question`、`en-no-to-continue`、`en-closing`、`en-not-addressed`、`en-private-note`。

## 执行记录

- 首次：`npm run desktop:build` 退出码 0；`node scripts/m2/live-semantics.mjs --real-model` 退出码 1，脚本输出 `missingCredential=true`，只尝试首个预设请求。
- 路由修复后、EOF 解析修复前的中间复测：不重建，单次执行 `node scripts/m2/live-semantics.mjs --real-model`；退出码 1，`missingCredential=false`。失败原因来自语义/协议报告，不是缺少凭据。
- 更新后的编译缓存包含安全模型选择 overlay：只读取 provider、model、reasoningEffort；本次脚本报告不包含 provider 字段，因此具体路由选择来自本地 profile 配置和 overlay 逻辑，而非报告字段。
- 只使用仓库预设的合成文本案例；没有使用麦克风、输出音频或 GPU，也没有下载或升级依赖。
- dsh 管理的凭据、Cookie、令牌及个人对话内容均未记录。

## 本机产物

- `outputs/desktop-validation/m2/semantic-observed-real.json`：EOF 解析修复后最后一轮的观察结果。
- `outputs/desktop-validation/m2/semantic-report-real.json`：EOF 解析修复后最后一轮的 57 条预设案例结果。
- `outputs/desktop-validation/m2/semantic-protocol-samples-real.json`：三个协议错误案例的逐 attempt 原始 assistant text、解析结果与错误原因。
- `docs/desktop-voice/validation/m2-semantics-real.json`：最后一次完整复测的 57 条逐例报告，与本机输出 SHA-256 一致。

## PROTOCOL_FORMAT 定向复现

执行 `node scripts/m2/protocol-sample.mjs --real-model`，退出码 0；仅发送三个固定合成 fixture，各一次模型请求，均正常完成且无 adapter error。三例都没有结尾换行，`DecisionStream.finish()` 的具体错误均为 `missing complete decision header`，且都没有产生已解析 header：

- `zh-not-addressed`：`{"v":1,"action":"SILENT","reason":"not_addressed","expectsReply":false}`
- `ja-unfinished-think`：`{"v":1,"action":"WAIT","reason":"unfinished","expectsReply":false}`
- `en-closing`：`{"v":1,"action":"SILENT","reason":"closing","expectsReply":false}`

样本原文与 parser 事件保存在独立 JSON 中。该定向复现没有修改解析器或 fixture 预期；三次额外请求不计入上面的整套语义报告计数。

首次缺凭据结果和中间复测失败的计数保留在本文件；本机完整报告已由最后一轮结果覆盖。EOF 修复后模型语义/协议失败未再出现，仍有未测试的声学、权限和物理设备案例。此次未复制或读取凭据，也未修改应用实现。

## EOF 解析修复后的最后完整复测

最后只运行一次 `node scripts/m2/live-semantics.mjs --real-model`，未重建缓存；退出码 0，`missingCredential=false`。57 条案例为 `PASS=39`、`FAIL=0`、`INVALID=0`、`UNTESTED=18`、`UNEXPECTED=0`，含 27 次真实模型调用。中文、日文、英文各 `13 PASS / 6 UNTESTED`。此前 `ja-no-to-continue` 的语义不匹配和 14 条 `PROTOCOL_FORMAT` 均未再出现。

18 条未测试案例每种语言各有：`continuation`、`playback-echo`、`repeat-and-ask`、`background-noise`、`prompt-injection`、`correction-interrupt`。它们依赖输入持续状态、声学证据或权限前后比较，被脚本明确跳过；本次没有验收这些声学、权限或真实设备行为。因此模型语义案例中已观察部分通过，但 M2 全部真实场景门禁仍未完成。

最终逐例报告已复制到 `docs/desktop-voice/validation/m2-semantics-real.json`，与本机 `semantic-report-real.json` 的 SHA-256 一致。未调整任何 fixture 预期。
