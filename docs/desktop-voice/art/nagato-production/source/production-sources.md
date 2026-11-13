# 长门有希常服原画来源

选定的全身稿、腿袜与双鞋原画、本轮三个分件素材保存在本目录。此处的左右为角色自身方向，角色右侧出现在画面左边。PSD 的绘画层使用下列生成图中的本侧像素，配准包括边缘裁切、缩放、透明度和颜色匹配。

- **后发 3 层、前发 7 层**。前发和后发以 B 稿头部为参考各自生成，再从前发稿拆出发顶、三束刘海和左右侧发，从后发稿拆出后发底和左右后颈发束。发根补层和侧发接缝使用单独生成的发根与侧发素材。
- **颈耳 3 层**。独立颈部和双耳生成稿。两耳按原画各自对位。
- **制服与四肢 23 层**。左右腿袜和左右鞋各一层，分别取自同侧生成稿。裙前后、左右侧褶、胸前内衬和开衫将 B 稿的可见原画与对应生成补层对位。左右袖臂各有上臂袖、前臂袖、袖口、手掌四层，肩肘和腕根取自各侧生成稿。左右衣领、领结结头从 B 稿拆出。两条飘带按完整领结分件生图，含结头下的根部。[全身 B 稿](full-uniform-b.png) · [全身 C 稿](full-stance-c.png) · [腿袜原画](legwear-pair.png) · [双鞋原画](loafer-pair.png) · [飘带原画](ribbon-pair.png)
- **脸部 30 层**。脸底、五官、发影、双眼、口型和眼镜。左右眼各有眼白、虹膜、眼内高光、上下睫毛和闭眼线，按各侧画面拆分。闭口从五官稿拆出，张口唇线、口腔、牙齿、舌从开口姿态及分件生成稿拆出。眼镜来自独立生图。六片发影从本轮生成稿拆出，随发束动并裁切在脸底上。[发影原画](fringe-shadows.png) · [高光原画](eye-glints.png)

前轮完整原件和提示词保存在本机 `.cache/nagato-canon-review`、`.cache/nagato-gpt-layer-review` 和 `.cache/nagato-layer-completion`。后者按 `hair`、`arms`、`uniform`、`face` 保留了原画和图层清单。复核时打开 66 层 PSD 和对应 PSD2Live 工程。[制作与交付记录](../../../nagato-live2d-production.md)

## 本轮生图提示词

使用内置 GPT ImageGen。下方保留入选稿的提示词。

### 发影

常服 B 稿、头部近景、六块旧发影的轮廓参考。按生成图的三列两行拆成六层，单独配准并调回半透明。 [生成原件](fringe-shadows.png)

> Create a production sprite sheet for the Live2D cast shadows of the FRONT HAIR of the exact Yuki Nagato character. Image 1 is the approved complete character, establishes animation style. Image 2 is the matching neutral head and its muted upper-left anime light. Image 3 is a six-cell exact silhouette and layout guide. Make a precise redraw of the six ISOLATED warm brown cel cast-shadow sprites in image 3. Copy its 3-column, 2-row order and retain each distinct silhouette and orientation precisely, including its flat root edges, number of tips, tip angles, and subtly asymmetric curves. Top left is a very thin left temple curve bending to the left, top center is the two-tipped viewer-left fringe, top right is the two-tipped central fringe with a longer right point; bottom left is the three-tipped viewer-right fringe, bottom center is the thin right temple curve bending right, bottom right is the broad shallow forehead shadow cap, a dome with a flat base. Each shape only needs ONE solid muted sienna fill around #945f48. Crisp clean anti-aliased anime edges, solid opaque inside, true transparent alpha outside and between ALL six pieces, with generous empty margins so they can be cropped individually. Match the SHAPES in image 3 rather than drawing a head or hair. No hair strands, face, features, outlines, strokes, shading texture, gradient, depth, numbers, guides, grid, words, checkerboard, other pieces, or extra objects. A single wide sprite sheet ready for six separate model textures.

### 左右飘带

常服 B 稿、完整领结近景、两条飘带轮廓参考。按左右分开，保留结头下的完整根部。 [生成原件](ribbon-pair.png)

> Draw TWO separate exact anime uniform ribbon tail artwork pieces for a Live2D model of Nagato Yuki, on true transparent alpha. Image 1 defines the complete character; image 2 is the exact complete bow and color reference; image 3 is a two-column alignment and silhouette guide. Draw only the two long narrow deep burgundy fabric streamers, viewer-left tail on the left and viewer-right tail on the right, each independently drawn and with its own slightly asymmetric ink line and upper crease, no reflection duplicates. Preserve how their upper half narrows, their lower halves widen gently and the original two tips are cut on opposite slants, with the inner ends pointing down. Follow the straight static reference shape and length, do not curve or design a new bow. The tails each have a fully drawn skinny burgundy root that starts behind the bow knot, so the top ten percent has continuous fabric and can bend without a gap. Visible color match image 2 exactly, desaturated cool cranberry #802b35, soft single dark muted maroon fold near root, fine dark brown-gray outline, matte late-2000s 2D anime cel artwork. Center two tails with large horizontal gap and generous empty margin. No knot, bow wings, school fabric, body, guide lines, ground or cast shadow, realistic sheen, gradient, text, or background. Entire tail edges visible and separated.

### 双眼高光

常服 B 稿、头部近景、两眼高光位置参考。按每眼三点配准，仍跟随虹膜并使用对应的眼白裁切。 [生成原件](eye-glints.png)

> Produce ONLY six small white anime eye highlight marks as two separate sets of three, on a true transparent sprite plate. Image 1 is the approved complete character, Image 2 the same approved eyes and lighting, Image 3 the exact layout at enlarged scale. Closely redraw each irregular smooth shape seen in Image 3, preserving its relative width and height, position and perspective. Each side has a very small upper-left near-round mark, a slightly larger lower-left soft ellipse and a tiny lower-right speck. Each set is subtly distinct as in image 3. Keep the same horizontal separation between the two groups and the same vertical distances. Think of simple painted creamy-white (#fff9ef) Japanese cel animation glints. Solid opaque warm white with smooth anti-aliasing on the edge. All surrounding and intervening pixels truly transparent. The two sets each occupy similar rectangular areas with comfortable margins, viewed front-on. No eye, pupil, iris, sclera, lashes, facial components, border, outline, colored backing, glow, colored shadow, labels, lettering, background or additional marks. Only six tiny matte paint dabs, matching the two grouped sets in the third reference.
