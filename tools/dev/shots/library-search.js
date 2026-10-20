// tools/dev/shot.mjs page script: the library search box under every chip and filter. A search that finds
// nothing in the chosen category falls back to all categories (and says so); a source filter that hides
// everything offers "Search all sources". Run: node tools/dev/shot.mjs tools/dev/shots/library-search.js
const out = {};
const input = document.querySelector("#lib-search");
const tiles = () => [...document.querySelectorAll("#lib-grid .tile")].slice(0, 6).map((t) => t.dataset.id);
async function type(text) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(700);
  return { status: document.querySelector("#lib-status").textContent, tiles: tiles() };
}
const chip = (label) => [...document.querySelectorAll("#lib-cats .chip")].find((c) => c.textContent.startsWith(label));
await sleep(500);
out.all = await type("flow cytometry");
await shot("search-all", "#library");
for (const label of ["Immune", "Lab", "Methods", "★ Favourites", "Recent", "📁 My library"]) {
  const c = chip(label);
  if (!c) { out[label] = "no chip"; continue; }
  c.click();
  await sleep(500);
  out[label] = { chip: c.textContent, ...(await type("flow cytometry")), activeNow: document.querySelector("#lib-cats .chip.active")?.textContent };
  if (label === "Immune") await shot("search-fallback", "#library");
}
chip("All").click();
await sleep(400);
const pack = document.querySelector("#lib-pack");
pack.value = "healthicons";
pack.dispatchEvent(new Event("change"));
out.healthicons = await type("flow cytometry");
out.healthiconsLink = document.querySelector("#lib-status .linkbtn")?.textContent;
await shot("search-source", "#library");
document.querySelector("#lib-status .linkbtn")?.click();
await sleep(600);
out.afterLink = { pack: pack.value, status: document.querySelector("#lib-status").textContent, tiles: tiles() };
pack.value = "";
pack.dispatchEvent(new Event("change"));
out.chips = [...document.querySelectorAll("#lib-cats .chip")].map((c) => c.textContent).slice(0, 30);
return out;
