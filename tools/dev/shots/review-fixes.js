// tools/dev/shot.mjs page script: the problems found in the review of steps 1–4, driven through the UI
// as a user would, each followed by what should happen now. Run it on a sandbox page:
//   node tools/dev/shot.mjs tools/dev/shots/review-fixes.js --base "http://localhost:8791/?sandbox"
const API = await import("/js/api.js");
if (!API.sandbox) throw new Error("run this on a ?sandbox page");
const SS = await import("/js/shapestyle.js");
const errors = [];
window.addEventListener("error", (e) => errors.push("error: " + e.message));
window.addEventListener("unhandledrejection", (e) => errors.push("rejection: " + (e.reason?.message || e.reason)));
const checks = [];
const ok = (cond, what, detail) => {
  checks.push((cond ? "ok   " : "FAIL ") + what + (!cond && detail !== undefined ? " — " + JSON.stringify(detail) : ""));
  return cond;
};
const fresh = () => {
  M.state.doc = M.newDoc();
  M.state.selection = [];
  C.setTool("select");
  C.renderDoc();
  M.resetHistory();
  C.fitView();
};
const stage = document.querySelector("#stage");
const scr = (x, y) => {
  const r = stage.getBoundingClientRect(), [sx, sy] = C.docToScreen(x, y);
  return [sx + r.left, sy + r.top];
};
const fire = (type, [x, y], extra = {}) => {
  const ev = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, pointerId: 1, pointerType: "mouse", ...extra });
  (type === "pointerdown" ? document.elementFromPoint(x, y) : window).dispatchEvent(ev);
};
/** Press at p0 and move to p1; returns finish() for the release (so the drag can be looked at first). */
const press = (p0, p1, extra = {}, steps = 8) => {
  fire("pointerdown", p0, extra);
  for (let i = 1; i <= steps; i++) fire("pointermove", [p0[0] + ((p1[0] - p0[0]) * i) / steps, p0[1] + ((p1[1] - p0[1]) * i) / steps], extra);
  return async () => {
    fire("pointerup", p1, extra);
    await sleep(40);
  };
};
const drag = async (p0, p1, extra = {}) => (await press(p0, p1, extra))();
const key = (k, extra = {}, target = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
const undoKey = () => key("z", { ctrlKey: true });
const qbBtn = (label) => [...document.querySelectorAll("#quickbar button")].find((b) => b.getAttribute("aria-label") === label);
const qbLabels = () => [...document.querySelectorAll("#quickbar button")].map((b) => b.getAttribute("aria-label"));
const until = async (fn, ms = 5000) => {
  for (let t = 0; t < ms; t += 40) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  return null;
};
const firstHit = async (q) => (await API.api("library.search", { q, offset: 0, limit: 1 })).items[0]?.id;
const assetOf = (id) => M.getObj(id)?.asset;

/* 1. Replace from the quick toolbar, undo, Replace again (and Enter straight after typing) */
{
  fresh();
  const mac = await A.placeIcon("biocanvas/macrophage", [200, 200]);
  await sleep(60);
  const [neu, fib] = [await firstHit("neutrophil"), await firstHit("fibroblast")];
  const replaceVia = async (query, enter = false) => {
    qbBtn("Replace").click();
    const dlg = await until(() => document.querySelector(".modal"));
    const inp = dlg.querySelector("input[type=search]");
    inp.value = query;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    if (enter) inp.form.requestSubmit(); // Enter at once, before the search has even started
    else {
      await until(() => dlg.querySelector(".lib-status").textContent.includes(query) && dlg.querySelector(".tile"));
      dlg.querySelector(".tile").click();
    }
    await until(() => !document.querySelector(".modal"));
    await sleep(500);
  };
  await replaceVia("neutrophil");
  ok(assetOf(mac.id) === neu, "toolbar Replace: macrophage → first neutrophil", assetOf(mac.id));
  undoKey();
  await sleep(80);
  ok(assetOf(mac.id) === "biocanvas/macrophage", "Ctrl+Z puts the macrophage back");
  await replaceVia("fibroblast");
  ok(assetOf(mac.id) === fib, "toolbar Replace after the undo changes the icon in the figure", assetOf(mac.id));
  undoKey();
  await sleep(80);
  M.setSelection([]);
  M.setSelection([mac.id]);
  await sleep(40);
  await replaceVia("neutrophil", true);
  ok(assetOf(mac.id) === neu, "Enter straight after typing uses the results for what was typed", assetOf(mac.id));
  ok(M.state.doc.objects.length === 1, "still one icon");
}

/* 2. The library search box: type and press Enter at once */
{
  fresh();
  const s = document.querySelector("#lib-search");
  const fib = await firstHit("fibroblast");
  s.value = "fibroblast";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  s.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until(() => M.state.doc.objects.length);
  await sleep(300);
  ok(M.state.doc.objects.length === 1 && M.state.doc.objects[0].asset === fib, "library box: Enter at once adds the first result for the typed words", M.state.doc.objects.map((o) => o.asset));
  s.value = "";
  s.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

/* 3. The quick toolbar's shape Style popover across an undo */
{
  fresh();
  const r1 = { id: "r1", type: "rect", x: 200, y: 200, w: 120, h: 70, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5, radius: 6 };
  M.state.doc.objects.push(r1);
  C.renderDoc();
  M.commit();
  M.setSelection(["r1"]);
  await sleep(40);
  qbBtn("Style").click();
  await sleep(60);
  const btn = (id) => document.querySelector(`.qb-style .preset[data-preset="${id}"]`);
  const fillOf = (id) => SS.SHAPE_PRESETS.find((p) => p.id === id).fill;
  btn("coral").click();
  await sleep(40);
  ok(M.getObj("r1").fill === fillOf("coral"), "Style: coral applied");
  undoKey();
  await sleep(60);
  ok(M.getObj("r1").fill === "#d9ecf7" && !!document.querySelector(".qb-style"), "Ctrl+Z with the popover open: the fill is back and the popover stays");
  btn("sage").dispatchEvent(new PointerEvent("pointerenter"));
  await sleep(30);
  ok(M.getObj("r1").fill === fillOf("sage"), "hovering a style after the undo previews it on the shape", M.getObj("r1").fill);
  document.querySelector(".qb-style .presets").dispatchEvent(new PointerEvent("pointerleave"));
  await sleep(30);
  ok(M.getObj("r1").fill === "#d9ecf7", "leaving the grid puts the fill back");
  btn("sage").click();
  await sleep(40);
  ok(M.getObj("r1").fill === fillOf("sage"), "clicking a style after the undo applies it", M.getObj("r1").fill);
  ok(document.querySelector(".qb-style .preset.on")?.dataset.preset === "sage", "the applied style is outlined");
  await shot("fix-style-pop");
  key("Escape");
  await sleep(30);
}

/* 4. Transform: rotating several objects, undo, rotate again */
{
  fresh();
  const mk = (id, x) => ({ id, type: "rect", x, y: 200, w: 120, h: 70, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5, radius: 6 });
  M.state.doc.objects.push(mk("t1", 200), mk("t2", 360));
  C.renderDoc();
  M.commit();
  M.setSelection(["t1", "t2"]);
  await sleep(40);
  qbBtn("Transform").click();
  await sleep(40);
  const rotIn = () => document.querySelectorAll(".qb-transform input.num")[4];
  const setRot = (v) => {
    rotIn().value = String(v);
    rotIn().dispatchEvent(new Event("change"));
  };
  const rots = () => [M.getObj("t1").rot, M.getObj("t2").rot].map((v) => Math.round(v * 100) / 100);
  setRot(30);
  await sleep(30);
  ok(rots().join() === "30,30", "rotate both by 30°", rots());
  setRot(50);
  await sleep(30);
  ok(rots().join() === "50,50" && rotIn().value === "50", "then 50: turned 20° more (the panel's own edits keep counting)", rots());
  undoKey();
  await sleep(50);
  ok(rots().join() === "30,30" && rotIn().value === "0", "Ctrl+Z: back to 30°, and the field starts again from 0", { rots: rots(), field: rotIn().value });
  setRot(45);
  await sleep(30);
  ok(rots().join() === "75,75" && rotIn().value === "45", "45 after the undo turns them 45° from where they are", rots());
  key("Escape");
  await sleep(30);
}

/* 5. Double-click on blank paper and on a handle */
{
  fresh();
  const r = { id: "h1", type: "rect", x: 100, y: 100, w: 100, h: 60, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5 };
  M.state.doc.objects.push(r);
  C.renderDoc();
  M.commit();
  const before = errors.length;
  const dbl = ([x, y]) => stage.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  dbl(scr(400, 300));
  M.setSelection(["h1"]);
  await sleep(40);
  const h = document.querySelector('#overlay [data-h="se"]').getBoundingClientRect();
  dbl([h.left + h.width / 2, h.top + h.height / 2]);
  await sleep(40);
  ok(errors.length === before, "double-clicking blank paper or a handle throws nothing", errors.slice(before));
}

/* 6. The toolbar's Style button follows a brush's pattern */
{
  fresh();
  const b = { id: "b1", type: "membrane", brush: "bilayer", pts: [[100, 200], [200, 150], [300, 200]], closed: false, thickness: 16, fill: "none", name: "Lipid bilayer" };
  M.state.doc.objects.push(b);
  C.renderDoc();
  M.commit();
  M.setSelection(["b1"]);
  await sleep(40);
  const pattern = () => [...document.querySelectorAll("#tab-design .field")].find((f) => f.querySelector("label")?.textContent === "Pattern").querySelector("select");
  ok(!qbLabels().includes("Style"), "a bilayer brush: no Style button");
  pattern().value = "freeform";
  pattern().dispatchEvent(new Event("change"));
  await sleep(60);
  ok(qbLabels().includes("Style"), "switched to Freeform shape: the Style button appears", qbLabels());
  qbBtn("Style").click();
  await sleep(40);
  ok(!!document.querySelector(".qb-style .preset"), "…and opens the shape styles");
  key("Escape");
  await sleep(30);
  pattern().value = "dna";
  pattern().dispatchEvent(new Event("change"));
  await sleep(60);
  ok(!qbLabels().includes("Style"), "switched to DNA: the Style button goes", qbLabels());
}

/* 7. Arrow keys after a submenu opened by hovering */
{
  fresh();
  const ic = await A.placeIcon("biocanvas/macrophage", [150, 150]);
  M.setSelection([]);
  await sleep(40);
  const [cx, cy] = scr(150, 150);
  document.elementFromPoint(cx, cy).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 2 }));
  await sleep(40);
  ok(M.state.selection.join() === ic.id, "right-click selects the icon");
  const rows = () => [...document.querySelectorAll(".dropdown")[0].querySelectorAll(".item")];
  rows().find((r) => r.textContent.startsWith("Flip")).dispatchEvent(new PointerEvent("pointerenter"));
  await sleep(250);
  ok(document.querySelectorAll(".dropdown").length === 2, "hovering Flip opens its submenu");
  key("ArrowDown");
  ok(document.querySelectorAll(".dropdown").length === 1, "Down moves on to Arrange and closes Flip's submenu");
  key("ArrowDown");
  const active = rows().find((r) => r.classList.contains("active"))?.querySelector(".mi-label").textContent;
  ok(active === "Align" && document.querySelectorAll(".dropdown").length === 1, "Down again: Align, no stale submenu", active);
  key("ArrowRight");
  await sleep(30);
  const sub = document.querySelectorAll(".dropdown")[1];
  ok(sub?.querySelector(".item.active")?.textContent.startsWith("Left"), "Right opens Align's submenu on its first item");
  key("Escape");
  key("Escape");
  ok(!document.querySelector(".dropdown"), "Escape twice closes both");
}

