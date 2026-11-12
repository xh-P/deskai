# 长门有希 Live2D

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
