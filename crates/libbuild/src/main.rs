//! Builds `library/` (cleaned SVGs, thumbnails, index.json) from the raw downloads in
//! `sources/` (see tools/fetch-*.mjs) and the generated originals in `originals/out/`.
//!
//!   biocanvas-libbuild [--root .] [--out library] [--only servier,bioicons,...] [--limit N]

use anyhow::{Context, Result};
use biocanvas_core::library::{display_name, slugify, THUMB_PX};
use biocanvas_core::render::encode_png;
use biocanvas_core::{palette, svgclean, taxonomy, IconMeta, LibraryIndex, PackInfo, Renderer};
use rayon::prelude::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

#[derive(Clone, Debug)]
struct Raw {
    pack: String,
    slug: String,
    name: String,
    src: PathBuf,
    src_category: String,
    tags: Vec<String>,
    description: String,
    author: String,
    license: String,
    source_url: String,
    /// slug of the primary icon this one is a variant of
    variant_of: Option<String>,
    style: String,
    /// force a unified category (originals know theirs)
    category: Option<String>,
}

fn packs() -> Vec<PackInfo> {
    let p = |id: &str, name: &str, description: &str, url: &str, credit: &str| PackInfo {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        url: url.into(),
        credit: credit.into(),
        count: 0,
    };
    vec![
        p("biocanvas", "BioCraft Originals", "Drawn for BioCraft with VectorCraft in Servier-like soft and NIH-like line styles", "", "BioCraft Originals (CC0)"),
        p("servier", "Servier Medical Art", "Servier Medical Art drawings as SVG, via Bioicons", "https://smart.servier.com", "Servier Medical Art (smart.servier.com), licensed under CC BY 3.0/4.0"),
        p("nih", "NIH BioArt Source", "NIAID NIH BioArt Source illustrations", "https://bioart.niaid.nih.gov", "NIAID NIH BioArt Source (bioart.niaid.nih.gov)"),
        p("bioicons", "Bioicons", "Community icons for biology and chemistry", "https://bioicons.com", "Bioicons (bioicons.com), individual authors and licences as listed"),
        p("dbcls", "DBCLS TogoTV", "Life-science illustrations by DBCLS, via Bioicons", "https://togotv.dbcls.jp/en/pics.html", "DBCLS TogoTV (togotv.dbcls.jp), licensed under CC BY 4.0"),
        p("healthicons", "Health Icons", "Public-health pictograms (filled and outline)", "https://healthicons.org", "Health Icons (healthicons.org), MIT licence"),
    ]
}

fn read_json(p: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(p).with_context(|| format!("reading {}", p.display()))?)?)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn bioicons_license(l: &str) -> String {
    match l {
        "cc-0" => "CC0-1.0",
        "cc-by-3.0" => "CC-BY-3.0",
        "cc-by-4.0" => "CC-BY-4.0",
        "cc-by-sa-3.0" => "CC-BY-SA-3.0",
        "cc-by-sa-4.0" => "CC-BY-SA-4.0",
        "mit" => "MIT",
        "bsd" => "BSD",
        _ => "UNKNOWN",
    }
    .into()
}

