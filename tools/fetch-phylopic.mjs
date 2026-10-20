// Download PhyloPic silhouettes (https://www.phylopic.org, API v2 https://api-docs.phylopic.org/v2/)
// into sources/phylopic/. Only images whose licence allows any use with at most attribution:
// CC0 1.0, Public Domain Mark 1.0, CC BY 3.0 and CC BY 4.0 (no NC, SA or ND licences).
//
// Selection (at most MAX images): model and biomedically relevant organisms first (several
// silhouettes each), then medically relevant groups (rodents, primates, vectors, parasites,
// microbes), then broad coverage of living groups, fossil groups last; one silhouette per genus
// outside the priority list, taken round-robin over the groups.
//
//   node tools/fetch-phylopic.mjs [max=2500]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, download, pool, writeJson, sleep } from "./lib/net.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "sources", "phylopic");
const API = "https://api.phylopic.org";
const MAX = +(process.argv[2] || 2500);
const HEADERS = { accept: "application/vnd.phylopic.v2+json" };

const LICENSES = {
  "https://creativecommons.org/publicdomain/zero/1.0/": "CC0-1.0",
  "https://creativecommons.org/publicdomain/mark/1.0/": "PD",
  "https://creativecommons.org/licenses/by/3.0/": "CC-BY-3.0",
  "https://creativecommons.org/licenses/by/4.0/": "CC-BY-4.0",
};
const LICENSE_RANK = { "CC0-1.0": 0, PD: 1, "CC-BY-4.0": 2, "CC-BY-3.0": 3 };

