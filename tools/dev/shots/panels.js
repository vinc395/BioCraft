// tools/dev/shot.mjs page script: resizable and collapsible side panels, Focus mode, the top bar's ⋯ menu,
// and the canvas following it all. Drives the real mouse (splitter drags, double-clicks, clicks on the
// chevrons and rails), the keyboard shortcuts and the View menu; checks the state and takes four shots:
// default, resized, collapsed (library) and Focus mode. Run it on a sandbox page at each size and theme:
//   node tools/dev/shot.mjs tools/dev/shots/panels.js --base "http://localhost:8791/?sandbox" --size 1280x800 --theme dark --out tools/dev/out/panels
const API = await import("/js/api.js");
if (!API.sandbox) throw new Error("run this on a ?sandbox page");
const L = await import("/js/layout.js");
const TH = await import("/js/theme.js");
const W0 = innerWidth, H0 = innerHeight;
const tag = `${W0}x${H0}-${TH.effectiveTheme()}`;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const errors = [];
window.addEventListener("error", (e) => errors.push("error: " + e.message));
window.addEventListener("unhandledrejection", (e) => errors.push("rejection: " + (e.reason?.message || e.reason)));
const checks = [];
const ok = (cond, what, detail) => {
  checks.push((cond ? "ok   " : "FAIL ") + what + (!cond && detail !== undefined ? " — " + JSON.stringify(detail) : ""));
  return cond;
};
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const width = (sel) => Math.round($(sel).getBoundingClientRect().width);
const collapsed = (k) => document.documentElement.dataset[k] === "collapsed";
const stored = () => JSON.parse(localStorage.getItem("biocraft.panels") || "null");
// (on the body: open menus see the key first, as they do with a real key press)
const press = (key, o = {}) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
const centre = (el) => {
  const r = (typeof el === "string" ? $(el) : el).getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
};
const click = async (el) => {
  const [x, y] = centre(el);
  await mouse("mouseMoved", x, y, { button: "none" });
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
  await frame();
};
/** Drag a panel's inner edge by dx with the real mouse, in steps. */
const dragEdge = async (k, dx, steps = 6) => {
  const [x, y] = centre(`.splitter[data-panel="${k}"]`);
  await mouse("mouseMoved", x, y, { button: "none" });
  await mouse("mousePressed", x, y);
  for (let i = 1; i <= steps; i++) await mouse("mouseMoved", x + (dx * i) / steps, y);
  await frame();
  const during = { dragging: $(`.splitter[data-panel="${k}"]`).classList.contains("dragging"), resizing: document.body.classList.contains("resizing") };
  await mouse("mouseReleased", x + dx, y);
  await frame();
  return during;
};
/** Things that stick out of `root` sideways, or rows of text pushed wider than their box. */
function overflows(root) {
  const R = root.getBoundingClientRect(), out = [];
  for (const e of root.querySelectorAll("*")) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || e.closest(".lib-grid")) continue;
    const name = e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : "");
    if (r.right > R.right + 0.5 || r.left < R.left - 0.5) out.push(`${name} sticks out (${Math.round(r.left)}–${Math.round(r.right)} of ${Math.round(R.left)}–${Math.round(R.right)})`);
    const cs = getComputedStyle(e);
    if (e.scrollWidth > e.clientWidth + 1 && e.clientWidth && cs.overflowX === "visible" && !/^(svg|path|g)$/i.test(e.tagName)) out.push(`${name} content wider than its box (${e.scrollWidth} > ${e.clientWidth})`);
  }
  return [...new Set(out)].slice(0, 12);
}
const out = { tag };

/* the figure: a few icons, a shape, an arrow and some text; an icon selected (inspector and quick toolbar) */
const mac = await A.placeIcon("biocanvas/macrophage", [260, 200]);
const tcell = (await API.api("library.search", { q: "T cell", offset: 0, limit: 1 })).items[0]?.id;
if (tcell) await A.placeIcon(tcell, [420, 260]);
C.insertObject("rect", [520, 160]);
C.insertObject("arrow", [330, 330]);
M.setSelection([mac.id]);
C.fitView();
await sleep(500);

