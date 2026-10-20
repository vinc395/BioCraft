// Page script for tools/dev/shot.mjs: the Insert menu, legends, scale bars and panel labels in the
// real app — inserting from the menu, editing legend rows in the Design panel (rename, reorder,
// remove, add), double-clicking a row, dragging handles, the panel labels dialog, Layers, undo.
//   node tools/dev/shot.mjs tools/dev/shots/furniture.js --out tools/dev/out/shots --size 1500x1000 [--theme dark]
M.state.doc = M.newDoc();
M.state.selection = [];
C.renderDoc();
M.resetHistory();
C.fitView();
const R = {};
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const stage = $("#stage");
const scr = (x, y) => {
  const r = stage.getBoundingClientRect(), [sx, sy] = C.docToScreen(x, y);
  return [sx + r.left, sy + r.top];
};
const fire = (type, [x, y], { down, hover, ...extra } = {}) => {
  const ev = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerdown" || down ? 1 : 0, pointerId: 1, pointerType: "mouse", ...extra });
  (type === "pointerdown" || hover ? document.elementFromPoint(x, y) : window).dispatchEvent(ev);
};
const drag = async (from, to, extra = {}, steps = 8) => {
  fire("pointerdown", from, extra);
  for (let i = 1; i <= steps; i++) fire("pointermove", [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps], { ...extra, down: true });
  await sleep(40);
  fire("pointerup", to, extra);
  await sleep(40);
};
const handleAt = (h) => {
  const e = $(`#overlay [data-h="${h}"]`);
  if (!e) return null;
  const b = e.getBoundingClientRect();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const menuItems = () => $$(".dropdown .item").map((r) => r.querySelector(".mi-label")?.textContent);
const clickItem = (label) => {
  const row = $$(".dropdown .item").find((r) => r.querySelector(".mi-label")?.textContent === label);
  if (!row) throw new Error("no menu item " + label);
  row.click();
};
const openInsert = () => $('#menus .menu[data-menu="insert"] button').click();
const legend = () => M.state.doc.objects.find((o) => o.type === "legend");
const bar = () => M.state.doc.objects.find((o) => o.type === "scalebar");

// a small figure: three kinds of cell, one of them twice and one recoloured
const cells = [];
for (const [id, x, y] of [["nih/509-t-cell", 120, 140], ["biocanvas/macrophage", 300, 140], ["nih/509-t-cell", 480, 140], ["biocanvas/b-cell", 300, 320]]) cells.push(await A.placeIcon(id, [x, y]));
A.updateSel(() => {}); // (placeIcon selected the last one)
M.setSelection([cells[3].id]);
A.updateSel((o) => (o.colors = { ...o.colors }));
M.setSelection([]);
C.renderDoc();
M.resetHistory();

// 1. the Insert menu sits between Edit and Arrange
R.topMenus = $$("#menus .menu > button").map((b) => b.textContent);
openInsert();
await sleep(50);
R.insertItems = menuItems();
await shot("insert-menu");
// From My library opens a submenu
const mine = $$(".dropdown .item").find((r) => r.querySelector(".mi-label")?.textContent === "From My library");
mine.dispatchEvent(new PointerEvent("pointerenter"));
await sleep(250);
R.myLibrarySub = $$(".dropdown.submenu .item").map((r) => r.querySelector(".mi-label")?.textContent).slice(-3);
await shot("insert-mylibrary");
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

// 2. Insert › Legend
openInsert();
await sleep(30);
clickItem("Legend");
await sleep(80);
const L = legend();
R.legendRows = L.rows.map((r) => r.label);
R.legendSelected = M.state.selection[0] === L.id;
R.panelRows = $$("#tab-design .lrow").length;
await shot("legend-inserted");
await shot("legend-panel", "#inspector");

// 3. rename row 0 by typing, move row 0 down, remove the last row
const inp = $('#tab-design .lname[data-row="0"]');
inp.focus();
inp.value = "Helper T cell";
inp.dispatchEvent(new Event("input", { bubbles: true }));
inp.dispatchEvent(new Event("change", { bubbles: true }));
inp.blur();
await sleep(50);
R.renamed = legend().rows[0].label;
const x0 = legend().x, y0 = legend().y;
$$('#tab-design .lrow')[0].querySelector('[aria-label="Move down"]').click();
await sleep(50);
R.afterMove = legend().rows.map((r) => r.label);
R.topLeftKept = Math.abs(legend().x - x0) < 1e-6 && Math.abs(legend().y - y0) < 1e-6;
$$("#tab-design .lrow").at(-1).querySelector('[aria-label="Remove"]').click();
await sleep(50);
R.afterRemove = legend().rows.length;
// 4. + Add row → Arrow (activation); and the icon brought back from the figure
const addBtn = [...$$("#tab-design button")].find((b) => b.textContent === "+ Add row");
addBtn.click();
await sleep(50);
R.addMenu = menuItems();
R.addMenuPictures = $$(".dropdown .item").map((r) => !!r.querySelector("img.mi-img")).every(Boolean);
await shot("legend-add-menu");
clickItem("Arrow (activation)");
await sleep(50);
R.afterAdd = legend().rows.map((r) => r.label);
[...$$("#tab-design button")].find((b) => b.textContent === "Update from figure").click();
await sleep(50);
R.afterUpdate = legend().rows.length;
// title, two columns, border
const title = $('#tab-design input[placeholder="Title (optional)"]');
title.value = "Cell types";
title.dispatchEvent(new Event("input", { bubbles: true }));
title.dispatchEvent(new Event("change", { bubbles: true }));
title.blur();
await sleep(30);
[...$$("#tab-design button")].find((b) => b.textContent === "Border").click();
await sleep(50);
R.titled = [legend().title, legend().border];
await shot("legend-edited");
await shot("legend-edited-panel", "#inspector");

// 5. double-click a row on the page: its label gets the focus
M.setSelection([]);
const Lr = legend();
const { legendLayout } = await import("/js/render.js");
const lay = legendLayout(Lr);
const cell2 = lay.cells[2];
const pt = scr(Lr.x + (Lr.w - lay.w) / 2 + cell2.x + cell2.w * 0.6, Lr.y + (Lr.h - lay.h) / 2 + cell2.y + cell2.h / 2);
document.elementFromPoint(...pt).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: pt[0], clientY: pt[1] }));
await sleep(80);
R.dblclickFocus = document.activeElement?.dataset?.row;
R.dblclickSelected = M.state.selection[0] === Lr.id;
document.activeElement.blur();

