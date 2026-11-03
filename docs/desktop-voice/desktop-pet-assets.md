# 长门有希桌宠：图片与动画素材记录

日期：2026-10-30。使用内置 imagegen 编辑，不调用第三方生图程序，不修改原始参考图片。

## 来源与目录

- 校服造型参考本地《凉宫春日的消失》版权绘；魔法服参考本地《凉宫春日的公式》设定页 HARUHIF_020.jpg。
- 四套基础图的生成提示词和来源见 [首张 Q 版记录](./pet-generation/GENERATION.md) 与 [其余三套记录](./pet-generation/VARIANTS-GENERATION.md)。
- 正式资源目录：`apps/desktop/renderer/public/pet/<variant>/{idle,blink,speaking}.png`。
- variant：`uniform-chibi` 校服 Q 版、`uniform-normal` 校服原作比例、`witch-chibi` 魔法服 Q 版、`witch-normal` 魔法服原作比例。
- idle 为预览已确认范围内的四张生成图逐字节复制。每张 blink/speaking 分别以对应 idle 为输入，未串联编辑。
- Q 版画布 1254 × 1254；原作比例画布 1024 × 1536。十二张均为 RGBA，完全透明像素占比约 57%–78%。
- 原始版权绘和设定集不随运行包复制；运行包只携带这十二张生成素材。本记录不代表获得原作角色或参考作品的再分发授权。

## 渲染约束

AI 编辑可能在非表情区域产生轻微变化。因此运行时始终保留 idle 身体，只对眼睛和嘴部局部羽化合成，不用整图交替制造动画。所有状态共享底图透明边界、脚部锚点及同一比例。此实现为二维局部表情动画，并非 Live2D 骨骼或音素口型。

透明区可能保留 RGB 颜色；验收以实际 alpha 和浏览器透明合成为准，不能把查看器显示的透明区 RGB 光晕当作不透明背景。

## 八张表情帧的完整提示词

### uniform-chibi / blink

- 文件：`apps/desktop/renderer/public/pet/uniform-chibi/blink.png`
- 保存的生成原图：`C:\Users\19102\.codex\generated_images\01a18995-c8f4-7810-a961-a90d7fbccee3\exec-a5b6b0d6-cb10-4882-a338-778972969a47.png`
- SHA-256：`60a5777e8307d955fe0f9805a06e0edadf8ad9760072905f5b4e645c6c71830b`
- 输入：同目录 `idle.png`；`transparent_background: true`。

```text
Use case: identity-preserve. Asset type: ONE closed-eye blink animation frame for an existing desktop-pet sprite.
Edit the supplied image with a single tiny local change: close BOTH of Nagato Yuki's eyes in a natural blink, replacing each open eye with a clean gently curved closed eyelid and the same small lashes. Her mouth stays closed and neutral. Keep her expression calm, not smiling or sleeping.
CRITICAL ANIMATION REGISTRATION: preserve the EXACT original square canvas size, character scale, position, head tilt, face outline, hair, eyebrows, nose, mouth, neck, skin colors, book, hands, clothes, legs, shoes and silhouette. Do not redraw the body, move the head, reframe, crop, rescale, center differently or change proportions. Only the two tiny eye regions are allowed to change. Match the existing polished 2D anime linework.
Keep the genuinely transparent RGBA background and unchanged clean silhouette. No new objects, text, outlines, shadows, lighting effects or background. Deliver one full-frame image perfectly aligned with the reference, with eyes gently closed.
```

### uniform-chibi / speaking

- 文件：`apps/desktop/renderer/public/pet/uniform-chibi/speaking.png`
- 保存的生成原图：`C:\Users\19102\.codex\generated_images\01a18995-c8f4-7810-a961-a90d7fbccee3\exec-3c41e9bf-ff66-4178-a10c-f2667f842de5.png`
- SHA-256：`32fa289cf2e679c132ed114c48b96a5a16113b19d0f4d388545b0d40b0b51527`
- 输入：同目录 `idle.png`；`transparent_background: true`。

```text
Use case: identity-preserve. Asset type: ONE speaking-mouth animation frame for an existing desktop-pet sprite.
Make only one tiny localized edit to the supplied Nagato Yuki sprite: change her tiny closed mouth into a small gently open vertical oval suitable for calm quiet speech. Dark muted rose mouth interior, subtle lower edge, no teeth, no smile, no exaggerated emotion. Both eyes must remain exactly as in the reference.
CRITICAL: preserve the EXACT original square canvas size and exact character scale, position, head tilt, face outline, eyes, eyebrows, nose, hair, skin colors, book, hands, uniform, legs, shoes and silhouette. Only the tiny mouth region changes. No reframing, cropping, recentering, rescaling or redraw of other parts. Keep the same chibi proportions and 2D anime linework.
Genuinely transparent RGBA background unchanged. No text, new objects, glow, shadows or solid background. Deliver a full-frame image aligned with the reference.
```