/* 1. default: as the app starts at this size */
{
  const narrow = W0 < L.NARROW;
  ok(!collapsed("library"), "default: the library is open");
  ok(collapsed("inspector") === narrow, `default: the inspector is ${narrow ? "collapsed (narrow window)" : "open"}`, document.documentElement.dataset);
  ok(width("#library") === 330, "default: library 330 px", width("#library"));
  if (!narrow) ok(width("#inspector") === 300, "default: inspector 300 px", width("#inspector"));
  else {
    ok(width("#inspector") === 28, "narrow: the inspector is a 28 px rail", width("#inspector"));
    ok($('.rail[data-panel="inspector"]').classList.contains("has-sel"), "narrow: the inspector rail shows a dot (an object is selected)");
  }
  const bar = $("#topbar");
  ok(bar.scrollWidth <= bar.clientWidth, "top bar: nothing clipped", [bar.scrollWidth, bar.clientWidth]);
  out.folded = $$("#topbar .folded").map((e) => e.id || e.dataset.tool || e.className);
  ok(!$("#btn-export").classList.contains("folded") && $("#btn-export").getBoundingClientRect().right <= innerWidth, "top bar: Export visible");
  ok(!overflows($("#library .lib-head")).length, "library head fits", overflows($("#library .lib-head")));
  ok($("#lib-search").scrollWidth <= $("#lib-search").clientWidth + 1, "search box: no text overflow");
  const qb = $("#quickbar"), sw = $("#stage-wrap").getBoundingClientRect(), q = qb.getBoundingClientRect();
  ok(qb.classList.contains("show") && q.left >= sw.left && q.right <= sw.right, "quick toolbar inside the canvas", { q: [q.left, q.right], sw: [sw.left, sw.right], compact: qb.classList.contains("compact") });
  out.quickbarCompact = qb.classList.contains("compact");
  out.placeholder = $("#lib-search").placeholder;
  await shot(`${tag}-1-default`);
}

/* the ⋯ menu holds what the top bar folded away */
if (!$("#btn-more").classList.contains("folded")) {
  await click($("#btn-more"));
  const items = $$(".dropdown .item .mi-label").map((e) => e.textContent);
  out.moreMenu = items;
  ok(items.length > 0, "⋯ menu lists the folded buttons", items);
  if ($("#btn-undo").closest(".folded")) ok(items.includes("Undo") && items.includes("Redo"), "⋯ menu: Undo and Redo");
  if ($("#btn-theme").classList.contains("folded")) ok(items.includes("Theme"), "⋯ menu: Theme");
  press("Escape");
  await frame();
}

/* 2. resized: drag the library edge 150 px wider and the inspector edge 100 px wider */
{
  if (collapsed("inspector")) {
    await click($('.rail[data-panel="inspector"]'));
    ok(!collapsed("inspector") && width("#inspector") >= 240, "narrow: clicking the rail opens the inspector on demand", width("#inspector"));
  }
  C.zoomAt(1.3); // (not fitted: the point at the centre stays put)
  await frame();
  const c0 = C.viewCenter();
  const during = await dragEdge("library", 150);
  ok(during.dragging && during.resizing, "dragging the edge: highlighted, col-resize everywhere", during);
  const lw = width("#library"), maxL = Math.min(560, innerWidth - 360 - width("#inspector"));
  ok(near(lw, Math.min(480, maxL), 1), `library dragged to ${Math.min(480, maxL)} px`, lw);
  const c1 = C.viewCenter();
  ok(near(c0[0], c1[0], 0.6) && near(c0[1], c1[1], 0.6), "the view centre stays put while the panel resizes", { c0, c1 });
  await dragEdge("inspector", -100);
  const iw = width("#inspector"), maxI = Math.min(480, innerWidth - 360 - width("#library"));
  ok(near(iw, Math.min(400, Math.max(240, maxI)), 1), `inspector dragged to ${Math.min(400, Math.max(240, maxI))} px`, iw);
  ok(innerWidth - width("#library") - width("#inspector") >= 359, "the canvas keeps at least 360 px", innerWidth - width("#library") - width("#inspector"));
  ok(!overflows($("#library .lib-head")).length, "library head fits when wider", overflows($("#library .lib-head")));
  const tiles = $$("#lib-grid .tile").slice(0, 8).map((t) => Math.round(t.getBoundingClientRect().top));
  out.tilesPerRow = tiles.filter((t) => t === tiles[0]).length;
  ok(out.tilesPerRow >= 3, "the icon grid reflows into more columns", out.tilesPerRow);
  const s = stored();
  ok(s && s.library.width === lw && s.inspector.width === iw, "widths remembered in localStorage", s);
  const qb = $("#quickbar"), sw = $("#stage-wrap").getBoundingClientRect(), q = qb.getBoundingClientRect();
  ok(!qb.classList.contains("show") || (q.left >= sw.left - 0.5 && q.right <= sw.right + 0.5), "quick toolbar inside the narrower canvas", { q: [q.left, q.right], sw: [sw.left, sw.right], compact: qb.classList.contains("compact") });
  out.resizedPlaceholder = $("#lib-search").placeholder;
  await shot(`${tag}-2-resized`);

  // the limits, the keyboard and a real double-click
  await dragEdge("library", 5 - centre(".splitter[data-panel=library]")[0]);
  ok(width("#library") === 220, "library stops at 220 px", width("#library"));
  ok(!overflows($("#library .lib-head")).length, "library head fits at 220 px", overflows($("#library .lib-head")));
  out.narrowPlaceholder = $("#lib-search").placeholder;
  ok(!out.narrowPlaceholder.includes("e.g."), "a narrow search box drops the examples from its hint", out.narrowPlaceholder);
  ok($("#lib-search").title.includes("e.g."), "…and keeps them in its tooltip", $("#lib-search").title);
  await shot(`${tag}-2b-library-220`, "#library");
  await dragEdge("library", innerWidth - 5 - centre(".splitter[data-panel=library]")[0]);
  ok(width("#library") === Math.min(560, innerWidth - 360 - width("#inspector")), "library stops at 560 px or the room left", width("#library"));
  const edge = $('.splitter[data-panel="library"]');
  edge.focus();
  const before = width("#library");
  edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  await frame();
  ok(width("#library") === before - 10, "ArrowLeft on the edge: 10 px narrower", [before, width("#library")]);
  const [ex, ey] = centre(edge);
  await mouse("mouseMoved", ex, ey, { button: "none" });
  await mouse("mousePressed", ex, ey, { clickCount: 1 });
  await mouse("mouseReleased", ex, ey, { clickCount: 1 });
  await mouse("mousePressed", ex, ey, { clickCount: 2 });
  await mouse("mouseReleased", ex, ey, { clickCount: 2 });
  await frame();
  ok(width("#library") === 330, "double-clicking the edge: the usual 330 px", width("#library"));
}

