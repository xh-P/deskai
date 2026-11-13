# PSD2Live 制作与验证

- 项目当前使用 PSD2Live 3.6.7。作者工程用 `.psd2live` 保存，Cubism 交付用 `.cmo3` 与 `.can3`。编辑器可视化适合核对绑定和关键形，批处理可走 PSD2Live 的本机 MCP。[PSD2Live 源码和文档](https://github.com/tsunehimatoi/psd2live/tree/v3.6.7) · [本机编辑器准备脚本](../../../scripts/desktop/prepare-nagato-editor.ps1)
- 先打开源工程并检查图层与 Rig。新增绘画可用 `layer_import_images`，再设置注册矩形和绘制顺序。只有贴图变化且轮廓仍在旧网格内时可用 `layer_replace_image` 保持网格。重做轮廓时验证网格覆盖完整 alpha。写入本地副本并在工程重开后检查 ArtMesh、父级、参数关键值和动作曲线。
- 参考模型用整体腿图时，隐藏的大腿与袜脚从源画绘完。裙/裤前片压住腿根，鞋面压住袜脚，保持固定地面。Cubism Deform Path 是绘制关键形的编辑工具，运行时用保存的关键形。验证 CMO3 内的路径及 SDK 中立、动作与单轴极限的输出。[Deform Paths](https://docs.live2d.com/en/cubism-editor-manual/deformpath/) · [PSD 导入](https://docs.live2d.com/en/cubism-editor-manual/psd-import/)
- 量化范围须标明实际文件和取样条件。固定镜头检查画面外轮廓、原画接缝和前后遮盖。脚底取接触带的顶点，手掌比较同一组顶点间距。物理单独关开，分辨曲线本身、弹簧响应和程序追加的呼吸。完整循环里比较起止位置及速度。
- 使用 DeskAI 的源码开发入口运行预览。模型侧车与 `.model3.json` 同目录，导入后以运行时实际存在的轨道和网格为准。测试用隔离用户数据；确认保存覆盖后重开模型。对现有仓库运行 `npm run desktop:build` 和相关回归。
