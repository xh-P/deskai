# 桌面语音与任务工作台

当前入口是源码开发模式：`npm run desktop:dev`。本轮继续优化，不生成安装包或目录包。

- [当前方向](./current-direction.md)：有效要求与已撤销约束。
- [本轮架构、结果与待答复](./host-architecture-20261110.md)：AI 委派 dsh、持久工作控制、产物与应用协作。
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
