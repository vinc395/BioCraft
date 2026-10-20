// Licences and credits: which library icons a figure draws, what was changed in each, the
// figure-legend credit, and the licence & attribution report. The report itself (PDF, Markdown,
// CSV) is written by the app (app/src/licence.rs), which the MCP tool and the command line share;
// the walk, the change list and the legend below mirror that file word for word.

import { api, downloadResult, isDesktop } from "./api.js";
import { state, assetsUsed, endPreviews } from "./model.js";
import { documentSvg } from "./render.js";
import { hasLabels } from "./labels.js";
import { toast } from "./util.js";

const add = (arr, x) => {
  if (!arr.includes(x)) arr.push(x);
};

/* ---------- what the figure uses ---------- */

/** What was changed from the library drawing (CC BY asks for changes to be indicated). Moving,
 *  resizing, rotating and flipping are not changes to the drawing. */
export function iconChanges(o, asset, fx = []) {
  const c = [];
  const tint = typeof o.tint === "string" ? o.tint : "";
  const preset = typeof o.preset === "string" ? o.preset : "";
  const parts = Array.isArray(o.slotColors) && o.slotColors.some((x) => typeof x === "string" && x);
  // the colour recipe before any saturation/lightness change
  const recipe = o.baseColors && typeof o.baseColors === "object" ? o.baseColors : o.colors;
  const mapped = !!recipe && typeof recipe === "object" && Object.entries(recipe).some(([k, v]) => typeof v === "string" && v.toLowerCase() !== k.toLowerCase());
  if (tint === "gray" || preset === "gray") c.push("greyscale");
  else if (preset && preset !== "original") c.push("recoloured (style preset)");
  else if (tint) c.push("colour overlay");
  else if (parts) c.push("recoloured parts");
  else if (mapped) c.push("recoloured");
  if (typeof o.saturation === "number" && o.saturation !== 100) c.push("saturation changed");
  if (typeof o.lightness === "number" && o.lightness !== 0) c.push("lightness changed");
  if (asset && hasLabels(asset)) {
    if (o.labels === "hidden") c.push("built-in labels hidden");
    else if (o.labels === "detached") c.push("built-in labels made editable");
  }
  for (const f of fx) add(c, f);
  return c;
}

/** Every drawn use of a library asset ({asset, place, changes}) and the placed pictures' names.
 *  Hidden objects are left out: they are not in the exported image. */
export function iconUses(objects, assets = state.doc.assets) {
  const uses = [], pics = [];
  const walk = (objs, inherited) => {
    for (const o of objs || []) {
      if (o.hidden) continue;
      // a glow or transparency on a group reaches every icon in it
      const fx = [...inherited];
      if (o.glow) add(fx, "glow added");
      if (typeof o.opacity === "number" && o.opacity < 1) add(fx, "made transparent");
      const a = typeof o.asset === "string" ? o.asset : "";
      if (o.type === "icon" && a) uses.push({ asset: a, place: "icon", changes: iconChanges(o, assets[a], fx) });
      else if (o.type === "membrane" && o.brush === "icon" && a) uses.push({ asset: a, place: "icon brush", changes: iconChanges(o, null, fx) });
      else if (o.type === "legend") {
        for (const r of o.rows || []) if (typeof r.asset === "string" && r.asset) uses.push({ asset: r.asset, place: "legend", changes: iconChanges(r, assets[r.asset], fx) });
      } else if (o.type === "image") pics.push(o.name?.trim() ? o.name : "Picture");
      else if (o.type === "group") walk(o.children, fx);
    }
  };
  walk(objects, []);
  return { uses, pics };
}

/** Not from the library: My library uploads and SVGs placed straight onto the canvas. */
export const isOwn = (m) => m.pack === "user" || m.pack === "file" || m.license === "USER";

const RECOLOURS = ["greyscale", "recoloured (style preset)", "colour overlay", "recoloured parts"];

/** pack → {name, credit, url, items: [{id, meta, uses, places, changes, adapted}]}, in drawing order. */
export function creditsInfo(objects = state.doc.objects) {
  const assets = state.doc.assets;
  const byPack = new Map();
  const items = new Map();
  for (const u of iconUses(objects, assets).uses) {
    const asset = assets[u.asset];
    if (!asset || typeof asset !== "object") continue;
    const m = asset.meta || {};
    let it = items.get(u.asset);
    if (!it) {
      it = { id: u.asset, meta: m, uses: 0, places: [], changes: [] };
      items.set(u.asset, it);
      const pack = m.pack || "";
      if (!byPack.has(pack)) byPack.set(pack, { name: m.packName || pack, credit: m.packCredit, url: m.packUrl, items: [] });
      byPack.get(pack).items.push(it);
    }
    it.uses++;
    add(it.places, u.place);
    for (const c of u.changes) add(it.changes, c);
  }
  for (const it of items.values()) {
    // a legend row copies its icon's colours: "recoloured" says nothing more than the colour change
    if (it.changes.some((c) => RECOLOURS.includes(c))) it.changes = it.changes.filter((c) => c !== "recoloured");
    // CC BY asks for changes to be indicated: these are credited as "adapted from"
    it.adapted = it.changes.length > 0 && (it.meta.license || "").startsWith("CC-BY");
  }
  return byPack;
}

