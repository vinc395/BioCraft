# BioCraft figure guide for AI agents

BioCraft is a local editor for scientific illustrations with a library of ~12,000 open biology
icons, ~17,000 with their colour and style variants (Servier Medical Art, NIH BioArt, Reactome,
Bioicons, DBCLS TogoTV, PhyloPic, Health Icons, BioCraft Originals). You draft a figure as JSON;
BioCraft draws it exactly as the desktop app would and saves a `.biocraft` file that the author
opens and refines in the app.

## The loop

1. **search_icons** — find icons by plain words ("macrophage", "synovial joint", "antibody").
   Look at the contact sheet; prefer one art style per figure (`style`: soft = Servier-like
   shading, line = NIH-like outlines).
2. **get_icon** — check its proportions (`aspect` = width / height), colour slots, licence and
   whether it carries its own text labels (`aspect_labels_hidden` is its shape without them).
3. **render_figure** with a figure spec — read the warnings and LOOK at the preview image. It
   saves the editable figure (`save`, default `Documents/BioCraft figures/<title>.biocraft`,
   which never replaces a file the author saved or edited: the draft then gets a numbered name,
   see `saved` and `save_note`) and exports `out` (.png/.tiff at `dpi`, .pdf, .svg;
   `transparent: true` for PNG/TIFF without a background). `figure_path` re-renders or exports a
   saved .biocraft, e.g. after the author has edited it; that file is not re-saved unless you
   pass `save`.
4. Refine positions, sizes, colours and labels; render again until it reads well.
5. Give the author the saved `.biocraft` path (new figures are saved in the figures folder, so they
   also appear on the app's home page under My files; the app saves figures there as the author
   edits them, so render from `figure_path` to export their latest version) and call
   **open_in_biocraft**; put the returned
   `credits` text in the figure legend. With the final export pass `licence_report: true` to write
   a licence & attribution report beside it (`<out>-licence.pdf`, `.md`, `.csv`; or choose the
   path with `licence_report_path`) and give the author its paths. Pass `publication` {journal,
   manuscript, figure_title, open_access: cc-by | oa-other | subscription, date} to put the journal
   on the report; the result's `publication_check` says whether the icons' licences fit it.

## Figure spec

Units are millimetres from the top-left corner of the page (x to the right, y down). Objects
are drawn in list order: the first is at the back. Fields marked * are required.

```json
{
  "width_mm": 178, "height_mm": 100,       // * page size
  "background": "#ffffff",                  // default white; null or "none": no background
                                            // (PNG/TIFF still white unless transparent: true)
  "title": "RA synovitis",                  // optional; names the saved file
  "objects": [ ... ]                        // * see below
}
```

### icon
`{"type": "icon", "id": "servier/macrophage", "x": 10, "y": 20, "w": 30}`

- `id`* — a library id from search_icons.
- Position: `x` (left edge) or `cx` (centre), and `y` (top edge) or `cy` (centre) — mix freely,
  e.g. `"cx": 40, "y": 20`.
- `w` **or** `h` — size in mm (default 30 mm wide); the icon keeps its proportions.
- `rotate` (degrees, clockwise, about the centre), `flip`: `"h"`, `"v"` or `"hv"`, `opacity` 0–1.
- Colour, one of:
  - `colors`: per colour slot, in the order get_icon lists them — `["#0072b2", null, "#e69f00"]`
    (null = keep) or `{"1": "#d55e00"}`. Each slot keeps its highlights and shadows.
  - `tint`: `"#009e73"` — the whole icon in one hue.
  - `grayscale`: `true`.
- `labels`: `"hide"` removes the text labels drawn inside the icon, with stroked leader lines and
  their end dots, and crops to what is left (as the app's Hide button does; leaders drawn as
  filled shapes stay). `"show"` (default) keeps them.
- `name`: layer name shown in the app.

### text
`{"type": "text", "text": "T cell\n(CD4+)", "x": 40, "y": 52, "size_pt": 8, "align": "center"}`

- `text`* (`\n` for line breaks), `x`*, `y`* — the top edge of the text, at its left, centre or
  right end according to `align` (`"left"` default, `"center"`, `"right"`).
- `size_pt` (default 8), `color` (default `#1c2733`), `bold`, `italic`, `font` (default Arial),
  `rotate`, `line_height` (× size, default 1.25), `opacity`.

### arrow, inhibit, line
`{"type": "arrow", "from": [50, 40], "to": [80, 40]}`

- `from`*, `to`* — end points `[x, y]`.
- `type`: `arrow` ends in an arrowhead, `inhibit` in a flat bar (⊣), `line` has no head.
- `head` (end) / `tail` (start): `"arrow"`, `"open"`, `"bar"`, `"dot"`, `"diamond"`, `"none"`.
- `curve_mm` — bow at the midpoint; positive bends to the right of the direction of travel
  (downwards for a left-to-right arrow), negative to the left.
- `color` (default `#2b3440`), `width_pt` (default 1.5), `dash`: `"dash"`, `"long"` or `"dot"`
  (very fine dots; prefer `"dash"`), `head_scale` (default 1), `opacity`.