### uniform-normal / blink

- 文件：`apps/desktop/renderer/public/pet/uniform-normal/blink.png`
- 保存的生成原图：`C:\Users\19102\.codex\generated_images\01a18995-c8f4-7810-a961-a90d7fbccee3\exec-11d1b1e4-ca70-4b93-8602-a9306710a17e.png`
- SHA-256：`6f0a0e60e2f2057879a47ed1049ce811c423d6c3190c528306e1f47331fd22fc`
- 输入：同目录 `idle.png`；`transparent_background: true`。

```text
Use case: identity-preserve. Asset type: a registered blink animation frame.
Edit the supplied normal-proportion Nagato Yuki sprite ONLY in the two eye regions: gently close both eyes for a brief natural blink, with simple curved closed eyelids and the original delicate lashes. Do not change her eyebrows, head tilt, nose, tiny closed mouth or facial outline. No smile, blush, sleepy head movement or new expression.
This is an animation frame requiring exact registration: retain the same portrait canvas dimensions, exact character size and exact pixel placement from hair to shoes. Preserve normal original-anime proportions, all hair, skin shading, book, hands, brown cardigan, blue uniform, red ribbon, skirt, socks and shoes unchanged. Do not recompose, crop, recenter, rescale, move or redraw any other region.
Keep true RGBA transparency. No new background or external glow, text, shadow or objects. Output the entire original sprite with only the eyes closed.
```

### uniform-normal / speaking

- 文件：`apps/desktop/renderer/public/pet/uniform-normal/speaking.png`
- 保存的生成原图：`C:\Users\19102\.codex\generated_images\01a18995-c8f4-7810-a961-a90d7fbccee3\exec-670ffb2a-9f2e-4fbc-936a-9044b76d3513.png`
- SHA-256：`9db3d9b927a377b0aa40bb0686eaab6106193757cb5ce56f3cb93f4118274ec7`
- 输入：同目录 `idle.png`；`transparent_background: true`。

```text
Use case: identity-preserve. Asset type: registered speaking-mouth frame for a normal-proportion anime desktop pet.
Modify ONLY Nagato Yuki's tiny mouth: it opens slightly into a small vertical oval for soft, calm speech, muted dark rose interior, no teeth, no smile. Her eyes remain open exactly as in the supplied idle reference.
Lock EVERYTHING ELSE to the reference: exact portrait canvas dimensions, character placement and size, original-anime normal body proportions, head tilt, face outline, eyes and eyebrows, hairstyle, skin shading, book and hands, cardigan, blue uniform and red ribbon, skirt, navy socks and shoes. No pose shift, rescaling, recentering, crop or redrawing unrelated regions. The new mouth must sit exactly at the original mouth position.
Preserve genuine RGBA transparency and existing clean silhouette, with no added scene, glow, shadows, text or decorations. Output one complete aligned sprite with a slightly open speaking mouth.
```

### witch-chibi / blink

- 文件：`apps/desktop/renderer/public/pet/witch-chibi/blink.png`
- 保存的生成原图：`C:\Users\19102\.codex\generated_images\01a18995-c8f4-7810-a961-a90d7fbccee3\exec-482b3bb6-2591-4471-a6a8-ddc12254d5b2.png`
- SHA-256：`e02b3348f13a661d02be9bfccb4244a6c4a0bfe9818d91da7207f596b4117ed6`
- 输入：同目录 `idle.png`；`transparent_background: true`。

```text
Use case: identity-preserve. Asset type: closed-eye blink frame for an existing chibi witch-costume Nagato Yuki desktop sprite.
Make a tiny local edit ONLY to the two eye regions: both eyes gently close into clean curved eyelids with the original small lashes for a short blink. Keep the mouth neutral and closed. No nod, sleeping pose, smile, blush or head movement.
Everything else is LOCKED pixel-for-pixel in placement: exact square canvas size, character scale, head tilt and face shape, eyebrows, nose, hair, the ENTIRE large witch hat with bent tip and brim, dark cloak and bow, blue uniform/red ribbon, star wand and hand, legs and brown shoes. Do not recenter, rescale, crop, change silhouette, change costume or redraw any region beyond the eyes. Maintain the same clean 2D anime chibi style.
Preserve true RGBA transparency around the entire sprite with no added glow, background, shadow, text or objects. Output the complete aligned image.
```