// Model and biomedically important organisms: [scientific name, common name]
const PRIORITY = [
  ["Homo sapiens", "human"], ["Mus musculus", "house mouse"], ["Rattus norvegicus", "brown rat"], ["Rattus rattus", "black rat"],
  ["Mesocricetus auratus", "golden hamster"], ["Cricetulus griseus", "Chinese hamster"], ["Cavia porcellus", "guinea pig"],
  ["Oryctolagus cuniculus", "rabbit"], ["Macaca mulatta", "rhesus macaque"], ["Macaca fascicularis", "crab-eating macaque"],
  ["Callithrix jacchus", "common marmoset"], ["Pan troglodytes", "chimpanzee"], ["Sus scrofa", "pig"], ["Bos taurus", "cattle"],
  ["Ovis aries", "sheep"], ["Capra hircus", "goat"], ["Equus caballus", "horse"], ["Canis familiaris", "dog"], ["Canis lupus familiaris", "dog"], ["Canis lupus", "wolf"],
  ["Felis catus", "cat"], ["Mustela furo", "ferret"], ["Heterocephalus glaber", "naked mole-rat"], ["Peromyscus maniculatus", "deer mouse"],
  ["Meriones unguiculatus", "Mongolian gerbil"], ["Microtus", "vole"], ["Chinchilla lanigera", "chinchilla"], ["Monodelphis domestica", "grey short-tailed opossum"],
  ["Ornithorhynchus anatinus", "platypus"], ["Rousettus aegyptiacus", "Egyptian fruit bat"], ["Tupaia belangeri", "tree shrew"],
  ["Gallus gallus", "chicken"], ["Taeniopygia guttata", "zebra finch"], ["Coturnix japonica", "Japanese quail"], ["Columba livia", "rock pigeon"],
  ["Anas platyrhynchos", "mallard duck"], ["Xenopus laevis", "African clawed frog"], ["Xenopus tropicalis", "western clawed frog"],
  ["Ambystoma mexicanum", "axolotl"], ["Anolis carolinensis", "green anole"], ["Danio rerio", "zebrafish"], ["Oryzias latipes", "medaka"],
  ["Takifugu rubripes", "fugu"], ["Poecilia reticulata", "guppy"], ["Astyanax mexicanus", "Mexican tetra"], ["Nothobranchius furzeri", "turquoise killifish"],
  ["Gasterosteus aculeatus", "three-spined stickleback"], ["Salmo salar", "Atlantic salmon"], ["Petromyzon marinus", "sea lamprey"],
  ["Drosophila melanogaster", "fruit fly"], ["Caenorhabditis elegans", "nematode worm"], ["Apis mellifera", "honey bee"], ["Bombyx mori", "silkworm"],
  ["Tribolium castaneum", "red flour beetle"], ["Anopheles gambiae", "malaria mosquito"], ["Anopheles", "malaria mosquito"], ["Aedes aegypti", "yellow fever mosquito"],
  ["Aedes albopictus", "tiger mosquito"], ["Culex pipiens", "house mosquito"], ["Glossina", "tsetse fly"], ["Ixodes scapularis", "black-legged tick"], ["Ixodes ricinus", "castor bean tick"],
  ["Triatoma infestans", "kissing bug"], ["Pediculus humanus", "human louse"], ["Cimex lectularius", "bed bug"], ["Xenopsylla cheopis", "rat flea"],
  ["Daphnia pulex", "water flea"], ["Nematostella vectensis", "starlet sea anemone"], ["Hydra vulgaris", "hydra"], ["Schmidtea mediterranea", "planarian"],
  ["Schistosoma mansoni", "blood fluke"], ["Ascaris lumbricoides", "giant roundworm"], ["Aplysia californica", "California sea hare"], ["Octopus vulgaris", "common octopus"],
  ["Strongylocentrotus purpuratus", "purple sea urchin"], ["Ciona intestinalis", "sea squirt"], ["Branchiostoma", "lancelet"], ["Platynereis dumerilii", "ragworm"],
  ["Trichoplax adhaerens", "placozoan"], ["Arabidopsis thaliana", "thale cress"], ["Oryza sativa", "rice"], ["Zea mays", "maize"], ["Nicotiana benthamiana", "tobacco"],
  ["Nicotiana tabacum", "tobacco"], ["Physcomitrium patens", "moss"], ["Marchantia polymorpha", "liverwort"], ["Chlamydomonas reinhardtii", "green alga"],
  ["Medicago truncatula", "barrel medic"], ["Solanum lycopersicum", "tomato"], ["Triticum aestivum", "wheat"], ["Hordeum vulgare", "barley"], ["Glycine max", "soybean"],
  ["Saccharomyces cerevisiae", "baker's yeast"], ["Schizosaccharomyces pombe", "fission yeast"], ["Candida albicans", "yeast"], ["Aspergillus", "mould"],
  ["Neurospora crassa", "red bread mould"], ["Cryptococcus neoformans", "yeast"], ["Escherichia coli", "E. coli"], ["Staphylococcus aureus", "staph"],
  ["Mycobacterium tuberculosis", "tuberculosis bacterium"], ["Bacillus subtilis", "hay bacillus"], ["Pseudomonas aeruginosa", "bacterium"], ["Streptococcus", "bacterium"],
  ["Salmonella enterica", "bacterium"], ["Vibrio cholerae", "cholera bacterium"], ["Helicobacter pylori", "bacterium"], ["Listeria monocytogenes", "bacterium"],
  ["Plasmodium falciparum", "malaria parasite"], ["Plasmodium", "malaria parasite"], ["Toxoplasma gondii", "parasite"], ["Trypanosoma brucei", "sleeping sickness parasite"],
  ["Trypanosoma cruzi", "Chagas parasite"], ["Leishmania", "parasite"], ["Giardia", "parasite"], ["Entamoeba histolytica", "amoeba"], ["Dictyostelium discoideum", "slime mould"],
  ["Tetrahymena thermophila", "ciliate"], ["Paramecium", "ciliate"],
];

