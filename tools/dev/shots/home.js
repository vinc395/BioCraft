// tools/dev/shot.mjs page script: the home page (figure gallery) and saving as you work, driven as a
// user would. Run it on a sandbox page with the gallery shown and a throwaway figures folder on the
// server (BIOCRAFT_FIGURES) holding the five sample figures:
//   node tools/dev/shot.mjs tools/dev/shots/home.js --base "http://localhost:8791/?sandbox&home" --out <dir>
const API = await import("/js/api.js");
if (!API.sandbox) throw new Error("run this on a ?sandbox page");
const H = await import("/js/home.js");
const errors = [];
window.addEventListener("error", (e) => errors.push("error: " + e.message));
window.addEventListener("unhandledrejection", (e) => errors.push("rejection: " + (e.reason?.message || e.reason)));
const checks = [];
const ok = (cond, what, detail) => {
  checks.push((cond ? "ok   " : "FAIL ") + what + (!cond && detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 300) : ""));
  return cond;
};
const until = async (fn, ms = 6000) => {
  for (let t = 0; t < ms; t += 40) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  return null;
};
const home = () => document.querySelector("#home");
const cards = () => [...home().querySelectorAll(".home-files .card:not(.current)")];
const names = () => cards().map((c) => c.querySelector(".card-name").textContent);
const cardNamed = (n) => cards().find((c) => c.querySelector(".card-name").textContent === n);
const side = (label) => [...home().querySelectorAll(".side-item")].find((b) => b.querySelector(".side-label")?.textContent === label);
const menuItem = (label) => [...document.querySelectorAll(".dropdown .item")].find((i) => i.textContent.trim().startsWith(label));
const docName = () => document.querySelector("#doc-name").textContent;
const saveState = () => document.querySelector("#save-state").textContent;
const steps = () => M.takeHistory().stack.length;
const saved = () => until(() => M.state.galleryId && !M.state.dirty && saveState() === "Saved");
const button = (m, label) => [...m.querySelectorAll("button")].find((b) => b.textContent === label);
const answer = async (value, label) => {
  const m = await until(() => document.querySelector(".modal"));
  const inp = m.querySelector("input");
  inp.value = value;
  button(m, label).click();
  await until(() => !document.querySelector(".modal"));
};
const listed = async (folder) => (await API.api("gallery.list", {})).files.filter((f) => f.folder === folder).map((f) => f.name);
const toastEl = document.querySelector("#toast");
const toasts = [];
new MutationObserver(() => toasts.push(toastEl.textContent)).observe(toastEl, { childList: true, subtree: true, characterData: true });

// start: the home page over the editor, every figure with a preview
await until(() => home() && !home().hidden && cards().length);
ok(home() && !home().hidden, "Home: shown at start (asked for with ?home)");
ok(/What would you like to create today/.test(home().textContent), "Home: the create banner");
ok(cards().length === 5, "My files: every figure in the figures folder and its project folders", names());
ok(cards().every((c) => c.querySelector(".card-thumb img")?.src.startsWith("data:image/")), "My files: a preview of every canvas");
ok(side("RA synovium paper")?.querySelector(".side-count")?.textContent === "2" && side("Methods figures"), "Sidebar: project folders with their counts");
await shot("home-light", null);

// folders, search, sort, list
side("RA synovium paper").click();
await frame();
ok(home().querySelector(".home-h").textContent === "RA synovium paper" && cards().length === 2, "Folder: only its figures", names());
side("My files").click();
const search = home().querySelector(".home-search");
search.value = "olink";
search.dispatchEvent(new Event("input"));
ok(names().join() === "Olink PEA", "Search: across all folders", names());
search.value = "";
search.dispatchEvent(new Event("input"));
const sort = home().querySelector(".home-sort");
sort.value = "name";
sort.dispatchEvent(new Event("change"));
ok(names()[0] === "Figure 1 Synovial immune landscape" && names().at(-1) === "Tumour microenvironment", "Sort: by name", names());
home().querySelector('.home-layout[data-layout="list"]').click();
ok(home().querySelector(".home-files").classList.contains("list") && cards()[0].querySelector(".card-date").textContent.includes("mm"), "Layout: list with folder and size", cards()[0]?.textContent);
home().querySelector('.home-layout[data-layout="grid"]').click();

// a new folder, and a new figure in it: its file is made at its first change
side("New folder").click();
await answer("Grant figures", "Create");
await until(() => home().querySelector(".home-h").textContent === "Grant figures");
ok(side("Grant figures")?.classList.contains("on"), "New folder: created and opened");
home().querySelector(".home-create").click();
await until(() => menuItem("Single-column figure"));
menuItem("Single-column figure").click();
await until(() => home().hidden);
ok(home().hidden && M.state.galleryId == null && M.state.doc.width === 89 && docName() === "Untitled figure", "Create new: a single-column page in the editor", [M.state.galleryId, M.state.doc.width, docName()]);
ok(toasts.some((t) => t.includes("saves itself in Grant figures")), "…which says where it will be saved", toasts);
ok((await listed("Grant figures")).length === 0, "…and no file until something is on it");

