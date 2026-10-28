# DeskAI2

Windows 桌面 AI 语音对话项目：**dsh SenseVoiceSmall + dsh + GPT-SoVITS**。

默认常态有希 v2，支持自动语音对话、自然插话、选择性回应和角色声音切换。

## 当前状态

截至 2026-10-28：**M1 自动采集与 M2 选择性回应代码已接入桌面**。支持自动识别、单请求回应决策、流式正文、文字输入、人格/回复语言独立设置、显式停止与重试。M2 本地协议/界面回放通过；真实模型请求仍返回 `MISSING_CREDENTIAL`，按用户本轮安排保留真实模型语义验收未完成。语音合成桌面集成待 M3，当前只显示生成正文；真实麦克风、扬声器和 AEC 未验收。

- 双击 `启动桌面语音对话.cmd`，或执行 `npm run desktop:dev`；点击“开始对话”后才采音，“结束对话”释放麦克风。
- `npm run desktop:test`：确定性回归；`npm run desktop:smoke`：模拟麦克风、真实本地 ASR 回放；`npm run m2:smoke`：模拟模型的桌面界面回放。这些命令不验收物理设备。
- [M2 运行与验证](./docs/desktop-voice/m2-validation.md) · [M1 验证](./docs/desktop-voice/m1-validation.md) · [M0 剩余门禁](./docs/desktop-voice/m0-validation.md)。

- [设计与实现交接](./docs/desktop-voice/README.md)
- [分阶段执行计划与验收](./docs/desktop-voice/execution-plan.md)
- [开发约定](./CONTRIBUTING.md)
- [Agent 规则](./AGENTS.md) · [协作说明](./docs/agent-collaboration.md)

## 现有入口

- `start-deepseek-harness.cmd` 或 `npm start`：启动已有 dsh Web，不是桌面语音应用。
- `start-gpt-sovits-v5.cmd`：已有 GPT-SoVITS 启动入口。
- `compare-nagato-voices.cmd`：已有试听比较入口；具体实验见 outputs 和训练文档。
- `启动长门v5训练.cmd` 等训练入口：仅在明确需要训练时使用，不属于桌面应用启动步骤。

新增桌面入口与这些原入口相互独立。当前为源码开发启动方式，尚未制作可分发安装包。

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