// Groups, most specific first: [PhyloPic clade, category label, tier]
// tier 2: medically relevant groups; 3: other living groups; 4: fossil groups
const GROUPS = [
  ["Primates", "Animals, Mammals, Primates", 2],
  ["Rodentia", "Animals, Mammals, Rodents", 2],
  ["Chiroptera", "Animals, Mammals, Bats", 2],
  ["Mammalia", "Animals, Mammals", 3],
  ["Aves", "Animals, Birds", 3],
  ["Pterosauria", "Animals, Fossil reptiles, Pterosaurs", 4],
  ["Dinosauria", "Animals, Fossil reptiles, Dinosaurs", 4],
  ["Ichthyosauria", "Animals, Fossil reptiles", 4],
  ["Sauropterygia", "Animals, Fossil reptiles", 4],
  ["Squamata", "Animals, Reptiles, Lizards and snakes", 3],
  ["Testudines", "Animals, Reptiles, Turtles", 3],
  ["Crocodylia", "Animals, Reptiles, Crocodilians", 3],
  ["Amphibia", "Animals, Amphibians", 3],
  ["Actinopterygii", "Animals, Fishes", 3],
  ["Chondrichthyes", "Animals, Fishes, Sharks and rays", 3],
  ["Trilobita", "Arthropods, Trilobites", 4],
  ["Diptera", "Arthropods, Insects, Flies and mosquitoes", 2],
  ["Phthiraptera", "Arthropods, Insects, Lice", 2],
  ["Siphonaptera", "Arthropods, Insects, Fleas", 2],
  ["Hemiptera", "Arthropods, Insects, True bugs", 3],
  ["Insecta", "Arthropods, Insects", 3],
  ["Acari", "Arthropods, Arachnids, Ticks and mites", 2],
  ["Arachnida", "Arthropods, Arachnids", 3],
  ["Crustacea", "Arthropods, Crustaceans", 3],
  ["Arthropoda", "Arthropods", 3],
  ["Nematoda", "Parasites, Nematodes", 2],
  ["Platyhelminthes", "Parasites, Flatworms", 2],
  ["Mollusca", "Animals, Molluscs", 3],
  ["Annelida", "Animals, Annelids", 3],
  ["Cnidaria", "Animals, Cnidarians", 3],
  ["Echinodermata", "Animals, Echinoderms", 3],
  ["Tunicata", "Animals, Tunicates", 3],
  ["Porifera", "Animals, Sponges", 3],
  ["Viridiplantae", "Plants", 3],
  ["Rhodophyta", "Plants, Red algae", 3],
  ["Fungi", "Fungi", 2],
  ["Bacteria", "Bacteria", 2],
  // (no "Archaea": in PhyloPic's tree that clade contains the eukaryotes)
  ["Amoebozoa", "Protists, Amoebae", 2],
  ["Alveolata", "Protists, Alveolates", 2],
  ["Stramenopiles", "Protists, Stramenopiles", 2],
  ["Rhizaria", "Protists, Rhizaria", 2],
  ["Excavata", "Protists, Excavates", 2],
  ["Discoba", "Protists, Excavates", 2],
  ["Metamonada", "Protists, Excavates", 2],
  ["Choanoflagellata", "Protists, Choanoflagellates", 2],
];

const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "silhouette";
const norm = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z -]+/g, " ").replace(/\s+/g, " ").trim();

async function api(p) {
  const url = API + p;
  const j = await fetchJson(url, { headers: HEADERS, timeoutMs: 90000 });
  await sleep(150);
  return j;
}

