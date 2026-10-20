// tools/dev/shot.mjs page script: the licence & attribution report for a figure that mixes every
// kind of licence and change, checked against what the app (app/src/licence.rs) writes, plus the
// Export dialog option, the File menu entry and the Credits tab button. Run it on a sandbox page:
//   node tools/dev/shot.mjs tools/dev/shots/licence-report.js --base "http://localhost:8791/?sandbox" --out <dir>
// It returns the checks and the report files (PDF as base64) to look at.
const API = await import("/js/api.js");
if (!API.sandbox) throw new Error("run this on a ?sandbox page");
const L = await import("/js/licence.js");
const S = await import("/js/style.js");
const F = await import("/js/furniture.js");
const E = await import("/js/exporter.js");
const B = await import("/js/brush.js");
const errors = [];
let exportedPdf = null;
window.addEventListener("error", (e) => errors.push("error: " + e.message));
window.addEventListener("unhandledrejection", (e) => errors.push("rejection: " + (e.reason?.message || e.reason)));
// browser-mode exports and reports end in downloads: keep them off the disk
document.addEventListener("click", (e) => { if (e.target?.download) e.preventDefault(); }, true);
const checks = [];
const ok = (cond, what, detail) => {
  checks.push((cond ? "ok   " : "FAIL ") + what + (!cond && detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 400) : ""));
  return cond;
};
const until = async (fn, ms = 5000) => {
  for (let t = 0; t < ms; t += 40) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  return null;
};

M.state.doc = M.newDoc();
M.state.selection = [];
C.setTool("select");
C.renderDoc();
M.resetHistory();
C.fitView();

/* a figure with every licence and every kind of change */
const at = (i) => [110 + (i % 4) * 150, 110 + Math.floor(i / 4) * 150];
const ids = {
  mac: "servier/macrophage", chrom: "servier/chromosome", virus: "nih/646-adenovirus",
  fish: "bioicons/stefano-vianello-acanthurus-triostegus-adult", syringe: "healthicons/devices-syringe",
  fib: "biocanvas/fibroblast", mouse: "scidraw/adult-mouse-284dd297", rodent: "phylopic/parapodemus-lugdunensis",
};
const o = {};
let slot = 0;
for (const [k, id] of Object.entries(ids)) o[k] = await A.placeIcon(id, at(slot++));
const mac2 = await A.placeIcon(ids.mac, at(slot++)); // a second, unchanged copy
S.setPartColor(o.mac, 0, "#0072b2");
A.setIconLabels(o.chrom, "hidden");
S.applyOverlay(o.virus, "gray");
o.mouse.opacity = 0.6;
o.rodent.hidden = true; // not in the export, so not in the report
M.setSelection([o.fish.id, o.syringe.id]);
A.groupSel();
M.getObj(M.state.selection[0]).glow = { color: "#33cc88", size: 6 };
M.state.doc.objects.push({ id: "brush1", type: "membrane", brush: "icon", asset: ids.fib, pts: [[90, 560], [300, 600], [520, 560]], closed: false, thickness: B.BRUSHES.icon.T, fill: "none", colors: {}, slotColors: [], name: "Fibroblast (brush)", seed: 3 });
M.state.doc.assets["user/test-blot"] = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#445566"/><rect x="3" y="4" width="5" height="2" fill="#ffffff"/></svg>',
  w: 20, h: 10, slots: [], meta: { id: "user/test-blot", name: "Test blot", pack: "user", packName: "My library", license: "USER" },
};
M.state.doc.objects.push({ id: "mine1", type: "icon", asset: "user/test-blot", name: "Test blot", x: 560, y: 420, w: 90, h: 45, rot: 0, colors: {}, slotColors: [] });
const cv = Object.assign(document.createElement("canvas"), { width: 24, height: 12 });
{ const g = cv.getContext("2d"); g.fillStyle = "#445566"; g.fillRect(0, 0, 24, 12); g.fillStyle = "#e8eef5"; g.fillRect(3, 5, 7, 2); g.fillRect(14, 5, 6, 2); }
const png = cv.toDataURL("image/png");
A.placeImage(png, "Western blot.png", [620, 520]);
await until(() => M.state.doc.objects.some((x) => x.type === "image"));
F.insertLegend([640, 120]);
M.commit();
C.renderDoc();
await frame();
await shot("licence-figure", "#stage");