fn adapt_bioicons(root: &Path) -> Result<Vec<Raw>> {
    let dir = root.join("sources/bioicons");
    let manifest = read_json(&dir.join("manifest.json"))?;
    let authors = read_json(&dir.join("authors.json")).unwrap_or(Value::Null);
    // display author names from icons.json, keyed by (category, name)
    let mut display: HashMap<(String, String), String> = HashMap::new();
    if let Ok(Value::Array(icons)) = read_json(&dir.join("icons.json")) {
        for i in icons {
            display.insert((s(&i, "category"), s(&i, "name")), s(&i, "author"));
        }
    }
    let mut out = Vec::new();
    for e in manifest.as_array().into_iter().flatten() {
        let (cat, name, path_author) = (s(e, "category"), s(e, "name"), s(e, "author"));
        let author = display
            .get(&(cat.clone(), name.clone()))
            .cloned()
            .unwrap_or_else(|| path_author.replace("--", ". ").replace('-', " "));
        let pack: &'static str = match author.as_str() {
            "Servier" => "servier",
            "DBCLS" => "dbcls",
            _ => "bioicons",
        };
        let author_url = authors.get(&author).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let author_label = match pack {
            "servier" => "Servier Medical Art".to_string(),
            "dbcls" => "DBCLS TogoTV".to_string(),
            _ => author.clone(),
        };
        let slug = if pack == "bioicons" { slugify(&format!("{author}-{name}")) } else { slugify(&name) };
        out.push(Raw {
            pack: pack.to_string(),
            slug,
            name: display_name(&name),
            src: dir.join(s(e, "file")),
            src_category: cat.clone(),
            tags: vec![cat.replace('_', " ")],
            description: String::new(),
            author: author_label,
            license: bioicons_license(&s(e, "license")),
            source_url: if author_url.is_empty() { "https://bioicons.com".into() } else { author_url },
            variant_of: None,
            style: String::new(),
            category: None,
        });
    }
    Ok(out)
}

fn adapt_nih(root: &Path) -> Result<Vec<Raw>> {
    let dir = root.join("sources/nih-bioart");
    let manifest = read_json(&dir.join("manifest.json"))?;
    let mut out = Vec::new();
    for e in manifest.as_array().into_iter().flatten() {
        let groups: Vec<&Value> = e["groups"].as_array().into_iter().flatten().filter(|g| g.get("file").is_some()).collect();
        if groups.is_empty() {
            continue;
        }
        let id = e["id"].as_u64().unwrap_or(0);
        let title = s(e, "title");
        // primary: the variant captioned exactly like the entry, else the first one
        let primary = groups.iter().position(|g| s(g, "caption").eq_ignore_ascii_case(&title)).unwrap_or(0);
        let primary_slug = format!("{id}-{}", slugify(&title));
        let mut tags: Vec<String> = e["keywords"].as_array().into_iter().flatten().filter_map(|k| k.as_str().map(String::from)).collect();
        for k in ["category", "disciplines"] {
            for part in s(e, k).split(',') {
                let p = part.trim();
                if !p.is_empty() {
                    tags.push(p.to_string());
                }
            }
        }
        let license = match s(e, "license").to_lowercase().as_str() {
            "public domain" | "" => "PD",
            l if l.contains("by 4") => "CC-BY-4.0",
            l if l.contains("cc0") => "CC0-1.0",
            _ => "PD",
        };
        let author = {
            let c = s(e, "creator");
            let credit = s(e, "credit");
            match (c.is_empty(), credit.is_empty()) {
                (false, false) => format!("{c} ({credit})"),
                (false, true) => c,
                _ => if credit.is_empty() { "NIAID".into() } else { credit },
            }
        };
        for (gi, g) in groups.iter().enumerate() {
            let caption = s(g, "caption");
            let is_primary = gi == primary;
            let style = if caption.to_lowercase().contains("blackwhite") || caption.to_lowercase().contains("black and white") {
                "line"
            } else {
                ""
            };
            out.push(Raw {
                pack: "nih".into(),
                slug: if is_primary { primary_slug.clone() } else { format!("{primary_slug}-{}", g["group"].as_u64().unwrap_or(gi as u64)) },
                name: if is_primary || caption.is_empty() { title.clone() } else { caption.replace(" - ", " — ") },
                src: dir.join(s(g, "file")),
                src_category: s(e, "category"),
                tags: tags.clone(),
                description: s(e, "description"),
                author: author.clone(),
                license: license.into(),
                source_url: s(e, "url"),
                variant_of: if is_primary { None } else { Some(primary_slug.clone()) },
                style: style.into(),
                category: None,
            });
        }
    }
    Ok(out)
}

