// Download NIH BioArt Source vector illustrations (SVG) with their metadata into sources/nih-bioart/.
// https://bioart.niaid.nih.gov — free for any use; most entries Public Domain, some CC BY 4.0
// (licence recorded per entry). Every colour variant ("file group") that has an SVG is fetched.
//
//   node tools/fetch-nih-bioart.mjs [maxId=1100]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRetry, download, pool, writeJson, sleep } from "./lib/net.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "sources", "nih-bioart");
const BASE = "https://bioart.niaid.nih.gov";
const MAX_ID = +(process.argv[2] || 1100);
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** Join the Next.js RSC flight payload chunks embedded in the page. */
function flightPayload(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = re.exec(html))) {
    try { parts.push(JSON.parse('"' + m[1] + '"')); } catch {}
  }
  return parts.join("");
}

/** Return the balanced JSON value ({...} or [...]) that starts at index i. */
function balanced(s, i) {
  const open = s[i], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(i, j + 1);
  }
  return null;
}

function jsonAfter(s, key) {
  const i = s.indexOf(key);
  if (i < 0) return null;
  const start = i + key.length - 1; // key ends with "{" or "["
  try { return JSON.parse(balanced(s, start)); } catch { return null; }
}

const unescape = (t) => {
  try { return JSON.parse('"' + t + '"'); } catch { return t; }
};
const decode = (t) =>
  t == null ? t : unescape(t).replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function parseEntry(id, payload) {
  const title = /"variant":"h4","color":"heading","children":"((?:[^"\\]|\\.)*)"/.exec(payload)?.[1];
  if (!title) return null;
  // The label is "Licensing:" + NBSP, followed by a link whose text is the licence.
  const lic = /"Licensing:\s*",\[[^\]]*?"children":"([^"]+)"/.exec(payload)?.[1];
  // Only the __html block after the "Description" heading (the page also inlines error-page CSS).
  const descAt = payload.indexOf('"children":"Description"');
  const description =
    descAt < 0 ? null : /"dangerouslySetInnerHTML":\{"__html":"((?:[^"\\]|\\.)*)"\}/.exec(payload.slice(descAt))?.[1];
  // Labelled fields: label (uppercase subtitle) followed by its body1 value.
  const fields = {};
  const fre = /"opacity":0\.6\},"children":"([^"]+)"\}\],(\["\$","\$L[0-9a-z]+",null,\{"variant":"body1","color":"body","children":("(?:[^"\\]|\\.)*"|\[)|\[\[)/g;
  let m;
  while ((m = fre.exec(payload))) {
    const label = m[1];
    if (m[3] && m[3].startsWith('"')) fields[label] = JSON.parse(m[3]);
    else {
      // array of children (e.g. software list) — collect strings inside
      const arr = balanced(payload, m.index + m[0].length - 1);
      const strs = arr ? [...arr.matchAll(/"children":"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]) : [];
      fields[label] = strs.join(", ");
    }
  }
  const carousel = jsonAfter(payload, '"carouselItems":[') || [];
  const filemapping = jsonAfter(payload, '"filemapping":{') || {};
  const captions = {};
  for (const c of carousel) if (c.bioartFileGroupId != null) captions[c.bioartFileGroupId] = c.caption;
  const groups = Object.entries(filemapping).map(([gid, fmt]) => ({
    group: +gid,
    caption: captions[gid] || null,
    svg: fmt.SVG || null,
    png: fmt.PNG || null,
    formats: Object.keys(fmt),
  }));
  return {
    id,
    code: "BIOART-" + String(id).padStart(6, "0"),
    title: decode(title),
    license: lic || fields["License"] || null,
    description: decode(description),
    keywords: (fields["Keywords"] || "").split(",").map((s) => s.trim()).filter(Boolean),
    collection: fields["Collection"] || null,
    creator: fields["Creator"] || null,
    credit: fields["Credit"] || null,
    category: fields["Category"] || null,
    disciplines: fields["Scientific Disciplines And Research Areas"] || null,
    imageType: fields["Image Type"] || null,
    fields,
    groups,
    url: `${BASE}/bioart/${id}`,
  };
}

fs.mkdirSync(path.join(OUT, "meta"), { recursive: true });
const ids = Array.from({ length: MAX_ID }, (_, i) => i + 1);
const entries = [];
await pool(
  ids,
  4,
  async (id) => {
    const metaFile = path.join(OUT, "meta", `${id}.json`);
    let entry;
    if (fs.existsSync(metaFile)) entry = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    else {
      let html;
      try {
        html = await (await fetchRetry(`${BASE}/bioart/${id}`, { headers: { "user-agent": BROWSER_UA } }, 2)).text();
      } catch (e) {
        return; // missing id (500/404)
      }
      entry = parseEntry(id, flightPayload(html));
      if (!entry) return;
      writeJson(metaFile, entry);
      await sleep(150);
    }
    for (const g of entry.groups) {
      if (!g.svg) continue;
      const file = path.join(OUT, "svg", String(id), `${g.group}.svg`);
      try {
        await download(`${BASE}/api/bioarts/${id}/files/${g.svg}`, file, { headers: { "user-agent": BROWSER_UA } });
        g.file = path.relative(OUT, file).split(path.sep).join("/");
      } catch (e) {
        g.error = String(e.message || e);
      }
    }
    entries.push(entry);
  },
  { label: "nih pages", every: 50 }
);
entries.sort((a, b) => a.id - b.id);
writeJson(path.join(OUT, "manifest.json"), entries);
const svgCount = entries.reduce((a, e) => a + e.groups.filter((g) => g.file).length, 0);
console.log(`Done: ${entries.length} entries, ${entries.filter((e) => e.groups.some((g) => g.file)).length} with SVG, ${svgCount} SVG files`);
