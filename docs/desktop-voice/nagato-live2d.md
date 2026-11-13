# 长门有希 Live2D

## 新版常服交互审阅

在项目根目录运行 `npm run desktop:preview-nagato`，打开终端显示的本地网址。首次准备 Cubism Core 时先运行 `npm run desktop:prepare-live2d`。点「轻风待机」播放四秒循环。选「全身」看重心和裙摆，选「上半身」看呼吸、肩臂跟随和眨眼。预览支持在待机中叠加手动转头、眨眼、眼镜和抬手。角色页可通过「导入模型」打开小样。[模型清单](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.model3.json)

常服使用 76 个网格、37 个参数。参考虹色真央的头身与袖臂曲线，待机用 16 条可编辑轨道驱动侧视、转头与歪头、眨眼、眉毛、肩胸呼吸和轻微重心转移。左右前臂各用一个变形器，肩根固定在衣身，肘下弯曲带着袖口和手一起跟随。刘海、侧发、后颈发、飘带、开衫下摆、裙摆和袖子仍由各自的摆锤响应。关掉待机时，头身和手臂先缓回站姿，衣发随后收住。手动转头也会带动发梢。[虹色真央](https://www.live2d.com/zh-CHS/learn/sample/niziiro-mao/) · [Cubism 物理](https://docs.live2d.com/en/cubism-editor-manual/physics-operation/)

小样从已审阅的 72 层常服 PSD 起模，加入四张 GPT 补绘的中段袖臂图层。右肩固定在衣领下，抬手参数联动上臂、前臂、袖口和手。前臂随视角缩短，手背和指尖单独配准。抬手从垂手出发，抬到腰前稍停后放下，动作以 `.motion3.json` 随模型导出。[PSD2Live 3.6.7](https://github.com/tsunehimatoi/psd2live/tree/v3.6.7) · [Cubism 绘制顺序](https://docs.live2d.com/en/cubism-editor-manual/draworder/) · [Cubism 姿势切换](https://docs.live2d.com/en/cubism-editor-manual/change-pose/) · [Inkinesis](https://github.com/codewayco/Inkinesis)

PSD2Live 工程和 CMO3 回读均有 12 个摇摆变形器及 2 个前臂跟随变形器，默认站姿轮廓与上一版重合。Chrome WebGL 中，待机的发顶网格最大位移约 25 个模型画布像素，衣领和手部约 8 至 10 像素，鞋底落点固定。独立测试了呼吸及左右前臂轨道，也检查了待机叠加转头、眼镜和抬手。高位抬手时内腋处还有一小块空隙，中段袖褶与手指仍待精修。常服通过评审后进入魔法服制作。

## 手动编辑新版常服

Windows 桌面双击「长门有希 常服编辑」即可启动中文版 PSD2Live 并打开「文档 → 长门有希 Live2D」下的常服工程。编辑器已有打开的工程时，快捷方式保留当前编辑会话，常服可从「最近」打开。在另一台 Windows 电脑配置时，可用 PowerShell 运行 [编辑器准备脚本](../../scripts/desktop/prepare-nagato-editor.ps1)。脚本安装 PSD2Live 便携版、复制工程并建立快捷方式，自动打开需本机的 Python。

- **调哪一块、怎么变形**。进入「绑定」，在层级树选「右袖与手腕」等变形器，右键点「编辑摇摆…」。拖空心方块调整固定边，拖菱形调整柔软度，拖尖端圆点调整形变幅度，点「预览摆动」，确认后点「应用」。要手改关键形，在参数面板展开「轻风与衣发摆动」，选对应参数的 `-1` 或 `1`，切到「变形」拖控制点。修改三角网格的布点用「编辑」模式。
- **调单个部件的幅度和跟随**。打开「物理」工作区，选「右袖与手腕」「左侧发」等同名组。到「输出」调「倍率」，到「摆锤设置」调「反应速度」和「收敛速度」。在左侧预览打开物理，拖动摆锤画布检查跟随和回稳。
- **调整循环速度**。在「动画」工作区点「选择动作… → 轻风待机 → 摄影表」。单击关键帧，可在底部改「时间」。例如把 4 秒加快到 3 秒，将各轨道的关键帧时间乘 `0.75`，其中「轻风 · 驱动」的 `1 / 2 / 3 / 4` 秒键依次移到 `0.75 / 1.5 / 2.25 / 3` 秒。移完后再把工具栏「时长」设为 3 秒，点「首尾衔接」。缩短「时长」会裁掉超出的键。播放时在预览画布打开「物理」，即可看到实际的衣发摆动。
- **调眨眼和视线**。在同一个动作里，`ParamEyeLOpen / ParamEyeROpen` 控制双眼开合，`ParamEyeBallX / ParamEyeBallY` 控制视线方向。在「摄影表」改关键帧时间与数值，在「曲线」调整缓入缓出。
- **调头身、呼吸与前臂跟随**。在「轻风待机」的「曲线」里，`ParamAngleX/Y/Z` 控制头部，`ParamBodyAngleX/Y/Z` 控制身体，`ParamBreath` 控制肩胸呼吸。单击关键帧可调「时间」和「数值」。左右前臂有单独的「左前臂跟随」「右前臂跟随」轨道。要改肘下变形的形状，在「绑定」选同名变形器，选参数的 `-1` 或 `1` 再进入「变形」。
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
