# 长门 Live2D 素材与调校

在「角色 → 模型与动作」的「桌宠模型」可选长门常服和魔法服。常服为水手服配棕色开衫的垂手站姿，魔法服为尖帽、斗篷和魔杖。[两套模型、素材与可编辑工程](./nagato-live2d.md)

## 角色动作

主对话模型可选点头、摇头、向两侧歪头或向四个方向转视线。摇头和点头分别用头部 X、Y，歪头用 Z。转视线先动眼球，头部稍后跟随，身体按模型绑定以较小幅度跟进。两套长门都使用标准头部、眼球和身体参数。动作能力以模型载入时实际存在的参数及范围为准。[动作参数](../../apps/desktop/renderer/src/live2d/gesture-motion.ts) · [Cubism 标准参数](https://docs.live2d.com/en/cubism-editor-manual/standard-parameter-list/)

## 调校与反馈

- 在「角色 → 模型与动作」选择模型。点画面或图层列表可选中网格。当前层的运动、物理和局部形变在「图层调节」同一处，姿态测试可独立拨动模型参数。循环速度与分组幅度在「整体待机」，桌宠取景、缩放和口型在「高级预览与设置」。点「应用到角色」保存模型配置。[常服逐层调校](./nagato-live2d.md#在角色页微调常服)
- 遇到表情切换过重、脸偏离画面中心或嘴型过大时，记下模型名、状态、当前幅度和一张截图。需要调整原始绑定时，再附上涉及的参数 ID。
- 导入其他模型时，保留 `.model3.json` 引用的 `.moc3`、贴图、物理、姿势、表情、动作和可选 `.cdi3.json` 及其目录结构。导出目标应能在项目锁定的 Cubism Core 加载。可通过同名 `.layers.json` 声明图层名、运动分组、待机、物理和形变权限。[模型调校清单示例](../../apps/desktop/models/live2d/nagato-uniform-review/nagato-uniform-review.layers.json)

侧车的 `layers` 按 ArtMesh ID 关联 `motion`、`sway` 和 `shape`。运动用实际的待机参数 ID，物理用 Physics3 的输出 ID。待机分组可以自由命名，`groupNames` 提供显示名，`base` 用于无整体幅度控件的曲线。一个摆锤同时驱动多个参数时，各输出可分别调幅度。响应速度控件用于该输出独用的摆锤。

制作或迭代站姿待机时，按统一取景测量脚底、腿、身体、头部与两臂的位移和时序。[站姿待机调校指南](./live2d-standing-idle-guide.md) · [常服图文制作记录](./nagato-live2d-production.md)
