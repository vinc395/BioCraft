// Page script for tools/dev/shot.mjs: the icon Style panel (presets, parts, colour overlay, glow),
// Layers with colour parts, a part's colour picker opened from Layers, two copies of one icon, and
// a preset previewed on the canvas by hovering.
//   node tools/dev/shot.mjs tools/dev/shots/style-panel.js --size 1500x1400 [--theme dark]
M.state.doc = M.newDoc();
M.state.selection = [];
C.renderDoc();
M.resetHistory();
C.fitView();
const a = await A.placeIcon("biocanvas/macrophage", [180, 180]);
const b = await A.placeIcon("nih/509-t-cell", [420, 200]);
const c = await A.placeIcon("biocanvas/macrophage", [300, 330]);
M.setSelection([a.id]);
document.querySelector('#tab-design .preset[data-preset="teal"]').click();
await shot("style-panel", "#inspector");
document.querySelector("#tab-design .linkbtn").click();
await shot("style-panel-more", "#inspector");
document.querySelector('#tab-design .overlays .swatch.ov[title="Magenta overlay"]').click();
[...document.querySelectorAll("#tab-design h3")].find((h) => h.firstChild.textContent === "Glow").querySelector("button").click();
document.querySelector("#tab-design").scrollTop = 0;
await shot("style-panel-overlay-glow", "#inspector");
P.showTab("layers");
document.querySelector(`#tab-layers .layer[data-id="${a.id}"] .twisty`).click();
document.querySelector(`#tab-layers .layer[data-id="${b.id}"] .twisty`).click();
await shot("style-layers-parts", "#inspector");
document.querySelector(`#tab-layers .part-row[data-id="${b.id}"][data-part="1"]`).click();
await sleep(50);
await shot("style-part-picker");
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
M.setSelection([a.id, c.id]);
await shot("style-panel-multi", "#inspector");
M.setSelection([c.id]);
document.querySelector('#tab-design .preset[data-preset="lavender"]').dispatchEvent(new PointerEvent("pointerenter"));
await shot("style-hover-preview", "#stage-wrap");
return { hovered: M.getObj(c.id).preset, undoable: M.canUndo() };
