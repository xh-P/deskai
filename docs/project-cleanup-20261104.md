# 2026-11-04 项目整合与归档

本地仅有 main 分支和一个工作区，先前子 agent 的成果共享此工作区。本次将语音流程、人格及桌宠源码统一纳入 main；没有额外分支可合并。按用户授权推送 origin，不改写远端历史。

## 当前入口

- 源码开发：根目录 `启动桌面语音对话.cmd`。
- 已验证桌宠包：`启动有希桌宠.cmd` → `release/DeskAI2-Pet-Drag-20261030/DeskAI.exe`。
- `release/DeskAI2` 通用旧包保留供回退，重新构建命令为 `npm run desktop:package`。
- 原始 assets、训练权重、runtime、Conda、音频产物与用户配置未清理。本机 `.codex/` 和归档目录加入 Git 忽略规则。

## 本机归档

归档根目录为 `archive/2026-11-04/`，保持原相对路径；完整本机映射见其中 `manifest.json`。仅移动，不删除：

- `release/` 下的 `DeskAI2-Nagato-20261030`、`DeskAI2-Pet-20261030`、`DeskAI2-Pet-Motion-20261030`、`DeskAI2-VoiceFlow-20261030`。
- `apps/pet-prototype`、`scripts/pet-prototype`、`预览有希桌宠.cmd`。
- `outputs/desktop-pet/` 下的 `deployment`、`motion-override`、`validation` 历史证据。最新 `drag-fix` 及素材调研仍留原处；后续 smoke 可以重新创建 validation。

生成提示词另保存在 `docs/desktop-voice/pet-generation/`，正式十二张桌宠 PNG 留在应用资源目录并纳入版本管理。

恢复时先退出对应程序，再把所需归档条目按 manifest 原路径移回；若原路径已存在，应先人工比较，不能覆盖。原型须同时恢复 apps、scripts 和启动器三项。旧运行包依赖 `../../` 的外部资源定位，历史脚本也依赖原目录层级，因此不要直接从归档目录启动。归档只保存在本机，不随 Git 推送；它减少活跃目录中的旧内容，不释放磁盘空间。

## 验证

`npm run desktop:test`：104 / 104 通过；`npm run desktop:build`：主进程及 renderer 类型检查、Vite 构建通过。日志在 `outputs/integration-20261104/`。未重新测试真实麦克风、AEC、物理拖动、跨屏 DPI 或长时运行。

随后源码审查补充了桌宠停止回复入口的活动状态判断，防止空闲点击无意义推进输出代次；该改动追加主进程 TypeScript 检查通过。保留的 10 月 30 日运行包没有重打包，不含此新增保护；使用源码开发入口可运行整合后的代码。
