// tools/dev/shot.mjs page script: looks for clipped or overflowing UI at every panel width and window size.
// The inspector at 240, 300 and 480 px with each kind of object selected (Design, Layers, Credits), the
// library at 220, 330 and 560 px (My library open), the top bar from 800 to 1920 px wide, and the dialogs
// and menus at 1024 × 700. Reports what sticks out or wraps where it shouldn't, and takes a few shots.
//   node tools/dev/shot.mjs tools/dev/shots/layout-audit.js --base "http://localhost:8791/?sandbox" --size 1280x800 --out tools/dev/out/panels
const API = await import("/js/api.js");
if (!API.sandbox) throw new Error("run this on a ?sandbox page");
const L = await import("/js/layout.js");
const B = await import("/js/brush.js");
const F = await import("/js/furniture.js");
const X = await import("/js/exporter.js");
const LIB = await import("/js/library.js");
const TH = await import("/js/theme.js");
const theme = TH.effectiveTheme();
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const errors = [];
window.addEventListener("error", (e) => errors.push("error: " + e.message));
window.addEventListener("unhandledrejection", (e) => errors.push("rejection: " + (e.reason?.message || e.reason)));
const problems = {};
const note = (where, list) => {
  if (list.length) problems[where] = list;
};
const press = (key, o = {}) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
const click = async (el) => {
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  await mouse("mouseMoved", x, y, { button: "none" });
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await frame();
};
const nameOf = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).join(".") : "") + (e.textContent?.trim() ? ` "${e.textContent.trim().slice(0, 24)}"` : "");
const px = (v) => parseFloat(v) || 0;
/** The room an element has: its section's content box (inside the padding) in the inspector, else the root's box. */
function room(e, root) {
  const s = e.parentElement?.closest(".section");
  const box = s && root.contains(s) ? s : root, r = box.getBoundingClientRect(), cs = getComputedStyle(box);
  return box === root ? { left: r.left, right: r.right } : { left: r.left + px(cs.paddingLeft), right: r.right - px(cs.paddingRight) };
}
/** Inside something that clips it on purpose (an ellipsis, a chip), below the root. */
const clipped = (e, root) => {
  for (let a = e.parentElement; a && a !== root; a = a.parentElement) if (/hidden|clip/.test(getComputedStyle(a).overflowX)) return true;
  return false;
};
/** What sticks out of its room sideways, a box whose content is wider than it, a scroller that scrolls sideways, a button whose label wraps. */
function overflows(root, { skip = ".lib-grid" } = {}) {
  const out = [];
  for (const e of [root, ...root.querySelectorAll("*")]) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || (skip && e.closest(skip) && e !== root) || clipped(e, root)) continue;
    const cs = getComputedStyle(e);
    if (e !== root) {
      const R = room(e, root);
      if (r.right > R.right + 0.5 || r.left < R.left - 0.5) out.push(`${nameOf(e)} sticks out by ${Math.round(Math.max(r.right - R.right, R.left - r.left))} px`);
    }
    if (/^(svg|path|g|circle|rect|line|polygon|ellipse|img|input|select|textarea)$/i.test(e.tagName)) continue;
    const scroller = /auto|scroll/.test(cs.overflowX);
    if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth) {
      if (scroller) out.push(`${nameOf(e)} scrolls sideways (${e.scrollWidth} > ${e.clientWidth})`);
      else if (cs.overflowX === "visible") out.push(`${nameOf(e)} content wider than its box (${e.scrollWidth} > ${e.clientWidth})`);
    }
    // (a menu row with a picture in it is taller than a line of text, without wrapping)
    if (e.matches(".btn, .chip, .tabs [data-tab], .seg button, .dropdown .item, .part") && !e.querySelector(".brush-prev, .mi-img")) {
      const inner = r.height - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth);
      if (inner > (px(cs.lineHeight) || px(cs.fontSize) * 1.4) * 1.6) out.push(`${nameOf(e)} wraps (${Math.round(r.height)} px tall)`);
    }
  }
  return [...new Set(out)].slice(0, 15);
}
const inView = (e) => {
  const r = e.getBoundingClientRect();
  return r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
};

