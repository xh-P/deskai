# 角色编辑、会话归属与知识检索

2026-11-12 完成 H1 和 H4 的第一版框架。当前演示使用「长门有希 · 主线消失后」和三条《消失》资料。[实现提交 4f01f80](https://github.com/xh-P/deskai/commit/4f01f8020fdf11205c24ffb7ece5bd43b5f3bc9f) · [任务清单](./optimization-backlog.md#h-角色定义与知识)

## 实际完成

- **H1** 桌面的「角色编辑」可创建角色，或编辑现有角色的显示名称、性格与表达方式。更新生成一个新版本。会话保存角色卡快照、关系模式和最多 12 条已交付历史，重新打开时以其记录的角色继续。新会话使用所选角色的最新版本。角色和对话记录分别写入应用用户目录的 `characters.json` 与 `conversations/`。dsh 的通用对话 preset 每轮读取该会话的角色与关系，上下文同时用于正式对话和候选回复。[角色与会话存储](../../apps/desktop/src/character-store.ts) · [上游角色存储](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/core/character_profiles.py) · [上游会话归属](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/docs/character-runtime.md)
- **H4** 本地 CPU 使用 `multilingual-e5-small` 的 ONNX 导出、归一化向量与 FAISS 距离检索。角色 ID 选择语料，命中的片段以带定位的 `characterReference` 进入本轮 Chat。检索开关默认关闭，索引缺失或未命中时继续普通对话。「角色知识」显示本轮命中数、距离和出处。示例库配置最多两条，平方 L2 阈值为 `0.29`。病房细节从角色卡的固定背景移入检索库，以便验证开关的实际影响。[本地检索](../../services/character-knowledge/knowledge.py) · [三条资料](../../config/character-knowledge/nagato-mainline-post-disappearance.json) · [出处核查](./character-research/nagato-novel-sources.md#两部中文版-epub-正文核查) · [上游角色 RAG](https://github.com/Code-Amadeus/Amadeus/blob/be9b97aef2ac3affb200998f8af3aab72aa22f6c/core/character_rag.py)

## 验收入口

运行 `npm run desktop:prepare-knowledge`，再用 `npm run desktop:dev` 启动。准备脚本用 `uv` 创建独立的 Python 3.12 环境，下载并校验约 465 MiB 的 ONNX 模型和 tokenizer，构建索引到 `.cache/character-knowledge/`。若下载需要代理，可为本次命令设置 `DESKAI_KNOWLEDGE_DOWNLOAD_PROXY`。语料更新后重新准备索引。[准备脚本](../../scripts/desktop/prepare-character-knowledge.mjs) · [固定模型版本](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx)

选择「长门有希 · 主线消失后」，打开「角色知识」切换检索。用「新会话」分别发同一句话，可以看到命中来源和真实回复。保存角色编辑后，打开新会话试新版本，或从「已有会话」继续原版本。

## 验证结果

- 使用同一 dsh 路由 `deepseek-account / deepseek-flash` 和长门第 4 版的朋友模式，三条问题各在两个全新文本会话中做开关对照。「今天有点累」开启后未命中，双方都自然建议先休息。「上周一起看烟火」也未命中，两次都没有确认这段经历，关闭时的回复仍用了「之前聊过」的笼统说法。[最后一次真实模型对照](../../outputs/desktop-validation/characters/character-e2e-1794428792554.json)
- 病房问题关闭时回复无法确认，前一次同设置还把所问承诺答成圣诞聚会。开启时稳定命中病房资料，最终答出阿虚会设法找回被带走的长门，并给出中文 EPUB 第六章 `chp6-2.xhtml` 第 47–82 段。一轮命中后出现听者身份混淆，提示词明确角色和用户的归属后，最后一次回答用「我」指长门。[较早一轮对照](../../outputs/desktop-validation/characters/character-e2e-1794428558850.json) · [最后一次对照](../../outputs/desktop-validation/characters/character-e2e-1794428792554.json)
- 样例索引验证了中文和日文病房提问命中。原来的 `0.33` 阈值在初测放行了日常话题，加入日文别名并校准阈值后，中文日常、共同经历、技术问题和日文日常均未命中。最后一次真实对照中首次 CPU 检索含进程和模型加载约 1.75 秒，后两次 6–10 ms。[语料配置](../../config/character-knowledge/nagato-mainline-post-disappearance.json)
- 临时编辑第 5 版后，重开旧会话仍是第 4 版、朋友模式及两条已交付消息。新会话采用第 5 版和阿虚模式，真实模型给出了只在临时编辑中加入的短句。复现命令为 `node --experimental-strip-types scripts/desktop/character-e2e.mjs --real-model`。[真实对照探针](../../scripts/desktop/character-e2e.mjs)
- Luna Max 的隔离桌面对话冒烟 12 项通过，包含 `characterEditPinned`。45 项定向检查通过，覆盖角色和历史重开、资料缺失降级、dsh/OpenAI-compatible 路由以及投机回复。[桌面冒烟](../../outputs/desktop-validation/m2/desktop-smoke-1794428226537.json) · [定向检查](../../tests/voice/chat-runtime.test.ts)

## 仍需物理设备验收

在真实麦克风、扬声器和持续语音中复核命中后的首句时延、插话取消和听感。语料依据当前核查过的小说中文 EPUB 定位，原作日文措辞与动画对应需另查。
