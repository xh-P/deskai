# 长门有希桌宠接入与部署

更新：2026-10-30。用户授权从独立预览扩展到主应用，固定位置，不自主走动。四种组合为校服 / 魔法服 × Q 版 / 原作比例。

## 启动与使用

- 根目录 `启动有希桌宠.cmd` 启动最新拖动修复包 `release/DeskAI2-Pet-Drag-20261030/DeskAI.exe`，此前桌宠包保留。已有旧版在运行时，先用旧版托盘菜单退出；应用的单实例锁会把新启动请求交给正在运行的版本。
- `启动桌面语音对话.cmd` / `npm run desktop:dev` 是源码构建入口，也包含桌宠。
- 首次默认校服 Q 版，透明窗口固定在主屏右下附近；拖动角色即可调整位置。右键或主窗口设置可切换四种造型、120–360 px 高度、显示/隐藏、置顶。托盘也提供桌宠菜单。
- 切换造型/尺寸时保持浮窗底部中心；接近屏幕边缘时优先保证窗口完整可见。断开显示器后位置恢复到可见工作区。
- 手动向上拖动时允许窗口部分越过工作区顶部，至少保留底部 64 DIP 可抓取区域，避免从角色下部抓取时过早停住。到达限制后反向立即跟手；保存的位置支持顶部部分越界恢复。
- 位置与桌宠偏好单独保存在应用用户目录的 `pet-settings.json`。外观切换不改变声音、人格、语言或对话记录。
- 按用户后续选择，桌宠动画默认使用“轻微动画”：即使系统要求减少动态，桌宠仍会眨眼、轻呼吸和播放口型。主窗口“桌宠动画”及右键/托盘同名菜单可切回“跟随系统”。该偏好独立保存为 `motionMode`，不修改 Windows 设置；旧偏好文件缺少此字段时补入轻微动画，并保留原造型、大小、位置和显示设置。
- 系统关闭角色窗口后，可从主窗口或托盘重新显示；应用退出时保留原有显示偏好。
- 显示桌宠不会自动开启采音。点击主窗口“开始语音对话”后，动画跟随当前会话；关闭会话后保留安静待机外观。
- 旧版独立预览及其启动器已归档到 `archive/2026-11-04/`，恢复方式见[整理记录](../project-cleanup-20261104.md)。

## 接入内容

- Electron 主应用创建透明桌宠窗口，使用独立、最小范围的 preload / IPC。透明轮廓外采用鼠标穿透，角色区域支持拖动与右键菜单。
- 十二张 RGBA 图片随 renderer 打包。底图固定，只合成眼睛和嘴部局部：自然眨眼、轻呼吸、点击时微微侧头、思考时缓慢歪头，播放时小幅开合嘴。选择“跟随系统”且系统要求减少动态时停止微动作；隐藏时停止非必要动画，渲染过慢时退回静态。
- 倾听、识别、思考等来自实际会话事件。只有匹配会话/代次的真实播放回执与已播放句子同时存在，才进入说话状态并显示当前句子。暂停、停止、取消、会话结束会收口；旧会话/已取消代次不能重新驱动口型。
- WAIT / SILENT 不生成伪回复气泡。字幕为当前正在播放的真实句子，长度受浮窗空间限制，完整内容在主窗口查看。
- 这是二维局部表情动画；说话开合由播放状态驱动，未做音素级口型、Live2D 骨骼或自主走动。

图片来源、完整提示词和哈希见[素材记录](./desktop-pet-assets.md)。

## 构建与验证

复建最新目录包：`npm run desktop:package -- --name DeskAI2-Pet-Drag-20261030`。包内包含 Electron、Node、应用代码和十二张桌宠图片；ASR / GPT-SoVITS 权重、Conda、runtime 沿用外部目录。移动整个包后，按 `deskai-runtime.json` 设置 `assetRoot`。

- 首次桌宠部署的 `npm run desktop:test`：98 / 98 通过，包含桌宠状态投影与偏好边界测试；涵盖播放回执、暂停/清除、旧代次拒绝、WAIT / SILENT 安静行为。后续独立动画更新只执行受影响检查，未重复完整语音回归。
- `npm run desktop:package -- --name DeskAI2-Pet-20261030`：主进程与 renderer 静态检查、Vite 构建和目录打包通过；包内十二张 PNG 与源码 SHA-256 全部一致。
- 首次桌宠包 `DeskAI.exe --pet-smoke`：使用隔离用户目录和默认 GPU 参数，从正式 bootstrap 启动主应用和透明窗口，8 项检查通过。覆盖四造型、透明角点、尺寸/置顶/显示控制、菜单存在性、状态投影、系统关闭后的重新显示，没有 renderer 错误。此项使用模拟状态，不播放真实语音、不采集麦克风。早期禁用 GPU 的诊断记录属于此前构建，不作为最终包的同模式复测结论。
- 隔离 `pet-settings.json` 读写往返通过，包括造型、尺寸、置顶、显示与位置；未修改正在运行的旧版用户偏好。
- 首次成品启动发现新包模块声明缺失导致 ESM / CommonJS 不一致，已补齐 `packages/desktop-pet/package.json` 并重新构建验证。smoke 启动失败也会记录错误并退出，避免模态错误框使自动验收挂起。
- 动画检查修复了媒体偏好订阅时序和隐藏再显示后的画布重建问题。最终正式 renderer 的隔离视觉验收保留隐藏/显示操作，恢复后 canvas 为 521 × 540、有效 alpha 像素 121,606；25 ms 采样取得 379 个眼/嘴区域样本，确认闭眼后复开、说话时有开闭两种嘴型、WAIT / paused / SILENT 回到闭口。对应 9 秒 WebM 与四种表情截图已保存。演示使用合成状态和测试专用随机控制，并非真实语音录制。