### rect, ellipse
`{"type": "rect", "x": 5, "y": 5, "w": 80, "h": 60, "fill": "#eef6fb", "stroke": null, "radius_mm": 3}`

- `x` or `cx`, `y` or `cy` (as for icons), `w`*, `h`*.
- `fill` (rect `#d9ecf7`, ellipse `#fde7c8` by default; `"none"` or null for none), `stroke`
  (default blue/orange; `"none"` or null), `stroke_pt` (default 1.125), `dash`, `radius_mm`
  (rect corners), `rotate`, `opacity`.

### brush — a pattern drawn along a smooth path
`{"type": "brush", "pattern": "bilayer", "points": [[10, 80], [90, 75], [170, 80]]}`

- `pattern`*: `bilayer` (lipid bilayer), `dna`, `rna`, `cuboidal`, `columnar`, `squamous`
  (epithelial cell rows on a basement membrane), `actin`, `microtubule`, `collagen`, or `icon`
  (repeat a library icon; give its id in `icon`).
- `points`* — `[[x, y], …]`, at least 2 (3 for a loop); the curve passes through them.
- `closed` (loop), `fill` (inside a closed loop), `thickness_mm` — default (allowed range, as
  in the app): bilayer 4.2 (1.6–15.8), dna 5.8 (2.2–23.8), rna 3.7 (1.6–15.8), cuboidal 9
  (2.7–37), columnar 15.9 (4.3–58.2), squamous 2.6 (1.1–15.8), actin 3.2 (1.1–15.8),
  microtubule 6.4 (2.2–23.8), collagen 4.2 (1.4–21.1), icon 10.6 (1.6–79.3).
- `colors`: bilayer `{"head": "#…", "tail": "#…"}`; dna `s1 s2 a t g c`; rna `s1 a u g c`;
  cells `cell edge nuc bm`; actin `m1 m2`; microtubule `a b`; collagen `f d`; icon: slot colours
  as for icons.
- `side`: `-1` (default; cells and bases on the left of the direction of travel, i.e. above a
  left-to-right path) or `1`. `apical`: `"microvilli"` or `"cilia"` (cuboidal and columnar),
  `basement`: false hides the basement membrane, `spacing` (0.4–2.5, 1 = normal; not bilayer),
  `seed` (variation), `jitter` 0–1 and `follow` (icon pattern).

### group
`{"type": "group", "name": "Joint", "objects": [ ... ]}` — moves and selects as one in the app.

Errors name the exact field to fix (`objects[3] (icon): "w" must be …`). Fields that start with
`_` are ignored, so you can leave notes.

## Design tips

- **Size for the journal**: 85 mm (single column), 114 mm (1.5 columns) or 178 mm (full width);
  keep height under ~230 mm. Graphical abstracts are often 178 × 90–110 mm.
- **Grid**: 5 mm margins, align things on a 5 mm grid, keep gaps equal. Lay out in reading order
  (left → right or top → bottom) with one clear story.
- **Text**: 6–9 pt at final size (7–8 pt for labels, 9–10 pt for headings, bold panel letters
  A, B at 10–12 pt). One font (Arial/Helvetica). Label close to the thing, not with long leaders.
- **Icons**: draw things of the same kind at the same scale (all cells ~12–18 mm wide), keep one
  art style, and hide built-in labels (`"labels": "hide"`) when you label them yourself.
- **Arrows**: pointed arrowheads for activation, flow, secretion or "leads to"; flat-headed
  inhibition (`"type": "inhibit"`) for blocks/suppresses; dashed for indirect or hypothesised
  steps. 1–1.5 pt lines; bend with `curve_mm` to route around icons; leave 1–2 mm between an
  arrow end and the icon it points at.
- **Colour**: use the colour-blind-safe Okabe–Ito palette and give each colour one meaning:
  `#E69F00` orange, `#56B4E9` sky blue, `#009E73` bluish green, `#F0E442` yellow, `#0072B2`
  blue, `#D55E00` vermillion, `#CC79A7` reddish purple, `#000000` black. Avoid red-vs-green
  contrasts; pale fills (`#eef6fb`, `#fdf3e7`) make good background panels.
- **Credits and licences**: CC BY icons (Servier, DBCLS, many Bioicons) require the credit line
  returned as `credits`; put it in the figure legend. CC0 and public-domain icons don't need
  it, but citing them is good practice. CC BY icons you recolour, grey out, give a glow, make
  transparent or strip of their labels are changed, so the credit says “adapted from” for them.
  CC BY-SA icons can oblige the figure to be shared under CC BY-SA (avoid them with
  `license: "nosa"`), and MIT/BSD icons (Health Icons) need their licence notice to travel with
  the figure; `licence_report` writes all of this down. BioCraft grants no licence itself.

## Command line

    biocraft search "synovial fibroblast" --limit 10
    biocraft icon servier/macrophage --png macrophage.png
    biocraft render figure.json --out figure.png --save figure.biocraft --dpi 300 --licence
    biocraft figure.biocraft        (opens it in the app)
