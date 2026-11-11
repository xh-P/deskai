# Qwen3-ASR 本地运行

默认对话识别使用 `Qwen/Qwen3-ASR-0.6B`，唤醒识别继续使用本地 dsh SenseVoice。`config/voice/input-runtime.json` 可配置模型、设备、端点和唤醒词。`device` 可设 `cuda:0` 或 `cpu`；`idlePolicy: resident` 在退回唤醒监听后保留模型，避免再次冷启动，但继续占用显存；`unload` 则在退回唤醒监听时结束进程，下次唤醒重新加载。会话关闭时结束进程。

开发机的隔离环境可通过以下 PowerShell 命令复现（已有的 GPT-SoVITS 环境须存在）：

```powershell
.\.conda\gsv-v5\python.exe -m venv --system-site-packages .conda\qwen-asr
.\.conda\qwen-asr\Scripts\python.exe -m pip install qwen-asr==0.0.6
.\.conda\qwen-asr\Scripts\python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-ASR-0.6B')"
```

此环境借用 GPT-SoVITS 环境中的 PyTorch/CUDA 和其他依赖，不修改其包；该原环境必须保留。首次加载需要下载或使用本机 Hugging Face 缓存中的权重。资源根目录由 `DESKAI_ASSET_ROOT` 指定。需要不同环境可在配置中设置 `python` 为解释器绝对路径。模型首次加载耗时、显存与速度取决于设备和其他服务，不等同于实际对话端到端延迟。

在仓库根运行一次 `npm run desktop:prepare-asr`，把固定版本的 Amadeus 推理模块准备到 `.cache/amadeus-qwen`。随后按原开发入口启动。默认 `conversation.inference.engine` 为 `cuda_graph`，在 NVIDIA CUDA 上预捕获一个 512 token 的静态解码图。容量按输入与输出 token 预算计算。缺少上游模块、设备能力或容量时使用官方解码，实际引擎和原因可在语音时序的 `asr` 字段查看。`flashAttention` 允许上游在支持的环境选择音频 FlashAttention，当前开发机实测使用 SDPA。

在同一台机器用缓存权重复测官方解码和 Graph，可运行 `./.conda/qwen-asr/Scripts/python.exe scripts/desktop/qwen-asr-bench.py <WAV 路径>`。报告分别记录启动、预捕获、预热和推理耗时，包含实际重放步数与文本一致性。

也可将 `conversation` 设为 `{"provider":"dsh"}`，或使用 `{"provider":"openai","baseUrl":"http://127.0.0.1:8000/v1","model":"Qwen/Qwen3-ASR-0.6B"}` 接入支持音频转写接口的服务；若需认证，`apiKeyEnv` 指向存有密钥的环境变量名，配置中不要写入密钥。Qwen 失败不会自动切换到 dsh。