fn adapt_healthicons(root: &Path) -> Result<Vec<Raw>> {
    let dir = root.join("sources/healthicons");
    let manifest = read_json(&dir.join("manifest.json"))?;
    let meta = read_json(&dir.join("meta-data.json")).unwrap_or(Value::Null);
    let mut by_path: HashMap<String, (String, Vec<String>)> = HashMap::new();
    for m in meta.as_array().into_iter().flatten() {
        let tags = m["tags"].as_array().into_iter().flatten().filter_map(|t| t.as_str()).filter(|t| !t.contains(':')).map(String::from).collect();
        by_path.insert(s(m, "path"), (s(m, "title"), tags));
    }
    let mut out = Vec::new();
    for e in manifest.as_array().into_iter().flatten() {
        let (style, cat, name) = (s(e, "style"), s(e, "category"), s(e, "name"));
        let key = format!("{cat}/{name}");
        let (title, tags) = by_path.get(&key).cloned().unwrap_or_else(|| (display_name(&name), vec![]));
        let primary_slug = slugify(&format!("{cat}-{name}"));
        let is_outline = style == "outline";
        out.push(Raw {
            pack: "healthicons".into(),
            slug: if is_outline { format!("{primary_slug}-outline") } else { primary_slug.clone() },
            name: if is_outline { format!("{title} (outline)") } else { title },
            src: dir.join(s(e, "file")),
            src_category: cat.replace('_', " "),
            tags,
            description: String::new(),
            author: "Health Icons (Resolve to Save Lives)".into(),
            license: "MIT".into(),
            source_url: format!("https://healthicons.org/icon/{style}/{cat}/{name}"),
            variant_of: if is_outline { Some(primary_slug) } else { None },
            style: "glyph".into(),
            category: None,
        });
    }
    Ok(out)
}

/// Any `sources/<dir>/` with pack.json + manifest.json in the common format:
/// [{slug, name, file, category, tags, author, license, source_url, description?, variant_of?}]
fn adapt_generic(dir: &Path) -> Result<(PackInfo, Vec<Raw>)> {
    let p = read_json(&dir.join("pack.json"))?;
    let pack = PackInfo {
        id: s(&p, "id"),
        name: s(&p, "name"),
        description: s(&p, "description"),
        url: s(&p, "url"),
        credit: s(&p, "credit"),
        count: 0,
    };
    if pack.id.is_empty() {
        anyhow::bail!("pack.json has no id");
    }
    let manifest = read_json(&dir.join("manifest.json"))?;
    let raws = manifest
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| !s(e, "file").is_empty())
        .map(|e| Raw {
            pack: pack.id.clone(),
            slug: slugify(&if s(e, "slug").is_empty() { s(e, "name") } else { s(e, "slug") }),
            name: s(e, "name"),
            src: dir.join(s(e, "file")),
            src_category: s(e, "category"),
            tags: e["tags"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(String::from)).collect(),
            description: s(e, "description"),
            author: s(e, "author"),
            license: { let l = s(e, "license"); if l.is_empty() { "UNKNOWN".into() } else { l } },
            source_url: s(e, "source_url"),
            variant_of: e.get("variant_of").and_then(|v| v.as_str()).map(|v| slugify(v)),
            style: s(e, "style"),
            category: None,
        })
        .collect();
    Ok((pack, raws))
}

/// Generated originals: originals/out/manifest.json → [{slug, name, category, tags, style, file, variant_of?}]
fn adapt_originals(root: &Path) -> Result<Vec<Raw>> {
    let dir = root.join("originals/out");
    let manifest = read_json(&dir.join("manifest.json"))?;
    Ok(manifest
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| Raw {
            pack: "biocanvas".into(),
            slug: s(e, "slug"),
            name: s(e, "name"),
            src: dir.join(s(e, "file")),
            src_category: s(e, "category"),
            tags: e["tags"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(String::from)).collect(),
            description: s(e, "description"),
            author: "BioCraft Originals (made with VectorCraft)".into(),
            license: "CC0-1.0".into(),
            source_url: String::new(),
            variant_of: e.get("variant_of").and_then(|v| v.as_str()).map(String::from),
            style: s(e, "style"),
            category: Some(s(e, "category")).filter(|c| !c.is_empty()),
        })
        .collect())
}

