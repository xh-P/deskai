# 长门有希 Live2D

## 在角色页微调常服

打开「角色 → 模型与动作」，在「桌宠模型」选「长门有希 · 常服」。可从左栏搜索 66 个图层，也可直接点画面选中可见部件。按住 Alt 点击可依次选中重叠层，双击可放大。右上角「只看此层」可检查被遮挡或默认透明的部件。「网格显示」可选描边、三角网格和形变对照。形变对照用橙色虚线显示当前姿态下的原网格，用绿色显示调过的网格。[交互参考 · Mesh Avatar Studio](https://github.com/shinshin86/mesh-avatar-studio)

- 「图层调节」中同时显示所选层可用的待机轨道、物理和形变。选手可调同侧肩肘，选腿可调同侧收放。选衣领可调重心。发束、飘带和裙摆可调物理摆幅与跟随速度。共享控制的图层会联动。
- 可形变的层有宽度、高度和弯曲滑杆。点「拖动形变」后拖画面上的圆点。衣袖两端固定，调整中段轮廓。
- 「姿态测试」可在中立画面单独拨动头、眼、肩、肘、腕、重心和双腿。点「恢复中立姿态」归零测试值。回到「图层调节」，拖「待机时间」检查帧，点「物理」可开关衣发等次级动效。
- 「整体待机」调循环速度及头、身、臂、腿、头发、衣料和视线的幅度。默认 5.60 秒一轮，`1.25×` 为约 4.48 秒一轮。

点「应用到角色」保存轨道、形变、摆动和眼镜设置。姿态测试、网格显示、单层显示和当前时间属于预览状态。从托盘退出旧客户端后，重新启动源码版即可查看。

## 常服模型

常服使用 66 个网格、43 个参数和 21 条待机轨道。重心位移带上身和髋走，颈部控制头的跟随量，脸朝向由头部 X 轴单独控制。每侧用一张连续腿袜与一只独立鞋，鞋底接近固定。两臂按肩 → 肘 → 腕绑定，肩先动、肘随后，窄袖口和手掌随前臂移动。前臂袖面、发束、飘带和衣摆有各自的物理响应。运行 `npm run desktop:preview-nagato` 可在浏览器播放整轮，暂停后可拖时间，切换头肩、袖臂或腿脚近景。[图文制作记录](./nagato-live2d-production.md) · [模型清单](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.model3.json)

虹色真央的官方工程按上身、下身、头颈和手臂分层绑定。胸腹侧移时头随颈部移动，头部 X 改变局部脸向，衣领和肩部由身体网格产生透视变化。待机用 A 手势，肘部补偿网格用 Glue 连起两段袖子，左右肩肘分别设关键帧。长门用垂手姿势的关节链，在小幅转动区间用图层重叠覆盖袖缝。[站姿待机调校指南](./live2d-standing-idle-guide.md) · [虹色真央官方样例](https://www.live2d.com/en/learn/sample/niziiro-mao/) · [Cubism Glue](https://docs.live2d.com/en/cubism-editor-manual/glue/)

PSD2Live 和 CMO3 回读已验证。袖口、袖肘、颈部、裙下、袜口和鞋口用实际待机与高幅度姿态取样检查。 [本轮动作数值与检查](./live2d-standing-idle-guide.md#长门常服第一轮)

## 手动编辑新版常服

Windows 桌面双击「长门有希 常服编辑」可在中文版 PSD2Live 打开常服工程。本机新版另存为「文档 → 长门有希 Live2D → 长门有希 常服（站姿重绘）.psd2live」。已有编辑会话时，可从「文件 → 打开工程」切换。Cubism 的 CMO3 与 CAN3 放在同目录下的「站姿重绘 Cubism」文件夹，两个文件保留原文件名。另一台 Windows 电脑可用 PowerShell 运行编辑器准备脚本，安装便携版、复制工程并建立快捷方式，自动打开需本机的 Python。[编辑器准备脚本](../../scripts/desktop/prepare-nagato-editor.ps1)

- **调哪一块、怎么变形**。进入「绑定」，在层级树选「左侧发」等变形器，右键点「编辑摇摆…」。拖空心方块调整固定边，拖菱形调整柔软度，拖尖端圆点调整形变幅度，点「预览摆动」，确认后点「应用」。要手改关键形，在参数面板展开「轻风与衣发摆动」，选对应参数的 `-1` 或 `1`，切到「变形」拖控制点。修改三角网格的布点用「编辑」模式。
- **调单个部件的幅度和跟随**。打开「物理」工作区，选「右前臂袖料摆动」或「左侧发」等组。到「输出」调「倍率」，到「摆锤设置」调「反应速度」和「收敛速度」。在左侧预览打开物理，拖动摆锤画布检查跟随和回稳。
- **调整循环速度**。只改播放速度可在 DeskAI 的「整体待机」拖「待机速度」。需要改源动作时，在 PSD2Live 打开「动画 → 选择动作… → 轻风待机 → 摄影表」。单击关键帧可改底部「时间」。例如将 5.60 秒改为 4.20 秒，先把每条轨道的时间乘 `0.75`，再把工具栏「时长」设为 4.20 秒并检查首尾。缩短「时长」会裁掉超出的键。播放时可打开「物理」检查衣发跟随。
- **调眨眼和视线**。在同一个动作里，`ParamEyeLOpen / ParamEyeROpen` 控制双眼开合，`ParamEyeBallX / ParamEyeBallY` 控制视线方向。在「摄影表」改关键帧时间与数值，在「曲线」调整缓入缓出。
- **调头身、腿和手臂**。在「轻风待机」的「曲线」里，`ParamWeightShift` 控制重心，`ParamLegGatherL/R` 控制两腿收放，`ParamAngleX/Y/Z` 和 `ParamBodyAngleX/Y/Z` 控制头身关键形。两侧肩与肘可各调「时间」和「数值」。在「绑定」里可检查手腕姿态和前臂袖料变形。
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

- 站姿重绘版的 Windows Electron 冒烟覆盖长门与虹色真央的图层浏览、画面点选、网格和姿态，常服检查了三类同面板设置、保存、待机定位、眨眼和眼镜。隔离报告保存在本机 `.cache/nagato-production/smoke/report.json`。[制作与验证](./nagato-live2d-production.md#5-验收)
- 在 Windows Electron 中用同一 Cubism Core 5.2 和 Pixi 渲染器检查两套模型的静止、眨眼、眼球移动、嘴型和组合转头姿势。单独扫过斗篷参数，确认变形集中在下摆。
- Luna Max 的隔离 Electron 冒烟通过，覆盖角色页预览、应用与切换、两套透明桌宠的 WebGL2 和物理、播报预览口型以及切回静态。9 项桌宠回归通过，两套资源引用和角色绑定重开也已核对。本机冒烟报告为 `.cache/nagato-smoke/report.json`。
- 物理设备验收还需在实际麦克风和扬声器上检查连续插话后的收口和续播，并在不同 DPI 的屏幕间验证拖动和边缘点击穿透。
