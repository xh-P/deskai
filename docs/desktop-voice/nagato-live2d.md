# 长门有希 Live2D

## 在角色页微调常服

打开「角色 → 模型与动作」，在「桌宠模型」选「长门有希 · 常服」。可从左栏搜索 68 个图层，也可直接点画面选中可见部件。按住 Alt 点击可依次选中重叠层，双击可放大。右上角「只看此层」可检查被遮挡或默认透明的部件。「网格显示」可选描边、三角网格和形变对照。形变对照用橙色虚线显示当前姿态下的原网格，用绿色显示调过的网格。[交互参考 · Mesh Avatar Studio](https://github.com/shinshin86/mesh-avatar-studio)

- 「运动」按部位选择待机轨道，可调幅度、提前或延迟。选左手即可调左肩、左肘或左手腕。袖、袖口和手按关节层级一起跟随。头发、飘带、裙摆等有「物理摆动」，可调摆幅和响应速度。共用摆锤的图层会联动。
- 「形变」暂停在当前画面。在头发和衣料等可微调的层上，拖圆点可改弯曲和高度，右侧滑杆也可精调宽度。衣袖两端固定，调整中段轮廓。
- 「姿态测试」可在中立画面单独拨动头、眼、肩、肘、腕等参数。点「恢复中立姿态」归零测试值。回到「运动」，拖「待机时间」检查帧，点「物理」可开关衣发等次级动效。
- 「整体待机」调全局循环速度和六个部位的幅度。原始节奏是 4 秒一轮，`1.25×` 为 3.2 秒一轮。

点「应用到角色」保存轨道、形变、摆动和眼镜设置。姿态测试、网格显示、单层显示和当前时间属于预览状态。从托盘退出旧客户端后，重新启动源码版即可查看。

## 常服模型

常服使用 68 个网格、40 个参数和 20 条待机轨道。两侧均按肩 → 肘 → 腕绑定原生旋转。袖口继承肘，手继承腕，只有前臂袖面保留接缝修形和袖料物理。发束、飘带、衣摆由各自的摆锤响应。四秒待机中肩先动，肘随后，腕角以低于 0.7° 的幅度跟随。浏览器审阅可通过 `npm run desktop:preview-nagato` 打开。[模型清单](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.model3.json)

虹色真央的官方 CMO3、CAN3 与 SDK 样例中，A/B 手势各有肩肘腕链，Pose 控制左右手势的图层切换。A 组的两片袖子用肘部补偿网格和 Glue 连接，待机的肘比肩晚约八帧，腕保持中立。头发、衣袍、帽带、挂件等由 16 组物理驱动，其中颈链使用串联的两段旋转。长门采用垂手姿势的一套旋转链，在小幅转动区间使用重叠画面覆盖接缝。两套模型都保有各自的造型与动作。 [虹色真央官方样例](https://www.live2d.com/en/learn/sample/niziiro-mao/) · [Cubism 旋转与变形](https://docs.live2d.com/en/cubism-editor-manual/deformer/) · [Cubism Glue](https://docs.live2d.com/en/cubism-editor-manual/glue/)

PSD2Live 和 CMO3 回读已验证。中立画面相对上一版最大网格偏差约 0.067 个画布像素。Cubism Core 对单轴肩肘腕转动的手部顶点间距变化测得低于 0.00005 像素。袖口与手、前后袖的重叠覆盖用手动极限姿态和待机取样核对。

## 手动编辑新版常服

Windows 桌面双击「长门有希 常服编辑」可在中文版 PSD2Live 打开常服工程。本机新版另存为「文档 → 长门有希 Live2D → 长门有希 常服（关节摆动）.psd2live」。已有编辑会话时，可从「文件 → 打开工程」切换。Cubism 的 CMO3 与 CAN3 放在同目录下的「关节摆动 Cubism」文件夹，两个文件保留原文件名。另一台 Windows 电脑可用 PowerShell 运行编辑器准备脚本，安装便携版、复制工程并建立快捷方式，自动打开需本机的 Python。[编辑器准备脚本](../../scripts/desktop/prepare-nagato-editor.ps1)

- **调哪一块、怎么变形**。进入「绑定」，在层级树选「左侧发」等变形器，右键点「编辑摇摆…」。拖空心方块调整固定边，拖菱形调整柔软度，拖尖端圆点调整形变幅度，点「预览摆动」，确认后点「应用」。要手改关键形，在参数面板展开「轻风与衣发摆动」，选对应参数的 `-1` 或 `1`，切到「变形」拖控制点。修改三角网格的布点用「编辑」模式。
- **调单个部件的幅度和跟随**。打开「物理」工作区，选「右前臂袖料摆动」或「左侧发」等组。到「输出」调「倍率」，到「摆锤设置」调「反应速度」和「收敛速度」。在左侧预览打开物理，拖动摆锤画布检查跟随和回稳。
- **调整循环速度**。在「动画」工作区点「选择动作… → 轻风待机 → 摄影表」。单击关键帧，可在底部改「时间」。例如把 4 秒加快到 3 秒，将各轨道的关键帧时间乘 `0.75`，其中「轻风 · 驱动」的 `1 / 2 / 3 / 4` 秒键依次移到 `0.75 / 1.5 / 2.25 / 3` 秒。移完后再把工具栏「时长」设为 3 秒，点「首尾衔接」。缩短「时长」会裁掉超出的键。播放时在预览画布打开「物理」，即可看到实际的衣发摆动。
- **调眨眼和视线**。在同一个动作里，`ParamEyeLOpen / ParamEyeROpen` 控制双眼开合，`ParamEyeBallX / ParamEyeBallY` 控制视线方向。在「摄影表」改关键帧时间与数值，在「曲线」调整缓入缓出。
- **调头身、呼吸与手臂**。在「轻风待机」的「曲线」里，`ParamAngleX/Y/Z` 控制头部，`ParamBodyAngleX/Y/Z` 控制身体，`ParamBreath` 控制肩胸呼吸。肩、肘、腕各有左右两条转动轨道，可单击关键帧调「时间」和「数值」。在「绑定」里选前臂袖料变形器可微调关节周围的袖形。
- **保存并导出**。保存 PSD2Live 工程会写入「文档」中的编辑副本。完成后可用编辑器导出 Cubism 模型。仓库保存原始可编辑工程和供运行时加载的资源。[PSD2Live 工程](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.psd2live) · [CMO3 工程](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.cmo3)

## 在桌面使用

启动源码版桌面，打开「角色」，在「桌宠模型」选择「长门有希 · 常服」或「长门有希 · 魔法服」，预览后点「应用到角色」。首次使用时，如界面提示 Cubism Core 未准备，运行 `npm run desktop:prepare-live2d` 后重新启动。两套都以全身取景打开。近看嘴型可改为「主播半身」。[外观配置](../../config/live2d-models.json)

- **常服**使用棕色开衫、蓝色水手服和双手自然下垂的站姿，带可切换的眼镜和可微调的待机。[模型清单](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.model3.json) · [可编辑工程](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.cmo3)
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