fn clean_raw(r: &Raw, opt: &biocanvas_core::usvg::Options) -> Result<svgclean::Cleaned> {
    let data = fs::read(&r.src).with_context(|| format!("reading {}", r.src.display()))?;
    let tree = svgclean::parse(&data, opt)?;
    svgclean::clean(&tree, 0.02)
}

/// Write the thumbnail (and the SVG unless `shared_file` names the primary's file) and build
/// the metadata.
fn finish(
    r: &Raw,
    cleaned: &svgclean::Cleaned,
    shared: Option<(&str, std::collections::BTreeMap<String, String>)>,
    renderer: &Renderer,
    opt: &biocanvas_core::usvg::Options,
    out: &Path,
) -> Result<IconMeta> {
    let thumb = format!("packs/{}/thumbs/{}.png", r.pack, r.slug);
    let (file, colors) = match shared {
        Some((f, map)) => (f.to_string(), map),
        None => {
            let file = format!("packs/{}/svg/{}.svgz", r.pack, r.slug);
            svgclean::write_svgz(&out.join(&file), &cleaned.svg)?;
            (file, Default::default())
        }
    };
    let ctree = svgclean::parse(cleaned.svg.as_bytes(), opt)?;
    fs::write(out.join(&thumb), encode_png(&renderer.thumbnail(&ctree, THUMB_PX)?, None)?)?;
    let category = r.category.clone().unwrap_or_else(|| taxonomy::categorize(&r.src_category, &r.name, &r.tags).to_string());
    let mut tags = r.tags.clone();
    tags.sort();
    tags.dedup();
    Ok(IconMeta {
        id: format!("{}/{}", r.pack, r.slug),
        name: r.name.clone(),
        pack: r.pack.clone(),
        category,
        subcategory: r.src_category.replace('_', " "),
        tags,
        description: r.description.clone(),
        author: r.author.clone(),
        license: r.license.clone(),
        source_url: r.source_url.clone(),
        file,
        thumb,
        w: (cleaned.w * 100.0).round() / 100.0,
        h: (cleaned.h * 100.0).round() / 100.0,
        slots: palette::slots(&cleaned.colors),
        raster: cleaned.raster,
        variants: vec![],
        hidden: r.variant_of.is_some(),
        style: r.style.clone(),
        colors,
    })
}

