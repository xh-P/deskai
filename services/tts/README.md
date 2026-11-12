# GPT-SoVITS v2 本地服务

默认使用 [输出清单](../../config/voice/output-runtime.json)。可通过 `DESKAI_TTS_CONFIG` 指定另一份同结构 JSON，资源路径基于 `DESKAI_ASSET_ROOT`，默认是仓库根。

- `python`、`repository`、`ffmpegBin` 指向带 PyTorch/CUDA 和 websockets 的 Python 环境、GPT-SoVITS 和 FFmpeg。
- `modelDirectory`、`referenceDirectory` 指向本地 v2 模型和参考音频。`registry` 是模型目录内的角色清单。每个条目包括 `name`、`gpt`、`sovits` 和 `refs`。参考音频条目包括 `name`、`file`、`text` 和可选 `language`。
- `voiceIds` 将 GPT 权重相对路径映射到稳定声音 ID。`defaultVoiceId` 必须在声音清单中。按清单顺序分配参考音频 ID。
- `streaming` 管理语义流式开关、最小分块和重叠长度。

桌面通过私有本机 WebSocket 获取目录、选择声音、合成和取消。worker 预热所选音色后报告就绪。音色切换通过修订号隔离，PCM 帧同时带会话、回复代次、句子和音色身份。

worker 回传合成器产生的完整 PCM。没有语音的结果报告为 `TTS_NO_AUDIO`，采样或时长越界报告为 `TTS_INVALID_PCM`。

桌面收到第一个完整可读片段便提交合成。后续片段只在播放余量足以覆盖合成首块时等待同一句的续文，余量耗尽时先提交已就绪的分句。纯标点、引号等无文字片段在合成前跳过，原文仍可显示。

PCM 到达后直接发出语音主体，最多保留 20 毫秒原始尾部用于标记段末。播放器完整输出当前段，再将段末的残余电平短暂衰减，或衔接到下一段已就绪的安静前沿。后续片段合成失败只撤回该片段，已成功合成的前段播完后再进入文字回退。

## 本地微调与试听

把每个说话人的短句 WAV 和 UTF-8 标注清单放到本机的 `training/<音色 ID>/`。清单每行按 `WAV 路径|说话人 ID|语言|原文` 填写，日语使用 `ja`。`train.list` 用于特征提取和微调，`holdout.list` 留作独立试听参考。[GPT-SoVITS 数据格式](https://github.com/RVC-Boss/GPT-SoVITS#dataset-format)

在 `runtime/GPT-SoVITS` 中使用输出清单指定的 Python 和 FFmpeg，选 v2 及对应的基础权重。运行 `GPT_SoVITS/prepare_datasets/` 中的文本、HuBERT 和语义预处理，再由 `s2_train.py` 和 `s1_train.py` 分别导出 SoVITS `.pth` 和 GPT `.ckpt`。试听时用同一组权重及一条附有原文的参考音频加载 v2 推理。[v2 基础权重](https://huggingface.co/lj1995/GPT-SoVITS/tree/main/gsv-v2final-pretrained)

南梦芽本机训练目录为 `training/minami_yume_v2/`。切片时序及日文标注见 `dataset_manifest.json`，训练配置、权重和试听分别位于 `configs/`、`weights/` 和 `audition/`。

同一份南梦芽标注的 v5turbo 微调位于 `training/minami_yume_v5turbo/`。复用 v2 的音素与 HuBERT 特征，用 `s2Gv5turbo.pth` 提取语义码，再运行 `s2_train_v3_lora.py` 训练 SoVITS LoRA，并用 `s1_train.py` 从 `s1v3.ckpt` 微调 GPT。试听加载 v5turbo 底模、LoRA 和 v5 声码器。[v5 基础权重与声码器](https://huggingface.co/lj1995/GPT-SoVITS/tree/main/gsv-v5-pretrained)

两版使用同一条留出参考和相同的中日文台词。`audition/` 中的对听 WAV 统一到 48 kHz 并匹配语音电平，先播 v2，停顿后播 v5turbo。原始样音、参考音频校验值和回转写见试听记录。
