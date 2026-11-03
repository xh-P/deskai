# DeskAI2

Windows 桌面 AI 语音对话项目：**dsh SenseVoiceSmall + dsh + GPT-SoVITS**。

默认常态有希 v2，支持自动语音对话、自然插话、选择性回应和角色声音切换。

## 当前状态

截至 2026-11-04（本轮整合与归档）：**M3 逐句 v2 合成/换声与 M4 桌面功能已接入**。支持自动识别、单请求选择性回应、自然插话状态机、播放回执、十角色/参考切换、独立人格和语言、托盘、设备与音量/语速设置。十声音真实 GPU 生成、39 条真实模型文本案例、模拟麦克风→真实 ASR→dsh 模型→v2→播放贯通通过；真实麦克风、扬声器/AEC、主观听校和 M5 长时自然对话仍未验收。

- 双击 `启动桌面语音对话.cmd`，或执行 `npm run desktop:dev`；启动会预热本地服务，点击“开始语音对话”后才采音。关闭窗口默认隐藏到托盘，退出使用托盘菜单。
- 有希桌宠入口：`启动有希桌宠.cmd`，对应独立包 `release/DeskAI2-Pet-Drag-20261030/DeskAI.exe`。提供校服 / 魔法服 × Q 版 / 原作比例四种组合，固定位置可拖动，眨眼、微动作与播放状态口型。默认独立启用轻微动画，可在主窗口或右键菜单切回“跟随系统”，不改 Windows 设置。旧版运行时先从托盘退出再启动新包；接入、验证及设备限制见[桌宠部署说明](./docs/desktop-voice/desktop-pet-20261030.md)。旧版独立预览已归档，见[整理记录](./docs/project-cleanup-20261104.md)。
- “人格 / 角色”可选“长门有希 · 主线消失后（试验性）”，再选朋友或用户扮演阿虚；轻量有希与普通助手继续可用。声音、人格和语言独立，默认及已有保存设置不自动改选。角色以圣诞聚会之后为时间锚点，原作还原和主观表现尚待核验，见[角色与关系说明](./docs/desktop-voice/prompts.md#已接入主线有希与两种关系2026-10-30)。
- 可运行目录包：`npm run desktop:package` 后双击 `release/DeskAI2/DeskAI.exe`。大模型、Conda 与 runtime 使用外部资源；移动包后修改旁边 `deskai-runtime.json` 的 assetRoot。
- 语音体验修订已整合进当前源码；原 VoiceFlow 独立包已归档，需按整理记录恢复后才能运行。统一音频边界、整段续说重识别，保留中日英自动识别并按用户选择采用约一秒确认窗口，详见[修订与验证限制](./docs/desktop-voice/voice-flow-20261030.md)。可用 `npm run desktop:package -- --name DeskAI2-VoiceFlow-20261030` 复建。
- `npm run desktop:test`：确定性回归；`npm run desktop:smoke`：模拟麦克风、真实本地 ASR 回放；`npm run m2:smoke`：模拟模型的桌面界面回放。这些命令不验收物理设备。
- `npm run desktop:pet-smoke`：启动正式主应用与透明桌宠窗口，用模拟状态验证四造型和窗口控制，不启动语音模型、不采集物理麦克风。
- [M3–M4 运行与验证](./docs/desktop-voice/m3-m4-validation.md) · [真实模型验证](./docs/desktop-voice/m2-live-validation-20261030.md) · [临时协助清单](./docs/desktop-voice/temporary-user-checks.md) · [M0 剩余门禁](./docs/desktop-voice/m0-validation.md)。

- [设计与实现交接](./docs/desktop-voice/README.md)
- [分阶段执行计划与验收](./docs/desktop-voice/execution-plan.md)
- [开发约定](./CONTRIBUTING.md)
- [Agent 规则](./AGENTS.md) · [协作说明](./docs/agent-collaboration.md)

## 现有入口

- `start-deepseek-harness.cmd` 或 `npm start`：启动已有 dsh Web，不是桌面语音应用。
- `start-gpt-sovits-v5.cmd`：已有 GPT-SoVITS 启动入口。
- `compare-nagato-voices.cmd`：已有试听比较入口；具体实验见 outputs 和训练文档。
- `启动长门v5训练.cmd` 等训练入口：仅在明确需要训练时使用，不属于桌面应用启动步骤。

新增桌面入口与这些原入口相互独立。已提供 Windows 目录运行包；尚未提供签名安装程序，外部模型/Conda 资产不随包复制。

## 环境与目录

- Node 版本要求以 [package.json](./package.json) 为准；dsh 当前锁定 `0.2.1-rc.2`。
- Python 使用现有 Conda 环境 `.conda/gsv-v5`；环境名称不限制 TTS 版本，v2 必须显式配置。
- `assets/`：原始素材、v2 权重与参考语音。
- `runtime/`：GPT-SoVITS 与 ffmpeg；`scripts/`：准备、训练、试听和测试工具。
- `training/`：独立角色训练项目；`outputs/`：试听与测试产物。
- `docs/desktop-voice/`：产品、架构、轮次策略、提示词、执行计划与开源调研。

Git 仓库保存应用源码、配置模板、测试和文档。素材/模型、Conda、runtime、outputs 和合成 WAV 留在本机，不上传；克隆源码并不自动获得这些大资源。现有工作台可直接使用原资源启动。

现有训练说明：[消失有希](./training/nagato_disappearance_v5/README.md)、[常态有希](./training/nagato_normal_v5/README.md)。

本地音频识别/合成不等于整套离线：对话文字会发送给 dsh 配置的模型服务。凭据由 dsh 管理，不写入仓库或日志。