原始证据：`archive/2026-11-04/outputs/desktop-pet/validation/app-pet-smoke.json` 与同目录四张 `app-pet-*.png`；`archive/2026-11-04/outputs/desktop-pet/deployment/` 内有 `final-acceptance.md`、`packaged-pet-smoke-default-gpu.json`、`package-pet-assets.json`、`settings-persistence.json`、`pet-animation-review.json` 和 `pet-rendered-animation.webm`。

### 独立轻微动画更新验收

- 新包 `DeskAI2-Pet-Motion-20261030` 构建通过。`pet-motion.test.ts` 与 `pet-projection.test.ts` 合计 5 / 5 通过，覆盖旧偏好兼容、模式保存和原有状态投影；新测试已加入日常 `desktop:test` 入口。
- 新包默认 GPU 参数的正式 `DeskAI.exe --pet-smoke` 9 / 9 通过，包含新增模式切换及原有四造型/关闭重开检查，没有 renderer 错误。
- 测试页通过 CDP 设置 `prefers-reduced-motion: reduce`，Windows 设置不变。实际 CSS/眼嘴区域共 21 / 21 检查通过：四造型在 gentle 模式都能眨眼和开合嘴；system 模式静止；切回 gentle 恢复；WAIT / paused 收口且无字幕；隐藏再显示后画布尺寸和 alpha 正常。
- 动画采样使用本次正式构建产物；该目录全部 22 个文件与新运行包中的 renderer 逐文件 SHA-256 一致，见 `renderer-equivalence.json`。状态由隔离测试 preload 提供，不代表真实语音测试。
- 本轮证据集中在 `archive/2026-11-04/outputs/desktop-pet/motion-override/`：`validation-summary.md`、`motion-settings-review.json`、`packaged-smoke-evidence/app-pet-smoke.json`、`motion-renderer-review.json`。此前同名默认 smoke 输出已备份在其 `baseline/`，避免混用不同版本结果。

### 拖动异常修复验收

- 修复顶部整窗夹限导致的过早停住；拖动投影统一使用 DIP，并在触及边界时丢弃超量位移，反向无需经过空行程。保存的顶部部分越界位置在首次图片几何校正后仍保留。
- 按 pointerId 管理拖动；松键、左键位消失、取消、丢失捕获、失焦、隐藏及造型/尺寸变化都会结束对应拖动。捕获失败不会留下活动拖动状态；拖动中记录真实透明命中，结束后恢复穿透。
- `pet-motion.test.ts` 与 `pet-projection.test.ts` 合计 9 / 9 通过；main / renderer TypeScript 检查和 `DeskAI2-Pet-Drag-20261030` 构建通过。
- 新包正式默认 GPU `--pet-smoke` 9 / 9 通过，四造型及原有窗口功能正常，无 renderer 错误。报告：`outputs/desktop-pet/drag-fix/packaged-runs/20261030T080618165Z-pid50380-0/packaged-default-gpu-smoke.json`。
- 直接加载新包 renderer 的合成指针检查 13 / 13 通过，包括异常后再次拖动；包内几何 helper 验证保留负 y。报告：`outputs/desktop-pet/drag-fix/renderer-runs/20261030T080700687Z-pid44712-0/packaged-drag-renderer-lifecycle.json`。首轮测试选中低 alpha 边缘像素，修正测试取点后通过，未因此修改产品。
- 上述合成指针检查替代了 preload 并模拟捕获，没有驱动系统鼠标或实际拖动窗口；不能据此宣称用户设备上的漂移已实测消失。物理鼠标与跨 DPI 屏幕仍需复核。此前成品 smoke 证据已归档，本次未重复完整语音回归。

## 硬件与环境限制

- “跟随系统”模式在系统要求减少动态时停止眨眼/呼吸/侧头，说话时仅使用静态开口；默认“轻微动画”只覆盖桌宠自身效果，不改变操作系统或其他窗口的动画偏好。
- 自动回放和鼠标事件注入不能代替真实麦克风、扬声器 AEC、主观听校或物理鼠标操作。
- 物理鼠标拖动/点击穿透、多显示器热插拔、跨不同 DPI 屏幕拖动、Windows 桌面合成效果仍需实际设备确认。已验证的是本机 1.5 DPR 下的窗口与图像输出。
- 本轮未单独进行空闲 CPU 测量或长期资源稳定性测试。
- 本机目录包不是签名安装程序；语音仍依赖现有模型/runtime/Conda，dsh 对话服务及其配置仍需可用。