/* the credit: the Credits tab's text and the app's are the same words */
const used = M.assetsUsed(M.state.doc.objects);
const content = JSON.stringify({ ...M.state.doc, app: "BioCraft", version: 1, assets: Object.fromEntries(Object.entries(M.state.doc.assets).filter(([k]) => used.has(k))) });
const rep = await API.api("licence.report", { content, name: "licence-test", export: { format: "png", dpi: 300, widthMm: 178, heightMm: 120 }, preparedBy: "Test Person" });
const js = L.legendText();
ok(js === rep.credit, "the Credits tab writes the app's credit", { js, rust: rep.credit });
ok(js.includes("Servier Medical Art (smart.servier.com), licensed under CC BY 4.0/3.0 (adapted from Macrophage, Chromosome)"), "changed Servier icons are credited as adapted", js);
ok(js.includes("Bioicons: adapted from Acanthurus triostegus adult by Stefano-Vianello (CC BY-SA 4.0)"), "a glow inherited from its group adapts a CC BY-SA icon", js);
ok(js.includes("Health Icons: Syringe by Health Icons (Resolve to Save Lives) (MIT)"), "MIT icons are not marked adapted", js);
ok(js.includes("illustrations from NIAID NIH BioArt Source (bioart.niaid.nih.gov"), "NIH credit", js);
ok(js.includes("SciDraw: adapted from Adult mouse by Yunan Chen (CC BY 4.0)"), "transparency counts as a change", js);
ok(!js.includes("Parapodemus"), "hidden icons are left out", js);
ok(js.includes("BioCraft Originals (CC0)"), "the icon brush's original is credited", js);

/* the files */
const files = Object.fromEntries((rep.downloads || []).map((f) => [f.name.split(".").pop(), f]));
ok(Object.keys(files).sort().join() === "csv,md,pdf" && files.pdf.name === "licence-test-licence.pdf", "PDF, Markdown and CSV come back for download", rep.downloads?.map((f) => f.name));
const text = (f) => new TextDecoder().decode(Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)));
const md = text(files.md), csv = text(files.csv), pdf = atob(files.pdf.base64);
for (const want of ["# Licence & attribution report", "**Prepared by:** Test Person", "PNG · 178.0 × 120.0 mm · 2,102 × 1,417 px at 300 dpi", "Share-alike: 1 icon (Acanthurus triostegus adult)", "Licence notices: 1 icon (Syringe)", "built-in labels hidden", "greyscale", "glow added", "made transparent", "recoloured parts", "icon brush", "legend", "## Your own material", "My library upload: Test blot", "Placed picture: Western blot.png", "BioCraft does not grant licences"]) {
  ok(md.includes(want), "Markdown: " + want, md.slice(0, 1500));
}
const rows = csv.trim().split("\n");
ok(rows[0].startsWith("figure_id,icon_id,name,source,author,licence"), "CSV header");
ok(rows.length === 1 + 7 + 2, "CSV: 7 library icons and 2 of your own", rows.length);
// two icons and their two legend rows; the rows' copied colours add nothing to "recoloured parts"
ok(rows.some((r) => r.includes(",servier/macrophage,Macrophage,Servier Medical Art,") && r.endsWith(",4,icon; legend,recoloured parts")), "CSV: the macrophage drawn twice and in the legend, recoloured", rows.find((r) => r.includes("macrophage")));
ok(pdf.startsWith("%PDF") && (pdf.match(/\/Type \/Page\b/g) || []).length >= 2, "a multi-page PDF", (pdf.match(/\/Type \/Page\b/g) || []).length);
ok(rep.figure_id && /^[0-9a-f]{12}$/.test(rep.figure_id) && md.includes(rep.figure_id) && rows[1].startsWith(rep.figure_id + ","), "the figure id is on every output", rep.figure_id);

