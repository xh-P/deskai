# 长门有希 Live2D

## 在角色页微调常服

打开「角色 → 模型与动作」，在「桌宠模型」选「长门有希 · 常服」。左栏按部位列出 68 个图层，可搜索名称或网格 ID。单击图层显示轮廓，双击放大。用「只看此层」检查被挡住或平时透明的部件，调完可取消单层预览并切回全身或半身。中间预览还可以暂停待机、试眨眼和开关眼镜。[交互参考 · Mesh Avatar Studio](https://github.com/shinshin86/mesh-avatar-studio)

- 「形变」调选中层的宽度、高度和弯曲。宽高 `100%`、弯曲 `0%` 是原始值。
- 「摆动」调该层绑定的摆幅和响应速度。共用一个摆锤的层会一起动，面板列出联动层。例如调左侧发会带动它的阴影，调袖口会带动同侧衣袖和手。
- 「整体待机」调全局循环速度和六个部位的幅度。原始节奏是 4 秒一轮，`1.25×` 约为 3.2 秒一轮。

拖动即时预览，点「应用到角色」才保存到桌宠。图层形变按网格 ID 保存，摆动按物理输出参数保存；聚焦、描边和单层显示只作用于预览。角色资料和声音在同页的「角色与声音」。从托盘退出旧客户端后，重新启动源码版即可查看。

## 常服模型

常服使用 68 个网格、36 个参数、12 个摇摆变形器和 2 个前臂跟随变形器。参考虹色真央的头身与袖臂曲线，16 条待机轨道驱动侧视、歪头、眨眼、眉毛、肩胸呼吸和重心转移。左右前臂各用一个变形器，肘下弯曲带着袖口和手一起跟随。发束、飘带、衣摆和袖子由各自的摆锤响应。浏览器审阅入口仍可通过 `npm run desktop:preview-nagato` 打开。[模型清单](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.model3.json) · [虹色真央](https://www.live2d.com/zh-CHS/learn/sample/niziiro-mao/)

当前工程已删除抬手动作、`ParamArmLift` 和八张抬手备用图层。原截图中的青色轮廓对应其中的 `Hand R raised`。该差分在垂手时透明，选中后仍会画出网格边线。PSD2Live 与 CMO3 回读验证通过，Cubism 在六组垂手姿态中测得保留网格的位置和透明度与上版一致。

## 手动编辑新版常服

Windows 桌面双击「长门有希 常服编辑」即可启动中文版 PSD2Live 并打开「文档 → 长门有希 Live2D」下的常服工程。已有编辑会话时，可从「文件 → 打开工程」选择新版。另存的本机更新版名为「长门有希 常服（已清理抬手）.psd2live」。另一台 Windows 电脑可用 PowerShell 运行编辑器准备脚本，安装便携版、复制工程并建立快捷方式，自动打开需本机的 Python。[编辑器准备脚本](../../scripts/desktop/prepare-nagato-editor.ps1)

- **调哪一块、怎么变形**。进入「绑定」，在层级树选「右袖与手腕」等变形器，右键点「编辑摇摆…」。拖空心方块调整固定边，拖菱形调整柔软度，拖尖端圆点调整形变幅度，点「预览摆动」，确认后点「应用」。要手改关键形，在参数面板展开「轻风与衣发摆动」，选对应参数的 `-1` 或 `1`，切到「变形」拖控制点。修改三角网格的布点用「编辑」模式。
- **调单个部件的幅度和跟随**。打开「物理」工作区，选「右袖与手腕」「左侧发」等同名组。到「输出」调「倍率」，到「摆锤设置」调「反应速度」和「收敛速度」。在左侧预览打开物理，拖动摆锤画布检查跟随和回稳。
- **调整循环速度**。在「动画」工作区点「选择动作… → 轻风待机 → 摄影表」。单击关键帧，可在底部改「时间」。例如把 4 秒加快到 3 秒，将各轨道的关键帧时间乘 `0.75`，其中「轻风 · 驱动」的 `1 / 2 / 3 / 4` 秒键依次移到 `0.75 / 1.5 / 2.25 / 3` 秒。移完后再把工具栏「时长」设为 3 秒，点「首尾衔接」。缩短「时长」会裁掉超出的键。播放时在预览画布打开「物理」，即可看到实际的衣发摆动。
- **调眨眼和视线**。在同一个动作里，`ParamEyeLOpen / ParamEyeROpen` 控制双眼开合，`ParamEyeBallX / ParamEyeBallY` 控制视线方向。在「摄影表」改关键帧时间与数值，在「曲线」调整缓入缓出。
- **调头身、呼吸与前臂跟随**。在「轻风待机」的「曲线」里，`ParamAngleX/Y/Z` 控制头部，`ParamBodyAngleX/Y/Z` 控制身体，`ParamBreath` 控制肩胸呼吸。单击关键帧可调「时间」和「数值」。左右前臂有单独的「左前臂跟随」「右前臂跟随」轨道。要改肘下变形的形状，在「绑定」选同名变形器，选参数的 `-1` 或 `1` 再进入「变形」。
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
