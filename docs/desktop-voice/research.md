# 桌面语音 AI：开源方案调研笔记

日期：2026-10-25  
目标栈：SenseVoiceSmall（CPU、整句 ASR）→ DeepSeek（文本 LLM）→ GPT-SoVITS v2（语音合成）；默认角色“有希”，可切换声音。  
范围：只读查看官方文档、官方仓库及官方 LICENSE；未克隆仓库，未做实验。本笔记是架构参考，不代表这些项目已在目标机器上验证。

实施优先级：以下包含开源项目的可选能力，不全部进入首版。最终范围以 [product.md](./product.md)、[turn-policy.md](./turn-policy.md) 和 [prompts.md](./prompts.md) 为准：默认自动对话，不依赖唤醒词/按键；无主动发言定时器；不做自动长期记忆；不能按短词或未提供的置信度直接屏蔽用户回答。

## 结论摘要

先把三个不同问题分开：

1. **轮次检测**：用户开始说话了吗、这句话结束了吗、用户是在句中停顿还是说完了？
2. **打断处理**：有希正在说话时，用户的声音是否应立即让有希停下？短促的“嗯”“对”可能是附和（backchannel），未必是抢话。
3. **回应策略**：用户说完后，有希要回答、只记录而不说，还是在允许的时机主动开口？

Pipecat 和 LiveKit 的 turn detection / interruption 主要解决前两项；它们不会自然地替应用定义“有希在什么社交情境下保持安静”。LiveKit 明确提供了不生成回复的入口，但触发条件仍由应用决定。

对指定栈，**整句 ASR 不会单独提供低延迟的抢话信号**。应另有本地 VAD 监视音频；ASR 负责结束后提供文字，VAD 负责及时暂停/取消 TTS。第一版可用规则和 VAD 先行，再按实际需要加本地 Smart Turn 一类结束判断器。

节省 LLM 调用的关键是：高置信的静默场景由规则直接短路；不确定的社交表达若需要模型判断，把“决定静默或说什么”合在同一次 DeepSeek 生成中。不要先问一次 LLM“要不要回答”，再问一次“回答什么”。TTS 只合成最后确认要说的文本；无需对候选回复做预合成。

## 四个项目的可借鉴点

### 1. Pipecat：本地 CPU 轮次分析与显式打断帧

Pipecat 把用户轮次开始/结束策略作为可替换组件。当前代码中的默认开始策略是 VAD 与转录信号，默认结束策略使用 LocalSmartTurnAnalyzerV3；文档说明 Smart Turn 在 VAD 检测到停顿时查看最近音频，判断用户是否说完，并提供本地 ONNX/CPU 路径。文档声称 v3 在普通 CPU 上推理可低于 100ms、支持 23 种语言；这不是本项目的实测结果，且中文普通话是否在实际模型支持范围内，应在接入前核实。