// saving as you work: no Save needed
await A.placeIcon("biocanvas/macrophage");
ok(saveState() === "Saving…", "Top bar: Saving… right after a change", saveState());
await A.placeIcon("biocanvas/b-cell");
await saved();
ok(M.state.galleryId === "Grant figures/Untitled figure.biocraft" && saveState() === "Saved", "Saved as you work: the figure's file made in its folder", [M.state.galleryId, saveState()]);
ok((await listed("Grant figures")).join() === "Untitled figure", "…and on Home", await listed("Grant figures"));
M.state.doc.objects.push({ id: U.uid(), type: "text", x: 30, y: 12, w: 320, h: 34, rot: 0, text: "Immune cells in  RA\nsynovium", fontSize: 26, fontFamily: "Arial", color: "#1c2733", align: "left", bold: true, italic: false });
C.renderDoc();
M.commit();
await saved();
ok(steps() === 4 && M.canUndo(), "Undo: a step for every change", steps());
await shot("editor-saved", "#topbar");

// Home: "Name your file", offering the figure's title
document.querySelector("#btn-home").click();
const dlg = await until(() => document.querySelector(".modal.name-file"));
ok(dlg?.querySelector("h2").textContent === "Name your file" && dlg.querySelector("input").value === "Untitled figure" && home().hidden, "Home button: Name your file first, as it is still Untitled figure");
const sug = dlg?.querySelector(".name-suggest");
ok(sug?.textContent.includes("“Immune cells in RA synovium”"), "…offering the figure's title (its largest text, on one line)", sug?.textContent);
await shot("name-your-file", null);
sug.click();
ok(dlg.querySelector("input").value === "Immune cells in RA synovium", "…which fills in the name");
button(dlg, "Save").click();
await until(() => !home().hidden);
ok(M.state.galleryId === "Grant figures/Immune cells in RA synovium.biocraft" && docName() === "Immune cells in RA synovium", "Save: the file renamed, then Home", M.state.galleryId);
side("Grant figures").click();
await until(() => cards().length === 1);
const c1 = cards()[0];
ok(c1.classList.contains("open") && names()[0] === "Immune cells in RA synovium" && c1.querySelector("img").src.startsWith("data:image/jpeg"), "Home: the figure under its new name, with a fresh preview, marked open", [names(), c1.className]);
ok(!home().querySelector(".card.current"), "Home: no separate unsaved card — the open figure is saved");

// back to it: the same figure, every undo step still there
const doc0 = M.state.doc;
c1.click();
await until(() => home().hidden);
ok(M.state.doc === doc0 && steps() === 4, "Back from Home: the same figure, with its undo steps", steps());
M.undo();
ok(!M.state.doc.objects.some((o) => o.type === "text"), "Undo after Home: the title comes off");
await saved();
M.redo();
await saved();
ok(M.state.doc.objects.some((o) => o.type === "text") && !M.state.dirty, "…and redo puts it back, saved again");

// Home again: a named figure isn't asked about
document.querySelector("#btn-home").click();
await until(() => !home().hidden);
ok(!document.querySelector(".modal"), "Home again: straight there, as the figure has a name");

// another figure, then back: the first keeps its undo history
side("Methods figures").click();
await until(() => cards().length === 2);
cardNamed("Olink PEA").click();
await until(() => home().hidden && M.state.galleryId === "Methods figures/Olink PEA.biocraft");
ok(!M.canUndo(), "Another figure: its own undo history");
await A.placeIcon("biocanvas/plasma-cell");
await saved();
document.querySelector("#topbar .brand").click(); // (the logo is a way home too)
await until(() => !home().hidden);
side("Grant figures").click();
await until(() => cards().length === 1);
cards()[0].click();
await until(() => home().hidden && M.state.galleryId === "Grant figures/Immune cells in RA synovium.biocraft");
ok(steps() === 4 && M.canUndo() && !M.canRedo(), "Back to the first figure: its undo history kept while the other was open", steps());
M.undo();
ok(!M.state.doc.objects.some((o) => o.type === "text"), "…and it undoes");
M.redo();
await saved();

// renamed on Home while another figure is open: its history follows the file
document.querySelector("#btn-home").click();
await until(() => !home().hidden);
side("Methods figures").click();
await until(() => cards().length === 2);
cardNamed("Olink PEA").click();
await until(() => home().hidden && M.state.galleryId === "Methods figures/Olink PEA.biocraft");
ok(steps() === 2, "Olink PEA again: its own history kept too", steps());
document.querySelector("#btn-home").click();
await until(() => !home().hidden);
side("Grant figures").click();
await until(() => cards().length === 1);
cards()[0].querySelector(".card-more").click();
await until(() => menuItem("Rename"));
menuItem("Rename").click();
await answer("Grant figure 1 — immune cells", "Rename");
await until(() => names()[0] === "Grant figure 1 — immune cells");
cards()[0].click();
await until(() => home().hidden && M.state.galleryId === "Grant figures/Grant figure 1 — immune cells.biocraft");
ok(steps() === 4 && docName() === "Grant figure 1 — immune cells", "Renamed on Home: opened again, its undo history came along", [steps(), docName()]);

