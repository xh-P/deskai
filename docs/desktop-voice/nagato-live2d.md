# 长门有希 Live2D

## 新版常服交互审阅

在项目根目录运行 `npm run desktop:preview-nagato`，打开终端显示的本地网址。首次准备 Cubism Core 时先运行 `npm run desktop:prepare-live2d`。选「上半身」并点「轻风待机」，可同时观察四秒循环里的发梢、袖口、裙摆、短暂侧视和眨眼。预览也支持转头、手动眨眼、开关眼镜和右臂抬手。角色页可通过「导入模型」打开小样。[模型清单](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.model3.json)

常服使用 76 个网格、35 个参数。参考虹色真央的局部跟随和短促眨眼，三组刘海、左右侧发、后颈发束、左右飘带、开衫下摆、裙摆及左右袖各有弯曲变形器与独立的物理响应。刘海和发影共用变形器，每侧袖子和手腕也一起变形。轻风动作驱动物理输入，另有独立的双眼开合和视线轨道。停止后眼神回正，衣发逐渐收住。手动转头也会带动发梢。[虹色真央](https://www.live2d.com/zh-CHS/learn/sample/niziiro-mao/) · [Cubism 物理](https://docs.live2d.com/en/cubism-editor-manual/physics-operation/)

小样从已审阅的 72 层常服 PSD 起模，加入四张 GPT 补绘的中段袖臂图层。右肩固定在衣领下，抬手参数联动上臂、前臂、袖口和手。前臂随视角缩短，手背和指尖单独配准。抬手从垂手出发，抬到腰前稍停后放下，动作以 `.motion3.json` 随模型导出。[PSD2Live 3.6.7](https://github.com/tsunehimatoi/psd2live/tree/v3.6.7) · [Cubism 绘制顺序](https://docs.live2d.com/en/cubism-editor-manual/draworder/) · [Cubism 姿势切换](https://docs.live2d.com/en/cubism-editor-manual/change-pose/) · [Inkinesis](https://github.com/codewayco/Inkinesis)

PSD2Live 工程和 CMO3 回读均有 12 个摇摆变形器，默认站姿轮廓与上一版重合。在同一 Chrome WebGL 渲染器里，发梢、飘带和衣摆的最大位移增加约 20% 至 27%，按模型画布坐标测得左右袖口移动约 2 像素，手部约 4 像素。发顶、鼻子、衣领、结心和鞋保持固定。抬手的中间换稿仍有袖褶和手指待精修。常服通过评审后进入魔法服制作。

## 手动编辑新版常服

Windows 桌面双击「长门有希 常服编辑」即可启动中文版 PSD2Live 并打开「文档 → 长门有希 Live2D」下的常服工程。编辑器已有打开的工程时，快捷方式保留当前编辑会话，常服可从「最近」打开。在另一台 Windows 电脑配置时，可用 PowerShell 运行 [编辑器准备脚本](../../scripts/desktop/prepare-nagato-editor.ps1)。脚本安装 PSD2Live 便携版、复制工程并建立快捷方式，自动打开需本机的 Python。

- **调哪一块、怎么变形**。进入「绑定」，在层级树选「右袖与手腕」等变形器，右键点「编辑摇摆…」。拖空心方块调整固定边，拖菱形调整柔软度，拖尖端圆点调整形变幅度，点「预览摆动」，确认后点「应用」。要手改关键形，在参数面板展开「轻风与衣发摆动」，选对应参数的 `-1` 或 `1`，切到「变形」拖控制点。修改三角网格的布点用「编辑」模式。
- **调单个部件的幅度和跟随**。打开「物理」工作区，选「右袖与手腕」「左侧发」等同名组。到「输出」调「倍率」，到「摆锤设置」调「反应速度」和「收敛速度」。在左侧预览打开物理，拖动摆锤画布检查跟随和回稳。
- **调整循环速度**。在「动画」工作区点「选择动作… → 轻风待机 → 摄影表」。选中「轻风 · 驱动」的关键帧，可在底部改「时间」。例如把 4 秒加快到 3 秒，依次把 `1 / 2 / 3 / 4` 秒的键移到 `0.75 / 1.5 / 2.25 / 3` 秒。若想让眼睛也按同样比例加速，先将眼睛轨道各键的时间乘 `0.75`。移动完成后将工具栏「时长」设为 3 秒，再点「首尾衔接」。缩短「时长」会裁掉超出的键。播放时在预览画布打开「物理」，即可看到实际的衣发摆动。
- **调眨眼和视线**。在同一个动作里，`ParamEyeLOpen / ParamEyeROpen` 控制双眼开合，`ParamEyeBallX / ParamEyeBallY` 控制视线方向。在「摄影表」改关键帧时间与数值，在「曲线」调整缓入缓出。
- **保存并导出**。保存 PSD2Live 工程会写入「文档」中的编辑副本。完成后可用编辑器导出 Cubism 模型。仓库保存原始可编辑工程和供运行时加载的资源。[PSD2Live 工程](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.psd2live) · [CMO3 工程](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.cmo3)

## 在桌面使用

启动源码版桌面，打开「角色」，在「桌宠模型」选择「长门有希 · 常服」或「长门有希 · 魔法服」，预览后点「应用到角色」。首次使用时，如界面提示 Cubism Core 未准备，运行 `npm run desktop:prepare-live2d` 后重新启动。两套都以全身取景打开。近看嘴型可改为「主播半身」。[外观配置](../../config/live2d-models.json)

- **常服**保留棕色开衫、蓝色水手服和怀中的书。[静态原画](../../apps/desktop/renderer/public/pet/uniform-normal/idle.png) · [模型清单](../../apps/desktop/models/live2d/nagato-uniform/nagato-uniform.model3.json) · [可编辑工程](../../apps/desktop/models/live2d/nagato-uniform/nagato-uniform.cmo3)
- **魔法服**保留尖帽、斗篷和星形魔杖。帽檐随头部运动，斗篷下摆随头身运动摆动。[静态原画](../../apps/desktop/renderer/public/pet/witch-normal/idle.png) · [模型清单](../../apps/desktop/models/live2d/nagato-witch/nagato-witch.model3.json) · [可编辑工程](../../apps/desktop/models/live2d/nagato-witch/nagato-witch.cmo3)

两套都支持头身转动、视线、眨眼、呼吸、发丝物理及按 PCM 驱动的开合与展圆口形。倾听和思考使用各自的表情预设，轻点桌宠可播放点头。在角色页可单独预览待机、眨眼、点头、摇头和三个表情。

## 制作与维护

- 两套原作比例静态造型各自拆出脸、前后发、颈部、眼白、虹膜、睫毛、闭眼、眉和嘴。开口和闭眼取自对应造型已有的播报和眨眼素材。补绘刘海、下颌和帽檐下被遮挡的区域，限制头部和视线幅度以保持原画的轻微侧倾姿态。
- 用 PSD2Live 3.6.7 生成网格和基础变形，修订闭嘴透明度、歪头关键形、眼球移动幅度及发丝摆幅，再为魔法服绑定斗篷物理。导出目标是 Cubism 5.0，贴图为 2048 × 2048。桌面用项目锁定的 Core 5.2 加载。继续改绑定可打开对应 `.cmo3`，重新导出后核对清单、贴图、表情和动作引用。[PSD2Live](https://github.com/tsunehimatoi/psd2live/tree/v3.6.7) · [Cubism 嵌入用数据导出](https://docs.live2d.com/en/cubism-editor-manual/export-moc3-motion3-files/)
- Cubism 的官方制作流程从分层 PSD 导入、网格和变形器绑定开始。Bunraku 的研究演示了单图拆层和关键形预测，公开仓库提供论文与演示。本次分层使用项目已有的三组姿态素材以保持服装、轮廓和表情一致。[Cubism PSD 导入](https://docs.live2d.com/en/cubism-editor-manual/psd-import/) · [Bunraku](https://bunraku-live2d.github.io/)

## 验证

- 在 Windows Electron 中用同一 Cubism Core 5.2 和 Pixi 渲染器检查两套模型的静止、眨眼、眼球移动、嘴型和组合转头姿势。单独扫过斗篷参数，确认变形集中在下摆。
- Luna Max 的隔离 Electron 冒烟通过，覆盖角色页预览、应用与切换、两套透明桌宠的 WebGL2 和物理、播报预览口型以及切回静态。9 项桌宠回归通过，两套资源引用和角色绑定重开也已核对。本机冒烟报告为 `.cache/nagato-smoke/report.json`。
- 物理设备验收还需在实际麦克风和扬声器上检查连续插话后的收口和续播，并在不同 DPI 的屏幕间验证拖动和边缘点击穿透。
