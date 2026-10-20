# BioCraft Originals — writing icon recipes

> **Before drawing anything, read [`.claude/skills/biocraft-illustration/SKILL.md`](../.claude/skills/biocraft-illustration/SKILL.md)**
> — the house-style rules, colour conventions, required landmarks and the self-review checklist
> distilled from expert reviews of this library. Containment and variation helpers are in
> `lib/organic.mjs`.

New icons are drawn by **VectorCraft** (installed at `C:\Program Files\VectorCraft\vectorcraft-cli.exe`)
from small JavaScript recipes. Each recipe describes the icon as a list of *parts*; the renderer
(`lib/style.mjs`) draws every part twice over — once per house style — using VectorCraft's
exact path booleans for the shading:

| style | looks like | how parts are drawn |
|---|---|---|
| `soft` | Servier Medical Art | pastel fill, thin darker rim on the shadow side (bottom-right), a light band just inside the lit edge (top-left), two small specular dots, **no outlines** |
| `line` | NIH BioArt | slightly lighter flat fill + a dark outline in the part's own hue |

Light always comes from the **top left**. Keep shapes simple and recognisable at 40 px.

## Files

- `recipes/<topic>.mjs` — one file per topic, each exporting `icons` (see below). **Only edit your own file.**
- `lib/geom.mjs` — path helpers (read it; it is short).
- `lib/style.mjs` — the renderer and colour helpers `shade(hex, amt)`, `tint(hex, amt)`.
- `build.mjs` — draws recipes; writes `out/svg/<slug>.svg`, `out/preview/<slug>.png`, `out/meta/<topic>.json`.

## Icon definition

```js
import { blob, circle, ellipse, rect, capsule, ribbon, smoothClosed, smoothOpen, armsPts, blobPts,
         scatter, wavePts, polygon, polyline, rotate, rng, f } from "../lib/geom.mjs";
import { shade, tint } from "../lib/style.mjs";

export const icons = [
  {
    slug: "fibroblast-like-synoviocyte",          // unique, kebab-case, no "-line" suffix (added automatically)
    name: "Fibroblast-like synoviocyte (FLS)",    // human name shown in the library
    category: "cells",                            // one of the category ids below
    tags: ["FLS", "synovial fibroblast", "rheumatoid arthritis", "synovium"],   // search words, synonyms, abbreviations
    scene: (style) => ({ size: [200, 200], parts: [ /* bottom → top */ ] }),
  },
];
```

### Parts (drawn in order, first = bottom)

| field | meaning |
|---|---|
| `d` | SVG path data (absolute commands, as `geom.mjs` produces). An **array** draws several separate shapes with identical treatment. |
| `unite` | array of path data merged into **one** shape (VectorCraft *Unite*): lobed nuclei, granule clusters, a tube with a cap… Disjoint shapes become one compound shape — cheap to shade. |
| `fill` | base colour `#rrggbb` or `"none"` |
| `stroke` | `{ color, width, cap?: "round"|"butt", dash?: [6,4] }` — for lines, filaments, receptor stalks, DNA backbones. Stroke-only parts use `fill: "none"`. |
| `shade` | `"body"` (cells, big objects), `"organelle"` (nuclei, organelles, medium parts), `"small"` (granules, beads, small parts: just a rim), `"rim"` (rim only), `"dip"` (a hollow/concave area) — omit for flat parts |
| `opacity` | 0..1 |
| `gloss: false` | no specular dots (use for elongated or tiny parts where dots look odd) |
| `highlight: false` | no light band |
| `glossAt: [fx, fy]`, `glossSize` | move/resize the specular dots (fractions of the part's bounding box) |
| `soft: false` / `line: false` | skip the part in that style (e.g. faint chromatin specks only in soft) |
| `thin: true` | thinner outline in line style |

### Rules of thumb

- Design space is 200 × 200 (use `size: [w, h]` for wide objects, e.g. `[300, 140]`). Leave ~10 px margin.
- Fill colours: soft pastels like Servier (cytoplasm `#a9d6ee`, `#cfe8a8`, `#f6d9ab`, `#f5c6a5`…; nuclei purple/mauve `#8a7fc6`, `#9c78b8`;
  proteins/receptors saturated mid tones). Lab plastics: very light greys/blues with a coloured cap or liquid.
  Avoid pure black/white fills — they don't recolour well; use `#2b3440`-ish darks and `#f4f6f8`-ish whites.
- One colour per *part*: BioCanvas lets users recolour each part separately, and its shading follows.
  Distinct parts should differ clearly in hue **or** lightness.
- Prefer few, well-shaped parts over many tiny ones; shade big parts, keep small details flat or `"small"`.
- `blob(cx, cy, rx, ry, {n, wobble, seed, rot})` gives organic outlines; `armsPts` + `smoothClosed` gives
  pseudopods/dendrites; `capsule` gives rods; `ribbon(points, width)` gives bands along a curve;
  `scatter(cx, cy, rx, ry, count, {minDist, avoid:[[x,y,r]…]})` places granules.
- Deterministic: always pass `seed`s, never `Math.random()`.

## Category ids

`immune-cells`, `cells`, `organelles`, `membranes`, `proteins`, `nucleic-acids`, `molecules`, `viruses`,
`microbes`, `parasites`, `anatomy`, `tissues`, `people`, `animals`, `plants`, `lab`, `methods`, `shapes`, `charts`, `computing`, `other`

## Build and review

```bash
node originals/build.mjs <topic>.mjs                       # all icons in your file, both styles
node originals/build.mjs <topic>.mjs --only slug-a,slug-b  # just some
node tools/vc/sheet.mjs .cache/sheet-<topic>.png "originals/out/preview/*<prefix>*"   # contact sheet → look at it
```

Open the contact sheet PNG and **look** at every icon in both styles: is it recognisable, is the
shading on the right side, do parts overlap sensibly, does anything poke outside the art? Iterate
until each icon would look at home next to Servier Medical Art. Reference drawings are in
`sources/bioicons/svg/cc-by-3.0/*/Servier/` and `sources/nih-bioart/svg/` (for looking only — never copy their paths).