/** All pages of an /images listing (licence-filtered), cached per build; [] if over maxPages. */
async function listImages(build, extra, cacheKey, embedNode, maxPages = Infinity) {
  const dir = path.join(OUT, "api", `b${build}`);
  fs.mkdirSync(dir, { recursive: true });
  const cacheFile = path.join(dir, `${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const q = `build=${build}&filter_license_nc=false&filter_license_sa=false${extra}`;
  const head = await api(`/images?${q}`);
  if ((head.totalPages || 0) > maxPages) {
    console.log(`  ${cacheKey}: ${head.totalItems} images — too broad for a group, skipped`);
    writeJson(cacheFile, []);
    return [];
  }
  const pages = Array.from({ length: head.totalPages || 0 }, (_, i) => i);
  const results = await pool(
    pages,
    2,
    async (pg) => {
      const j = await api(`/images?${q}&page=${pg}&embed_items=true${embedNode ? "&embed_specificNode=true" : ""}`);
      return (j._embedded?.items || []).map((it) => (embedNode ? slim(it) : it.uuid));
    },
    { label: cacheKey, every: 25 }
  );
  const failed = results.filter((r) => !Array.isArray(r)).length;
  const items = results.flatMap((r) => (Array.isArray(r) ? r : []));
  if (!failed) writeJson(cacheFile, items);
  else console.log(`  ${cacheKey}: ${failed} pages failed (not cached)`);
  return items;
}

function slim(it) {
  const L = it._links || {};
  const node = it._embedded?.specificNode;
  const names = (node?.names || []).map((n) => ({ cls: n[0]?.class, text: n.filter((p) => p.class !== "citation").map((p) => p.text).join(" ") }));
  return {
    uuid: it.uuid,
    license: L.license?.href || "",
    vector: L.vectorFile?.href || "",
    vectorSize: L.vectorFile?.sizes || "",
    attribution: it.attribution || "",
    contributor: L.contributor?.title || "",
    node: node?.uuid || L.specificNode?.href?.match(/nodes\/([0-9a-f-]+)/)?.[1] || "",
    title: L.specificNode?.title || "",
    scientific: names.find((n) => n.cls === "scientific")?.text || L.specificNode?.title || "",
    vernacular: [...new Set(names.filter((n) => n.cls === "vernacular").map((n) => n.text))].slice(0, 8),
    modified: it.modified || it.created || "",
  };
}

/** The node named `name`; when several nodes carry the name, the one with the most images. */
async function findClade(build, name) {
  const j = await api(`/nodes?build=${build}&filter_name=${encodeURIComponent(norm(name))}&page=0&embed_items=true`);
  const hits = [];
  for (const n of j._embedded?.items || []) {
    const sci = (n.names || []).filter((x) => x[0]?.class === "scientific").map((x) => x.filter((p) => p.class !== "citation").map((p) => p.text).join(" "));
    if (sci.some((s) => norm(s) === norm(name))) hits.push(n.uuid);
  }
  if (hits.length <= 1) return hits[0] || null;
  let best = null, most = -1;
  for (const uuid of hits.slice(0, 6)) {
    const h = await api(`/images?build=${build}&filter_clade=${uuid}&filter_license_nc=false&filter_license_sa=false`);
    if ((h.totalItems || 0) > most) { most = h.totalItems || 0; best = uuid; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });
const root = await api("/");
const build = root.build;
console.log(`PhyloPic build ${build}`);

const all = await listImages(build, "", "all", true);
console.log(`  ${all.length} images allow reuse without NC/SA`);

// clade membership
const groupOf = new Map(); // image uuid → group index (first, i.e. most specific, wins)
const cladeFile = path.join(OUT, "api", `b${build}`, "clades.json");
const clades = fs.existsSync(cladeFile) ? JSON.parse(fs.readFileSync(cladeFile, "utf8")) : {};
for (const [name] of GROUPS) if (!(name in clades)) clades[name] = await findClade(build, name);
writeJson(cladeFile, clades);
for (let gi = 0; gi < GROUPS.length; gi++) {
  const [name] = GROUPS[gi];
  if (!clades[name]) { console.log(`  clade ${name}: not found`); continue; }
  const ids = await listImages(build, `&filter_clade=${clades[name]}`, `clade-${name}`, false, 50);
  if (ids.length > 50 * 48) { console.log(`  clade ${name}: ${ids.length} images — too broad for a group, skipped`); continue; }
  let n = 0;
  for (const id of ids) if (!groupOf.has(id)) { groupOf.set(id, gi); n++; }
  console.log(`  clade ${name}: ${ids.length} images (${n} new)`);
}

// candidates
const prio = PRIORITY.map(([sci, common]) => ({ sci, common, key: norm(sci) }));
const cands = [];
const skipped = { license: 0, noVector: 0 };
for (const im of all) {
  const lic = LICENSES[im.license];
  if (!lic) { skipped.license++; continue; }
  if (!im.vector) { skipped.noVector++; continue; }
  const sciN = norm(im.scientific || im.title);
  // longest matching priority name (species before genus)
  const p = prio.filter((p) => sciN === p.key || sciN.startsWith(p.key + " ")).sort((a, b) => b.key.length - a.key.length)[0];
  const gi = groupOf.get(im.uuid);
  const group = gi != null ? GROUPS[gi] : null;
  const tier = p ? 1 : group ? group[2] : 4;
  cands.push({ ...im, lic, prio: p, gi: gi ?? -1, tier, genus: sciN.split(" ")[0] || sciN });
}
const better = (a, b) => LICENSE_RANK[a.lic] - LICENSE_RANK[b.lic] || String(b.modified).localeCompare(String(a.modified));

const chosen = [];
const take = (im) => { if (chosen.length < MAX) chosen.push(im); };
// tier 1: up to 6 per priority taxon
const byPrio = new Map();
for (const c of cands.filter((c) => c.tier === 1)) (byPrio.get(c.prio.key) || byPrio.set(c.prio.key, []).get(c.prio.key)).push(c);
for (const p of prio) {
  const list = (byPrio.get(p.key) || []).sort(better);
  const perNode = new Map();
  let k = 0;
  for (const c of list) {
    if (k >= 6) break;
    const n = perNode.get(c.node) || 0;
    if (n >= 3) continue;
    perNode.set(c.node, n + 1);
    take(c); k++;
  }
}
const chosenIds = new Set(chosen.map((c) => c.uuid));
// tiers 2–4: one per genus, round-robin over groups so that every group is represented
for (const tier of [2, 3, 4]) {
  const pool2 = cands.filter((c) => c.tier === tier && !chosenIds.has(c.uuid)).sort(better);
  const seen = new Set(chosen.map((c) => c.genus));
  const byGroup = new Map();
  for (const c of pool2) {
    const key = c.genus;
    if (seen.has(key)) continue;
    seen.add(key);
    (byGroup.get(c.gi) || byGroup.set(c.gi, []).get(c.gi)).push(c);
  }
  const queues = [...byGroup.values()];
  let added = 0;
  for (let round = 0; queues.some((q) => q.length) && chosen.length < MAX; round++)
    for (const q of queues) if (q.length && chosen.length < MAX) { const c = q.shift(); chosen.push(c); chosenIds.add(c.uuid); added++; }
  console.log(`  tier ${tier}: +${added} (${chosen.length} chosen)`);
}

// download vector files
const failures = [];
await pool(
  chosen,
  4,
  async (c) => {
    const file = path.join(OUT, "svg", `${c.uuid}.svg`);
    try {
      await download(c.vector, file);
      c.file = `svg/${c.uuid}.svg`;
    } catch (e) {
      failures.push({ uuid: c.uuid, error: String(e.message || e) });
    }
  },
  { label: "silhouettes", every: 250 }
);

const used = new Set();
const manifest = chosen
  .filter((c) => c.file)
  .map((c) => {
    const group = c.gi >= 0 ? GROUPS[c.gi] : null;
    const sci = c.scientific || c.title;
    const common = c.prio && norm(c.prio.sci) === norm(sci) ? c.prio.common : c.prio && c.tier === 1 && sci.split(" ").length === 1 ? c.prio.common : "";
    let slug = slugify(sci);
    if (used.has(slug)) slug = slugify(`${sci}-${c.uuid.slice(0, 8)}`);
    used.add(slug);
    const label = group ? group[1] : "Organisms";
    const author = c.attribution || c.contributor || "PhyloPic contributor";
    return {
      slug,
      name: common ? `${sci} (${common})` : sci,
      file: c.file,
      category: label,
      tags: [...new Set([c.genus && c.genus[0].toUpperCase() + c.genus.slice(1), ...label.split(", "), common, ...c.vernacular, c.tier === 1 ? "model organism" : "", "silhouette"].filter((t) => t && t.length < 60))],
      author,
      license: c.lic,
      source_url: `https://www.phylopic.org/images/${c.uuid}`,
      description: `Silhouette of ${sci}${common ? ` (${common})` : ""} from PhyloPic.`,
      style: "glyph",
      phylopic: { uuid: c.uuid, node: c.node, tier: c.tier },
    };
  });
