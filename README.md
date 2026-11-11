# DeskAI2

Windows 桌面语音与任务工作台，当前持续迭代源码，不制作新的软件发行包。

## 开发入口

- `npm run desktop:dev` 或 `启动桌面语音对话.cmd`：启动桌面应用。开始语音后采集麦克风，关闭窗口默认隐藏到托盘。
- `npm run host:serve` 启动独立任务 Host，`npm run host:ctl -- snapshot` 查询项目与任务。桌面退出后 Host 继续运行。
- `npm run host:ctl -- receipt <操作ID>` 查询该操作绑定的执行与回执。
- `npm start` 或 `start-deepseek-harness.cmd`：已有 DeepSeek Harness 原生 Web 入口。
- `npm run desktop:build`：TypeScript 检查与开发构建；`npm run desktop:test`：回归测试。

语音使用 SenseVoice 唤醒 → Qwen3-ASR 对话识别 → 可配置 Chat → GPT-SoVITS v2 原生流式合成。Qwen 默认保持驻留。人格、声音和语言独立；桌宠沿用现有实现。

对话可由 AI 委派 dsh 执行后台任务。独立 Host 管理项目、执行恢复、Git 工作区、Diff、产物导出与人工验收。登记的应用可通过 AUIP v0 上报状态并接收声明动作。dsh 默认启用原生自动审查。[Host 与交付](./docs/desktop-voice/host-work-20261112.md) · [Work 验收与 AUIP](./docs/desktop-voice/work-review-auip-20261112.md)

同一句话可能指向多个任务时，桌面会显示选择卡。选定后用原话继续，已受理操作可按操作 ID 找回执行回执。[对话引用与 Work 回执](./docs/desktop-voice/work-control-20261112.md)

## 配置与资源

- 默认输入配置：`config/voice/input-runtime.json`；Chat 路由：`config/voice/chat-runtime.json`。界面设置写入应用用户目录，不改源码默认值。
- 本地 ASR 环境：[说明](./services/asr/README.md)；v2 TTS：[说明](./services/tts/README.md)。
- Node 版本以 `package.json` 为准；本地 Harness 版本由 lockfile 固定。
- `assets/`、`runtime/`、`.conda/`、`outputs/` 留在本机，不上传。克隆源码不会自动获得模型和声音资源。
- 凭据由 Harness 或环境变量管理，不写入仓库。对话和任务文本会发送到所配置的模型服务。
- 原有 GPT-SoVITS、训练与试听入口继续保留，非本轮改造范围。

## 文档

- [当前方向](./docs/desktop-voice/current-direction.md)
- [当前文档与历史索引](./docs/desktop-voice/README.md)
- [独立 Host、执行恢复与交付](./docs/desktop-voice/host-work-20261112.md)
- [Work 验收与 AUIP 应用协作](./docs/desktop-voice/work-review-auip-20261112.md)
- [Amadeus 对照基准](./docs/desktop-voice/amadeus-vs-deskai2.md)

自动检查不能替代实际设备上的唤醒、外放双讲、误打断和音质验收。历史目录包不包含本轮源码变化，请使用开发入口验收。