- **可以借用**：把 VAD 开始、结束判断和打断事件分别表示；单纯静音阈值可作为基线，停顿误切较多时再用本地 Smart Turn 做结束判定。
- **注意语义边界**：VAD 起音触发 interruption 说明“有人开始说话”，不等于识别出用户有意抢话，也不等于决定 LLM 应答。短的咳嗽或附和可能造成误打断。
- **适配目标栈**：Pipecat 是流式音频帧管线。可借鉴策略与事件模型，但不必为批量整句 ASR 搬入整套 transport/pipeline；把连续 PCM/VAD 窗口送入本地门控，最终 ASR 文本只提交一次即可。避免照搬基于临时转录的抢跑生成，否则文本变化会带来作废 LLM 请求。
- **源码与许可证**：目标源码快照 60999e29fa1e6c890f4beb46f50950a5464ac1cf。主要文件：[user_turn_strategies.py](https://github.com/pipecat-ai/pipecat/blob/60999e29fa1e6c890f4beb46f50950a5464ac1cf/src/pipecat/turns/user_turn_strategies.py)，策略文档：[User Turn Strategies](https://docs.pipecat.ai/api-reference/server/utilities/turn-management/user-turn-strategies)，[Smart Turn Overview](https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview)，根许可证：[LICENSE](https://github.com/pipecat-ai/pipecat/blob/60999e29fa1e6c890f4beb46f50950a5464ac1cf/LICENSE) 为 BSD 2-Clause。

### 2. LiveKit Agents：把端点、打断、预生成分别配置

LiveKit 文档把端点等待、用户打断、误打断恢复和预生成分别列为 turn-taking 配置。其 Turn Detector 使用语义和声学信号判断结束；VAD、STT endpointing 和手动控制是其他选项。Interruption 可以用 VAD（检测到语音就触发）或 adaptive 模式（用音频模型区分真正打断和 backchannel）；误打断可在静默超时后恢复原语音。文档中的默认端点范围是最少 0.5 秒、最多 3 秒，适合作为概念参考，不是目标环境的推荐定值。

- **回应或静默是另一层**：Python 可用 commit_user_turn(skip_reply=True) 只提交转录而不自动回复；也可在 on_user_turn_completed 中因空输入抛出 StopResponse。这证明响应决策应可与转录/端点分离，但有希的“哪些内容应静默”仍需本地规则或一次生成内的决策。
- **调用成本提醒**：LiveKit 当前文档将 preemptive generation 描述为默认开启。它可在轮次最终确认前启动 LLM，取消时会浪费生成；preemptive TTS 会再增加被取消的合成成本。目标 ASR 是整句提交，先关闭抢跑生成更省调用；只有测得延迟确实需要时再评估。
- **可借用 / 不必照搬**：借鉴独立的端点、interrupt、false-interruption recovery 开关和可观察事件；不用为桌面单机整套引入 LiveKit room/transport。Adaptive interruption 使用额外音频模型，部署和费用取决于 LiveKit 的运行方式与额度，不等于免费本地能力。
- **源码与许可证**：目标源码快照 1f514fdec6dadd47c50a028b9d2c0f6fc432707a。配置定义在 [turn.py](https://github.com/livekit/agents/blob/1f514fdec6dadd47c50a028b9d2c0f6fc432707a/livekit-agents/livekit/agents/voice/turn.py)，会话装配在 [agent_session.py](https://github.com/livekit/agents/blob/1f514fdec6dadd47c50a028b9d2c0f6fc432707a/livekit-agents/livekit/agents/voice/agent_session.py)。官方文档：[Turns overview](https://docs.livekit.io/agents/logic/turns/)、[Turn-taking tuning](https://docs.livekit.io/agents/logic/turns/tuning/)、[Turn handling options](https://docs.livekit.io/reference/agents/turn-handling-options/)。根 [LICENSE](https://github.com/livekit/agents/blob/1f514fdec6dadd47c50a028b9d2c0f6fc432707a/LICENSE) 为 Apache-2.0。

### 3. SillyTavern：角色卡与上下文提示词分层

SillyTavern 文档将角色描述、性格、场景、角色主提示词、角色历史后提示、用户 persona、示例对话、聊天历史和 World Info 分为不同输入位置。World Info 可以按关键词动态激活，也有预算控制；文档建议内容简洁。这个组织方式适合借鉴为有希的可编辑角色卡和 prompt 组装器。

- **可借用**：把“有希是谁、怎么说话、当前用户资料、可检索的关系/事件记忆、近期对话”分开存；稳定的性格与语气留在角色配置，用户/关系记忆按需检索并短摘要注入，近期对话作为滚动上下文。
- **不适配**：它是文本聊天前端，不提供桌面麦克风 VAD/打断决策。World Info 的关键词插入和角色扮演式故事模板可作为模式参考，不能替代语音 turn policy。角色卡本身也不应无限增长；每次请求只带必要的人设、记忆和对话窗口。
- **声音配置建议**：将“有希的人格/说话风格”与 GPT-SoVITS 的 speaker/voice ID 分开存。切换音色只改 TTS 配置；如果某些音色对应不同说话风格，再额外关联风格说明，而不把声音 ID 写死进通用系统提示词。
- **源码与许可证**：目标源码快照 06bde939fb1e9c4c8d8641d810f0a916b5bce127（release）。示例默认提示词顺序见 [default/content/settings.json](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/default/content/settings.json)。官方文档：[Character Design](https://docs.sillytavern.app/usage/characters/characterdesign/)、[Context Template](https://docs.sillytavern.app/usage/prompts/context-template/)、[Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)、[World Info](https://docs.sillytavern.app/usage/worldinfo/)。根 [LICENSE](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/LICENSE) 为 GNU AGPL v3。

### 4. AIRI：桌面语音链路的职责边界

AIRI 是桌面/网页陪伴型项目，最有价值的材料是其 2026-10-16 语音输入 ADR。该设计把语音拆成 Capture、Signal、Policy、Runtime、Projection：采音和播放不做决策；VAD/ASR/结束判断等给出证据；纯规则 Policy 根据状态和事件决定开始、结束或取消；Runtime 执行命令；UI/trace 是事件流的投影。ADR 还主张把 VAD、唤醒词和打断 fade 放在设备侧，让打断不等待远端策略。

AIRI 的 core-agent README 另外展示了在识别文本变化时提前启动 memory.search、在输入定稿时复用仍匹配的检索结果并 attach 到本轮。这个思路可与 ASR 同步做检索，降低等候时间，而不多做一次 LLM 判断。需要谨慎：这是仓库文档/设计的描述，不是本项目性能验证。

- **可以借用**：把所有音频状态变成带 input/turn ID 的事件；把策略写成可单元测试的状态转移；快速的本地打断只执行一次，再上报事件；失败的慢速信号不能卡住采音和播放。
- **目标栈的取舍**：SenseVoice 整句 ASR 可作为 final transcript signal；DeepSeek 保留在实际需要回应的生成路径中。若记忆检索要先完成，可只检索小型索引并加入 prompt，不应让远程规则服务决定是否及时停播。
- **源码与许可证**：目标源码快照 74ddd90c04deed806eaef1e89a2b7ecaac529ba9。参考 [voice input layers ADR](https://github.com/moeru-ai/airi/blob/74ddd90c04deed806eaef1e89a2b7ecaac529ba9/docs/ai/adr/2026-10-16-voice-input-layers.md) 与 [core-agent README](https://github.com/moeru-ai/airi/blob/74ddd90c04deed806eaef1e89a2b7ecaac529ba9/packages/core-agent/README.md)。根 [LICENSE](https://github.com/moeru-ai/airi/blob/74ddd90c04deed806eaef1e89a2b7ecaac529ba9/LICENSE) 为 MIT。

## 对目标桌面语音栈的实操建议

### 轮次与抢话

- 连续读取麦克风 PCM，使用本地 VAD 标记讲话开始和停顿。VAD 触发只改变录音/播放状态，不直接启动 LLM。
- 停顿后由静音阈值确定候选结束；若实际对话经常在句中停顿后被截断，再评估本地 Smart Turn。Smart Turn 判断的是音频结束/继续，不是“这句话值得回应吗”。
- SenseVoiceSmall 在候选结束后处理整句。用户在有希 TTS 播放时持续讲话，则先让播放快速 duck/停止并继续收音；若只是极短声音，可暂缓取消并设置短超时恢复，减少咳嗽或附和造成的假打断。实际阈值应通过本地录音和 trace 调整，本笔记未做测试。
- 对“嗯、对、好”等常见附和，仅在没有待回答问题、上下文明确是听者附和时才本地短路；不能仅凭短语表过滤。它们可能是有效确认回答。需要语义理解时走单次决策/生成；历史处理按 turn-policy 的 submitted 边界执行，不能为了记录附和额外触发一次模型回应。

### 静默与主动插话

建议一个便宜的本地响应门控，只有下面“不确定且值得聊”的场景才交给 DeepSeek：

- 无有效转录或可信的纯噪声：静默，不调用 LLM。短填充词按上下文处理；只有接口确实提供并经校准的置信度才可使用，不为 SenseVoice 接口臆造 confidence 字段。
- 唤醒词、快捷键/按键、明确称呼有希、问题或命令：按普通回应路径调用一次。
- 普通闲聊陈述：由“陪伴模式”配置决定是否进入 LLM。若进入，可要求同一次 DeepSeek 响应返回 SILENT 或待朗读文本；若返回静默标记就不调用 TTS。模型是在唯一一次生成中同时选择“说或不说”和产出候选话术。
- 后续若用户明确要求主动插话（例如定时问候），才考虑独立、低频的调度器。首版没有此定时器，WAIT/SILENT 不触发自动追问或模型重试。

### 有希人设、音色和记忆

角色提示词建议只保留稳定且短的内容，按层组装：

1. **运行规则**：回应条件、沉默标记格式、工具与安全边界、文本必须适合口语朗读。
2. **有希角色卡**：身份、性格、与用户关系、语气节奏、默认简洁度；加少量高质量示例，而不是长篇重复定义。
3. **当前状态**：选定的音色 ID、陪伴模式、用户显式偏好、当前任务/场景。音色是 TTS 配置；提示词只描述语言风格与发声习惯。
4. **按需记忆**：简短用户资料 + 与本轮相关的历史事实；检索结果附时间/来源，避免将大量历史每次全部塞入上下文。
5. **近期对话**：有限的最近轮次。仅在超出上下文或某个明确节点时摘要，不要求每轮单独调用 LLM 做摘要。

尽可能在一次最终请求中拼入本轮所需的检索结果和上下文，再让 DeepSeek 返回“静默或 spoken text”。不要把模型内部决策解释读出来；如 API/解析方式支持结构化输出，可用 action、text、emotion 字段，其中 action=silent 时跳过 TTS。若普通聊天接口不方便保证 JSON，则用一个不会与正常口语冲突的固定静默标记，并在 TTS 前剥离/处理。

## 参考及许可证核对说明

本次只核对上述官方仓库根目录 LICENSE，许可证名称分别为：Pipecat BSD 2-Clause、LiveKit Agents Apache-2.0、SillyTavern AGPL-3.0、AIRI MIT。引用代码或打包其资源前，仍需查看对应具体文件、依赖、模型权重、字体、音频和素材各自的许可；本笔记不对这些子项作推断。

提交号是调研时从各官方远程仓库分支读取的快照标识，文中的代码链接固定到该提交。项目文档链接可能随后更新。