/* the figure: one of each kind of object */
const fresh = () => {
  M.state.doc = M.newDoc();
  M.state.selection = [];
  C.renderDoc();
  M.resetHistory();
  C.fitView();
};
fresh();
const mac = await A.placeIcon("biocanvas/macrophage", [200, 160]);
const mac2 = await A.placeIcon("biocanvas/macrophage", [300, 160]);
const text = C.insertObject("text", [420, 120]);
C.finishTextEdit();
const rect = C.insertObject("rect", [520, 200]);
const ell = C.insertObject("ellipse", [520, 320]);
const arrow = C.insertObject("arrow", [300, 300]);
const conn = { id: U.uid(), type: "line", x1: 0, y1: 0, x2: 1, y2: 1, stroke: "#2b3440", strokeWidth: 2, curve: 0, startHead: "none", endHead: "arrow", dash: "", from: { id: mac.id }, to: { id: rect.id } };
const brush = (kind, extra = {}) => ({ id: U.uid(), type: "membrane", brush: kind, pts: [[120, 380], [220, 360], [320, 390]], closed: false, thickness: B.BRUSHES[kind].T, fill: "none", seed: 7, name: B.BRUSHES[kind].name, ...extra });
const bil = brush("bilayer", { headColor: "#f0a35c", tailColor: "#e9c88f" });
const cells = brush("columnar");
const parrow = brush("arrow", { startHead: "none", endHead: "arrow" });
const free = brush("freeform", { closed: true, fill: "#d9ecf7", fillOpacity: 1, stroke: "#1d6fa5", pts: [[400, 380], [460, 360], [480, 420], [420, 440]] });
const ibrush = brush("icon", { asset: mac.asset, colors: {}, slotColors: [], name: "Macrophage (brush)", thickness: 30 });
const locked = { ...brush("dna"), locked: true };
M.state.doc.objects.push(conn, bil, cells, parrow, free, ibrush, locked);
const legend = F.insertLegend([200, 450]);
const bar = F.insertScaleBar([520, 450]);
C.renderDoc();
M.commit();
const g1 = await A.placeIcon("biocanvas/macrophage", [650, 160]);
const g2 = C.insertObject("rect", [650, 260]);
M.setSelection([g1.id, g2.id]);
A.groupSel();
const group = M.selectedObjs()[0];
const SELECTIONS = {
  none: [], icon: [mac.id], text: [text.id], rect: [rect.id], ellipse: [ell.id], arrow: [arrow.id], connector: [conn.id],
  bilayer: [bil.id], cells: [cells.id], "path arrow": [parrow.id], freeform: [free.id], "icon brush": [ibrush.id], locked: [locked.id],
  legend: [legend.id], "scale bar": [bar.id], group: [group.id], "same icons": [mac.id, mac2.id], mixed: [mac.id, rect.id, arrow.id],
};
await sleep(300);

/* the inspector at its narrowest, usual and widest, for each selection and tab */
L.setPanels({ library: true, inspector: true });
const SHOTS = new Set(["icon", "text", "connector", "cells", "legend", "scale bar", "none"]);
for (const w of [240, 300, 480]) {
  L.setPanelWidth("inspector", w);
  await frame();
  for (const [name, ids] of Object.entries(SELECTIONS)) {
    M.setSelection(ids);
    P.showTab("design");
    await frame();
    note(`inspector ${w} · ${name}`, overflows($("#inspector")));
    if (w === 240 && SHOTS.has(name)) await shot(`audit-${theme}-inspector-240-${name.replace(/\s+/g, "-")}`, "#inspector");
  }
  for (const t of ["layers", "credits"]) {
    P.showTab(t);
    await frame();
    note(`inspector ${w} · ${t} tab`, overflows($("#inspector")));
  }
  P.showTab("design");
}
L.setPanelWidth("inspector", 300);

/* the library at 220, 330 and 560 px, with My library open */
const chip = (label) => $$("#lib-cats .chip").find((c) => c.textContent.startsWith(label));
for (const w of [220, 330, 560]) {
  L.setPanelWidth("library", w);
  await frame();
  note(`library ${w}`, overflows($("#library")));
  chip("📁 My library")?.click();
  await sleep(300);
  note(`library ${w} · My library`, overflows($("#library")));
  if (w === 220) await shot(`audit-${theme}-library-220-mine`, "#library");
  chip("All")?.click();
  await sleep(200);
}
L.setPanelWidth("library", 330);

