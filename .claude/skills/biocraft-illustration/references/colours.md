# BioCraft colour conventions

These are the colours already used by library icons. Reuse them, so that a figure mixing your new icon with existing ones shows one colour per cell type or molecule. Shades and tints come from `shade()` / `tint()` in `lib/style.mjs`; don't invent new near-duplicates.

## Immune and blood cells (single-cell icons, `recipes/immune.mjs`)

| Cell | Body | Nucleus | Distinguishing cue |
|---|---|---|---|
| CD4 helper T cell | `#a9d6ee` light blue | `#8a7fc6` | Y receptors `#3f6fa6` |
| CD8 cytotoxic T cell | `#bfe5cf` mint | `#6f8fc4` | Y receptors `#2f7a5a`, granules `#e2677f` |
| Treg | `#f6d9ab` apricot | `#9c78b8` | stick receptors `#b9772a` |
| B cell | `#cfe8a8` light green | `#8b78bf` | Y (BCR) receptors `#5f8f2f` |
| NK cell | `#f7e6a8` pale yellow | `#8d7cc4` | ball-tipped receptors `#b0892a`, red granules `#d9534f` |
| Plasma cell | `#f3c9d6` | `#8c5ea3` (eccentric, clock-face) | ER `#d58aa4`, perinuclear halo `#fbe4eb` |
| Macrophage (generic, also TAM) | `#f5c6a5` peach | `#a17cba` | ruffled pointed pseudopods, vacuoles `#fbe3d1` |
| M1 macrophage | `#f2a7a0` salmon | `#8e6aa8` | vacuoles `#fad6d1` |
| M2 macrophage | `#b8dcc4` sage | `#7d76b8` | vacuoles `#e1f2e7`. Next to mint CD8 cells, rely on the pseudopod silhouette and nucleus |
| Monocyte | `#cfe1f4` | `#8e74bd` kidney | small vacuoles `#b8a5d8` |
| Neutrophil | `#f6dde6` | `#7d4b9f`, 3–5 lobes joined by thin strands | granules `#e8a9c2` |
| Eosinophil | `#fae2d6` | `#6b58a8`, bilobed | orange granules `#ef7b55` |
| Basophil | `#e6def4` | `#7a68b2` | dark granules `#4b3a7d` covering the nucleus |
| Mast cell | `#f4e3c8` | `#8a68b0` | granules `#8e4aa6` |
| Dendritic cell | `#bfe4da` | `#6f8cc4` | long veils/dendrites |
| Platelet | `#ead0f2` | — | granules `#a86cc1` |
| Red blood cell | `#e04b4f`, centre `#ea6a66` (`dip`) | — | biconcave |
| Haematopoietic stem cell | `#ddd5f5` | `#9584d8` | short sticks `#7461b8` |

Rule: a tumour-associated macrophage is drawn peach (generic) unless the figure explicitly contrasts M1/M2. In that case use salmon for M1 and sage for M2.

## Tissue-scale cells and stroma (`lib/histo.mjs` palette `C`)

| Element | Colour |
|---|---|
| Generic nucleus (H&E-like purple) | `#8b63b3` |
| Matrix / stroma (healthy) | `#fbe3e1`; inflamed `#f8d3d3`; fibrotic `#f7dcd6` |
| Collagen fibres | `#eebaba` (line colour `#dca5a8`) |
| Fibroblast | `#ef9fbf` |
| FLS (synovial fibroblast-like) | `#f4c3d1` |
| MLS (synovial macrophage-like) | `#e3caee` |
| Vessel wall / lumen | `#f29a9e` / `#fdebe9`; artery media `#e3828b` |
| RBC (tissue scale) | `#d9434b` |
| Endothelial nuclei | `#a974b9` |
| Lymphatic | `#bfe3c8`, lumen `#effaf1` |
| Fat | `#fbe8a6`, border `#e2c470`, nuclei `#b392c7` |
| Fibrin | `#f6e6a4` |
| T cell / nucleus | `#9fcaf0` / `#4e63ad` |
| B cell / nucleus | `#c2e3a1` / `#4f7c3a`; germinal centre `#e2f1fb` |
| Plasma cell / nucleus | `#f3b8cd` / `#7b4c9c` |
| Macrophage / nucleus | `#f6c09d` / `#9a6aa9` |
| Mast cell / granules | `#f2dcc0` / `#8e4aa6` |
| Neutrophil / nucleus | `#f8d9e4` / `#7b4a9e` |

Organ-specific palettes already in use (keep them consistent within a series):
- **Kidney:** proximal tubule `#f1a6b4`, distal `#f7cdd4`, brush border `#f9dbe1`, capillary loop `#ec97a5`, mesangium `#f3bccb`, podocyte nuclei `#7d55a6`.
- **Bronchus:** epithelium `#f6cdd3`, goblet `#e3e5f6`, smooth muscle `#ee9aa4`, cartilage `#d6d2ee`, mucus `#cdd6ef`.
- **Brain** (`brain.mjs` `P`): neuron `#f5cf7f`, astrocyte `#b5d99a`, microglia `#a3cdec`, oligodendrocyte nucleus `#5a55a3`, amyloid `#e08d48` (core `#c2622d`), tangle `#433774`.

## Molecules and methods (`recipes/methods-seq.mjs` `COL`)

| Element | Colour |
|---|---|
| DNA (chromatin scale) | `#8e72c9` violet, kept distinct from blue antibodies |
| Histone octamer | `#f4a7b9` |
| Antibody heavy / light chain | `#5b8bd9` / `#f0a35c` |
| Protein A/G | `#45b7b0`; magnetic bead `#a0703f` |
| Tn5 / pA-Tn5 | `#7cc46a`; adapters `#e2566f` and `#f2c14e` |
| MNase | `#df5a4e`; TF `#f2c14e`; histone mark `#b8323f` |
| Capture oligo segments | Read 1 `#4f86d0` → cell barcode `#ef8f4a` → UMI `#9a7bd0` → poly(dT) `#f2c14e` |
| mRNA / poly(A) / 5' cap | `#d9609a` / `#74c267` / `#b0444f` |
| Gel bead / droplet / oil | `#b3c3ef` / `#dff0fb` / `#fbeec4` |
| Bases | A `#3aa655`, C `#4f86d0`, G `#f0a050`, T `#d64f5c` |
| P5 / P7 | `#45b7b0` / `#f0a050`; forward / reverse strands `#8e72c9` / `#e86a9a` |
| Lab plastic | `#e3edf4`, dark `#cadbe7`; instrument housing `#4d5866` |

Brush defaults (ui/js/brush.js):
- **DNA:** strands `#2f6db5` / `#e0634f`; bases A `#f2b83d`, T `#7cc36e`, G `#5aa6e0`, C `#b07cd1`.
- **Lipid heads / tails:** `#f0a35c` / `#e9c88f`.

## Charts

- Categorical clusters: `#4e8fd6 #f0a050 #6cbf68 #e2606a #9b7fd1 #45b7b0 #ec8fc0 #d9b43a`.
- Colour-blind-safe alternative (Okabe–Ito): `#e69f00 #56b4e9 #009e73 #f0e442 #0072b2 #d55e00 #cc79a7 #000000`.
- Axes `#6f7d8c`. Data marks are flat (no shading); legend keys match the marks.