/* the view menu, menus following their buttons, popovers, the text editor */
{
  await click($('#menus [data-menu="view"] button'));
  const rows = $$(".dropdown .item").map((r) => [r.querySelector(".mi-label").textContent, r.getAttribute("aria-checked")]);
  const row = (t) => rows.find(([l]) => l === t);
  ok(row("Library panel")?.[1] === "true" && row("Inspector panel")?.[1] === "true" && row("Focus mode")?.[1] === "false", "View menu: panels checked, Focus mode not", rows);
  await shot(`${tag}-menu-view`, ".dropdown");
  const item = $$(".dropdown .item").find((r) => r.querySelector(".mi-label")?.textContent === "Inspector panel");
  await click(item);
  ok(collapsed("inspector"), "View › Inspector panel collapses it");
  press("B", { ctrlKey: true, shiftKey: true });
  await frame();
  ok(!collapsed("inspector"), "Ctrl+Shift+B opens it again");

  // a menu hanging from the quick toolbar follows it when a panel collapses
  const align = [...$$("#quickbar button")].find((b) => b.getAttribute("aria-label") === "Align");
  if (align && $("#quickbar").classList.contains("show")) {
    align.click();
    await frame();
    const dd = $(".dropdown");
    const gap0 = dd.getBoundingClientRect().left - align.getBoundingClientRect().left;
    press("b", { ctrlKey: true });
    await frame();
    await frame();
    const gap1 = $(".dropdown") ? $(".dropdown").getBoundingClientRect().left - align.getBoundingClientRect().left : null;
    ok(collapsed("library") && gap1 !== null && near(gap0, gap1, 1), "Ctrl+B with a toolbar menu open: the menu moves with its button", { gap0, gap1 });
    press("Escape");
    press("b", { ctrlKey: true });
    await frame();
  }
  // the transform popover follows the toolbar too
  const tr = [...$$("#quickbar button")].find((b) => b.getAttribute("aria-label") === "Transform");
  if (tr && $("#quickbar").classList.contains("show")) {
    tr.click();
    await frame();
    const p = $(".qb-transform")?.closest(".dropdown");
    const gap0 = p.getBoundingClientRect().left - tr.getBoundingClientRect().left;
    L.togglePanel("library");
    await frame();
    await frame();
    const p1 = $(".qb-transform")?.closest(".dropdown");
    const gap1 = p1 ? p1.getBoundingClientRect().left - tr.getBoundingClientRect().left : null;
    ok(!!p1 && near(gap0, gap1, 1), "a popover moves with its button when a panel collapses", { gap0, gap1 });
    p1?.querySelector("input")?.blur();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    L.togglePanel("library");
    await frame();
  }
  // the text box being typed in stays on its text
  const t = C.insertObject("text", C.viewCenter());
  await frame();
  const ta = $("#text-editor"), st = $("#stage").getBoundingClientRect();
  L.togglePanel("library");
  await frame();
  await frame();
  const st1 = $("#stage").getBoundingClientRect(), [sx, sy] = C.docToScreen(t.x, t.y);
  ok(near(parseFloat(ta.style.left), sx, 1) && near(parseFloat(ta.style.top), sy, 1), "the text editor follows its text when the canvas changes size", { left: ta.style.left, sx, stageMoved: st1.left - st.left });
  C.finishTextEdit();
  M.setSelection([t.id]);
  A.deleteSel();
  M.setSelection([mac.id]);
  L.togglePanel("library");
  await frame();
}

