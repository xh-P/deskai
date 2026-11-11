# 运行与维护

## 桌面

在 Windows 安装 Node.js 22.19 或 24 以上版本。安装依赖后使用 `npm run desktop:dev` 或 `npm start`。开发入口编译 Electron 主进程与 Renderer，再从 `.cache/desktop-main` 和 `.cache/desktop-renderer` 加载。

- [输入配置](../../config/voice/input-runtime.json)管理唤醒词、AEC、插话、端点和转写路由。SenseVoice 提供待机唤醒，连续对话默认 Qwen3-ASR。准备方法见 [ASR 服务](../../services/asr/README.md)。
- [对话配置](../../config/voice/chat-runtime.json)管理 Chat 路由与候选回复。dsh 默认读取 `deskai2-voice`、共享配置或 `web` 中已保存的模型路由。OpenAI-compatible 路由在配置中引用保存密钥的环境变量名。Work 规划继续走 dsh。
- [输出配置](../../config/voice/output-runtime.json)管理 GPT-SoVITS v2 资源路径、稳定声音 ID、默认声音和流式参数。模型与参考音频需提前放在配置指定位置。[TTS 服务](../../services/tts/README.md)
- [角色卡](../../config/personas)与[角色语料](../../config/character-knowledge)按角色 ID 对应。运行 `npm run desktop:prepare-knowledge` 建立或更新本地索引。此命令使用 uv、Python 3.12 和固定版本的 multilingual-e5-small ONNX 模型。可用 `DESKAI_KNOWLEDGE_DOWNLOAD_PROXY` 指定下载代理。[长门角色知识](./character-research/README.md)
- `DESKAI_ASSET_ROOT` 可指定模型与运行时资源根目录。源码配置与派生构建产物以仓库为根。

## Host 和数据目录

桌面按需启动 Host，也可在单独终端运行 `npm run host:serve`。桌面和 CLI 使用同一个 `DESKAI_HOST_DIR` 时连接同一个 Host。Windows 默认目录如下。

- `%APPDATA%\DeskAI2\` 保存 `voice-preferences.json`、`pet-settings.json`、`characters.json`、`conversations/`。
- `%APPDATA%\DeskAI2\host\` 保存 Work 账本、产物登记、导出、工作区和本机连接记录。默认项目来自 [Work 配置](../../config/work-runtime.json)。
- `.conda/`、`runtime/`、`assets/` 是本机资源。知识索引、上游 ASR 模块和构建结果在 `.cache/`，验证报告在 `outputs/`。训练原始素材及实验权重在本机素材目录。

常用命令如下。参数用 `snapshot` 中相应的 ID。导出写入指定的新文件路径。

```powershell
npm run host:ctl -- snapshot
npm run host:ctl -- watch
npm run host:ctl -- receipt <操作ID>
npm run host:ctl -- diff <Attempt-ID>
npm run host:ctl -- recheck <Work-ID> <Attempt-ID>
npm run host:ctl -- accept <Work-ID> <Attempt-ID>
npm run host:ctl -- export <产物ID> <绝对路径>
npm run host:ctl -- shutdown
```

当前账本要求每个 Attempt 有操作 ID，并持久化 `operations`。使用旧源码进程时先让当前任务结束，再关闭旧 Host。当前版本使用新建的现行格式账本。设置文件缺少现行字段时使用默认值。

## 实时 Work 工作台

工作台从主窗口的「工作」进入。选中项目与任务后可查看实时轨迹，在「执行记录」切换 Attempt。向上滚动暂停跟随，使用「加载更早」读取旧记录。窄窗通过「详情」查看模型指标、输入请求和交付。

Work 会话使用 `deskai-work` dsh 预设。默认等待问题进入可在桌面答复的阶段为 5 秒，可在 [Work 配置](../../config/work-runtime.json)修改 `questionWaitSeconds`。原生前台提问、授权或完整会话从「原生会话」打开。升级仍在运行的源码 Host 时，等任务结算后执行 `npm run host:ctl -- shutdown`，再启动桌面应用以载入新订阅接口和预设。

## 验证入口

```powershell
npm run desktop:build
npm run desktop:test
npm run desktop:dev -- --dialogue-smoke
npm run desktop:smoke -- --input-wav 'C:\path\speech.wav'
npm run desktop:dev -- --tts-smoke --real-model --input-wav 'C:\path\speech.wav'
```

对话冒烟使用夹具模型。音频与 TTS 冒烟使用调用方提供的音频，报告分别写入 `outputs/desktop-validation/audio`、`dialogue` 或 `tts`。冒烟桌面和 Host 使用隔离的本机状态目录。TTS 冒烟默认用夹具对话，`--real-model` 另接入实际 dsh 规划和 Chat。

如需重复角色知识对照，可运行 `node --experimental-strip-types scripts/desktop/character-e2e.mjs --real-model`。运行真实 dsh Work 和能力回执探针可用 `node scripts/desktop/host-e2e.mjs --real-model --capabilities`。对照结果和设备检查见[验证记录](./verification.md)。