/* 8. Duplicate a locked object from the right-click menu */
{
  fresh();
  const r = { id: "lk", type: "rect", x: 150, y: 150, w: 100, h: 60, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5, locked: true };
  M.state.doc.objects.push(r);
  C.renderDoc();
  M.commit();
  await sleep(40);
  const [cx, cy] = scr(200, 180);
  stage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 2 }));
  await sleep(40);
  ok(M.state.selection.join() === "lk", "right-click selects the locked rectangle");
  [...document.querySelectorAll(".dropdown .item")].find((x) => x.querySelector(".mi-label").textContent === "Duplicate").click();
  await sleep(60);
  const copy = M.selectedObjs()[0];
  ok(copy && copy.id !== "lk" && !copy.locked && M.getObj("lk").locked, "Duplicate gives an unlocked copy; the original stays locked");
  ok(qbLabels().includes("Lock") && !qbLabels().includes("Unlock"), "the toolbar offers Lock for the copy", qbLabels());
  const [px, py] = scr(copy.x + copy.w / 2, copy.y + copy.h / 2);
  await drag([px, py], [px + 60, py + 30]);
  ok(M.getObj(copy.id).x > copy.x - 1 && Math.abs(M.getObj(copy.id).x - (r.x + 12) - 60 / M.state.view.zoom) < 2, "and it can be dragged", [M.getObj(copy.id).x, r.x]);
}

