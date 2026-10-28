# 常态长门有希 · v5 Turbo

本实验在独立目录训练常态时间线长门有希。已有消失版项目及其权重保持原样。

## 数据

数据来自 `assets/The Melancholy of Haruhi Suzumiya/Nagato_Normal_v2.zip`，59 条录音约 4.05 分钟。ASR 标注报告中的 46 条双模型词面一致候选（约 2.52 分钟）进入标签清单；其余 13 条不一致项目留给人工复核，不参加训练。候选仍是机器转录，未逐条人工听校。源音频、标签、分割和处理副本都有 SHA256 记录。

以随机种子 1234 从候选普通对白中留出 4 条（3–10 秒），训练 42 条。留出样本只用于听测，不用于训练。SoVITS 数据加载器会将小于 100 条的集合复制到至少两份；本数据集每轮读入 84 行，包含 42 条原始训练音频各两次。没有音频被 SoVITS 采样器或 GPT 数据集过滤。只有不超过 0.66 秒的训练音频在副本末尾补静音到 0.70 秒。

## 训练

使用项目本地 `.conda/gsv-v5` 环境和共享 v5 Turbo 底模。SoVITS batch 1、FP16、梯度检查点、LoRA rank 16、学习率 0.0001，共 8 轮，每 2 轮导出。实际共 672 个 batch step。GPT batch 1、梯度累计 4、16-mixed、固定学习率 0.002，共 15 轮，每 5 轮导出；最终 Lightning checkpoint 记录 315 次优化器更新。

推理权重位于 `weights/sovits/` 和 `weights/gpt/`；继续训练状态位于 `features/<标签哈希>/logs_s2_v5turbo_lora_16/` 和 `checkpoints/gpt/ckpt/`。实际配置在 `configs/`。完成状态、配置、训练数据检查、权重哈希和训练指标记录于 `checks/training-completed.json`。GPT 最终训练 loss/top-3 accuracy 是训练集指标，不是独立验证分数。

## 同文本听测

`outputs/nagato_normal_v5_comparison/20261024-155156-normal/` 有训练后 v5、v5 Turbo 底模和正确的常态有希 v2 输出。使用同一段常态有希参考音频、两条相同日语测试文本和相同推理参数；第一条是未参与训练的留出文本，第二条是新句子。`*_v5_trained_then_v2_normal.wav` 将训练后 v5 放在前、v2 放在后，中间留 0.8 秒。原始各模型 WAV、逐项指标和推理配置也保留。

可复跑的入口：

- `scripts/gsv_v5/prepare_normal_inputs.py`：校验源包和 ASR 来源，独立快照常态有希标签。
- `scripts/gsv_v5/normal_manage.py audit|prepare|preflight|train`：常态有希专用项目上下文。
- `scripts/gsv_v5/normal_check_training_data.py --data-only|--stage sovits|--stage gpt`：检查实际数据加载和真实样本反向传播。
- `scripts/gsv_v5/audition_normal.py`：与常态 v2 使用相同参考和文本试听对比。
