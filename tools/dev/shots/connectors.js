// Page script for tools/dev/shot.mjs: connectors drawn with the pointer (the target highlight mid-drag),
// the line inspector's Connector section, an elbow with its bend handle, the brush picker with the
// new arrows, shapes and brushes, and the path-arrow / freeform-shape inspectors.
//   node tools/dev/shot.mjs tools/dev/shots/connectors.js --size 1500x1000 [--theme dark]
M.state.doc = M.newDoc();
M.state.selection = [];
C.renderDoc();
M.resetHistory();
C.fitView();
const stage = document.querySelector("#stage");
const scr = (x, y) => {
  const r = stage.getBoundingClientRect(), [sx, sy] = C.docToScreen(x, y);
  return [sx + r.left, sy + r.top];
};
const fire = (type, [x, y], extra = {}) => {
  const ev = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", ...extra });
  (type === "pointerdown" ? document.elementFromPoint(x, y) : window).dispatchEvent(ev);
};
const a = await A.placeIcon("biocanvas/macrophage", [130, 140]);
const b = await A.placeIcon("nih/509-t-cell", [470, 330]);
const box = { id: U.uid(), type: "rect", name: "Nucleus", x: 380, y: 60, w: 120, h: 60, rot: 0, fill: "#efe3f7", stroke: "#7d4ea8", strokeWidth: 1.5, radius: 8 };
M.state.doc.objects.push(box);
C.renderDoc();
M.setSelection([]);
// draw an arrow from the macrophage towards the T cell; shoot while the pointer is over the T cell
C.setTool("arrow");
const p0 = scr(130, 140), p1 = scr(470, 330);
fire("pointerdown", p0);
for (let i = 1; i <= 8; i++) fire("pointermove", [p0[0] + (p1[0] - p0[0]) * i / 8, p0[1] + (p1[1] - p0[1]) * i / 8]);
await shot("conn-drag", "#stage-wrap");
fire("pointerup", p1);
const line = M.state.doc.objects.at(-1);
await shot("conn-line-panel", "#inspector");
// a second connector, as an elbow to the box
C.setTool("inhibit");
const q0 = scr(130, 140), q1 = scr(440, 90);
fire("pointerdown", q0);
for (let i = 1; i <= 6; i++) fire("pointermove", [q0[0] + (q1[0] - q0[0]) * i / 6, q0[1] + (q1[1] - q0[1]) * i / 6]);
fire("pointerup", q1);
const elbow = M.state.doc.objects.at(-1);
const routing = [...document.querySelectorAll("#tab-design .field")].find((f) => f.querySelector("label")?.textContent === "Routing").querySelector("select");
routing.value = "elbow";
routing.dispatchEvent(new Event("change"));
await shot("conn-elbow", "#stage-wrap");
await shot("conn-elbow-panel", "#inspector");
// move the T cell: the arrow follows
M.setSelection([b.id]);
const c0 = scr(b.x + b.w / 2, b.y + b.h / 2);
fire("pointerdown", c0);
for (let i = 1; i <= 6; i++) fire("pointermove", [c0[0] - 30 * i, c0[1] + 10 * i]);
fire("pointerup", [c0[0] - 180, c0[1] + 60]);
M.setSelection([line.id]);
await shot("conn-moved", "#stage-wrap");
// the brush picker
document.querySelector('#tools [data-tool="membrane"]').click();
await sleep(50);
await shot("brush-menu", ".dropdown");
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
// paint a path arrow and a freeform shape, then show their inspectors
const paint = (kind, pts, preset) => {
  M.state.brush = { kind, asset: null, ...(preset ? { preset } : {}) };
  C.setTool("membrane");
  const s = pts.map(([x, y]) => scr(x, y));
  fire("pointerdown", s[0]);
  for (const p of s.slice(1)) fire("pointermove", p);
  fire("pointerup", s.at(-1));
  return M.state.doc.objects.at(-1);
};
const wave = [];
for (let i = 0; i <= 30; i++) wave.push([90 + i * 9, 380 + 26 * Math.sin(i / 4.5)]);
const pa = paint("arrow", wave);
await shot("brush-arrow-panel", "#inspector");
const blob = [];
for (let i = 0; i <= 36; i++) {
  const t = (i / 36) * Math.PI * 2;
  blob.push([560 + 70 * Math.cos(t) * (1 + 0.15 * Math.sin(3 * t)), 220 + 50 * Math.sin(t)]);
}
const ff = paint("freeform", blob);
await shot("brush-freeform-panel", "#inspector");
paint("vessel", [[60, 20], [160, 40], [260, 15]]);
paint("axon", [[60, 430], [200, 410], [330, 440]]);
paint("arrow", [[600, 330], [660, 390]], "circular");
M.setSelection([]);
C.renderDoc();
await shot("brush-canvas", "#stage-wrap");
return { line: { from: line.from, to: line.to }, elbow: { route: elbow.route, from: elbow.from, to: elbow.to }, pa: pa.brush, ff: [ff.brush, ff.closed, ff.pts.length] };