/// Process a primary icon and its variants together, so variants that only change colours
/// share the primary's SVG file.
fn process_group(
    group: &[usize],
    raws: &[Raw],
    renderer: &Renderer,
    opt: &biocanvas_core::usvg::Options,
    out: &Path,
) -> Vec<(usize, Result<IconMeta>)> {
    let mut results = Vec::with_capacity(group.len());
    let primary = &raws[group[0]];
    let pclean = match clean_raw(primary, opt) {
        Ok(c) => c,
        Err(e) => {
            results.push((group[0], Err(e)));
            // without a primary, each variant stands alone
            for &vi in &group[1..] {
                results.push((vi, clean_raw(&raws[vi], opt).and_then(|c| finish(&raws[vi], &c, None, renderer, opt, out))));
            }
            return results;
        }
    };
    let pmeta = finish(primary, &pclean, None, renderer, opt, out);
    let pfile = pmeta.as_ref().map(|m| m.file.clone()).ok();
    results.push((group[0], pmeta));
    for &vi in &group[1..] {
        let r = &raws[vi];
        let res = clean_raw(r, opt).and_then(|c| {
            let shared = pfile.as_deref().and_then(|f| svgclean::recolor_map(&pclean.svg, &c.svg).map(|m| (f, m)));
            finish(r, &c, shared, renderer, opt, out)
        });
        results.push((vi, res));
    }
    results
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let root = PathBuf::from(arg("--root").unwrap_or_else(|| ".".into()));
    let out = arg("--out").map(PathBuf::from).unwrap_or_else(|| root.join("library"));
    let only: Option<HashSet<String>> = arg("--only").map(|s| s.split(',').map(|x| x.trim().to_string()).collect());
    let limit: Option<usize> = arg("--limit").and_then(|v| v.parse().ok());
    let want = |p: &str| only.as_ref().map_or(true, |o| o.contains(p));

    // --inspect file.svg[z]: print an icon's colours and slots (palette tuning)
    if let Some(f) = arg("--inspect") {
        let r = Renderer::new();
        let tree = svgclean::parse(&fs::read(&f)?, &r.options())?;
        let c = svgclean::clean(&tree, 0.02)?;
        for (col, w) in &c.colors {
            let lab = col.oklab();
            println!("{}  w={:<10.1} L={:.2} C={:.3} h={:.0}", col.hex(), w, lab.l, lab.chroma(), lab.hue());
        }
        for s in palette::slots(&c.colors) {
            println!("slot {:<6} {:.0}% base {} members {:?}", s.kind, s.weight * 100.0, s.base, s.members);
        }
        return Ok(());
    }
    // --recategorize: re-file icons after the keyword rules change, without rebuilding.
    // Only packs whose categories come from the rules (originals and manifest packs set theirs).
    if args.iter().any(|a| a == "--recategorize") {
        let path = out.join("index.json");
        let mut index: LibraryIndex = serde_json::from_slice(&fs::read(&path)?)?;
        let mut moved = 0;
        for m in index.icons.iter_mut().filter(|m| RULED.contains(&m.pack.as_str())) {
            let c = taxonomy::categorize(&m.subcategory, &m.name, &m.tags).to_string();
            if c != m.category {
                moved += 1;
                m.category = c;
            }
        }
        index.categories = category_counts(&index.icons);
        fs::write(&path, serde_json::to_vec(&index)?)?;
        println!("re-filed {moved} of {} icons", index.icons.len());
        return Ok(());
    }
    // --apply-names: apply sources/overrides/names.json to an existing library without rebuilding
    if args.iter().any(|a| a == "--apply-names") {
        let path = out.join("index.json");
        let mut index: LibraryIndex = serde_json::from_slice(&fs::read(&path)?)?;
        let n = apply_names(&root, &mut index.icons);
        index.categories = category_counts(&index.icons);
        fs::write(&path, serde_json::to_vec(&index)?)?;
        println!("renamed {n} icons");
        return Ok(());
    }
    // --reslot: recompute colour slots of an existing library without rebuilding it
    if args.iter().any(|a| a == "--reslot") {
        let r = Renderer::new();
        let opt = r.options();
        let path = out.join("index.json");
        let mut index: LibraryIndex = serde_json::from_slice(&fs::read(&path)?)?;
        let t = Instant::now();
        let files: Vec<String> = index.icons.iter().map(|m| m.file.clone()).collect();
        let slots: Vec<Option<Vec<biocanvas_core::Slot>>> = files
            .par_iter()
            .map(|f| {
                let svg = svgclean::read_svg(&out.join(f)).ok()?;
                let tree = svgclean::parse(svg.as_bytes(), &opt).ok()?;
                let c = svgclean::clean(&tree, 0.0).ok()?;
                Some(palette::slots(&c.colors))
            })
            .collect();
        for (m, s) in index.icons.iter_mut().zip(slots) {
            if let Some(s) = s {
                // colour variants: slots follow the variant's own colours
                m.slots = if m.colors.is_empty() {
                    s
                } else {
                    s.into_iter()
                        .map(|mut sl| {
                            let map = |h: &String| m.colors.get(h).cloned().unwrap_or_else(|| h.clone());
                            sl.base = map(&sl.base);
                            sl.members = sl.members.iter().map(map).collect();
                            sl
                        })
                        .collect()
                };
            }
        }
        fs::write(&path, serde_json::to_vec(&index)?)?;
        println!("re-slotted {} icons in {:.0}s", index.icons.len(), t.elapsed().as_secs_f32());
        return Ok(());
    }

    let t0 = Instant::now();
    let mut raws: Vec<Raw> = Vec::new();
    let mut add = |name: &str, r: Result<Vec<Raw>>| match r {
        Ok(mut v) => {
            if let Some(l) = limit {
                v.truncate(l);
            }
            println!("{name}: {} source files", v.len());
            raws.extend(v);
        }
        Err(e) => println!("{name}: skipped ({e:#})"),
    };
    if want("biocanvas") {
        add("biocanvas originals", adapt_originals(&root));
    }
    if want("servier") || want("bioicons") || want("dbcls") {
        add("bioicons (incl. servier, dbcls)", adapt_bioicons(&root).map(|v| v.into_iter().filter(|r| want(&r.pack)).collect()));
    }
    if want("nih") {
        add("nih bioart", adapt_nih(&root));
    }
    if want("healthicons") {
        add("health icons", adapt_healthicons(&root));
    }
    // any other source folder with pack.json + manifest.json (Servier kits, Reactome, PhyloPic…)
    let mut extra_packs: Vec<PackInfo> = Vec::new();
    let mut dirs: Vec<PathBuf> = fs::read_dir(root.join("sources")).map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect()).unwrap_or_default();
    dirs.sort();
    for dir in dirs {
        if !dir.join("pack.json").exists() {
            continue;
        }
        match adapt_generic(&dir) {
            Ok((pack, v)) if want(&pack.id) => {
                println!("{}: {} source files", pack.name, v.len());
                if pack.id == "servier" {
                    // the official kits supersede the Servier subset that ships inside Bioicons
                    let before = raws.len();
                    raws.retain(|r| r.pack != "servier");
                    println!("  (replacing {} Servier icons from Bioicons)", before - raws.len());
                }
                let mut v = v;
                if let Some(l) = limit {
                    v.truncate(l);
                }
                raws.extend(v);
                extra_packs.push(pack);
            }
            Ok(_) => {}
            Err(e) => println!("{}: skipped ({e:#})", dir.display()),
        }
    }

    // unique slugs per pack
    let mut seen: HashSet<String> = HashSet::new();
    for r in raws.iter_mut() {
        let base = r.slug.clone();
        let mut n = 2;
        while !seen.insert(format!("{}/{}", r.pack, r.slug)) {
            r.slug = format!("{base}-{n}");
            n += 1;
        }
    }
    let pack_ids: HashSet<String> = raws.iter().map(|r| r.pack.clone()).collect();
    for p in &pack_ids {
        fs::create_dir_all(out.join(format!("packs/{p}/svg")))?;
        fs::create_dir_all(out.join(format!("packs/{p}/thumbs")))?;
    }

    // groups: a primary followed by its variants (by slug within the pack)
    let mut slot_of: HashMap<(String, String), usize> = HashMap::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (i, r) in raws.iter().enumerate() {
        if r.variant_of.is_none() {
            slot_of.insert((r.pack.to_string(), r.slug.clone()), groups.len());
            groups.push(vec![i]);
        }
    }
    for (i, r) in raws.iter().enumerate() {
        if let Some(p) = &r.variant_of {
            match slot_of.get(&(r.pack.to_string(), p.clone())) {
                Some(&g) => groups[g].push(i),
                None => groups.push(vec![i]),
            }
        }
    }
    // biggest groups first keeps the thread pool busy until the end
    groups.sort_by_key(|g| std::cmp::Reverse(g.len()));

    let renderer = Renderer::new();
    let opt = renderer.options();
    let done = AtomicUsize::new(0);
    let total = raws.len();
    let results: Vec<(usize, Result<IconMeta>)> = groups
        .par_iter()
        .flat_map_iter(|g| {
            let res = process_group(g, &raws, &renderer, &opt, &out);
            let d = done.fetch_add(g.len(), Ordering::Relaxed) + g.len();
            if d / 500 != (d - g.len()) / 500 || d == total {
                println!("  processed {d}/{total} ({:.0}s)", t0.elapsed().as_secs_f32());
            }
            res
        })
        .collect();

    let mut icons: Vec<IconMeta> = Vec::new();
    let mut errors = String::new();
    for (i, r) in results {
        match r {
            Ok(m) => icons.push(m),
            Err(e) => errors.push_str(&format!("{}\t{}\t{e:#}\n", raws[i].pack, raws[i].src.display())),
        }
    }
    // link variants to their primaries
    let ids: HashMap<String, usize> = icons.iter().enumerate().map(|(i, m)| (m.id.clone(), i)).collect();
    let mut links: Vec<(usize, String)> = Vec::new();
    for r in &raws {
        if let Some(p) = &r.variant_of {
            let vid = format!("{}/{}", r.pack, r.slug);
            if let (Some(&pi), true) = (ids.get(&format!("{}/{p}", r.pack)), ids.contains_key(&vid)) {
                links.push((pi, vid));
            }
        }
    }
    for (pi, vid) in links {
        icons[pi].variants.push(vid);
    }
    // a variant whose primary failed becomes visible itself
    let primaries: HashSet<String> = icons.iter().flat_map(|m| m.variants.clone()).collect();
    for m in icons.iter_mut() {
        if m.hidden && !primaries.contains(&m.id) {
            m.hidden = false;
        }
    }
    let order = ["biocanvas", "servier", "nih", "reactome", "bioicons", "scidraw", "dbcls", "phylopic", "healthicons", "user"];
    icons.sort_by(|a, b| {
        let pa = order.iter().position(|p| *p == a.pack).unwrap_or(99);
        let pb = order.iter().position(|p| *p == b.pack).unwrap_or(99);
        pa.cmp(&pb).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    // built-in pack descriptions, replaced by a source's own pack.json where one exists
    let mut all_packs = packs();
    for p in extra_packs {
        all_packs.retain(|q| q.id != p.id);
        all_packs.push(p);
    }
    all_packs.sort_by_key(|p| order.iter().position(|o| *o == p.id).unwrap_or(99));
    // --update: keep every other pack of the existing library and replace only the rebuilt ones
    let mut icons = icons;
    if args.iter().any(|a| a == "--update") {
        if let Ok(old) = fs::read(out.join("index.json")).map_err(anyhow::Error::from).and_then(|b| Ok(serde_json::from_slice::<LibraryIndex>(&b)?)) {
            let rebuilt: HashSet<String> = icons.iter().map(|m| m.pack.clone()).collect();
            let kept: Vec<IconMeta> = old.icons.into_iter().filter(|m| !rebuilt.contains(&m.pack)).collect();
            println!("  update: kept {} icons from other packs", kept.len());
            for p in old.packs {
                if !all_packs.iter().any(|q| q.id == p.id) {
                    all_packs.push(p);
                }
            }
            icons.extend(kept);
            icons.sort_by(|a, b| {
                let pa = order.iter().position(|p| *p == a.pack).unwrap_or(99);
                let pb = order.iter().position(|p| *p == b.pack).unwrap_or(99);
                pa.cmp(&pb).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });
            all_packs.sort_by_key(|p| order.iter().position(|o| *o == p.id).unwrap_or(99));
        }
    }
    let renamed = apply_names(&root, &mut icons);
    if renamed > 0 {
        println!("  names: {renamed} icons renamed (sources/overrides/names.json)");
        icons.sort_by(|a, b| {
            let pa = order.iter().position(|p| *p == a.pack).unwrap_or(99);
            let pb = order.iter().position(|p| *p == b.pack).unwrap_or(99);
            pa.cmp(&pb).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
    }
    let mut index = LibraryIndex { version: 1, built: format!("{}", unix_now()), packs: all_packs, categories: vec![], icons };
    let mut counts: HashMap<String, usize> = HashMap::new();
    for m in index.icons.iter().filter(|m| !m.hidden) {
        *counts.entry(m.pack.clone()).or_default() += 1;
    }
    index.packs.retain(|p| counts.contains_key(&p.id));
    for p in &mut index.packs {
        p.count = counts[&p.id];
    }
    index.categories = category_counts(&index.icons);

    fs::write(out.join("index.json"), serde_json::to_vec(&index)?)?;
    fs::write(out.join("build-errors.txt"), &errors)?;
    let visible = index.icons.iter().filter(|m| !m.hidden).count();
    println!(
        "\nLibrary: {} icons ({} searchable + {} variants), {} failed, {:.0}s",
        index.icons.len(),
        visible,
        index.icons.len() - visible,
        errors.lines().count(),
        t0.elapsed().as_secs_f32()
    );
    for p in &index.packs {
        println!("  {:<12} {}", p.id, p.count);
    }
    for c in index.categories.iter().filter(|c| c.count > 0) {
        println!("  [{}] {}", c.count, c.name);
    }
    Ok(())
}

/// Packs whose categories come from the keyword rules (originals and manifest packs set their own).
const RULED: [&str; 6] = ["servier", "bioicons", "dbcls", "nih", "healthicons", "scidraw"];

/// Better names for icons whose own names say little about them — Servier drawings named after
/// their slide or after a website title shared by many drawings — from
/// `sources/overrides/names.json` (made with tools/servier-names.mjs):
/// `{"icons": {"servier/<slug>": {"name": "…", "tags": ["…"], "category"?: "…"}}}`. The old name is
/// kept as a tag and colour variants that shared their primary's old name take the new one. An
/// icon keeps its category (the keyword rules misfile descriptive names: "Smooth muscle cell,
/// spindle-shaped" would become an organelle), except one in a catch-all — People & medicine or
/// Other — which is re-filed by its new name, or one given a "category". Applied after every build,
/// so a rebuilt pack keeps the names; ids never change. Returns how many icons were renamed.
fn apply_names(root: &Path, icons: &mut [IconMeta]) -> usize {
    let Ok(v) = read_json(&root.join("sources/overrides/names.json")) else { return 0 };
    let Some(map) = v.get("icons").and_then(|m| m.as_object()) else { return 0 };
    let add_tag = |m: &mut IconMeta, t: &str| {
        let t = t.trim();
        if !t.is_empty() && !t.eq_ignore_ascii_case(&m.name) && !m.tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            m.tags.push(t.to_string());
        }
    };
    let refile = |m: &mut IconMeta| {
        if RULED.contains(&m.pack.as_str()) && (m.category == "people" || m.category == "other") {
            m.category = taxonomy::categorize(&m.subcategory, &m.name, &[]).to_string();
        }
    };
    let mut renamed: HashMap<String, (String, String)> = HashMap::new(); // id → (old name, new name)
    for m in icons.iter_mut() {
        let Some(o) = map.get(&m.id) else { continue };
        let Some(name) = o.get("name").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()) else { continue };
        for t in o.get("tags").and_then(|t| t.as_array()).into_iter().flatten().filter_map(|t| t.as_str()) {
            add_tag(m, t);
        }
        let category = o.get("category").and_then(|c| c.as_str()).filter(|c| taxonomy::CATEGORIES.iter().any(|x| x.0 == *c));
        if let Some(c) = category {
            m.category = c.to_string();
        }
        if m.name == name {
            continue; // already applied
        }
        let old = std::mem::replace(&mut m.name, name.to_string());
        add_tag(m, &old);
        if category.is_none() {
            refile(m);
        }
        renamed.insert(m.id.clone(), (old, m.name.clone()));
    }
    let primary_of: HashMap<String, String> = icons.iter().flat_map(|m| m.variants.iter().map(|v| (v.clone(), m.id.clone()))).collect();
    let mut n = renamed.len();
    for m in icons.iter_mut().filter(|m| !map.contains_key(&m.id)) {
        if let Some((old, new)) = primary_of.get(&m.id).and_then(|p| renamed.get(p)) {
            if m.name == *old {
                m.name = new.clone();
                add_tag(m, old);
                refile(m);
                n += 1;
            }
        }
    }
    n
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Searchable icons per category, in the taxonomy's order.
fn category_counts(icons: &[IconMeta]) -> Vec<biocanvas_core::CategoryInfo> {
    taxonomy::CATEGORIES
        .iter()
        .map(|(id, name)| biocanvas_core::CategoryInfo {
            id: id.to_string(),
            name: name.to_string(),
            count: icons.iter().filter(|m| !m.hidden && m.category == *id).count(),
        })
        .collect()
}
