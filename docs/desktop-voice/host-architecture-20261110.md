# DeskAI Host 架构与本轮汇报（临时，2026-11-10）

本轮目标：参考 Amadeus 的 Host 边界落地对话委派、工作控制、持久状态和应用协作；执行器先接 dsh。状态以文末验证为准，不把设计标为已实现。

## 实施前边界

```mermaid
flowchart LR
  User[语音 / 文字 / 点击] --> Chat[主对话与任务意图规划]
  Chat --> Host[Host 工作控制与任务账本]
  Host --> DSH[dsh 原生 Agent / 自动审查 / 工具]
  DSH --> Host
  Host --> Narration[事实回传 / 角色播报 / 工作面板]
  Narration --> User
  Host --> Artifacts[项目归属与产物登记]
  Artifacts --> Apps[受控应用会话 / 状态 / 动作回执]
  Chat --> Apps
  Apps --> Narration
```

- 主角色只得到结构化的工作控制和应用动作能力；实际文件、命令和 MCP 工具由 dsh 执行。任务识别由模型完成，不用关键词规则代替 AI 委派。
- Host 管理项目、草稿、任务、执行尝试和 dsh 会话对应关系；写入状态后才对外报告。继续、重试和取消具有独立语义，断线不当作完成。
- 自动审查调用 dsh 原生机制，作用于应用委派的会话；不改用户全局权限、不把自动审查等同无条件批准。
- 打断语音只影响当前对话/播放，不终止后台任务；终止任务必须通过明确任务控制。任务事件与主对话共享界面，但不混用取消标识。
- 产物必须存在且属于对应项目/任务，应用连接只允许登记的入口；模型不能凭一句“做好了”创建虚假的执行事实。
- 应用协作遵循注册清单、状态修订、声明动作和真实回执的边界；仅支持的协议范围会明确说明，断开后动作失败可见。
- 代码保持独立模块，Electron 主进程负责组装和可信 IPC。语音、TTS v2、可配置唤醒和 AEC 继续沿用现有实现。

## 实际修改

1. **AI 委派**：文字与识别后的语音先由独立规划器判断对话、提交、追加、继续、重试、取消、查询和应用动作。Host 校验真实目标再执行，角色拿执行回执回答。工作代理是 dsh，不再只是打开网页让用户手工分派。
2. **工作控制层**：新增 `work-core`，保存项目、草稿、任务、每次执行、会话 ID 和事件。桌面可直接管理任务，也可打开对应的 dsh 原生会话接管。继续复用会话，重试新建会话；重启时未确认的执行标为中断，不自动重跑。
3. **dsh 执行适配**：后台启动原生 Host，以认证 RPC 提交并跟踪任务。任务会话默认启用官方 auto-review，工具执行、MCP/Skills 与审查继续交给 dsh；需要人工回答时显示原生请求。关闭工作窗口不终止任务，停止聊天也不会取消后台工作。
4. **产物与应用协作**：按本次执行清单登记真实文件，检查项目范围和内容摘要。普通产物可预览；单文件 HTML 可在隔离窗口交互。短期一次性票据连接应用，声明状态、事件和动作；角色通过 Host 调用已声明动作，以实际回执更新状态。断开连接后不再执行动作。
5. **统一入口**：工作与应用面板接入现有桌面；本机 API 使用独立认证凭据连接同一 Host。语音、TTS v2、显存驻留、唤醒设置和 AEC 档位沿用现有链路。本轮只迭代源码。

## 源码依据与取舍

参考固定提交 `f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e` 的真实源码，按本项目 TypeScript / Electron / dsh 栈实现相同的职责分离；本轮没有整段搬入其 Python 后端：

