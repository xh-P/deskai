# M2 实现与验证

更新：2026-10-28。M2 代码已完成桌面接线，本地协议、状态机和模拟模型界面回放通过；真实模型语义门禁未完成。最小真实请求仍为 `MISSING_CREDENTIAL`，用户明确选择本轮保留真实模型验收未完成。下述模拟验证不能替代真实模型或真实设备验收。

## 使用

双击 `启动桌面语音对话.cmd` 或运行 `npm run desktop:dev`。可直接使用文字输入，不开启麦克风；点击“开始语音对话”后默认持续采集、自动分段、识别和提交。准备期间可以取消。识别文字经 dsh 发送给所选模型服务，原始音频只在本机处理。

M2 只把通过合法决策头的 SPEAK 正文显示为助手回复。WAIT/SILENT 只改变等待/安静状态，不插入“我保持沉默”气泡；没有沉默后主动请求模型的定时器。停止回复会调用原生取消并保持麦克风的会话状态；结束会话才释放麦克风。错误不会自动修复/循环请求，需点击“重试回复”；缺少账号后暂停自动模型请求，避免每句重复失败。

展开前的两项设置提供轻量有希风格与普通助手、自动/中/日/英回复语言。声音仍为原常态有希 v2，切人格/语言不会切声音；声音选择与逐句合成留在 M3。切换设置取消当前生成，后续请求用新配置和新 dsh Session，不重写旧系统提示词。正常模式的偏好保存在 Electron 用户数据目录，不保存模型凭据。

## 实现与历史边界

- `packages/voice-core/src/decision.ts/stream.ts`：第一行严格JSON，512 UTF-8字节、字段白名单、枚举与重复键校验；网络分块前的控制头私有缓存。WAIT/SILENT多余正文不显示，缺头/围栏/格式异常显式失败。正文内的JSON只是正文，不能当控制指令再执行。
- `config/personas/` 与 `prompts.ts`：可审查的系统模板和两张 schema 校验角色卡，应用协议、风格和回复语言分层；外来system/tool/script字段拒绝。版本与卡revision独立记录，不重新训练。
- `dialogue.ts/policy.ts`：每个有效请求至多一次决策/回复调用；本地窄停止/续播/明确等待/收尾可零调用。有效短回答和无问号的分享不按长度过滤。WAIT本地10秒过期只回到空闲，不再调模型；待回答问题可标stale，不催促。
- `delivery.ts`：生成、显示、完整已播、部分已播和未播分开保存。语音模式显示不算播放；末尾问题完整播完才 awaiting。文字模式经 renderer实际DOM确认后可 awaiting；WAIT/SILENT不会清除旧问题。迟到的旧问题确认不能在已回答/换人格后复活。
- `packages/dsh-adapter/src/session.ts`：使用固定版本真实 Session/Mux 类型，prompt受理回执与turn结束分开；reasoning排除、chunk按attempt/index去重，durable和快照不重新输出正文；显式session.cancel后等待结束，创建期取消不提交prompt。接入采用 [已核对的接口适配](./m2-dsh-contract.md)。

下一轮模型上下文只包含已接纳用户原话和已交付助手正文：voice只投影完整已播句，text投影界面已显示正文。未播生成全文保留在原dsh审计日志及本地播放账本，下一轮只带数量/中断元数据。使用每轮新Session避免未播原始历史被默认带入，无须再调用LLM摘要。当前尚无M3真实TTS播放，因此语音输入后的正文会显示，但不伪称已播或据此激活语音问题。

## 已执行的必要验证

- `npm run desktop:test`：涵盖M1输入/播放器、M2头部边界、逐帧revision、取消与迟到输出、去重、WAIT/SILENT、未播上下文排除、短回答、文字问题显示、重复重试抑制、回执晚到与后续ASR失败等确定性回归。收口前整套53项通过，随后新增的传输层必要修正及用例单独6/6通过；当前测试集合共55项。
- `npm run desktop:build`：main与renderer严格TypeScript检查、本地资源构建通过；M2未新增或升级运行依赖。
- `npm run m2:smoke`：只在显式双smoke标志下使用本地界面fixture。SPEAK正文隐藏控制头、WAIT/SILENT无气泡、文字问句显示确认、短回答、格式错误显式重试、取消、人格/语言独立、文字模式无麦克风均通过；恰好7次模拟模型请求，不将其描述成DeepSeek真实对话通过。原始证据在本机 `outputs/desktop-validation/m2/desktop-smoke-*.json`。
- M1真实SenseVoice CPU + 模拟麦克风两次会话回归已通过，播放时输入继续；最近回归在本机 `outputs/desktop-validation/m1/audio-smoke-1793169852473.json`。没有重新跑GPU训练或更换权重。
- [三语语义集](./m2-semantic-cases.md) 共57条，中/日/英各19；`npm run m2:semantics` 实际调用本地policy/core，15条PASS、42条UNTESTED、0FAIL。[逐例预期与实际](./validation/m2-semantics.json) 已随源码保存；需要真实模型或声学证据的项不复制预期值冒充actual。

自动测试输出和合成音频保留本机，未纳入Git；源码、测试fixture定义、许可和本说明纳入仓库。历史失败回放没有删除。模型请求数与provider attempt数分开统计；实际token用量取dsh usage事件，未取得真实模型数据时不虚报tokens或费用。

## 待验收与复现

真实模型的三语SPEAK/WAIT/SILENT语义、风格一致性、严格协议稳定率、真实provider取消/重连和用量尚未验收，故M2整体门禁不标为通过。物理麦克风、扬声器/AEC、自然插话成功率和主观听校也未验收，长附和仍可能达到800ms声学确认阈值并被取消。M3合成/逐句播放/换声、M4托盘与发行包、M5端到端验收仍待后续阶段。

配置模型后，可先 `npm run desktop:build`，再显式执行 `node scripts/m2/live-semantics.mjs --real-model`。此命令会把预设合成文本送到dsh已配置模型，可能产生用量，本轮未运行。它跳过需物理证据和权限实测的案例，缺凭据立即停止；报告中未跑项仍为UNTESTED。模型密钥只在dsh设置中配置，不传聊天、不写仓库。