writeJson(path.join(OUT, "manifest.json"), manifest);
writeJson(path.join(OUT, "pack.json"), {
  id: "phylopic",
  name: "PhyloPic",
  description: "Silhouettes of organisms: model organisms, vectors and parasites, microbes, plants and animals across the tree of life",
  url: "https://www.phylopic.org",
  credit: "PhyloPic (phylopic.org); CC0 / public domain images need no credit, CC BY images are credited to their authors",
});
if (failures.length) writeJson(path.join(OUT, "failures.json"), failures);
// silhouettes downloaded by an earlier run that the selection no longer includes
const keep = new Set(manifest.map((m) => path.basename(m.file)));
let pruned = 0;
for (const f of fs.readdirSync(path.join(OUT, "svg"))) if (!keep.has(f)) { fs.unlinkSync(path.join(OUT, "svg", f)); pruned++; }
if (pruned) console.log(`  removed ${pruned} silhouettes no longer selected`);
const lic = {};
for (const m of manifest) lic[m.license] = (lic[m.license] || 0) + 1;
const tiers = {};
for (const m of manifest) tiers[m.phylopic.tier] = (tiers[m.phylopic.tier] || 0) + 1;
console.log(`Done: ${manifest.length} silhouettes (${failures.length} failed); skipped ${skipped.license} other licences, ${skipped.noVector} without vector file`);
console.log("  licences:", lic, " tiers:", tiers);
