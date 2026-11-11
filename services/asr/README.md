# Qwen3-ASR 本地服务

[输入配置](../../config/voice/input-runtime.json)给出 Qwen 解释器、模型、设备、推理策略和超时。解释器路径以 `DESKAI_ASSET_ROOT` 为基准，默认根为仓库。待机唤醒使用 dsh SenseVoice。

开发环境复用本机 TTS Python 的 PyTorch/CUDA。模型缓存就绪后准备上游推理模块。

```powershell
$ttsPython = (Get-Content config/voice/output-runtime.json -Raw | ConvertFrom-Json).python
$qwen = (Get-Content config/voice/input-runtime.json -Raw | ConvertFrom-Json).conversation
& (Resolve-Path -LiteralPath $ttsPython).Path -m venv --system-site-packages .conda/qwen-asr
& (Resolve-Path -LiteralPath $qwen.python).Path -m pip install qwen-asr==0.0.6
npm run desktop:prepare-asr
```

首次加载需要可用的 Hugging Face 缓存或模型下载。默认 `resident` 在开始采集时准备模型并保持常驻。`unload` 在回到唤醒待机时退出 worker。启动或请求超时会停止当前 worker，下一次请求可重新启动。

`cuda_graph` 使用 [固定提交清单](./amadeus-runtime.json)中的 Amadeus 解码实现。容量、设备或上游模块不满足时使用官方解码，实际引擎与原因在语音时序诊断中显示。可用 `scripts/desktop/qwen-asr-bench.py <WAV 路径>` 对照同一音频的两种解码。

对话识别还支持 `{"provider":"dsh"}`，以及指定 `baseUrl`、`model` 和可选 `apiKeyEnv` 的 `openai` 路由。
