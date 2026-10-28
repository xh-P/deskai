# 消失版长门有希 · v5 Turbo 训练

2026-10-24：已导入用户指定的两份标注并完成特征提取。**GPT 微调 + v5 Turbo SoVITS LoRA** 已从原断点续训完成：SoVITS 共8轮、GPT 共15轮。训练输出保存在weights目录。首次GPT启动遇到Windows单卡DDP通信错误，已修复单卡策略与采样器并补跑完成。

## 双击入口

- 项目根目录 `启动长门v5训练.cmd`：校验输入和参数，后台依次训练 SoVITS、GPT。
- `查看长门v5训练进度.cmd`：查看阶段、状态和最近日志。
- `停止长门v5训练.cmd`：只停止本项目进程树，保留权重。再次启动从最近完整检查点恢复，当前未保存的一轮会丢失。

原英文入口仍可用。无需手动激活 Conda。后台训练不依赖聊天或启动窗口保持打开，完成后自行退出。保持电脑开机、接电；脚本阻止空闲休眠，但主动睡眠、合盖策略或重启仍可能中断。

## 数据与处理

使用 `lexical_consensus_candidate.list` 的244条与 `Nagato_short_no_asr_warnings/short_machine_draft.list` 的93条并集，共 **337条，约16分30秒**。无重复或文字冲突。长标注包相对WAV路径缺失，已按文件名和SHA256映射回原始音频；文字不改写。这些是双ASR一致的机器候选，不是人工听音确认集。

随机种子1234，固定留出 **17条3–10秒普通对白**供训练后试听；其余 **320条，原始时长约15分11秒**训练。所有93条短回应都进入训练。留出集不参与训练，也不是自动计算的验证分数。

仅在训练副本中，将 **36条不超过0.66秒**的音频尾部补零静音至0.70秒，兼容SoVITS分桶的32帧下限，总共增加约4.07秒。8条超过12秒的样本保留，最长14.68秒。原始录音及标注不动。上游特征提取按自身流程重采样和处理音量；22.05kHz源音频不会因此恢复缺失的高频。

## 参数与理由

**SoVITS：** v5 Turbo底模，LoRA rank/alpha均16，AdamW学习率 `0.0001`，batch 1，FP16，开启梯度检查点，**共8轮，每2轮导出权重（2/4/6/8）**。batch 1和检查点控制8GB显存占用；每轮320次更新。v5声码器使用预训练权重，不另外训练。

**GPT：** 共用 `s1v3.ckpt` 底模，batch 1，**累积4条再更新**，`16-mixed`，ScaledAdam固定学习率 `0.002`，**共15轮，每5轮导出权重（5/10/15）**，关闭DPO。320条对应每轮约80次、合计1200次优化器更新；已完成的第5、10轮权重原样保留。

ScaledAdam的0.002不能与AdamW的0.0001直接比较。上游原实现首步0.01、之后调度器写死0.002，YAML暖启动字段不按字面生效。本地新增可选 `optimizer.fixed_lr`，使首步及后续均为0.002；新增 `train.accumulate_grad_batches`，修正4条更新边界并在每轮末尾处理不足4条的情况。保留上游累加loss方式；没有设置新选项时保留原行为。修改记录在上游补丁中，已通过无GPU的边界测试。

GPT的 `max_sec=54` 保留上游过滤窗口，避免其附带的音素总数限制误丢长句；本次实际最长只有14.68秒，不代表输入54秒音频。数据读取worker为1。

保留各保存轮的推理权重，完整续训断点只留最近一份以节约磁盘。续训前原始配置、SoVITS第2轮和GPT第10轮完整断点、SoVITS第2轮及GPT第5/10轮推理权重已备份到 `backups/pre_extension_20261024-043317/`，附原文件SHA256清单。SoVITS断点包含模型、AdamW状态和已完成轮数，第2轮之后从第3轮开始；其学习率调度器按保存时的优化器学习率前进一步。上游SoVITS断点**不含 GradScaler 状态**，续训时缩放器重新初始化。GPT的Lightning断点包含模型、ScaledAdam、调度器、混合精度和训练进度，第10轮之后从第11轮开始。最终完整断点内部记录SoVITS第8轮/优化器步数2560、GPT第15轮/全局步数1200；新增推理权重内部轮数与文件名一致。原有12份推理权重均通过SHA256确认未改动，完整记录在 `checks/training-completed.json`。轮数不保证最优；接下来比较各轮、留出对白、新文本及现成v2。不要只按最后一轮或最低loss选模型。

实际配置：`configs/sovits.json`、`configs/gpt.yaml`。改配置后需重跑真实数据检查；启动器会拒绝与检查记录不一致的配置。

## 目录

- `assets/`：原录音、标注包和现成v2模型，保持原状。
- 本目录 `inputs/`：两份清单快照、来源/哈希、补静音与划分记录。
- `labels.list`：337条合并清单；`train.list`：320条训练；`holdout.list`：17条试听。
- `audio/`：训练/试听副本；`features/<标注哈希>/`：音素、HuBERT、32kHz音频和语义编码。
- `weights/sovits/`、`weights/gpt/`：各轮推理权重。
- `checkpoints/gpt/ckpt/`：GPT续训断点。
- `features/<标注哈希>/logs_s2_v5turbo_lora_16/`：SoVITS续训断点，不能当临时缓存删除。
- `logs/`：后台训练日志；`status.json`、`worker.json`：运行状态。
- `checks/`：准备日志、真实数据加载和前后向检查；`environment/`：依赖、版本及上游补丁。

## 检查与复现

独立Conda环境 `E:\workspace\deskai2\.conda\gsv-v5`，原有gpt_tts环境未修改。上游提交固定为 `b4570b876f5c086819ba84e3215472733c6a7b70`。

`prepare-nagato-v5.cmd` 可重新生成特征和配置。输入改变后应重跑以下检查；已有训练断点时不要混用新标注，应新建实验。

```powershell
& E:\workspace\deskai2\.conda\gsv-v5\python.exe E:\workspace\deskai2\scripts\gsv_v5\check_training_data.py --data-only
& E:\workspace\deskai2\.conda\gsv-v5\python.exe E:\workspace\deskai2\scripts\gsv_v5\check_training_data.py --stage sovits
& E:\workspace\deskai2\.conda\gsv-v5\python.exe E:\workspace\deskai2\scripts\gsv_v5\check_training_data.py --stage gpt
```

真实loader核验：SoVITS与GPT均实际纳入320条，无loader、分桶或音素比例过滤；全部特征和实际batch校验通过。极值真实样本检查进行前向/反向和优化器初始化，不执行optimizer.step、不保存模型，不能替代整轮训练、首次优化器状态分配、断点恢复和音质验证。检查结果以 `checks/real-data-*.json` 的success为准。

官方依据：[WebUI默认配置](https://github.com/RVC-Boss/GPT-SoVITS/blob/b4570b876f5c086819ba84e3215472733c6a7b70/webui.py)、[LoRA训练器](https://github.com/RVC-Boss/GPT-SoVITS/blob/b4570b876f5c086819ba84e3215472733c6a7b70/GPT_SoVITS/s2_train_v3_lora.py)、[GPT训练模块](https://github.com/RVC-Boss/GPT-SoVITS/blob/b4570b876f5c086819ba84e3215472733c6a7b70/GPT_SoVITS/AR/models/t2s_lightning_module.py)。本次组合是适配机器和数据的首轮配置，不是官方给该角色的最佳参数。
