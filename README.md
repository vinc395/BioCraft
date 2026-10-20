<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/biocraft-dark.svg">
    <img src="docs/logo/biocraft.svg" alt="BioCraft" width="380">
  </picture>
</h1>

A lightweight, offline editor for scientific figures — in the spirit of BioRender — with a
searchable library of open biology icons that you can recolour part by part. AI coding agents can
search the library and draft figures for you to refine (see [Use with AI agents](#use-with-ai-agents)).
BioCraft was called BioCanvas; the internal crates keep the old name.

**Download** from [Releases](https://github.com/vinc395/BioCraft/releases), with the icon library
inside: `BioCraft_<version>_x64-setup.exe` for Windows 10/11 (it installs for the current user), or
`BioCraft_<version>_universal.dmg` for macOS 12 or later (Apple silicon and Intel). The Mac app
isn't signed with an Apple developer certificate or notarised, so macOS blocks the first open:
right-click BioCraft and choose Open, or click Open Anyway in System Settings › Privacy & Security.
`tools/package/INSTALL.txt` has the steps.

- **~12,000 icons** (~17,000 with colour variants) from Servier Medical Art (all 49 official PowerPoint
  kits, converted to SVG), NIH BioArt Source, the Reactome Icon Library, Bioicons, DBCLS TogoTV,
  PhyloPic and Health Icons, plus **BioCraft Originals** drawn with VectorCraft in matching styles.
- **BioRender-style recolouring**: each icon exposes a few colour wells (membrane, nucleus, granules…);
  changing one keeps that part's highlights and shadows. Tint and greyscale in one click.
- Arrows, inhibition (⊣) lines, curved connectors, **lipid-bilayer membranes** drawn along any path,
  shapes, text, images, groups, layers, smart guides, undo/redo.
- **Export**: PNG/TIFF at 150–1200 dpi (DPI written into the file), vector **PDF** with live text, SVG,
  with a live preview of exactly what will be written (also in greyscale) and a **Publication
  permissions** panel: what the icons' licences allow (teaching, journals, open access, commercial
  use), what they ask, and a check against the journal's licence.
- **Home page** (at start-up, or the ⌂ button / BioCraft logo): Create new with page-size presets
  (single/1.5/double column, slide, A4), **My files** with a preview of every figure, **project
  folders**, search, sort, grid or list, and per-figure actions (rename, duplicate, move to a folder,
  trash and restore). Figures are ordinary `.biocraft` files in the figures folder —
  Documents/BioCraft figures by default (change it on the home page, or set `$BIOCRAFT_FIGURES`),
  one level of project folders inside — so they back up and sync like any other files, and figures
  drafted by AI agents appear there too.
- **Saved as you work**: figures in the figures folder save themselves a moment after every change
  (the top bar says Saved; click the figure's name there to rename it). A new figure gets its file
  at its first change, as “Untitled figure” in the folder it was created from, and leaving it asks
  once for a better name (offering the figure's title). Each figure keeps its **undo history** while
  you are on Home or in another figure, until BioCraft closes. A figure opened from elsewhere on
  disk is saved with Ctrl+S, as before.
- **Credits tab** writes the figure-legend attribution the icon licences require (CC BY icons you
  changed are credited as “adapted from”).
- **Licence & attribution report** with every export (or File › Export licence report…): a PDF
  (A4), Markdown and CSV beside the figure listing each icon's source, author and licence, what the
  licences ask of you (credit, share-alike, licence notices) and what you changed in each icon.
- Rust core, Tauri window: a ~15 MB app that uses the system webview (WebView2 on Windows,
  WebKit on macOS/Linux). Runs on **Windows, macOS and Linux** from one codebase.

## Layout

```
app/              Tauri desktop app (Rust): window, library protocol, file dialogs, `--serve` web mode,
                  command line and MCP server for AI agents (agent.rs, figure.rs)
crates/core/      biocanvas-core: SVG normalisation (usvg), colour slots, search, PNG/TIFF/PDF export
crates/libbuild/  biocanvas-libbuild: builds library/ from the downloaded sources and the originals
ui/               the editor (plain HTML/CSS/JS modules, no build step)
tools/            source downloaders (Node), icon-format helpers, VectorCraft client
originals/        icon recipes → VectorCraft → originals/out/svg (BioCraft Originals)
library/          built icon library (not in git; ~640 MB)
sources/          raw downloads (not in git; ~2 GB, can be deleted after building)
tools/package/    installers: build-windows.ps1, build-mac.sh, notices.mjs (THIRD-PARTY-NOTICES.txt)
examples/         a figure spec drafted for the agent tools, with its rendering
```

## Build and run

Requirements: Rust (stable), Node 18+; on Windows the MSVC C++ Build Tools; on Linux
`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`.

```bash
# 1. icons: download the open sources and build the library (once; ~15 min)
node tools/fetch-bioicons.mjs
node tools/fetch-nih-bioart.mjs
node tools/fetch-healthicons.mjs
node tools/fetch-servier-kits.mjs                  # Servier PPTX kits → SVG (tools/pptx2svg.mjs)
node tools/fetch-reactome.mjs
node tools/fetch-phylopic.mjs                      # ≤2,500 silhouettes, model organisms first
cargo run --release -p biocanvas-libbuild          # → library/
# add or refresh single packs without rebuilding the rest:
#   target/release/biocanvas-libbuild --only servier,reactome,phylopic --update

# 2. the app
cargo run --release -p biocraft                    # desktop window
cargo run --release -p biocraft -- --serve 8780    # same app in a browser at http://127.0.0.1:8780
```

The app finds `library/` next to (or above) the executable, in `$BIOCRAFT_LIBRARY`, or wherever
you point **File › Choose icon library folder…**.

### Installers

- **Windows**: `powershell -ExecutionPolicy Bypass -File tools\package\build-windows.ps1` →
  `dist\BioCraft_<version>_x64-setup.exe`. Needs the Tauri CLI
  (`cargo install tauri-cli --version "^2" --locked`).
- **macOS**, on a Mac (Apple's tools only run there): `sh tools/package/build-mac.sh` →
  `dist/BioCraft_<version>_universal.dmg`, for Apple silicon and Intel Macs on macOS 12 or later.
  It installs what it needs (the Xcode command-line tools, Rust, the Tauri CLI).
- **On GitHub's machines** (no Mac needed): `.github/workflows/build.yml` builds the Windows, macOS
  and Linux installers, or one of them (`gh workflow run build.yml -f platforms=macOS`); its header
  says how it gets the library. `library.yml` builds a library from the downloaded sources instead.

The installers carry the icon library, so each is about 600 MB. They install BioCraft for the
current user (no admin rights needed) and make `.biocraft` files open in it.
`THIRD-PARTY-NOTICES.txt` is installed alongside BioCraft (`node tools/package/notices.mjs` makes it).
It lists the icon collections with their licences and credit lines, and the open-source crates.
The installers are not code-signed. On Windows, SmartScreen shows "Windows protected your PC": click
More info › Run anyway. On a Mac, open BioCraft the first time by right-clicking it and choosing
Open, or under System Settings › Privacy & Security › Open Anyway.

### Library format

Each icon is a gzip-compressed SVG (`.svgz`, which Inkscape/Illustrator open) normalised through
usvg: styles resolved to attributes, paths written compactly at 4 significant digits, cropped to
the drawn pixels. Colour variants that only change colours are stored as a colour map over one
drawing. `index.json` holds names, tags, categories, licences and the colour slots.

Re-run `biocanvas-libbuild --reslot` after changing the colour-slot logic (no full rebuild), and
`biocanvas-libbuild --inspect file.svg` to see how an SVG's colours are grouped.

## Use with AI agents

BioCraft includes an [MCP](https://modelcontextprotocol.io) server and a command line, so coding
agents (Claude Code, OpenAI Codex CLI, Cursor, Claude Desktop, Gemini CLI or any MCP client) can
search the icon library and draft figures that you then open and polish in the app. The agent
writes a JSON figure spec in millimetres; BioCraft draws it exactly as the editor does, shows the
agent a preview, warns about problems (unknown icons, things off the page, overlapping or tiny
text), saves an editable `.biocraft` file and writes the figure-legend credits (and, with
`licence_report`, the licence & attribution report beside the export).

Tools: `search_icons`, `list_categories`, `get_icon`, `render_figure`, `open_in_biocraft`,
`biocraft_guide`. The spec and design advice are in [AGENTS.md](AGENTS.md) (also `biocraft guide`).

Use the path of your `biocraft` executable below: `target/release/biocraft.exe` after
`cargo build --release -p biocraft`, or the installed program. The server finds the icon library
the same way the app does (the folder chosen in the app, `$BIOCRAFT_LIBRARY`, or `library/`
beside the program). On Windows, write paths in JSON with forward slashes.

**Claude Code**

```bash
claude mcp add biocraft -- C:/Users/you/BioCanvas/target/release/biocraft.exe mcp
claude mcp add --scope user biocraft -- /path/to/biocraft mcp      # for all your projects
```

or commit a project `.mcp.json`:

```json
{
  "mcpServers": {
    "biocraft": { "command": "C:/Users/you/BioCanvas/target/release/biocraft.exe", "args": ["mcp"] }
  }
}
```

**OpenAI Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.biocraft]
command = "C:/Users/you/BioCanvas/target/release/biocraft.exe"
args = ["mcp"]
```

**Claude Desktop** (`claude_desktop_config.json`: Settings › Developer › Edit config) and
**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project) use the same block:

```json
{
  "mcpServers": {
    "biocraft": { "command": "C:/Users/you/BioCanvas/target/release/biocraft.exe", "args": ["mcp"] }
  }
}
```

**Gemini CLI** — `~/.gemini/settings.json` (or `.gemini/settings.json` in a project):

```json
{
  "mcpServers": {
    "biocraft": { "command": "C:/Users/you/BioCanvas/target/release/biocraft.exe", "args": ["mcp"] }
  }
}
```

Add `"env": { "BIOCRAFT_LIBRARY": "D:/BioCraft/library" }` to any of these to use another library.

**Plain command line** (JSON on stdout, for scripts and agents without MCP):

```bash
biocraft search "synovial fibroblast" --limit 10 [--category tissues] [--pack servier] [--sheet hits.png]
biocraft icon biocanvas/macrophage --png macrophage.png --svg macrophage.svg
biocraft render examples/agent-figure.json --out figure.png --save figure.biocraft --dpi 300 --licence
biocraft guide                  # the figure spec and design tips
biocraft figure.biocraft        # open a figure in the desktop app
```

Without `--save` (or the tool's `save`), a new figure is saved to `Documents/BioCraft figures/`
under its title. A draft there is only replaced while it is unchanged since BioCraft wrote it; a
file you edited or saved yourself is kept and the new draft gets a numbered name. Re-rendering a
`.biocraft` (to export it) does not save a copy unless asked. `--transparent` exports PNG/TIFF
without a background. If the icon library cannot be found, every command says where it looked.
Windows release builds are GUI programs: run the CLI from a terminal or redirect its output
(`biocraft search cell > hits.json`); MCP clients talk to it over pipes and need nothing extra.

[`examples/agent-figure.json`](examples/agent-figure.json) is a complete spec (an RA synovitis
graphical abstract) with its rendering, `examples/agent-figure.png`, and the editable
`examples/agent-figure.biocraft`.

## BioCraft Originals (VectorCraft)

`originals/recipes/*.mjs` describe icons as coloured parts; `originals/build.mjs` drives
VectorCraft's headless engine (`vectorcraft-cli mcp`) to draw each one in two house styles —
**soft** (Servier-like shading cut with exact path booleans) and **line** (NIH-like outlines) — and
export SVG. See `originals/RECIPES.md`.

```bash
node originals/build.mjs                 # all recipes, both styles
node originals/build.mjs immune.mjs      # one topic
node tools/vc/sheet.mjs sheet.png originals/out/preview   # contact sheet for review
cargo run --release -p biocanvas-libbuild                  # include them in the library
```

## Icon licences

Every icon keeps its source's licence; BioCraft shows it on the icon and in the Credits tab.
BioCraft itself grants no licence. The **licence & attribution report** (Export › “Save licence &
attribution report”, on by default; File › Export licence report…; the Credits tab; MCP
`licence_report`; `biocraft render … --licence`) documents the icons' own licences for one
exported figure: `<name>-licence.pdf` (A4, vector), `.md` and `.csv`. Its first page is ready to send
to a journal: the figure itself, the journal, manuscript and figure title you entered (kept in the
figure), whether the icons' licences fit the article's licence (open access CC BY, other open
licence or subscription; the one real conflict is share-alike CC BY-SA icons), and a plain statement
of what the report records. Then a summary
(attribution, commercial use, share-alike and licence-notice warnings, changed icons), the
ready-to-paste legend credit, a table of every icon (thumbnail, id, source, author, licence and
deed link, source URL, uses, changes), your own uploads and pictures, the MIT/BSD notices, a
plain-language glossary and a Figure ID (SHA-256 of the figure's content) that ties the report
to the export. It is a convenience, not legal advice.

| Source | Licence | Credit |
|---|---|---|
| Servier Medical Art (official PowerPoint kits; a few older drawings via Bioicons) | CC BY 4.0 (kits) / CC BY 3.0 (Bioicons copies) | required |
| Reactome Icon Library | CC BY 4.0 | required; designer and curator listed per icon |
| NIH BioArt Source | public domain (most) | appreciated; cite bioart.niaid.nih.gov/bioart/### |
| Bioicons (community) | per icon: CC0, CC BY, CC BY-SA, MIT, BSD | per icon |
| DBCLS TogoTV (via Bioicons) | CC BY 4.0 | required |
| PhyloPic | per image: CC0, public domain mark, CC BY 3.0 / 4.0 (NC/SA images not included) | CC BY images: required |
| Health Icons | MIT | licence notice |
| BioCraft Originals | CC0 | not required |

BioGDP is not included: its graphics are proprietary and only licensed for use inside BioGDP.
You can still place files you exported yourself (File › Place image or SVG…, or drag them in).

## Keyboard

V select · H pan (or hold Space) · T text · R rectangle · O ellipse · L line · A arrow ·
I inhibition · M membrane · Ctrl+Z/Ctrl+Shift+Z undo/redo · Ctrl+D duplicate · Ctrl+G group ·
Ctrl+[ / ] order · Shift+H/V flip · Ctrl+wheel zoom · Ctrl+0 fit · Ctrl+E export · / search.

---

BioRender is a trademark of its respective owner. BioCraft is an independent project, not
affiliated with, endorsed or sponsored by BioRender.
