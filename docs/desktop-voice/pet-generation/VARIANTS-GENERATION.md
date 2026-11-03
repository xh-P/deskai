# 有希桌宠：新增三种立绘的生成记录

日期：2026-10-30。首张 Q 版校服及其提示词见 [GENERATION.md](./GENERATION.md)。

## 四种组合扩展

用户已明确选择原作正常比例、四种组合。所有资源由内置 image_gen 生成，以 PNG 原件复制到本目录，保留透明 alpha；没有用程序重新绘制角色。

魔法服本地设定来源：`assets/[一般書籍][动画设定集][凉宫春日的公式][060825].(jpg)/(夋廤) 僆僼傿僔儍儖僼傽儞僽僢僋 椓媨僴儖僸偺岞幃 (jpg)/HARUHIF_020.jpg`，使用页面下方中央的魔法服全身有希。参考图预览裁图保存在 `outputs/desktop-pet/research-magic/magic-yuki-crop.jpg`，原始页面未改动。未使用网络参考图。

### 正常比例校服

- 文件：`nagato-normal.png`；1024 × 1536；RGBA。
- SHA256：`9598b112c4785fcdcac51f9b778b5ecc632c6fe38e1469d0d0cd293187ab45eb`。
- 工具来源文件：`C:/Users/19102/.codex/generated_images/01a18995-c8f4-7810-a961-a90d7fbccee3/exec-7819bc78-7525-4019-88b9-9c9e9b62c9f5.png`。

```text
Use case: stylized-concept.
Asset type: full-body transparent anime character sprite for a Windows desktop companion.
Reference: the provided local official artwork shows Nagato Yuki's identity, school uniform, cardigan, book, shoes and original anime body proportions. Redraw just this character as a new clean sprite.
Primary request: Nagato Yuki with NORMAL ORIGINAL ANIME proportions, around six to six and a half heads tall. This is emphatically NOT chibi, not a big-head doll, and not three heads tall. A small natural head relative to the entire body, slim normal torso and natural long legs, with the petite original character's proportions. Calm reserved face with narrow soft amber-brown eyes, tiny closed neutral mouth, short dusty lavender-gray layered bob with pointed ends and side-swept fringe. No glasses for this mainline version; no heavy blush or smile.
Costume: muted blue sailor uniform and pleated skirt, dark chocolate-brown open cardigan with long sleeves, dark red ribbon at the chest, navy knee socks, simple white indoor shoes with blue toe/sole accents. Both hands naturally hold a small closed cream-colored book gently in front of the upper torso. Keep the uniform modest and match the reference details.
Style: polished clean 2D anime model-sheet illustration, elegant controlled dark outlines, crisp cel shading, restrained soft color highlights. Faithful original anime face and anatomy rather than super-deformed game mascot proportions. Full-body relaxed standing pose, nearly front-facing with a very slight three-quarter turn; feet close together, no exaggerated twist.
Composition: single entire character from hair to both shoe soles visible, centered on a portrait canvas, around 90 percent of canvas height, transparent space on all sides. No extra people or props except the book.
Transparency is essential: genuinely transparent RGBA surroundings with a CLEAN silhouette and no colored haze. No background, no scenery, no floor or ground shadow, no glow, no vignette, no black/white background fill, no checkerboard pattern, no white sticker border. No text, watermark, logos, sparkles or UI.
```

```text
Use case: background-extraction.
Edit target: the supplied full-body normal-proportion Nagato Yuki sprite.
Remove ONLY the broad colored blurred glow, haze, vignette and all other background pixels around the character. This is a precise clean cutout, not a redesign. Everything outside the drawn outer contour of her hair, cardigan, skirt, legs and shoes must become completely transparent alpha=0. In particular, remove the lavender fog above and around the hair, brown haze around the torso, skin-colored halo around the knees, and blue-white bloom around the feet. No shadow or diffuse halo may remain.
Keep the character itself unchanged: exact normal anime proportions, face, hairstyle, colors, clothing, book, pose, hands, shoes and linework. Preserve the narrow clean anti-aliased drawn edges. Preserve complete hair tips and both shoe soles; leave at least 3 percent transparent margin around the silhouette. No stretching, cropping of the subject or chibi transformation. No background fill, white outlines, text, checkerboard or new details. Output a true transparent RGBA PNG of only the character.
```

### Q 版经典魔法服

- 文件：`nagato-witch-chibi.png`；1254 × 1254；RGBA。
- SHA256：`0fcbc60005a9b5d06717309e9adc809de67f233047d8adf9dbd7a87a01f85db6`。
- 工具来源文件：`C:/Users/19102/.codex/generated_images/01a18995-c8f4-7810-a961-a90d7fbccee3/exec-a2789b12-8bc4-46f8-b0c8-5917cce0e313.png`。

