# 开发说明

先阅读[当前方向](./docs/desktop-voice/current-direction.md)和[项目架构](./docs/desktop-voice/architecture.md)，从实际启动入口追踪本轮变更。

- 通用对话规则和交付状态放在 `voice-core`。模型、进程与原生协议留在适配器，桌面主进程负责装配。
- Work 效果统一通过 Host 受理。改变任务或原生请求前先绑定操作 ID、Task 和 Attempt。应用动作走已登记的 AUIP 会话。
- 设备、模型、阈值与资源清单放在 [配置目录](./config)。源码使用身份和稳定接口连接模块。
- 更新接口或数据结构时同步修正调用方、探针与现行文档。旧结构退出运行链路。

构建和已有回归命令如下。需要验证桌面入口时，使用[隔离冒烟](./docs/desktop-voice/operations.md#验证入口)。

```powershell
npm run desktop:build
npm run desktop:test
```