/* a fitted page fits again when the canvas grows */
{
  C.fitView();
  await frame();
  const z0 = M.state.view.zoom;
  L.togglePanel("library");
  await frame();
  await frame();
  const v1 = { ...M.state.view };
  C.fitView();
  const v2 = M.state.view;
  ok(near(v1.zoom, v2.zoom, 1e-6) && near(v1.x, v2.x, 0.01) && near(v1.y, v2.y, 0.01), "a fitted page is fitted again after a panel collapses", { v1, v2 });
  ok(v1.zoom >= z0 - 1e-9, "…and gets bigger or stays", { z0, z1: v1.zoom });
  L.togglePanel("library");
  await frame();
}

/* 3. collapsed: the library's chevron; the rail opens it again */
{
  C.zoomAt(1.2);
  await frame();
  const c0 = C.viewCenter();
  await click($('.panel-toggle[data-panel="library"]'));
  ok(collapsed("library") && width("#library") === 28, "the chevron collapses the library to a 28 px rail", width("#library"));
  ok(getComputedStyle($('.splitter[data-panel="library"]')).display === "none", "no resize edge on a collapsed panel");
  const c1 = C.viewCenter();
  ok(near(c0[0], c1[0], 0.6) && near(c0[1], c1[1], 0.6), "the view centre stays put when a panel collapses", { c0, c1 });
  ok(stored()?.library.open === false, "collapsed state remembered", stored());
  await shot(`${tag}-3-collapsed`);
  await click($('.rail[data-panel="library"]'));
  ok(!collapsed("library") && width("#library") === 330, "clicking the rail opens the library at its width", width("#library"));
}

/* 4. Focus mode: Ctrl+\ collapses both; again brings back what was open */
{
  press("\\", { ctrlKey: true, code: "Backslash" });
  await frame();
  ok(collapsed("library") && collapsed("inspector") && L.focusMode(), "Ctrl+\\ : Focus mode collapses both panels");
  const sw = $("#stage-wrap").getBoundingClientRect().width;
  ok(sw >= innerWidth - 56 - 2, "Focus mode: the canvas takes the window but for two rails", sw);
  // selecting while the inspector is collapsed: its rail shows a dot, the panel is ready with the new selection
  M.setSelection([]);
  await frame();
  ok(!$('.rail[data-panel="inspector"]').classList.contains("has-sel"), "no selection: no dot");
  M.setSelection([mac.id]);
  await frame();
  ok($('.rail[data-panel="inspector"]').classList.contains("has-sel"), "a selection: the inspector rail shows a dot");
  await shot(`${tag}-4-focus`);
  press("\\", { ctrlKey: true, code: "Backslash" });
  await frame();
  ok(!collapsed("library") && !collapsed("inspector"), "Ctrl+\\ again: both panels back");
  ok($("#tab-design input.num")?.value === "Macrophage", "the inspector shows the object selected while it was collapsed", $("#tab-design input.num")?.value);
}

/* a narrow window collapses the inspector, keeping a value being typed in it; a wide one brings it back */
if (W0 >= L.NARROW) {
  const w = $$("#tab-design input.num").find((i) => i.closest(".field")?.querySelector("label")?.textContent === "W");
  if (ok(!!w, "the inspector has the icon's W field")) {
    w.focus();
    w.select();
    await typeText("40");
    await viewport(1024, 700);
    ok(collapsed("inspector"), "narrow window: the inspector collapses by itself");
    ok(near(M.getObj(mac.id).w / M.MM, 40, 0.01), "…and the width typed into it is kept", M.getObj(mac.id).w / M.MM);
    ok(stored()?.inspector.open !== false, "…without changing the remembered choice", stored());
    await viewport(W0, H0);
    ok(!collapsed("inspector"), "wide again: the inspector comes back");
    M.undo();
    await frame();
  }
}

/* nothing went wrong on the way */
ok(!errors.length, "no errors", errors);
L.resetPanels();
return { checks, out, errors };
