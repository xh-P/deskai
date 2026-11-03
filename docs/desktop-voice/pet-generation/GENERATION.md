# 有希桌宠原型：图像来源与生成记录

日期：2026-10-30。用途：外观评审原型，尚待用户确认后正式接入。

## 首张资源：Q 版校服

- 文件：`nagato-chibi.png`，内置 image_gen 工具生成的透明 PNG，原样复制并保留 alpha。
- 原始尺寸：1254 × 1254；SHA256：`99541C126116293BC45AEE179E5433BABE249AE2BAA51B8005BDFAE99D894F61`。
- 第一稿身体偏长，第二稿针对两头身比例与透明边缘修订。只将第二稿作为当前资源。
- 当前造型：无眼镜、灰紫短发、琥珀棕眼、蓝色水手服、棕色开衫、红领结、抱书。表情与造型是本轮原型选择，待用户评审，不自动绑定声音或人格。
- 每种造型仍是单张角色立绘，动效由预览程序演示；没有逐帧表情、口型同步或骨骼动画。
- 用户提供的版权绘仅作角色及服装参考；未运行或提取参考 EXE 的角色素材。
- 工具来源文件：`C:/Users/19102/.codex/generated_images/01a18995-c8f4-7810-a961-a90d7fbccee3/exec-a689d71d-06a2-4fa7-8dd3-02dd64f65a14.png`。运行原型只依赖本目录 PNG。

现已补齐原作正常比例校服、Q 版经典魔法服和正常比例经典魔法服，组成可切换的四种造型。其来源与完整提示词见 [新增立绘生成记录](./VARIANTS-GENERATION.md)。

## 本地参考图

1. `assets/凉宫春日的消失 版权绘/无字：少字/__nagato_yuki_suzumiya_haruhi_no_yuuutsu__3980317a07821b311344084252c0bf6d.jpg`
2. `assets/凉宫春日的消失 版权绘/无字：少字/__nagato_yuki_suzumiya_haruhi_no_yuuutsu_and_2_more_drawn_by_nishiya_futoshi__7e91bdbf7135ba41aa2438255dc0176d.jpg`

## 首轮完整提示词

```text
Use case: stylized-concept.
Asset type: a polished transparent PNG character sprite for a Windows desktop companion, intended to read clearly at 180–320 pixels tall.
Primary request: Create a very cute Q-version / chibi Nagato Yuki from The Melancholy / Disappearance of Haruhi Suzumiya, using the two supplied local artwork references for identity and costume. This is a new chibi character drawing, not a crop or a poster.
Input image 1: identity reference for short dusty lavender-gray hair, distinctive layered pointed ends, side swept fringe, amber brown eyes and sailor collar. Input image 2: costume and book reference — muted cyan blue sailor uniform, dark chocolate brown open cardigan, deep red ribbon, blue pleated skirt, navy knee socks, white indoor shoes with blue trim, small plain cream book.
Character: one full-body girl, about 2.25 heads tall, large round head and small compact body, slightly sleepy calm amber-brown eyes with restrained highlights, tiny neutral closed mouth, quiet gentle reserved presence. No glasses in this first prototype, in keeping with the project's usual mainline Yuki. No exaggerated smile or blush. Wear the recognizable modest school outfit from the references. Hold a small closed cream-colored book against her chest with both hands, leaving the red ribbon and blue collar readable.
Style: clean high-quality 2D anime chibi game sprite, smooth deliberate dark lavender-brown outlines, controlled cel shading with very gentle soft accents, simplified readable folds, soft muted colors. Cute rounded proportions but preserve Nagato Yuki's character identity.
Composition: single character, standing front view with a very subtle three-quarter turn, feet together, complete head and both feet visible, centered with modest even transparent margins. Draw the subject large in the image, around 88 percent of image height. Balanced stable pose, both hands anatomically simple and natural.
Backdrop: genuinely transparent alpha everywhere around the character. No floor, no environment, no ground shadow, no solid color or checkerboard baked into the image.
Constraints: no text, no signature, no watermark, no logo, no stickers or white halo outline, no sparkles or floating icons, no extra characters, no animals or cat ears, no 3D plastic render, no photographic texture. Deliver just the isolated clean full-body sprite.
```

## 当前定稿修订提示词

```text
Use case: identity-preserve.
Edit target: the supplied generated Nagato Yuki character sprite.
Make her MUCH MORE SUPER-DEFORMED CHIBI, a compact two-head-tall desktop pet. This is a strong proportion correction, not a subtle revision. Her large round head must occupy about 52 percent of her total height, with the tiny body and short stubby legs together occupying the remaining 48 percent. The torso is short and broad. The legs are short, about half the torso height; no long slender adolescent legs. Rounder, wider, cuter face, small rounded hands and shoes. The whole silhouette is compact and almost twice as tall as it is wide. Keep the same dusty lavender short tousled hair, amber-brown calm eyes, tiny neutral mouth, dark chocolate cardigan, blue sailor collar and pleated skirt, red ribbon, navy socks, white-and-blue shoes, closed cream book held against chest. No glasses. Preserve the restrained gentle character expression and clean 2D anime linework, with simplified cel shading. Full body, centered on a square canvas with 8 percent transparent margin all around.
Output: strictly transparent RGBA background. Delete ALL diffuse colored glow/haze around the silhouette; edges must end cleanly outside the linework. Absolutely no shadows, black gradient, vignette, backdrop, ground, text, icons, white border or checkerboard pattern. Just ONE compact two-head-tall chibi character with real transparent surroundings.
```
