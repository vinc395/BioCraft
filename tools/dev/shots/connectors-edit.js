// Page script for tools/dev/shot.mjs: editing connectors with the pointer — the start highlight before
// drawing, lines across a background drawing staying free, Alt to draw without connecting, dragging an
// end off and onto objects, sliding an elbow's bend, Detach, End padding, Reverse direction, copy and
// paste, deleting a target, Layers names; and a hand-drawn freeform shape and path arrow.
//   node tools/dev/shot.mjs tools/dev/shots/connectors-edit.js --out tools/dev/out/shots --size 1500x1000 [--theme dark]
M.state.doc = M.newDoc();
M.state.selection = [];
C.renderDoc();
M.resetHistory();
C.fitView();
const R = {};
const stage = document.querySelector("#stage");
const scr = (x, y) => {
  const r = stage.getBoundingClientRect(), [sx, sy] = C.docToScreen(x, y);
  return [sx + r.left, sy + r.top];
};
const fire = (type, [x, y], { down, hover, ...extra } = {}) => {
  const ev = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerdown" || down ? 1 : 0, pointerId: 1, pointerType: "mouse", ...extra });
  (type === "pointerdown" || hover ? document.elementFromPoint(x, y) : window).dispatchEvent(ev);
};
const drag = async (from, to, extra = {}, steps = 8, before = null) => {
  fire("pointerdown", from, extra);
  for (let i = 1; i <= steps; i++) fire("pointermove", [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps], { ...extra, down: true });
  if (before) await before();
  fire("pointerup", to, extra);
};
const handleAt = (h) => {
  const e = document.querySelector(`#overlay [data-h="${h}"]`);
  const b = e.getBoundingClientRect();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const last = () => M.state.doc.objects.at(-1);
const ids = (o) => [o.from?.id || null, o.to?.id || null];

// a large background drawing with two cells on it
const bg = { id: U.uid(), type: "rect", name: "Synovium", x: 40, y: 40, w: 560, h: 360, rot: 0, fill: "#fbeee6", stroke: "#d9a58c", strokeWidth: 1.5, radius: 14 };
M.state.doc.objects.push(bg);
const a = await A.placeIcon("biocanvas/macrophage", [150, 150]);
const b = await A.placeIcon("nih/509-t-cell", [470, 300]);
M.setSelection([]);
C.renderDoc();

// 1. hovering with the arrow tool outlines the object a line would start on
C.setTool("arrow");
fire("pointermove", scr(150, 150), { hover: true });
R.hoverHint = document.querySelectorAll("#overlay .conn-target").length;
await shot("edit-hover", "#stage-wrap");

// 2. a line drawn across the background stays free; from a cell to a cell it joins them
await drag(scr(260, 330), scr(380, 120));
const across = last();
R.acrossBackground = ids(across);
C.setTool("arrow");
await drag(scr(150, 150), scr(470, 300), {}, 8, () => shot("edit-drag-cells", "#stage-wrap"));
await shot("edit-drag-cells-done", "#stage-wrap");
const line = last();
R.cellToCell = [line.from?.id === a.id, line.to?.id === b.id];
// 3. Alt draws without connecting
C.setTool("arrow");
await drag(scr(150, 150), scr(470, 300), { altKey: true });
const alt = last();
R.altFree = ids(alt);
M.state.doc.objects = M.state.doc.objects.filter((o) => o !== alt && o !== across);
M.setSelection([line.id]);
C.renderDoc();
M.commit();

// 4. drag the end off the T cell (over the background: it lets go), then onto the box
const box = { id: U.uid(), type: "rect", name: "Nucleus", x: 420, y: 70, w: 120, h: 60, rot: 0, fill: "#efe3f7", stroke: "#7d4ea8", strokeWidth: 1.5, radius: 8 };
M.state.doc.objects.push(box);
C.renderDoc();
M.setSelection([line.id]);
await drag(handleAt("p2"), scr(330, 360));
R.endOff = ids(line);
await drag(handleAt("p2"), scr(480, 100), {}, 8, () => shot("edit-end-onto-box", "#stage-wrap"));
R.endOnBox = line.to?.id === box.id;
R.endOnBoxGap = +(Math.hypot(line.x2 - (box.x + box.w / 2), line.y2 - (box.y + box.h / 2))).toFixed(1);

// 5. elbow routing and sliding its bend
const routing = () => [...document.querySelectorAll("#tab-design .field")].find((f) => f.querySelector("label")?.textContent === "Routing").querySelector("select");
routing().value = "elbow";
routing().dispatchEvent(new Event("change"));
R.elbow = [line.route, line.axis, line.bend];
const bend0 = handleAt("bend");
await drag(bend0, [bend0[0] + 60, bend0[1]]);
R.bendAfterDrag = +line.bend.toFixed(3);
const ptsAfter = M.elbowPts(line).map((p) => p.map((v) => Math.round(v)));
R.elbowSquare = ptsAfter.slice(1).every((q, i) => q[0] === ptsAfter[i][0] || q[1] === ptsAfter[i][1]);
await shot("edit-elbow-bend", "#stage-wrap");
M.undo();
R.bendUndo = M.getObj(line.id).bend; // (undo replaces the objects: read the live one)

// 6. Detach and End padding from the inspector
const L = () => M.getObj(line.id);
M.setSelection([line.id]);
const pad = [...document.querySelectorAll("#tab-design .field")].find((f) => f.querySelector("label")?.textContent === "End padding").querySelector("input");
const end0 = [L().x2, L().y2];
pad.value = "10";
pad.dispatchEvent(new Event("change"));
R.pad = [L().pad, +Math.hypot(L().x2 - end0[0], L().y2 - end0[1]).toFixed(1)];
await shot("edit-panel", "#inspector");
const detach = [...document.querySelectorAll("#tab-design .conn-row")][1].querySelector("button");
detach.click();
R.detached = ids(L());
M.undo();
R.detachUndo = ids(L());

// 7. Reverse direction swaps the heads (the path and connections stay)
const before = [L().startHead, L().endHead, L().x1, L().y1];
[...document.querySelectorAll("#tab-design button")].find((x) => x.textContent === "Reverse direction").click();
R.reversed = [L().startHead, L().endHead, L().x1 === before[2] && L().y1 === before[3], ids(L())];

// 8. copy and paste the line with both its objects; delete a target; undo
M.setSelection([line.id, a.id, box.id]);
A.copySel();
A.pasteClip();
const pasted = M.selectedObjs();
const pl = pasted.find((o) => o.type === "line");
R.pastedJoined = pasted.some((o) => o.id === pl.from?.id) && pasted.some((o) => o.id === pl.to?.id);
M.setSelection([box.id]);
A.deleteSel();
R.deleteTarget = ids(L());
M.undo();
R.deleteUndo = L().to?.id === box.id;
P.showTab("layers");
R.layerNames = [...document.querySelectorAll("#tab-layers .layer .nm")].map((n) => n.textContent).filter((t) => /→/.test(t));
await shot("edit-layers", "#inspector");
P.showTab("design");

// 9. a hand-drawn freeform shape and path arrow, then Reverse direction on the arrow
const paint = (kind, pts) => {
  M.state.brush = { kind, asset: null };
  C.setTool("membrane");
  const s = pts.map(([x, y]) => scr(x, y));
  fire("pointerdown", s[0]);
  for (const p of s.slice(1)) fire("pointermove", p, { down: true });
  fire("pointerup", s.at(-1));
  return last();
};
const blob = [];
for (let i = 0; i <= 60; i++) {
  const t = (i / 60) * Math.PI * 2;
  blob.push([620 + 70 * Math.cos(t) * (1 + 0.15 * Math.sin(3 * t)) + Math.sin(i * 7.3) * 1.5, 250 + 50 * Math.sin(t) + Math.cos(i * 5.1) * 1.5]);
}
const ff = paint("freeform", blob);
const gaps = ff.pts.map((p, i) => Math.hypot(ff.pts[(i + 1) % ff.pts.length][0] - p[0], ff.pts[(i + 1) % ff.pts.length][1] - p[1]));
R.freeform = { n: ff.pts.length, closed: ff.closed, spacing: [Math.min(...gaps).toFixed(1), Math.max(...gaps).toFixed(1)] };
await shot("edit-freeform-panel", "#inspector");
const wave = [];
for (let i = 0; i <= 30; i++) wave.push([80 + i * 9, 440 + 22 * Math.sin(i / 4.5)]);
const pa = paint("arrow", wave);
[...document.querySelectorAll("#tab-design button")].find((x) => x.textContent === "Reverse direction").click();
R.pathArrowReversed = [M.getObj(pa.id).startHead, M.getObj(pa.id).endHead];
await shot("edit-arrow-panel", "#inspector");
M.setSelection([]);
C.renderDoc();
await shot("edit-canvas", "#stage-wrap");
R.undoable = M.canUndo();
return R;
