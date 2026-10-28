# M0 音频设备验证窗口

这是一个临时 Electron 音频接口验证工具，不是桌面语音对话应用。它不接入 SenseVoice、dsh、VAD、轮次策略或 GPT-SoVITS。

## 启动

在项目根目录执行：

```powershell
node_modules/.bin/electron.cmd apps/desktop-m0
```

启动只枚举设备，不请求麦克风。点击 **开始设备验证** 后才请求麦克风，并以 `echoCancellation: true`、`noiseSuppression: true`、`autoGainControl: false` 获取 `MediaStreamTrack`。窗口显示设备名称、`track.getSettings()` 实际值及 AudioContext 采样率。点击 **播放 1 秒 PCM 测试音** 时，AudioWorklet 播放测试 PCM，采集 Worklet 继续计算输入帧数和 RMS。

点击 **停止** 会停止 MediaStream track、关闭 AudioContext，并保存聚合元数据到 `outputs/desktop-validation/m0/audio-device-*.json`。报告不含原始麦克风音频、设备 ID 或设备名称。

## 模拟 smoke

```powershell
node scripts/m0/audio-smoke.mjs --smoke
```

脚本显式附加 `--use-fake-device-for-media-stream` 与 `--use-fake-ui-for-media-stream`。在这个测试专用模式下，窗口自动运行一次采集与 PCM 输出，并把报告标记为 `simulated: true`。它验证 AudioWorklet 采集、PCM 输出和同时运行的帧计数；**不能**证明真实麦克风工作、物理回声路径或 Chromium AEC 有效。

## 安全边界

- `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- Preload 仅提供读取 smoke 状态、提交元数据报告和结束 smoke 的三个 IPC 方法。
- 权限处理只允许本地页面请求纯音频媒体；外部导航与新窗口被拒绝。
- Worklet 不发送或落盘原始采样，只发送聚合帧数、RMS 和峰值。