```text
Use case: identity-preserve.
Asset type: transparent desktop-pet sprite, classic magician outfit variant.
Input image 1: the existing Q-version Nagato Yuki sprite. Preserve this exact character identity, rounded face, amber-brown eyes, dusty lavender short layered hair, tiny neutral mouth, calm expression, clean linework, soft cel-shaded color style, and VERY COMPACT TWO-HEAD-TALL chibi body proportions (excluding the additional hat).
Input image 2: local official character-setting reference, the SMALL CENTRAL full-body witch-costume Yuki. Use this image ONLY for the classic costume details, never for body proportions or background. Ignore all other figures, text and the surrounding page.
Change the first sprite into the classic Nagato Yuki magician costume: a plain very dark plum-black wide-brim witch hat with tall slightly bent/floppy pointed top, a dark plum-black full-length cloak with a high turned-up collar and a small dark bow fastening at the neck. The cloak opens in front to reveal the familiar blue sailor school uniform and small dark red ribbon, blue pleated skirt, navy knee socks and brown school shoes. Preserve a clearly readable dark-purple shaded edge and folds on the black fabric, so the shape works on a dark desktop. No bright hat band, buckle, decorative stars, ornaments or newly invented costume motifs.
Remove the book and brown cardigan from the original sprite. One tiny hand visible through the cloak holds a slender brown wand with a SMALL golden-yellow five-point star at its tip, raised diagonally across the body as in the official costume reference; the other hand rests naturally at the side behind the cloak. No glasses. No magical effects.
Composition: ONE complete chibi character with entire hat brim, pointed tip, both shoes and whole wand visible. Nearly front-facing, stable cute standing pose. Large round head and extremely short torso and legs, retaining the existing sprite's two-head-tall body. Generous transparent margins around the hat and wand. High-quality clean 2D anime sprite, not photorealistic, not 3D.
Backdrop: true transparent alpha, clean silhouette, no backdrop or ground, no diffuse glow or fog, no shadows outside the sprite, no checkerboard baked in, no white sticker border, no text or watermark.
```

### 正常比例经典魔法服

- 文件：`nagato-witch-normal.png`；1024 × 1536；RGBA。
- SHA256：`dc292ebbb08458c97a2d7994a63c4382b30c4e50c607b4e989be8b28170b08c2`。
- 工具来源文件：`C:/Users/19102/.codex/generated_images/01a18995-c8f4-7810-a961-a90d7fbccee3/exec-28940bdc-7a38-45f7-8129-b1a5aa1efa19.png`。

```text
Use case: identity-preserve.
Asset type: full-body transparent anime desktop companion sprite, normal-proportion classic magician variant.
Input image 1: the normal-proportion Nagato Yuki uniform sprite. Preserve her original-anime body proportions, slender normal torso and legs, head-to-body scale, face shape, soft amber-brown eyes, dusty lavender-gray short layered bob, reserved neutral expression, and polished clean 2D cel-shaded drawing style.
Input image 2: local official costume reference. The small CENTRAL full-body witch Yuki is the costume reference. Ignore every other figure, text and background.
Change ONLY outfit and held prop/arm pose to faithfully reproduce classic Nagato Yuki's magician costume: very dark plum-black wide-brim pointed witch hat with a bent floppy tip, long very dark plum-black cape reaching the ankles, turned-up collar and small dark bow tie at the neck, cape open in front to show a blue sailor school uniform, red ribbon and blue pleated skirt, white blouse sleeves with blue cuffs, navy knee socks and flat brown school shoes. One hand holds a slender brown wand diagonally across the torso with a small golden-yellow five-point star at its upper end; the other rests naturally beneath the cape. No book or brown cardigan. No glasses, no bright decorative hat band or buckle, no extra ornaments.
The black fabric has subtle plum-purple cel-shaded highlights and clean outlined folds so it remains readable on dark backgrounds, but no magical glow. Match the official costume's simple design.
IMPORTANT: full NORMAL ORIGINAL ANIME proportions, NOT CHIBI and not a doll. Preserve the natural small head and long slender body of the first reference; roughly six heads tall body excluding the hat. Nearly frontal relaxed standing pose, complete hat, full cape hem, both shoes and entire star wand all visible. Center the single character on a portrait canvas with clear transparent margins on ALL sides. No hat tip or brim may touch or be cropped by an edge.
Output: one isolated 2D anime character, clean genuinely transparent RGBA background. No scene, floor, ground shadow, glow, fog, vignette, text, watermark, checkerboard, UI or white sticker border.
```
