// Writes THIRD-PARTY-NOTICES.txt (shipped with the installers): the icon library's sources, licences
// and credit lines, the licence texts that must travel with copies (MIT, BSD), and the open-source
// Rust crates BioCraft is built from. Run from anywhere, after the library or Cargo.lock changes:
//   node tools/package/notices.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ix = JSON.parse(readFileSync(join(ROOT, "library/index.json"), "utf8"));
const n = (x) => x.toLocaleString("en-GB");

const LICENCES = {
  "CC0-1.0": ["CC0 1.0 (public domain dedication)", "https://creativecommons.org/publicdomain/zero/1.0/"],
  PD: ["Public domain (e.g. US government works)", ""],
  "CC-BY-3.0": ["CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/"],
  "CC-BY-4.0": ["CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"],
  "CC-BY-SA-3.0": ["CC BY-SA 3.0", "https://creativecommons.org/licenses/by-sa/3.0/"],
  "CC-BY-SA-4.0": ["CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"],
  MIT: ["MIT", "see the text below"],
  BSD: ["BSD", "see the text below"],
};

const out = [];
const line = (s = "") => out.push(s);
const heading = (s, u = "=") => {
  line(s);
  line(u.repeat(s.length));
  line();
};

heading("BioCraft — third-party notices");
line("BioCraft's own code is licensed under MIT OR Apache-2.0. It ships with a library of icons from");
line("open collections and is built from open-source software; their notices follow.");
line();

heading("1. The icon library", "-");
line(`${n(ix.icons.length)} icons. Every icon keeps its own licence; its author, licence and source link are`);
line("recorded in library/index.json, and BioCraft's Credits tab and licence & attribution report list");
line("the credits a figure needs.");
line();
for (const p of ix.packs) {
  const icons = ix.icons.filter((i) => i.pack === p.id);
  if (!icons.length) continue;
  const by = {};
  for (const i of icons) by[i.license] = (by[i.license] || 0) + 1;
  line(`${p.name}${p.url ? " — " + p.url : ""}`);
  line(`  ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${n(c)} ${LICENCES[l]?.[0] || l}`).join(", ")}`);
  line(`  Credit: ${p.credit}`);
  line();
}
line("Licences");
for (const [id, [name, url]] of Object.entries(LICENCES)) if (ix.icons.some((i) => i.license === id)) line(`  ${name}${url ? " — " + url : ""}`);
line();

const holders = (lic) => [...new Set(ix.icons.filter((i) => i.license === lic).map((i) => i.author).filter(Boolean))];
if (holders("MIT").length) {
  line(`MIT licence — icons by ${holders("MIT").join(", ")}`);
  line();
  line(`Copyright (c) ${holders("MIT").join(", ")}`);
  line();
  line(`Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`);
  line();
}
if (holders("BSD").length) {
  line(`BSD licence — icons by ${holders("BSD").join(", ")}`);
  line();
  line(`Copyright (c) ${holders("BSD").join(", ")}. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions
   and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
   conditions and the following disclaimer in the documentation and/or other materials provided
   with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to
   endorse or promote products derived from this software without specific prior written
   permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`);
  line();
}

heading("2. Open-source software", "-");
line("BioCraft is built from these Rust crates (name, version — licence), on every platform it runs on.");
line("Their licence texts are at https://crates.io/crates/<name>.");
line();
const treeArgs = ["tree", "-p", "biocraft", "-e", "normal", "--target", "all", "--prefix", "none", "--format", "{p}\t{l}"];
const cargoTree = (extra) => execFileSync("cargo", [...treeArgs, ...extra], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
let tree;
try {
  tree = cargoTree(["--offline"]); // (the crates are usually downloaded already)
} catch {
  tree = cargoTree([]);
}
const crates = new Map();
for (const row of tree.split(/\r?\n/)) {
  const [pkg, lic] = row.split("\t");
  if (!pkg?.trim()) continue;
  const [name, version] = pkg.trim().replace(/ \(.*\)$/, "").replace(/ \(\*\)$/, "").split(" ");
  if (["biocraft", "biocanvas-core"].includes(name)) continue;
  crates.set(`${name} ${version}`, (lic || "").replace(/\s*\(\*\)\s*$/, "").trim() || "see crates.io"); // ((*): listed before)
}
for (const [k, l] of [...crates].sort((a, b) => a[0].localeCompare(b[0]))) line(`  ${k} — ${l}`);
line();
line("WebView2 (Windows) and WebKit (macOS) are part of the operating system.");

writeFileSync(join(ROOT, "THIRD-PARTY-NOTICES.txt"), out.join("\n") + "\n");
console.log(`THIRD-PARTY-NOTICES.txt: ${ix.packs.length} icon collections, ${crates.size} crates`);