/* Export dialog: preview, publication permissions, the report option (on by default, remembered) */
try { localStorage.removeItem("biocraft.licenceReport"); } catch {}
L.reportPrefs.save = true;
L.reportPrefs.preparedBy = "";
delete M.state.doc.publication;
// keep a copy of what the app returns for the report (browser mode hands the files back for download)
const reports = [];
const realFetch = window.fetch;
window.fetch = async (u, o) => {
  const r = await realFetch(u, o);
  if (String(u).endsWith("/api/licence.report")) r.clone().json().then((j) => reports.push(j.result)).catch(() => {});
  return r;
};
E.exportDialog();
const modal = await until(() => document.querySelector(".modal.export"));
ok(!!modal, "Export: the wide dialog with a preview");
const img = await until(() => modal.querySelector(".exp-frame img")?.naturalWidth && modal.querySelector(".exp-frame img"));
ok(img && img.src.startsWith("blob:") && img.naturalWidth > 50, "Export: the preview shows the figure", img?.naturalWidth);
const gray = [...modal.querySelectorAll("label.qb-check")].find((l) => /greyscale/i.test(l.textContent))?.querySelector("input");
gray.click();
ok(modal.querySelector(".exp-frame").classList.contains("gray") && getComputedStyle(img).filter.includes("grayscale"), "Export: preview in greyscale");
gray.click();
[...modal.querySelectorAll(".seg button")].find((b) => b.textContent === "Transparent").click();
await frame();
ok(modal.querySelector(".exp-frame").classList.contains("clear"), "Export: a transparent background shows as a checkerboard");
[...modal.querySelectorAll(".seg button")].find((b) => b.textContent === "White").click();
await until(() => E.exportState.summary);
const sm = E.exportState.summary;
const chips = [...modal.querySelectorAll(".perm-chip")].map((c) => c.textContent);
ok(chips.join("|") === "✓ Teaching|✓ Journals & books|✕ Open access (CC BY)|✓ Commercial use", "Publication permissions: what the licences allow (the share-alike icon rules out a CC BY article)", chips);
ok(/Credit required/.test(modal.querySelector(".perm").textContent) && /Share-alike: Acanthurus triostegus adult/.test(modal.querySelector(".perm").textContent), "Publication permissions: the conditions", modal.querySelector(".perm").textContent.slice(0, 400));
modal.querySelector(".perm-what").click();
ok(!modal.querySelector(".perm-explain").hidden && /can't grant a licence/.test(modal.querySelector(".perm-explain").textContent), "Publication permissions: What is this? explains why no licence is needed");
const chk = [...modal.querySelectorAll("label.qb-check")].find((l) => /licence & attribution report/i.test(l.textContent))?.querySelector("input");
ok(chk && chk.checked, "Export: 'Save the licence & attribution report' is on by default");
const details = modal.querySelector(".perm-details");
chk.click();
ok(details.style.display === "none", "Export: unticking hides the publication details");
chk.click();
details.open = true;
const setField = (label, v) => {
  const f = [...details.querySelectorAll(".field")].find((x) => x.querySelector("label").textContent === label);
  const inp = f.querySelector("input,select");
  inp.value = v;
  inp.dispatchEvent(new Event(inp.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
setField("Journal", "Arthritis Research & Therapy");
setField("Figure title", "Figure 3 | Mixed licences");
setField("Article licence", "cc-by");
setField("Prepared by", "Dr Test");
const warned = await until(() => modal.querySelector(".perm-check .warn"), 4000);
ok(warned && /Arthritis Research & Therapy, open access under CC BY/.test(warned.textContent) && /Acanthurus/.test(warned.textContent), "Publication check: share-alike icon flagged for a CC BY article", modal.querySelector(".perm-check")?.textContent);
setField("Article licence", "subscription");
const changed = await until(() => /subscription/.test(modal.querySelector(".perm-check")?.textContent || "") && modal.querySelector(".perm-check"), 4000);
ok(!!changed, "Publication check: follows the article licence", modal.querySelector(".perm-check")?.textContent);
setField("Article licence", "cc-by");
await sleep(400);
await shot("licence-export-dialog", ".modal");
const toasts = [];
const toastEl = document.querySelector("#toast");
const tObs = new MutationObserver(() => toasts.push(toastEl.textContent));
tObs.observe(toastEl, { childList: true, subtree: true, characterData: true });
[...modal.querySelectorAll("button")].find((b) => b.textContent === "Export").click();
await until(() => toasts.some((t) => /licence report|failed/i.test(t)), 15000);
tObs.disconnect();
ok(toasts.some((t) => /^Exported .*\.png and its licence report$/.test(t)), "Export: the figure and its report", toasts);
let saved = null;
try { saved = JSON.parse(localStorage.getItem("biocraft.licenceReport")); } catch {}
ok(saved?.save === true && saved?.preparedBy === "Dr Test", "Export: the choice and the name are remembered", saved);
ok(M.state.doc.publication?.journal === "Arthritis Research & Therapy" && M.state.doc.publication?.openAccess === "cc-by", "Export: the journal details are kept in the figure", M.state.doc.publication);
await until(() => reports.length);
const rmd = reports[0] && new TextDecoder().decode(Uint8Array.from(atob(reports[0].downloads.find((f) => f.name.endsWith(".md")).base64), (c) => c.charCodeAt(0)));
for (const want of ["**Figure:** Figure 3 \\| Mixed licences", "**Journal:** Arthritis Research & Therapy", "**Article licence:** Open access under CC BY", "**Prepared by:** Dr Test", "Publication in Arthritis Research & Therapy, open access under CC BY"]) ok(rmd && rmd.includes(want), "Report: " + want, rmd?.slice(0, 900));
const rpdf = reports[0] && atob(reports[0].downloads.find((f) => f.name.endsWith(".pdf")).base64);
ok(rpdf && rpdf.startsWith("%PDF"), "Report: the PDF");
window.fetch = realFetch;
exportedPdf = reports[0]?.downloads.find((f) => f.name.endsWith(".pdf")).base64;

/* File menu and Credits tab */
document.querySelector('[data-menu="file"] > button').click();
await frame();
const item = [...document.querySelectorAll(".menu-pop *, .menu-list *, [role=menu] *")].find((e) => e.textContent.trim().startsWith("Export licence report"));
ok(!!item, "File menu: Export licence report…");
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await frame();
P.showTab("credits");
await frame();
const pane = document.querySelector("#tab-credits");
ok([...pane.querySelectorAll("button")].some((b) => b.textContent === "Licence report (PDF)…"), "Credits tab: Licence report (PDF)… button");
ok(pane.querySelector("textarea")?.value === js, "Credits tab: the legend text");
ok(/Changed: recoloured parts/.test(pane.textContent), "Credits tab: what was changed");
await shot("licence-credits-tab", "#inspector");

ok(!errors.length, "no page errors", errors);
return { checks, files: { pdf: exportedPdf || files.pdf.base64, md, csv } };
