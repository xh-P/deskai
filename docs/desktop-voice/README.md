# 桌面语音与任务工作台

当前入口是源码开发模式 `npm run desktop:dev`。

- [角色编辑、会话归属与知识检索](./character-knowledge-20261112.md) 记录 H1、H4 的真实模型开关对照和验收入口。
- [对话引用与 Work 回执](./work-control-20261112.md) 记录 A 的候选消歧、操作绑定和验证。
- [Work 验收与 AUIP 应用协作](./work-review-auip-20261112.md) 记录 F、G 的验收证据、上游样例和复现入口。
- [独立 Host、执行恢复与交付](./host-work-20261112.md) 记录 C、D、E 的源码入口、真实 dsh 验证与待确认项。
- [语音延迟实施记录](./voice-latency-20261111.md) 记录 B4、B5 的 GPU 对照、投机确认和端到端冒烟。
- [语音稳定性实施记录](./voice-stability-20261111.md) 记录本轮改造、冒烟结果与设备验收项。
- [本轮起点交接](./handoff-20261111.md) 记录改造前的状态、上游源码基准和执行入口。
- [当前方向](./current-direction.md)：有效要求与已撤销约束。
- [Amadeus 整合任务清单](./optimization-backlog.md) 记录已核实的上游实现、DeskAI2 接入进度和验收项。
- [初版 Host 架构与验证](./host-architecture-20261110.md) 记录 AI 委派 dsh、初版工作控制、产物与应用协作。
- [AEC 专项核对](./aec-study-20261104.md)：上游源码差异、参考时序与近端误抑制的实验证据。
- [Amadeus 对照基准](./amadeus-vs-deskai2.md)：迁移前比较，不当作当前代码清单。
- [ASR 配置与环境](../../services/asr/README.md)、[v2 TTS 配置](../../services/tts/README.md)。

## 历史资料

以下资料保留作为历史证据，不能当作当前范围、路线或验收门禁：

- [唤醒、AEC 与原生 Work 入口记录](./iteration-20261104.md)：当时 Work 仍需手工调度，已由本轮 Host 架构替代。
- [上轮迁移记录](./amadeus-migration-temporary.md)：包含当时的模拟测试、显式 AEC 回退和目录包验证；最新决定以本轮记录为准。
- [2026-10-30 实现交接与旧方案索引](./history-overview.md)：产品、架构、回应策略、提示词及 M0–M5 历史文件集中由此访问。
- [M3–M4 历史验证](./m3-m4-validation.md)、[桌宠部署记录](./desktop-pet-20261030.md)。

真实外放双讲、唤醒准确率、音质和端到端延迟必须按实际设备确认，不能从单元测试或模拟设备结果直接推断。