- [work_ledger_coordinator.py](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/server/work_ledger_coordinator.py)：持久任务、执行尝试与 Provider 事件归属。
- [work_planner.py](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/server/work_planner.py)：工作规划与主对话分工，区分修改应用代码和调用现有应用功能。
- [work_artifact_registry.py](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/server/work_artifact_registry.py)：产物范围与归属。本项目使用执行专属清单，不扫描整个目录按修改时间猜产物。
- [auip_app_connection.py](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/server/auip_app_connection.py) 与 [协议说明](https://github.com/Code-Amadeus/Amadeus/blob/f86c72a366bd8ef99102c4a5ab2bb7a57fc5522e/docs/auip_application_sessions.md)：应用连接、票据、声明动作及回执边界。

本项目应用协议是 **AUIP 思路的精简实现，不能直接接 Amadeus AUIP v0 应用**。执行器仅 dsh；没有引入其 Browser、Codex、Pi，也没有实现多执行器调度。记忆系统、壁纸运行时和 VN Player 不属于这次已实现内容。

## 验证

- 真实模型端到端：规划器委派 dsh，在临时项目从头生成待办应用（没有直接复制示例），登记并校验文件，隔离窗口连接，模型把自然语言转换为应用动作，收到接受回执且状态包含新增待办，关闭后动作被拒绝。2026-11-10 报告：`outputs/host-validation/host-e2e.json`，`passed: true`。
- 复现命令：`node scripts/desktop/host-e2e.mjs --real-model`。需要本机已有模型凭据，会调用真实模型；探针只在临时项目操作。
- `npm run desktop:test`：121 项通过，包含任务持久化、请求接管、取消竞态、应用回执和本机 API 认证。最终 `npm run desktop:build`：通过。
- `npm run m2:smoke`：真实 Electron 界面加载、Host 工作/应用面板、对话重试与打断检查通过，模型为模拟实现。首次包装脚本仍引用旧协议字段和请求数，修正后复跑通过；记录见 `outputs/host-validation/final-checks.json`。
- 探针限制：首次从头生成超过原来的 3 分钟等待，改为 6 分钟；随后一次被会话中断，没有完整报告。最后一次功能断言全部通过，但 Electron 尚未退出时删除其用户目录触发 `EBUSY`，命令退出码为 1。已将清理移到父进程等待 Electron 退出之后，单独运行真实 Electron 生命周期探针验证清理通过；没有为这个清理修改重复调用模型。功能通过与脚本清理失败在这里分别记录。
- 上述验证不涉及真人麦克风、外放双讲、日语唤醒或音质，不能代替实机体验。

## 验收入口与仍待优化

1. 运行 `npm run desktop:dev`。在“工作任务”选择项目；在对话里明确要求创建文件或应用，观察后台任务状态，再用对话追加、查询或取消。也可直接通过任务草稿提交。
2. 任务结束后在“产物与应用”预览；HTML 点击协作入口，连接后用对话调用应用的已声明功能。普通 HTML 不自动具备协作能力，生成时需描述为协作应用或勾选对应选项。
3. 本机 API 描述保存在 Electron 用户数据目录的 `host/local-api.json`；支持认证 `GET /snapshot`、`POST /command`，后者 `type` 为 `work`、`chat` 或 `app-action`。凭据不进入模型上下文。API 随桌面 Host 运行，尚无独立无界面启动命令。
4. `completed` 表示 dsh 本次执行正常结束，文件校验只证明产物存在、归属和内容未变，不等同人工确认任务质量。暂未做 Amadeus 的独立目标完成评估、Git 差异交付、控制器租约和应用跨重启恢复。
5. 当前每轮输入先调用规划模型，再进入角色回复，会增加一次模型判断的延迟；后续可根据实机体验优化。尚需你验收自然语音委派、任务播报是否打扰、原生提问接管体验。本轮无必须先答复才能运行的阻塞项。历史 AEC 误抑制问题仍保留在专项文档，不因本轮架构变化而视为解决。
6. 按最新要求不保留旧数据或旧设计兼容层；旧 Work 的说明已移入历史入口，界面去掉原生 JSON 手填应答，直接使用当前工具结构或打开原生会话。
