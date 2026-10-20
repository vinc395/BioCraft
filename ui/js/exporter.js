// Export dialog: a live preview of exactly what will be written (optionally in greyscale) beside the
// settings — PNG/TIFF at a chosen DPI, vector PDF, SVG; whole figure or selection — and a Publication
// permissions section: what the icons' licences allow, the licence & attribution report saved beside
// the export, and the journal details it records and checks the licences against.

import { api, downloadResult, isDesktop } from "./api.js";
import { state, selectedObjs, docPx, MM, endPreviews } from "./model.js";
import { documentSvg, visualBox } from "./render.js";
import { modal } from "./menus.js";
import { bus, el, toast, debounce } from "./util.js";
import { licenceReport, licenceSummary, publicationOf, reportPrefs, saveReportPrefs } from "./licence.js";

const prefs = { format: "png", dpi: 300, bg: "white", scope: "page", gray: false };

/** The open dialog's state, for tests. */
export const exportState = { summary: null };

const ACCESS = [["", "Not sure yet"], ["cc-by", "Open access (CC BY)"], ["oa-other", "Open access (other licence)"], ["subscription", "Subscription journal"]];

export async function exportDialog() {
  endPreviews(); // export the styles that are applied, not one being previewed
  const sel = selectedObjs();
  const fmtBtns = el("div.seg");
  const dpiBtns = el("div.seg");
  const bgBtns = el("div.seg");
  const scopeBtns = el("div.seg");
  const info = el("div.small.muted");
  const nameIn = el("input.num", { value: (state.filePath || "figure").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") });
  const rasterRows = el("div", { style: { display: "grid", gap: "8px" } });

  // ---- what will be written (the export and the preview share one builder) ----
  const area = () => {
    if (prefs.scope === "selection" && sel.length) {
      const b = visualBox(sel); // glows reach past the selection box
      const m = 2 * MM;
      return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
    }
    const { w, h } = docPx();
    return { x: 0, y: 0, w, h };
  };
  const exported = () => {
    const raster = prefs.format === "png" || prefs.format === "tiff";
    const crop = prefs.scope === "selection" ? area() : null;
    const objects = prefs.scope === "selection" ? state.doc.objects.filter((o) => state.selection.includes(o.id)) : state.doc.objects;
    let background = state.doc.background;
    if (raster) background = prefs.bg === "white" ? state.doc.background || "#ffffff" : null;
    if (prefs.scope === "selection" && !raster) background = null;
    return { raster, crop, objects, background, svg: documentSvg(state.doc, { objects, crop, background }) };
  };

  // ---- preview ----
  const img = el("img", { alt: "Preview of the exported figure" });
  const frame = el("div.exp-frame", {}, img);
  const grayChk = el("input", { type: "checkbox", checked: prefs.gray });
  grayChk.addEventListener("change", () => { prefs.gray = grayChk.checked; frame.classList.toggle("gray", prefs.gray); });
  frame.classList.toggle("gray", prefs.gray);
  let url = null;
  const showPreview = () => {
    const x = exported();
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([x.svg], { type: "image/svg+xml" }));
    img.src = url;
    frame.classList.toggle("clear", !x.background); // a checkerboard shows what is transparent
  };

  // ---- publication permissions ----
  const pub = publicationOf();
  const field = (key, label, attrs = {}) => {
    const inp = el("input.num", { value: pub[key] || "", ...attrs });
    inp.addEventListener("input", () => { pub[key] = inp.value.trim(); recheck(); });
    return el("div.field.wide", {}, el("label", {}, label), inp);
  };
  const accessSel = el("select.num", {}, ...ACCESS.map(([v, t]) => el("option", { value: v, selected: pub.openAccess === v }, t)));
  accessSel.addEventListener("change", () => { pub.openAccess = accessSel.value; recheck(); });
  const byIn = el("input.num", { value: reportPrefs.preparedBy, placeholder: "optional" });
  const uses = el("div.perm-uses");
  const terms = el("div.small.muted");
  const check = el("div.perm-check");
  const explain = el("div.perm-explain", { hidden: true },
    el("p", {}, "BioRender and similar services own their icons, so they issue a publication licence before you may publish. BioCraft's icons come from open libraries (Servier Medical Art, NIH BioArt, Reactome, Bioicons and others) under licences their authors chose, and those licences already let anyone publish them — commercially and in open-access articles too. There is nothing to buy or unlock, and BioCraft can't grant a licence for icons it doesn't own."),
    el("p", {}, "What journals ask for is the credit in the figure legend (CC BY and MIT require it) and sometimes a record of the third-party material in a figure. The licence & attribution report is that record: the credit to paste, every icon with its source, author and licence, what you changed and — with the journal details — whether the licences fit the article's licence. It is a convenience, not legal advice."));
  const what = el("a.perm-what", { onclick: () => { explain.hidden = !explain.hidden; } }, "What is this?");
  const repChk = el("input", { type: "checkbox", checked: reportPrefs.save });
  const details = el("details.perm-details", { open: !!(pub.journal || pub.openAccess) },
    el("summary", {}, "Publication details (optional)"),
    el("div.perm-fields", {},
      field("journal", "Journal", { placeholder: "e.g. Arthritis Research & Therapy" }),
      field("manuscript", "Manuscript", { placeholder: "optional" }),
      field("figureTitle", "Figure title", { placeholder: "e.g. Figure 2 | Synovial immune landscape" }),
      el("div.field.wide", {}, el("label", {}, "Article licence"), accessSel),
      field("date", "Publication", { type: "date" }),
      el("div.field.wide", {}, el("label", {}, "Prepared by"), byIn)));
  repChk.addEventListener("change", () => { details.style.display = repChk.checked ? "" : "none"; });
  details.style.display = repChk.checked ? "" : "none";
  const perm = el("section.perm", {},
    el("div.perm-head", {}, el("b", {}, "Publication permissions"), what),
    explain, uses, terms, check,
    el("label.qb-check", { title: "Saved beside the figure as <name>-licence.pdf, .md and .csv" }, repChk, "Save the licence & attribution report with this export"),
    details);

  const chip = (ok, text) => el("span.perm-chip" + (ok ? ".ok" : ".no"), {}, (ok ? "✓ " : "✕ ") + text);
  const showSummary = (sm) => {
    exportState.summary = sm;
    if (!sm) return;
    const shareAlike = sm.shareAlike.length > 0;
    uses.replaceChildren(chip(true, "Teaching"), chip(true, "Journals & books"), chip(!shareAlike, "Open access (CC BY)"), chip(sm.commercial, "Commercial use"));
    const t = [];
    if (!sm.icons) t.push("No library icons in this figure.");
    else {
      t.push(`${sm.icons} icon${sm.icons === 1 ? "" : "s"} from ${sm.sources} source${sm.sources === 1 ? "" : "s"}: ${sm.licences.map((l) => `${l.name} (${l.count})`).join(", ")}.`);
      t.push(sm.attribution ? "Credit required in the figure legend." : "No credit required (citing the sources is still good practice).");
      if (shareAlike) t.push(`Share-alike: ${sm.shareAlike.join(", ")}.`);
      if (sm.notices.length) t.push(`MIT/BSD notice needed for ${sm.notices.join(", ")}.`);
    }
    if (sm.own) t.push(`${sm.own} item${sm.own === 1 ? "" : "s"} of your own material: check its rights.`);
    terms.textContent = t.join(" ");
    check.replaceChildren(...(sm.check ? [el("span" + (sm.check.warn ? ".warn" : ".ok"), {}, (sm.check.warn ? "⚠ " : "✓ ") + sm.check.text)] : []));
  };
  let asked = 0;
  const recheck = debounce(async () => {
    const my = ++asked;
    try {
      const sm = await licenceSummary(exported().objects, pub);
      if (my === asked) showSummary(sm);
    } catch (e) {
      terms.textContent = "Could not read the licences: " + e.message;
    }
  }, 250);

  // ---- settings ----
  const seg = (box, key, items) => {
    box.replaceChildren(...items.map(([v, t]) =>
      el("button" + (prefs[key] === v ? ".on" : ""), { onclick: () => { const scope = key === "scope"; prefs[key] = v; draw(); if (scope) recheck(); } }, t)));
  };
  const draw = () => {
    seg(fmtBtns, "format", [["png", "PNG"], ["tiff", "TIFF"], ["pdf", "PDF (vector)"], ["svg", "SVG"]]);
    seg(dpiBtns, "dpi", [[150, "150 dpi"], [300, "300"], [600, "600"], [1200, "1200"]]);
    seg(bgBtns, "bg", [["white", "White"], ["transparent", "Transparent"]]);
    seg(scopeBtns, "scope", sel.length ? [["page", "Whole figure"], ["selection", `Selection (${sel.length})`]] : [["page", "Whole figure"]]);
    if (!sel.length) prefs.scope = "page";
    const raster = prefs.format === "png" || prefs.format === "tiff";
    rasterRows.style.display = raster ? "grid" : "none";
    const { w, h } = area();
    if (raster) {
      const px = (v) => Math.round((v / 96) * prefs.dpi);
      info.textContent = `${(w / MM).toFixed(1)} × ${(h / MM).toFixed(1)} mm → ${px(w).toLocaleString()} × ${px(h).toLocaleString()} px at ${prefs.dpi} dpi`;
    } else info.textContent = `${(w / MM).toFixed(1)} × ${(h / MM).toFixed(1)} mm, editable vector${prefs.format === "pdf" ? " with embedded fonts" : ""}`;
    showPreview();
  };
  draw();
  recheck();
  rasterRows.append(dpiBtns, bgBtns);
  const left = el("div.exp-left", {}, frame, el("label.qb-check", {}, grayChk, "Preview in greyscale"));
  const right = el("div.exp-right", {}, fmtBtns, rasterRows, scopeBtns, info, el("div.field.wide", {}, el("label", {}, "File name"), nameIn), perm);
  const body = el("div.exp-body", {}, left, right);
  const ok = await modal("Export figure", body, [{ label: "Cancel", value: false }, { label: "Export", primary: true, value: true }], { cls: "wide export" });
  if (url) URL.revokeObjectURL(url);
  if (!ok) return;
  reportPrefs.save = repChk.checked;
  reportPrefs.preparedBy = byIn.value.trim();
  saveReportPrefs();
  // the journal details belong to the figure: kept in it (saved with it) when they changed
  const clean = Object.fromEntries(Object.entries(pub).filter(([, v]) => v));
  if (JSON.stringify(clean) !== JSON.stringify(state.doc.publication || {})) {
    if (Object.keys(clean).length) state.doc.publication = clean;
    else delete state.doc.publication;
    state.dirty = true;
    bus.emit("doc");
  }

  const x = exported();
  const { w, h } = area();
  const name = nameIn.value || "figure";
  toast("Exporting…");
  let res;
  try {
    res = await api("export", { format: prefs.format, svg: x.svg, dpi: prefs.dpi, name, background: x.raster && x.background ? x.background : null });
    if (res.cancelled) return;
    if (!isDesktop) downloadResult(res);
  } catch (e) {
    return toast("Export failed: " + e.message, true);
  }
  let note = "";
  if (reportPrefs.save) {
    try {
      // beside the figure on desktop (fig.png → fig-licence.pdf/.md/.csv); downloads in a browser
      await licenceReport({ objects: x.objects, name, path: res.path, svg: x.svg, publication: pub, exportInfo: { format: prefs.format, dpi: prefs.dpi, widthMm: w / MM, heightMm: h / MM } });
      note = " and its licence report";
    } catch (e) {
      return toast(`Exported ${res.path || res.name}, but the licence report failed: ${e.message}`, true);
    }
  }
  toast(res.path ? `Saved ${res.path}${note}` : `Exported ${res.name}${note}`);
}
