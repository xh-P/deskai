# M1 运行与验证

本文保留 M1 交付时点的结果；后续 M2 接线状态以 [M2 验证](./m2-validation.md) 为准。

更新：2026-10-28。M1 代码与自动验证已完成，物理设备验收未完成。当前桌面提供自动监听/分段/转写和插话测试；SPEAK/WAIT/SILENT、人格、dsh 对话回复、逐句 TTS 与换声桌面集成属于后续 M2/M3，尚未接入。

## 启动、结束与恢复

双击根目录 `启动桌面语音对话.cmd`，或在项目根运行 `npm run desktop:dev`。启动器先静态检查、构建本地 React/Electron，再打开窗口。应用打开时不录音；点击“开始对话”才启动所属 dsh Host、准备本地模型并请求麦克风，之后自动识别，无须按住说话。准备期间可点击“取消准备”。

“结束对话”停止 track、销毁 VAD/播放器并作废迟到 ASR；可重新开始。关闭窗口会关闭本应用创建的 dsh 进程树，保留外部已有 dsh 和原训练/试听入口。设备断开或 VAD 超载会释放麦克风并给出错误，后台 dsh 失联会结束本次会话，可重新开始。语音服务保留热模型时允许下一次快速开始。

本机已安装固定版本依赖；新环境先运行 `npm install`，Electron45需另外执行 `npm exec --no -- install-electron` 下载官方二进制。Node 版本遵循 package.json。开发启动使用已有独立 Node24.16运行 dsh，而不使用 Electron 内嵌 Node；桌面 ASR 不要求先开 TTS 或训练进程。首次 SenseVoice 下载约241.4MB，本地缓存可复用。启动不依赖 CDN；此入口尚不是可分发安装包。

“播放插话测试音频”播放既有常态有希参考 WAV，不是 AI 生成回复。播放期间仍采集，候选语音暂时暂停，空 ASR/短附和恢复未播位置，持续语音或独立停止意图确认后清空旧 generation。800ms 持续 VAD 的初始规则可能把较长附和判成抢话，确认后不会复活旧音频，需用真实噪声/附和校准；不宣称该策略已适合任意设备和房间。

## 实现位置

- `apps/desktop/src`：窄IPC、权限/本地页面限制、服务与输入协调；同一个轮次控制器跨会话复用，取消的 ASR 结束前不启动下一任务。
- `apps/desktop/renderer/src`：React、同一个 AudioContext 的采集与PCM播放、有界逐帧 Silero v5。VAD模型线程1，最多8个512样本帧；过载显式结束采集，不无声丢帧。
- `packages/voice-core/src`：250ms起音缓冲、600ms候选结束、明显未完成文本1200ms窗口、20秒/实际catalog上限切片、revision合并/撤销资格、串行有界队列、32/48k→16k流式重采样及规范PCM16 WAV。
- `packages/dsh-adapter/src`：固定dsh版本的实际Gateway RPC/Mux协议与认证、SenseVoice准备/状态/转写和所属进程清理。凭据不传renderer，正常模式不落原录音。
- `third_party/voice-runtime`：固定vad-web/ORT/Silero许可来源；构建从lockfile对应包复制本地模型、worklet、WASM。

## 实际检查

- `npm run desktop:test`：25项通过。覆盖续说时ASR保留/按顺序合并、未完成句不被ASR句号误判、资格撤销、长片不触发回答、窄停止语、两种“嗯”、短假起音、候选恢复、generation丢弃、ASR失败/溢出后恢复、跨会话取消串行、PCM释放、重采样抗混叠、WAV格式、VAD串行与队列上限。
- `npm run desktop:build`：main与renderer严格 TypeScript 检查和本地生产构建通过。
- `npm run desktop:smoke`：显式 Chromium fake-media + 已有 v2 WAV 输入；运行真实本地 Silero/AudioWorklet/dsh SenseVoice CPU。两次开始/结束/重开均完成自动识别与字幕，播放期间继续采集，旧generation被清空；[回放报告](../../outputs/desktop-validation/m1/audio-smoke-1793168746910.json)。共500帧、4个ASR片段、216帧在播放期间采集，两轮转写资格通过。ASR首次含唤醒约1.433秒，其余片段约57–132ms；不据此推导p95或用户端首声延迟。
- 起音检查使用合成源与捕获片段的波形相关，而不把“识别文字完全一致”当起音证明。本次相关系数0.918，首音前保留约119ms；自动语言识别曾把带日语口音的中文开头短句识别成日语，旧失败报告仍保留。自动语言/文字准确度与音频是否被裁剪是两个问题，仍需真人语音测试。
- `node scripts/desktop/asr-cancel-probe.mjs`（先build）：服务启动前/启动中取消均通过；真实CPU转写中HTTP abort约55ms被观察到，下一条转写约1.373秒恢复且与基线相同，[结果](../../outputs/desktop-validation/m1/asr-cancel-probe.json)。没有独立Provider取消确认，因此不宣称底层计算在55ms内已停止。
- 模拟回放结束后检查本应用Electron/dsh/TTS任务进程，无所属残留；未杀外部已有服务。原 `npm start`、训练/试听脚本用途保留。

模拟图像：[桌面回放截图](../../outputs/desktop-validation/m1/desktop-smoke.png)。测试音频和诊断截帧均来自明确的合成fixture；真实用户语音不默认落盘。自动回放验证需要已有Conda/SciPy进行波形对齐，这不是普通桌面启动的额外要求。

## 仍未验收

真实麦克风起音/权限/设备拔插、耳机与扬声器、自播回声环、自然插话成功率、AEC和主观听校都没有通过证据。请求 `echoCancellation/noiseSuppression` 并显示 getSettings，不代表AEC有效。当前没有声纹或多人定向能力。

M0真实模型门禁仍未完成，详见 [M0报告](./m0-validation.md)；M1不会把有效转写擅自送给模型，也不会对每句话固定回答。后续 M2 需在当前资格出口接入单次决策/回复，保留 WAIT/SILENT 和已播历史规则；M3 接入已验证的 v2 worker 后才成为完整语音对话链路。
