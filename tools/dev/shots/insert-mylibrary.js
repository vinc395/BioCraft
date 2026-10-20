// Page script for tools/dev/shot.mjs: Insert › From My library with icons in it. My library is
// stood in for by two library icons (the server's reply is stubbed), so nothing is added to it.
//   node tools/dev/shot.mjs tools/dev/shots/insert-mylibrary.js --out tools/dev/out/shots
M.state.doc = M.newDoc();
M.state.selection = [];
C.renderDoc();
M.resetHistory();
C.fitView();
const R = {};
const real = window.fetch;
const sample = (await (await real("/api/library.search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "macrophage", limit: 2 }) })).json()).result.items;
window.fetch = (u, o) => {
  if (String(u).endsWith("/api/library.search") && JSON.parse(o.body).pack === "user") {
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { items: sample, total: sample.length } })));
  }
  return real(u, o);
};
const L = await import("/js/library.js");
await L.loadMine();
window.fetch = real;
document.querySelector('#menus .menu[data-menu="insert"] button').click();
await sleep(50);
const row = [...document.querySelectorAll(".dropdown .item")].find((r) => r.querySelector(".mi-label")?.textContent === "From My library");
row.dispatchEvent(new PointerEvent("pointerenter"));
await sleep(250);
const sub = [...document.querySelectorAll(".dropdown.submenu .item")];
R.items = sub.map((r) => [r.querySelector(".mi-label")?.textContent, !!r.querySelector("img.mi-img")]);
await shot("insert-mylibrary-items");
sub[0].click();
await sleep(400);
R.placed = M.state.doc.objects.map((o) => o.asset);
R.expected = sample[0].id;
// Show My library in the panel
document.querySelector('#menus .menu[data-menu="insert"] button').click();
await sleep(30);
[...document.querySelectorAll(".dropdown .item")].find((r) => r.querySelector(".mi-label")?.textContent === "From My library").dispatchEvent(new PointerEvent("pointerenter"));
await sleep(250);
[...document.querySelectorAll(".dropdown.submenu .item")].find((r) => /library panel/.test(r.textContent)).click();
await sleep(300);
R.mineChip = document.querySelector("#lib-cats .chip.active")?.textContent;
R.mineBar = document.querySelector("#lib-mine")?.style.display !== "none";
return R;
