---
name: biocraft-illustration
description: House style, drawing rules and a self-review checklist for BioCraft scientific illustrations — Servier-Medical-Art-like "soft" and NIH-BioArt-like "line" vector icons drawn from JavaScript recipes with VectorCraft (originals/recipes/*.mjs): cells, tissue sections in health and disease, organelles, molecules, lab equipment, method workflows (sequencing, spatial omics, proteomics, AI pathology), charts, people and anatomy. Use whenever you create, revise or review BioCraft Originals art, write or edit a recipe, judge whether an icon "looks right", or draw any Servier/BioRender-style biomedical vector illustration in this project.
---

# BioCraft illustration

**The bar:** every icon could sit in a journal figure next to Servier Medical Art and NIH BioArt without standing out. That means it is scientifically accurate, organic rather than mechanical, readable as a ~90 px library thumbnail, and clean when enlarged.

These rules come from what independent expert reviewers kept rejecting in this project. Each rule names the defect it prevents. Follow them up front; it is far cheaper than a review round.

## Workflow

1. **Research the subject.** Find out how it really looks: histology (H&E), gross anatomy, cryo-EM, vendor photos and schematics. Use web search when unsure. Write down:
   - its required landmarks ([references/landmarks.md](references/landmarks.md));
   - the 1–3 features that must survive at thumbnail size;
   - real size ratios between its parts.
2. **Calibrate.** Render 2–4 comparable Servier/NIH drawings and look at proportions, palette, detail density and line weight:
   `node tools/vc/big.mjs 1.5 sources/bioicons/svg/cc-by-3.0/<Category>/Servier/<file>.svg ... --sheet ref`
   The NIH drawings are in `sources/nih-bioart/svg/`.
3. **Plan in a comment at the top of the scene.** Cover:
   - canvas size;
   - layers from bottom to top, i.e. paint order;
   - colours, taken from [references/colours.md](references/colours.md);
   - which parts are united;
   - where the variation comes from (seeds, uneven spacing, clusters).
4. **Build:** `node originals/build.mjs <file>.mjs --only <slug,...>`. This writes both styles.
5. **Look.**
   - Run `node tools/vc/big.mjs 2 <slug> <slug>-line` and Read the PNGs.
   - Run a `--sheet` at scale 0.5 to judge thumbnails.
   - Look properly: zoom on joins, edges and inclusions.
6. **Self-review** against the checklist at the end. Fix, rebuild and look again until every box is honestly ticked.

## House styles

- **Light comes from the top left.** This applies to every part and every highlight. A highlight must never swap sides along a tube or curl.
- **soft (Servier):**
  - pastel fills, a darker rim on the shadow side (bottom right), a light band and specular dots on the lit side;
  - no outlines and no black, including outlines on deposits, nuclei or crystals;
  - use the shading levels `body`, `organelle`, `small`, `rim` and `dip`. Leave flat any part that is tiny, elongated or a background.
- **line (NIH):**
  - flat, slightly lighter fills with a dark outline in the part's own hue;
  - thin outlines (`thin: true` or `lineWidth`) on small parts;
  - backgrounds, fields and diffuse things get `line: false` or a faint dashed stroke. Diffuse plaques, desmoplastic beds and stromal zones are not crisp objects.
- **Colour.** Use one colour per meaningful part, because users recolour parts like in BioRender. Distinct parts must differ clearly in hue *or* lightness. Never use pure black or white fills.
- **No text.** Users add their own labels. Avoid shapes that read as glyphs, too: a centriole "7", a hippocampus "C", tilde squiggles, a "¬".

## The rules

### 1. Containment: inclusions stay inside, with a visible margin
Defects this prevents: nuclei sitting across cell borders or out in the stroma; tangles poking out of neurons; gloss crossing a cell edge; amyloid bands spilling outside a vessel wall; phagocytosed particles outside the cell.

- **Build inclusions from their container,** e.g. from the container polygon scaled by about 0.75 toward its centroid or offset inwards. Do not place them freely. Keep:
  - nuclei within 0.75–0.8 of the cell width at that point, and at least 1 unit from the membrane;
  - tangles at least 1.5 units in from the soma outline;
  - gloss at least 2 units in from the outline;
  - bands inside the wall annulus.
- **Check in code while developing:**
  ```js
  import { assertInside, fitInside, inFrame } from "../lib/organic.mjs";
  assertInside("nucleus " + i, nucD, cellD, 1);   // warns in the build output
  pts = fitInside(pts, cellPoly, 1) ?? pts;        // shrink/pull a nucleus back inside
  ```
- **Test the whole extent, never just the centre.** A spindle 30 units long whose centre is 8 units from the edge still pokes out of the frame. Use `inFrame(d, [0, 0, W, H], 3)`.
- **Overlays such as necrosis, fibrin, or a lumen cut into cells** must not leave half-nuclei at their edge. Remove the whole cell, or clip the overlay to the cells it replaces.

### 2. Paint order: definition order is drawing order
Defect this prevents: nuclei hidden under their own cytoplasm because their layer was defined before the body layer.

- `Layers` paints in the order of `L.def(...)`, not the order of `L.add(...)`.
- `std(L, [...])` and `defineLayers` insert layers wherever you call them. Define each inclusion layer *after* its container layer.
- Before building, read your `def` sequence from top to bottom and ask: "is everything that sits on top of X defined after X?"

### 3. Organic, not mechanical
Defects this prevents: 24 identical T cells in an evenly spaced chain; three rotated microglia clones exactly 120° apart; cog-wheel gyri; snowflake astrocytes; identical squiggle "worms"; rulers of evenly spaced teeth; convex blobs packed with blue noise standing in for UMAP clusters.

- **Vary everything a real specimen varies, with seeded randomness:**
  - size: ±15–30%;
  - spacing: coefficient of variation 0.3–0.4 (`unevenSpacing`, `unevenAngles`);
  - angle, length and outline wobble;
  - nucleus shape and position;
  - the number of processes.
- **Cluster where nature clusters** (`clustered`): infiltrates, granules, data points with dense cores and sparse edges, a few outliers.
- **Never repeat a cell by rotation or translation alone.** Use `instances(R, n)` to give each copy its own scale, rotation, seed and variant.
- **Avoid perfect symmetry, rings of equal elements and straight radial spokes.** Real tissue has dominant features: one deep sulcus, one large population, one thick bundle.
- **Fibres and matrix:** use fewer, longer bundles of 2–3 parallel strands that follow the structures they wrap. Many short, evenly scattered squiggles read as background noise.

### 4. Topology: what touches in reality touches in the drawing
Defects this prevents:
- floating "stickers": a caudate island inside the ventricle, a hippocampus adrift in white matter, thalami separated from the third ventricle;
- an enzyme hovering above the DNA it acts on;
- anchors in the wrong place;
- cortex wrapped where none exists;
- a missing corpus callosum or insula;
- a vessel ending blind;
- base pairs out of register.

- **Before building, list the adjacencies** (A forms the wall or floor of B; C binds or clamps D; E is continuous with F) and draw shared boundaries, not gaps.
- **Check the required landmarks** for the subject in [references/landmarks.md](references/landmarks.md). A missing defining landmark is a blocker.
- **Vessels branch or leave the frame; they never end in a cap.** Neurites enter from outside. Strands are anchored where the chemistry anchors them.

### 5. True scale relationships
Defects this prevents:
- a cell larger than the 10x gel bead it shares a droplet with;
- an "activated" CAF smaller than the resting fibroblast icon;
- a microglion swallowing a whole plaque;
- one step of a workflow strip shrunk to a speck.

- Keep the real size ratios inside a drawing.
- Keep the scale consistent across a set and against existing library icons of the same thing.

### 6. Silhouette first
At 90 px, only the outline and the 1–3 key features survive. The outline must say what the thing is:
- **hypertrophic astrocyte:** a big soma and thick, uneven processes;
- **macrophage:** ruffled, pointed pseudopods;
- **NFT neuron:** a flame inside a triangular soma;
- **sequencer:** a screen with base colours or a flow-cell slot.

Avoid misleading tropes:
- stars, suns, pies and sunflowers for plaques;
- snowflakes and asterisks for glia;
- app-tile rounded squares with drop shadows for natural things;
- a generic box for an instrument.

### 7. The mechanism must be readable
The defining event must be visible at 1× and at 0.5×:
- Tn5 or MNase cuts as real gaps, at least 4–8 units wide *after* line caps;
- a basement membrane visibly breached, with cells crossing it;
- binding as contact;
- pairing teeth in register;
- the key object of a workflow step at least 26 px across on the 0.5× sheet.

Every element in a workflow strip must stay consistent with the component icons, e.g. use the same oligo segment colours.

### 8. Colour conventions and telling things apart
- Use the library colours for each cell type and molecule ([references/colours.md](references/colours.md)). A user mixing your icon with library icons must not get two different "M2 macrophage" colours.
- Neighbouring types need a hue difference **and** a shape cue: receptors (Y, stick, ball), granules, nucleus shape. Treg vs NK and sage M2 vs mint CD8 are known traps.
- One meaning per colour across a whole set or series.
- Disease contrast must survive thumbnails. Saturate or enlarge the hallmark (plaque core, necrosis, infiltrate) rather than adding many faint details.

### 9. Shading correctness
- Objects that each need their own crescent and highlight, such as droplets, separate cells or beads, must be **separate parts**. One compound `d` shades as one object, so the rim falls across the group.
- Pieces that form one silhouette (bulb + tail, soma + dendrite trunk) belong in one `unite` part. Separate subpaths draw internal rims, which looks "skewered".
- **Charts and data marks are flat:** no sphere shading, which distorts the encoded size and colour. Legend keys are shaded exactly like the marks they explain.

### 10. Clean geometry
- No self-intersecting outlines. Carve slits and holes with real booleans (`unite`, or a difference) instead of splicing points into an outline.
- Smooth joins: fillet dendrite trunks into the soma, give DNA entry and exit points tangent-continuous curves, and use arcs instead of pipe elbows. Avoid zig-zag hooks at strand ends.
- No stepped corners. Side bands follow the corner radius as a crescent.
- Nothing outside the art box, and no big empty margins. Crop to a margin of about 8–10 units and centre the drawing.
- Text-like artefacts and stray dashes count as defects.

## Self-review checklist (tick honestly before reporting)

- [ ] I compared the drawing against real references. Every required landmark is present and all adjacencies touch.
- [ ] Sizes are true to life within the drawing and consistent with the library.
- [ ] No inclusion crosses its container: I ran `assertInside` or zoomed in on every nucleus, tangle and gloss. Nothing pokes out of the frame.
- [ ] Inclusion layers are defined after their containers.
- [ ] No clones, no even chains or rings, no radial combs. Spacing and size vary, and clusters look natural.
- [ ] The silhouette identifies the subject at 0.5×. The disease hallmark or mechanism is visible at 0.5×.
- [ ] Colours follow references/colours.md. Neighbouring types differ in hue and shape.
- [ ] Shading: light is top-left everywhere, separate objects are separate parts, silhouettes are united, and charts are flat.
- [ ] Line style: no crisp outlines on diffuse things, no stray outline loops, and thin lines on small parts.
- [ ] No text, glyph look-alikes, stepped corners, blind-ending vessels or empty canvas.
- [ ] Tags carry the synonyms, abbreviations and technique or vendor names people will search for.

## Tooling

- **Recipe format:** see `originals/RECIPES.md` for part fields, shading levels and category ids. Helpers live in `originals/lib/`:
  - `geom.mjs`, `tissue.mjs` (cellBand, honeycomb, packWhere…), `histo.mjs` (Layers, vessels, immune cells);
  - `organic.mjs`: `checkInside`, `assertInside`, `fitInside`, `inFrame`, `unevenSpacing`, `unevenAngles`, `clustered`, `instances`, `vary`.
- **Unite layer:** `L.def("k", { fill, unite: [] })`, then `L.map.get("k").unite.push(d)`. The pieces become one merged shape.
- **Determinism:** always use `rng(seed)`, never `Math.random()`.
- **Gotchas:**
  - Write multi-line files with the Write or Edit tool, not bash heredocs.
  - In Node `String.replace`, `$$`, `$&` and `$'` in the replacement are special, so use `split`/`join`.
  - Syntax-check with `node --input-type=module --check < file.mjs`.
  - `big.mjs` needs the BioCraft server on port 8791 (`target/debug/biocraft.exe --serve 8791`).
- **Don't run libbuild.** The library is rebuilt in one go with `biocanvas-libbuild --only biocanvas --update` after recipes change.
