# M3–M4 接口查证与适配

2026-10-30：本地 dsh 的 `--from-default-profile web` 使用随包的 Web 模板，**不会复制用户已配置的 web profile 的模型选择**。凭据位于共享的 dsh home；账号登录和 API key 是两个独立 provider。桌面旧 profile 没有模型覆盖时仍选 `deepseek-official`，所以即使原 Web 已登录 `deepseek-account`，桌面也会报 `MISSING_CREDENTIAL`。

修复采用受支持的 `agent-default-model` 启动 overlay，只读取 profile 中 provider/model/reasoningEffort 白名单，不复制凭据，也不覆盖用户原 profile。桌面 profile 的明确模型选择优先；未设置时复用 home 或 Web 的选择。没有可复用选择则保留 dsh 默认值并显示实际错误。实现位于 dsh adapter 的 chat-patch；此适配不触发额外模型请求。

同日三条定向真实模型样本确认：WAIT/SILENT 返回完全合规的单行 JSON 后直接结束，不附末尾换行。原解析器把这一合法的“无正文末行”误报格式错误。协议调整为：流中仍必须等换行才消费头；仅在确认流正常结束时，可用 EOF 终止完整且严格校验通过的 WAIT/SILENT 头。SPEAK 仍须换行加非空正文；缺字段、重复字段、围栏、额外正文和不完整 JSON 不放宽。这不把任意文本当作静默，也不增加修复模型调用。

桌面运行包携带应用、Electron、独立 Node 和生产依赖；模型、原参考、GPT-SoVITS runtime 与 Conda 使用外部资源根。`deskai-runtime.json` 的 assetRoot 相对包目录解析，避免把开发机路径写进包。worker 代码与外部资源根分别解析；原训练和 Web 入口继续使用原目录。

输出设备通过 AudioContext.setSinkId 设置；按已安装 Electron 类型，增加仅对本地主窗口开放的 speaker-selection 权限。麦克风权限仍额外要求会话已启动；选择输出设备不会开启麦克风。物理设备切换效果保留待验。