// Skip keeps "Untitled figure", and isn't asked again
document.querySelector("#btn-home").click();
await until(() => !home().hidden);
side("My files").click();
home().querySelector(".home-create").click();
await until(() => menuItem("Square"));
menuItem("Square").click();
await until(() => home().hidden);
await A.placeIcon("biocanvas/fibroblast");
await saved();
ok(M.state.galleryId === "Untitled figure.biocraft", "Create new from My files: saved there", M.state.galleryId);
document.querySelector("#topbar .brand").click();
const dlg2 = await until(() => document.querySelector(".modal.name-file"));
ok(dlg2 && !dlg2.querySelector(".name-suggest"), "Name your file: no title to offer when the figure has none");
button(dlg2, "Skip").click();
await until(() => !home().hidden);
ok(M.state.galleryId === "Untitled figure.biocraft", "Skip: the name stays");
home().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
ok(home().hidden, "Esc: back to the editor");
document.querySelector("#btn-home").click();
await until(() => !home().hidden);
ok(!document.querySelector(".modal"), "…and leaving again doesn't ask a second time");

// closing the question (Esc) stays in the editor
home().querySelector(".home-create").click();
await until(() => menuItem("Slide"));
menuItem("Slide").click();
await until(() => home().hidden);
await A.placeIcon("biocanvas/t-cell");
await saved();
ok(M.state.galleryId === "Untitled figure 2.biocraft", "A second untitled figure: numbered", M.state.galleryId);
document.querySelector("#btn-home").click();
const dlg3 = await until(() => document.querySelector(".modal.name-file"));
dlg3.querySelector("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await until(() => !document.querySelector(".modal"));
await frame();
ok(home().hidden && M.state.galleryId === "Untitled figure 2.biocraft", "Esc on Name your file: stay in the editor");

// Ctrl+S: saved already, so it only offers the name, saying why
toasts.length = 0;
document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
const dlg4 = await until(() => document.querySelector(".modal.name-file"));
ok(/saves itself in My files as you work/.test(dlg4?.textContent || ""), "Ctrl+S on an untitled figure: Name your file, saying it saves itself", dlg4?.textContent);
dlg4.querySelector("input").value = "Quick test";
button(dlg4, "Save").click();
await until(() => toasts.includes("Saved"));
ok(M.state.galleryId === "Quick test.biocraft" && toasts.includes("Saved"), "…named and saved", [M.state.galleryId, toasts]);

// the name in the top bar renames the figure
document.querySelector("#doc-name").click();
await answer("Quick test renamed", "Rename");
await until(() => M.state.galleryId === "Quick test renamed.biocraft");
ok(docName() === "Quick test renamed" && M.state.galleryId === "Quick test renamed.biocraft", "Top bar: click the name to rename the figure", [docName(), M.state.galleryId]);

// the open figure to the trash: the editor starts a new one; restored and opened, its history is back
document.querySelector("#btn-home").click();
await until(() => !home().hidden);
side("My files").click();
await until(() => cardNamed("Quick test renamed"));
cardNamed("Quick test renamed").querySelector(".card-more").click();
await until(() => menuItem("Move to trash"));
menuItem("Move to trash").click();
await until(() => !cardNamed("Quick test renamed"));
ok(M.state.galleryId == null && !M.state.doc.objects.length, "Trash the open figure: the editor has a new, empty one", M.state.galleryId);
side("Trash").click();
await until(() => cards().length === 1);
cards()[0].click(); // restore
await until(() => !cards().length);
side("My files").click();
await until(() => cardNamed("Quick test renamed"));
cardNamed("Quick test renamed").click();
await until(() => home().hidden && M.state.galleryId === "Quick test renamed.biocraft");
ok(steps() === 2 && M.canUndo(), "Restored and opened: its undo history is back", steps());

// a figure file dropped on the canvas opens as a new figure: saved in My files under the file's name
const d0 = M.state.doc;
const dt = new DataTransfer();
dt.items.add(new File([JSON.stringify({ ...d0, thumbnail: undefined })], "Dropped figure.biocraft", { type: "application/json" }));
const r0 = document.querySelector("#stage-wrap").getBoundingClientRect();
document.querySelector("#stage-wrap").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r0.x + 100, clientY: r0.y + 100 }));
await until(() => M.state.doc !== d0);
ok(M.state.galleryId == null && docName() === "Dropped figure" && !M.state.dirty, "Drop a figure file: opened as a new figure with the file's name", [M.state.galleryId, docName()]);
document.querySelector("#btn-home").click();
await until(() => !home().hidden);
ok(M.state.galleryId === "Dropped figure.biocraft" && cardNamed("Dropped figure"), "…saved in My files when you leave it", M.state.galleryId);

document.querySelector("#btn-home").click();
await until(() => !home().hidden);
await shot("home-final", null);
ok(!errors.length, "no page errors", errors);
return checks;