/* 9. Connectors: a nucleus to its cell, a cell to a spot on the tissue (Ctrl connects), across the tissue */
{
  fresh();
  const T = { id: "tis", type: "rect", name: "Tissue", x: 40, y: 40, w: 600, h: 360, rot: 0, fill: "#f6e3e8", stroke: "none" };
  const cell = { id: "cel", type: "ellipse", name: "Cell", x: 300, y: 150, w: 120, h: 120, rot: 0, fill: "#d9ecf7", stroke: "#1d6fa5", strokeWidth: 1.5 };
  const nuc = { id: "nuc", type: "ellipse", name: "Nucleus", x: 335, y: 185, w: 50, h: 50, rot: 0, fill: "#b9a3e3", stroke: "#5b3d9e", strokeWidth: 1.5 };
  const oth = { id: "oth", type: "rect", name: "Other cell", x: 520, y: 300, w: 60, h: 40, rot: 0, fill: "#fde7c8", stroke: "#c76b1f", strokeWidth: 1.5 };
  M.state.doc.objects.push(T, cell, nuc, oth);
  C.renderDoc();
  M.commit();
  const last = () => M.state.doc.objects.at(-1);
  const ends = (o) => [o.from?.id ?? null, o.to?.id ?? null].map(String).join(" → ");
  const deselect = () => M.setSelection([]); // a selected arrow's handles would be dragged instead of drawing a new one
  C.setTool("arrow");
  await drag(scr(360, 210), scr(400, 250));
  ok(ends(last()) === "nuc → cel", "arrow from the nucleus to its cell connects both ends", ends(last()));
  deselect();
  C.setTool("arrow");
  let finish = press(scr(320, 175), scr(560, 100));
  const hint = document.querySelector("#status-msg").textContent;
  await finish();
  ok(ends(last()) === "cel → null", "arrow from the cell to a spot on the tissue: the tissue isn't joined", ends(last()));
  ok(/Tissue/.test(hint) && /hold (Ctrl|⌘) to connect/.test(hint), "while dragging, the status bar says how to connect anyway", hint);
  deselect();
  C.setTool("arrow");
  await drag(scr(320, 175), scr(560, 100), { ctrlKey: true });
  ok(ends(last()) === "cel → tis", "the same with Ctrl held joins the tissue", ends(last()));
  deselect();
  C.setTool("arrow");
  await drag(scr(100, 100), scr(200, 350));
  ok(ends(last()) === "null → null", "arrow across the tissue: both ends free", ends(last()));
  deselect();
  C.setTool("arrow");
  await drag(scr(100, 100), scr(550, 320));
  ok(ends(last()) === "null → oth", "arrow from the tissue to a cell on it: only the cell is joined", ends(last()));
  // drag the free end of the cell → spot arrow onto the tissue with Ctrl
  const spot = M.state.doc.objects.find((o) => o.type === "line" && o.from?.id === "cel" && !o.to);
  C.setTool("select");
  M.setSelection([spot.id]);
  await sleep(40);
  const hp = document.querySelector('#overlay [data-h="p2"]').getBoundingClientRect();
  const p2 = [hp.left + hp.width / 2, hp.top + hp.height / 2];
  await drag(p2, [p2[0] + 10, p2[1] + 15]);
  ok(!M.getObj(spot.id).to, "dragging that end over the tissue: still free");
  M.setSelection([spot.id]);
  await sleep(40);
  const hp2 = document.querySelector('#overlay [data-h="p2"]').getBoundingClientRect();
  const q2 = [hp2.left + hp2.width / 2, hp2.top + hp2.height / 2];
  await drag(q2, [q2[0] + 10, q2[1] + 15], { ctrlKey: true });
  ok(M.getObj(spot.id).to?.id === "tis", "…with Ctrl it joins the tissue", M.getObj(spot.id).to);
  M.setSelection([]);
  await sleep(40);
  await shot("fix-connectors", "#stage-wrap");
}

return { checks, failed: checks.filter((c) => c.startsWith("FAIL")).length, errors };