/* the top bar from 800 to 1920 px wide */
const W0 = innerWidth, H0 = innerHeight;
const bars = {};
for (const w of [800, 900, 1024, 1100, 1280, 1440, 1600, 1920]) {
  await viewport(w, 760);
  await sleep(60);
  const b = $("#topbar");
  bars[w] = { clipped: b.scrollWidth > b.clientWidth, folded: $$("#topbar [data-fold].folded").map((e) => e.dataset.tool || e.id || "group").join(" ") || "none", inspector: document.documentElement.dataset.inspector || "open" };
  note(`top bar ${w}`, overflows(b));
  if (w === 1024 || w === 1600) await shot(`audit-${theme}-topbar-${w}`, "#topbar");
}

/* dialogs and menus at 1024 × 700 */
await viewport(1024, 700);
M.setSelection([mac.id]);
await frame();
const dialogs = {
  export: () => X.exportDialog(),
  replace: () => LIB.replaceDialog(),
  "panel labels": () => F.panelLabelsDialog(),
  shortcuts: () => press("?"),
};
for (const [name, open] of Object.entries(dialogs)) {
  open();
  await sleep(name === "replace" ? 900 : 300);
  const m = $(".modal");
  if (!m) {
    problems[`dialog ${name}`] = ["did not open"];
    continue;
  }
  const list = overflows(m, { skip: null });
  if (!inView(m)) list.push("not inside the window");
  note(`dialog ${name}`, list);
  await shot(`audit-${theme}-dialog-${name.replace(/\s+/g, "-")}`, ".modal");
  press("Escape");
  await frame();
}
const menus = {};
for (const m of $$("#menus .menu > button")) {
  await click(m);
  const dd = $(".dropdown");
  menus[m.textContent] = dd ? { inView: inView(dd), scrolls: dd.scrollHeight > dd.clientHeight + 1, width: Math.round(dd.getBoundingClientRect().width) } : "did not open";
  if (dd) note(`menu ${m.textContent}`, overflows(dd, { skip: null }).concat(inView(dd) ? [] : ["not inside the window"]));
  press("Escape");
  await frame();
}
// the brush picker (Insert › Brush…), the ⋯ menu, the context menu, a colour picker
await click($('#menus [data-menu="insert"] button'));
const brushRow = $$(".dropdown .item").find((r) => r.querySelector(".mi-label")?.textContent.startsWith("Brush"));
await click(brushRow);
await frame();
const bm = $(".dropdown");
note("brush menu", bm ? overflows(bm, { skip: null }).concat(inView(bm) ? [] : ["not inside the window"]) : ["did not open"]);
await shot(`audit-${theme}-brush-menu`, ".dropdown");
press("Escape");
await frame();
if (!$("#btn-more").classList.contains("folded")) {
  await click($("#btn-more"));
  const mm = $(".dropdown");
  note("⋯ menu", mm ? overflows(mm, { skip: null }).concat(inView(mm) ? [] : ["not inside the window"]) : ["did not open"]);
  await shot(`audit-${theme}-more-menu`, ".dropdown");
  press("Escape");
  await frame();
}
const st = $("#stage").getBoundingClientRect();
const [cx, cy] = C.docToScreen(mac.x + mac.w / 2, mac.y + mac.h / 2);
await mouse("mouseMoved", st.left + cx, st.top + cy, { button: "none" });
await mouse("mousePressed", st.left + cx, st.top + cy, { button: "right" });
await mouse("mouseReleased", st.left + cx, st.top + cy, { button: "right" });
await frame();
const cm = $(".dropdown");
note("context menu", cm ? overflows(cm, { skip: null }).concat(inView(cm) ? [] : ["not inside the window"]) : ["did not open"]);
press("Escape");
await frame();
L.setPanels({ inspector: true });
await frame();
$("#tab-design .part")?.click();
await frame();
const cp = $(".colorpop")?.closest(".dropdown");
note("colour picker", cp ? overflows(cp, { skip: null }).concat(inView(cp) ? [] : ["not inside the window"]) : ["did not open"]);
press("Escape");
await viewport(W0, H0);
return { theme, problems, bars, menus, errors };