/** CC BY 4.0, CC BY-SA 4.0, CC0 1.0, public domain, MIT. */
export function shortLicence(id = "") {
  if (id === "PD") return "public domain";
  if (id.startsWith("CC-")) {
    const parts = id.slice(3).split("-");
    const v = parts.length && /^\d+(\.\d+)?$/.test(parts[parts.length - 1]) ? parts.pop() : null;
    return `CC ${parts.join("-")}${v ? " " + v : ""}`;
  }
  return id.replace(/-/g, " ");
}

/** The figure-legend credit line (licence.rs `legend`). */
export function legendText(objects) {
  const parts = [];
  for (const [pack, g] of creditsInfo(objects)) {
    const items = g.items.filter((it) => !isOwn(it.meta));
    if (!items.length) continue;
    const name = (it) => it.meta.name || it.id;
    const uniq = (v) => [...new Set(v)];
    if (pack === "nih") {
      const urls = uniq(items.map((it) => (it.meta.source_url || "").replace(/^https?:\/\//, ""))).filter(Boolean);
      parts.push(`illustrations from NIAID NIH BioArt Source (${urls.join(", ")})`);
    } else if (pack === "servier") {
      const lics = uniq(items.map((it) => (it.meta.license || "").replace("CC-BY-", "")));
      const plain = uniq(items.filter((it) => !it.adapted).map(name));
      const adapted = uniq(items.filter((it) => it.adapted).map(name));
      const names = [];
      if (plain.length) names.push(plain.join(", "));
      if (adapted.length) names.push(`adapted from ${adapted.join(", ")}`);
      parts.push(`Servier Medical Art (smart.servier.com), licensed under CC BY ${lics.join("/")} (${names.join("; ")})`);
    } else if (pack === "biocanvas") {
      parts.push("BioCraft Originals (CC0)");
    } else {
      const group = items[0].meta.packName || items[0].meta.pack || "";
      const by = [];
      for (const it of items) {
        const author = it.meta.author || group, lic = it.meta.license || "";
        let b = by.find((x) => x.author === author && x.lic === lic && x.adapted === it.adapted);
        if (!b) by.push((b = { author, lic, adapted: it.adapted, names: [] }));
        add(b.names, name(it));
      }
      parts.push(`${group}: ${by.map((b) => `${b.adapted ? "adapted from " : ""}${b.names.join(", ")} by ${b.author} (${shortLicence(b.lic)})`).join("; ")}`);
    }
  }
  return parts.length ? `Created with BioCraft using ${parts.join("; ")}.` : "Figure created with BioCraft.";
}

/* ---------- the report ---------- */

const KEY = "biocraft.licenceReport";

/** {save: write a report with every export, preparedBy: name printed on it}, remembered here. */
export const reportPrefs = (() => {
  try {
    return { save: true, preparedBy: "", ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { save: true, preparedBy: "" };
  }
})();

export function saveReportPrefs() {
  try {
    localStorage.setItem(KEY, JSON.stringify(reportPrefs));
  } catch {
    /* storage unavailable: remembered for this session only */
  }
}

/** The figure as saved, limited to `objects` and the assets they use (what the app's licence code reads). */
export function figureJson(objects = state.doc.objects) {
  const d = state.doc;
  const used = assetsUsed(objects);
  const assets = Object.fromEntries(Object.entries(d.assets).filter(([k]) => used.has(k)));
  return JSON.stringify({ ...d, objects, app: "BioCraft", version: 1, assets });
}

/** Where the figure will be published: {journal, manuscript, figureTitle, openAccess, date}, kept in the figure. */
export const publicationOf = (doc = state.doc) => ({ journal: "", manuscript: "", figureTitle: "", openAccess: "", date: "", ...(doc.publication || {}) });

/**
 * What the icons' licences allow and ask for `objects` (and, with publication details, whether they
 * fit the journal): {icons, sources, licences, attribution, commercial, shareAlike, notices, changed,
 * own, legend, check: {warn, text} | null}. Worded by the app, exactly as the report words it.
 */
export function licenceSummary(objects = state.doc.objects, publication = publicationOf()) {
  return api("licence.summary", { content: figureJson(objects), publication });
}

/**
 * Write the licence & attribution report for `objects`. Desktop: beside the exported figure at
 * `path` (fig.png → fig-licence.pdf/.md/.csv), or where the save dialog says; browser: downloads.
 * `exportInfo` = {format, dpi, widthMm, heightMm} of what was exported; `svg` the exported figure
 * (shown on the report's first page). Null when cancelled.
 */
export async function licenceReport({ objects = state.doc.objects, name = "figure", path = null, exportInfo = null, svg = null, publication = publicationOf() } = {}) {
  endPreviews();
  const res = await api("licence.report", {
    content: figureJson(objects), name, path: path || null, export: exportInfo, svg: svg || documentSvg(state.doc, { objects }), publication, preparedBy: reportPrefs.preparedBy || null,
  });
  if (res.cancelled) return null;
  if (!isDesktop) for (const f of res.downloads || []) downloadResult(f);
  return res;
}

/** File ▸ Export licence report… and the Credits tab's button: a report for the whole figure. */
export async function exportLicenceReport() {
  const name = (state.filePath || "figure").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "figure";
  try {
    const res = await licenceReport({ name });
    if (res) toast(res.files?.length ? `Saved ${res.files[0]} (+ .md and .csv)` : "Licence report downloaded (PDF, Markdown, CSV)");
  } catch (e) {
    toast("Licence report failed: " + e.message, true);
  }
}