### witch-chibi / speaking

- 文件：`apps/desktop/renderer/public/pet/witch-chibi/speaking.png`
- 保存的生成原图：`C:\Users\19102\.codex\generated_images\01a18995-c8f4-7810-a961-a90d7fbccee3\exec-6fd7e140-959a-4ab2-8983-dbcd65c94b80.png`
- SHA-256：`ca1e57306b4b32f0692dc0b7d6dc6e3889a89a27d91e1667a02c5115bd7dfed8`
- 输入：同目录 `idle.png`；`transparent_background: true`。

```text
Use case: identity-preserve. Asset type: ONE speaking-mouth animation frame for an existing chibi witch-costume Nagato Yuki.
Change ONLY her tiny closed mouth into a small gently open vertical oval for quiet speech, a muted dark rose interior with no teeth and no smile. Keep both amber eyes exactly open as in the reference and preserve her calm expression.
Critical frame registration: exact original square canvas and exact pixel placement of the complete character. Preserve head tilt, face outline, eyes, eyebrows, nose, short lavender hair, all skin shading, the large dark witch hat with bent tip and brim, cloak and bow, blue uniform, red ribbon, hand and star wand, short legs and brown shoes. Do not redraw or move the body or head, crop, reframe, recenter or change proportions. Only the tiny mouth region changes.
Keep the original genuinely transparent RGBA surroundings and clean silhouette; no text, new objects, shadows, glow, backdrop or border.
```

### witch-normal / blink

- 文件：`apps/desktop/renderer/public/pet/witch-normal/blink.png`
- 保存的生成原图：`C:\Users\19102\.codex\generated_images\01a18995-c8f4-7810-a961-a90d7fbccee3\exec-df6edf5b-5d0d-4cc9-8a9b-f04e8e670917.png`
- SHA-256：`8c360db3c8b46bb9ac184eb7c4db4b3ee84c740ddc45960204b5fe64df259120`
- 输入：同目录 `idle.png`；`transparent_background: true`。

```text
Use case: identity-preserve. Asset type: registered closed-eye blink animation frame.
Make ONLY a localized change to both eyes of the supplied normal-proportion witch-costume Nagato Yuki: close them gently into natural curved eyelids with the same delicate eyelashes. The tiny mouth remains closed and neutral. Do not tilt or move her head, smile, blush, lower her face or change her posture.
Maintain EXACT image dimensions and character position/size. Preserve original-anime normal proportions and all other pixels' content: face outline, eyebrows, nose, hair and skin shading, entire dark bent-point witch hat and wide brim, long cloak and bow, sailor uniform and red ribbon, arm, hand and golden-star wand, legs, socks, brown shoes and complete silhouette. No crop, rescale, reframe, recenter or body redraw. This must align with the original idle frame.
Keep genuine RGBA transparency, no added lighting, glow, shadow, background, text or objects. Output one complete sprite with only the eyes changed to a blink.
```

### witch-normal / speaking

- 文件：`apps/desktop/renderer/public/pet/witch-normal/speaking.png`
- 保存的生成原图：`C:\Users\19102\.codex\generated_images\01a18995-c8f4-7810-a961-a90d7fbccee3\exec-585c4fb1-2649-41bf-847e-d5c3eba3d0cc.png`
- SHA-256：`5fafd024e7efb3ad12c214d6be7ee36869ba5ad5a562f5bef38e99fdaf54348b`
- 输入：同目录 `idle.png`；`transparent_background: true`。

```text
Use case: identity-preserve. Asset type: registered speaking-mouth animation frame of the supplied original-anime-proportion witch Nagato Yuki.
Edit ONLY the tiny closed mouth into a subtle small open vertical oval for soft speech, with muted dark rose inside, no visible teeth and no smile. Keep the amber eyes OPEN exactly as in the reference. Preserve the quiet neutral expression.
Critical: retain exact portrait canvas, exact pixel registration and original proportions. Do not redraw, shift, tilt, rescale, crop or recenter the head or body. The face outline, hair, eyebrows, eyes, nose, skin shading, enormous dark witch hat with bent point and brim, dark cape, collar and bow, sailor uniform, red ribbon, hand and gold-star wand, legs, socks and brown shoes all remain exactly as the idle image. Only the mouth changes.
Output a complete sprite with true RGBA transparency, no new background, glow, lighting, shadow, lettering or objects.
```
