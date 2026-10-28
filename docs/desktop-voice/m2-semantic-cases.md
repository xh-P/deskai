# M2 语义回归案例

本文件说明人工预设的回归期待，案例本身不是模型输出，也不是已完成的运行结果。数据在 tests/voice/fixtures/m2-semantic-cases.json；报告工具只把单独采集的观察值按 ID 与预期比较。

## Fixture 约定

当前共 57 条：中文、日文、英文各 19 条。覆盖最低语义集和相同短语在不同上下文的变化：

- 天气问题、无问号的疲劳分享、思考中等待、明确仍在说话的未完句累积。
- 「嗯。」「はい。」「Yes.」在无待答问题、问题已播完、问题未播完时的不同结果；已播问题的否定回答。
- 明确停止与否定停止词、播放中的修正/插话、自然收尾以及收尾后继续提问。
- 明确对别人说话时静音；AI 播放回声；用户有近端语音复述 AI 后追问。
- 呼吸/键盘/咳嗽等非语音；明确不求答的个人笔记；要求覆盖协议的注入文本。

字段含义：

- **language** 是本例语言，**source** 是语音转写或键盘文本。
- **input** 是人工设定的转写文本；括号说明是无可辨认转写的场景标签，不是音频样本。
- **context.outputPlaying** 描述播放状态。**context.inputStillSpeaking** 表示候选输入是否仍在持续；ACCUMULATE 案例必须显式设为 true，避免只凭未完句文本推断仍未到提交门禁。**pendingQuestion.status** 使用 awaiting、unplayed 或 stale；只有问题已实际播完才应为 awaiting。**deliveryState** 给出问题是否播完和用户已听到的文本。
- **expected.route** 是默认路线：local 表示不应提交模型请求，model 表示交给单次语义决策请求。可选 **expected.routes** 列出允许路线；存在时 report 按 action 精确匹配且 route 命中该列表判定。思考中等待、自然收尾和对已播问题的明确拒答允许 local 或 model，不额外强制一次模型调用。**expected.action** 除 SPEAK/WAIT/SILENT 外，还允许本地控制结果 STOP/RESUME/ACCUMULATE/DROP。
- **expected.hard** 标记必须通过的关键期待；false 表示更适合人工复核的倾向样本。报告仍会逐例比较，不会忽略 hard=false。
- **expected.notes** 是人工判定理由，不是可执行规则或自动评分提示。

未播问题后的「嗯。」「はい。」「Yes.」仍有歧义；这些案例预期单次模型决策 SILENT，不规定本地短词过滤。声学场景的 fixture 只说明案例前提，不能证明运行时实际检测到了对应声学状态。设置了 context.acousticEvidence.requiresAudioEvidence 的案例，观察文件必须带独立运行时证据；报告会核对近端语音、回声匹配或 VAD 分类字段。仅有相同转写文字不足以通过 echo/noise 案例。固定文本回放不能代替真实麦克风、扬声器与 AEC 验收。

注入案例设置 context.permissionCheck = "unchanged"。观察文件须记录处理前后的能力清单；报告要求两份快照一致，不预设当前能力清单为空。语义动作/路由之外的应用权限未变化，必须以这些运行时快照为证据。

## 观察文件与报告

观察 JSON 必须独立于 fixture，schemaVersion 为 1，并提供非空的 observationSource。每个已执行案例只写实际捕获的 actual.action 和 actual.route；不得从 fixture 复制 expected 充当 actual。evidence 应来自本地策略执行轨迹、实际 dsh 响应/协议记录或独立运行时快照，不能由模型评价自己的行为。

普通决策案例示例：

    {
      "schemaVersion": 1,
      "observationSource": "m2-core-replay",
      "cases": [
        {
          "id": "zh-hard-stop",
          "actual": { "action": "STOP", "route": "local" },
          "evidence": { "event": "stop-command", "modelRequestCount": 0 }
        }
      ]
    }

声学案例须额外记录运行时声学依据，例如 evidence.acousticEvidence 中的 basis、nearEndSpeech、echoOnly、playbackReferenceMatched 或 vadClass。注入案例须包含 evidence.permissionsBefore 与 evidence.permissionsAfter 字符串数组。

从项目根目录运行：

    node scripts/m2/semantic-report.mjs
    node scripts/m2/semantic-report.mjs --observed path/to/observed.json
    node scripts/m2/semantic-report.mjs --observed path/to/observed.json --format json

不传观察文件时所有案例都显示 UNTESTED。报告不会生成模拟实际值，也不会调用 dsh 或任何模型。缺少观察记录是 UNTESTED；非法/重复记录是 INVALID；预期 action、允许 route 或必需证据不同是 FAIL；匹配才是 PASS。未知 ID 记作 UNEXPECTED。存在 FAIL、INVALID 或 UNEXPECTED 时退出码为 1；输入格式错误退出码为 2。全未测试时不会伪报失败或通过。全量未运行快照保存在 outputs/desktop-validation/m2/report.json，应显示 57 条 UNTESTED。