// 6. drag the legend's corner handle: everything in it scales
const fs0 = legend().fontSize, is0 = legend().iconSize;
const se = handleAt("se");
await drag(se, [se[0] + 120, se[1] + 120]);
R.cornerScale = +(legend().fontSize / fs0).toFixed(3);
R.cornerIcons = +(legend().iconSize / is0).toFixed(3);
R.cornerStillFits = (() => { const l = legendLayout(legend()); return Math.abs(l.w - legend().w) < 0.01 && Math.abs(l.h - legend().h) < 0.01; })();
await shot("legend-scaled", "#stage-wrap");

// 7. Insert › Scale bar; units and length in the panel; the side handle sets the bar's length
openInsert();
await sleep(30);
clickItem("Scale bar");
await sleep(80);
R.barInserted = !!bar() && M.state.selection[0] === bar().id;
R.barHandles = $$("#overlay .handle").map((h) => h.dataset.h);
const unitSel = $("#tab-design .sb-len select");
unitSel.value = "nm";
unitSel.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(40);
const valIn = $("#tab-design [data-f=value]");
valIn.value = "500";
valIn.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(40);
[...$$("#tab-design .sb-pos button")].find((b) => b.textContent === "Below").click();
await sleep(40);
R.barLabel = [bar().value, bar().unit, bar().labelPos];
const leftEnd = () => { const b = bar(); return b.x + b.w / 2 - b.length / 2; };
const left0 = leftEnd(), len0 = bar().length;
const e = handleAt("e");
await drag(e, [e[0] + 80, e[1]]);
R.barLonger = +(bar().length - len0).toFixed(1);
R.barLeftEndKept = Math.abs(leftEnd() - left0) < 0.01;
R.barFontKept = bar().fontSize === 12;
await shot("scalebar", "#stage-wrap");
await shot("scalebar-panel", "#inspector");
// without a label the bar is thin: its click area reaches a few px past it
[...$$("#tab-design .sb-pos button")].find((b) => b.textContent === "None").click();
await sleep(40);
const thin = bar();
M.setSelection([]);
await sleep(30);
const [bx, by] = scr(thin.x + thin.w / 2, thin.y), [, by2] = scr(thin.x + thin.w / 2, thin.y + thin.h);
const hitAt = (y) => document.elementFromPoint(bx, y)?.closest("#content > g.obj")?.dataset.id === thin.id;
R.thinBar = { h: +thin.h.toFixed(2), above: hitAt(by - 2), below: hitAt(by2 + 2), farAbove: hitAt(by - 12) };
M.setSelection([thin.id]);
await sleep(30);
[...$$("#tab-design .sb-pos button")].find((b) => b.textContent === "Below").click();
await sleep(30);

