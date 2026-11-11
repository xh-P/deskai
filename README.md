# DeskAI2

Windows 本地桌面应用，支持语音和文字对话、可编辑角色、按角色检索资料，以及通过独立 Host 委派和验收 Work。桌宠读取会话与播放状态。

## 从源码启动

准备 Node.js 和项目所需的本地模型资源，然后在仓库根目录运行以下命令。也可双击 [启动桌面语音对话.cmd](./启动桌面语音对话.cmd)。

```powershell
npm ci
npm run desktop:dev
```

默认用 SenseVoice 唤醒、Qwen3-ASR 转写连续对话、dsh 生成对话和执行 Work、GPT-SoVITS v2 播报。打开文字会话即可输入，点击「开始语音对话」才开始采集。角色、关系、回复语言、声音和知识检索可分别设置。

- [项目架构与数据流](./docs/desktop-voice/architecture.md)
- [运行、配置与数据位置](./docs/desktop-voice/operations.md)
- [Amadeus 整合任务清单](./docs/desktop-voice/optimization-backlog.md)
- [验证与实机验收](./docs/desktop-voice/verification.md)