// 8. Insert › Panel labels… with three cells selected
M.setSelection([cells[0].id, cells[1].id, cells[3].id]);
openInsert();
await sleep(30);
clickItem("Panel labels…");
await sleep(80);
R.dialog = $(".modal h2")?.textContent;
R.dialogNote = $(".modal .small.muted")?.textContent;
[...$$(".modal .seg button")].find((b) => b.textContent === "a, b, c").click();
await sleep(30);
R.dialogStart = $(".modal input:not([type=number])").value;
await shot("panel-labels-dialog");
[...$$(".modal .actions button")].find((b) => b.classList.contains("primary")).click();
await sleep(80);
const labels = M.state.doc.objects.filter((o) => o.panelLabel);
R.panelLabels = labels.map((t) => t.text);
R.panelLabelsBold = labels.every((t) => t.bold && t.type === "text");
await shot("panel-labels", "#stage-wrap");
// nothing selected: one label in the middle of the view; the next one steps down and right
const mid = [];
for (let k = 0; k < 2; k++) {
  M.setSelection([]);
  openInsert();
  await sleep(30);
  clickItem("Panel labels…");
  await sleep(60);
  if (!k) R.dialogNoSelection = [$(".modal .pl-body > .small.muted")?.textContent, [...$$(".modal .actions button")].map((b) => b.textContent)];
  [...$$(".modal .actions button")].find((b) => b.classList.contains("primary")).click();
  await sleep(60);
  const t = M.state.doc.objects.at(-1);
  mid.push([t.text, +(t.x + t.w / 2).toFixed(1), +(t.y + t.h / 2).toFixed(1)]);
}
const vc = C.viewCenter();
R.middleLabels = { labels: mid, viewCentre: vc.map((v) => +v.toFixed(1)) };
M.undo();
M.undo();

// 9. Layers list names, then undo everything
P.showTab("layers");
await sleep(30);
R.layers = $$("#tab-layers .layer .nm").map((e) => e.textContent).slice(0, 5);
await shot("furniture-layers", "#inspector");
P.showTab("design");
let undos = 0;
while (M.canUndo() && undos < 40) {
  M.undo();
  undos++;
}
C.renderDoc();
R.undoneAll = !M.state.doc.objects.some((o) => o.type === "legend" || o.type === "scalebar" || o.panelLabel) && M.state.doc.objects.length === 4;
// Insert › Text, Rectangle, Ellipse and Arrow at the view centre
for (const it of ["Rectangle", "Ellipse", "Arrow"]) {
  openInsert();
  await sleep(20);
  clickItem(it);
  await sleep(30);
}
R.basicInserts = M.state.doc.objects.slice(-3).map((o) => o.type + (o.endHead === "arrow" ? "→" : ""));
openInsert();
await sleep(20);
clickItem("Text");
await sleep(60);
R.textEditing = C.isEditingText() && document.activeElement?.id === "text-editor";
C.finishTextEdit();
R.history = undos;
return R;
