//! Licence & attribution report for an exported figure: every library icon it uses, the licence
//! each is under and what that asks of the author (credit, share-alike, licence notices, marking
//! changes), as an A4 vector PDF, Markdown and CSV. One builder serves the app's Export dialog,
//! the MCP render_figure tool and `biocraft render --licence`, so all three say the same thing.
//!
//! BioCraft grants no licence of its own: the icons stay under their authors' licences and the
//! report only documents them.

use crate::figure::{asset_parts, icon_inner};
use crate::labels;
use anyhow::{Context, Result};
use biocanvas_core::render::pages_to_pdf;
use biocanvas_core::{license_info, svgclean, usvg, Renderer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn s<'a>(o: &'a Value, k: &str) -> &'a str {
    o.get(k).and_then(|v| v.as_str()).unwrap_or("")
}
fn num(o: &Value, k: &str) -> Option<f64> {
    o.get(k).and_then(|v| v.as_f64())
}
fn truthy(o: &Value, k: &str) -> bool {
    match o.get(k) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(x)) => x.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn children(o: &Value) -> &[Value] {
    o.get("children").and_then(|c| c.as_array()).map(|v| v.as_slice()).unwrap_or(&[])
}
fn add<T: PartialEq>(v: &mut Vec<T>, x: T) {
    if !v.contains(&x) {
        v.push(x);
    }
}

/* ---------- what the figure uses ---------- */

/// One drawn use of a library asset: where it is and what was changed from the drawing.
pub struct Use {
    pub asset: String,
    pub place: &'static str,
    pub changes: Vec<&'static str>,
}

/// Every drawn use of a library asset, in drawing order, and the names of the placed pictures.
/// Hidden objects are left out: they are not in the exported image.
pub fn uses(doc: &Value) -> (Vec<Use>, Vec<String>) {
    let (mut out, mut pics) = (Vec::new(), Vec::new());
    let objs = doc.get("objects").and_then(|v| v.as_array()).map(|v| v.as_slice()).unwrap_or(&[]);
    walk(objs, doc.get("assets").unwrap_or(&Value::Null), &[], &mut out, &mut pics);
    (out, pics)
}

fn walk(objs: &[Value], assets: &Value, inherited: &[&'static str], out: &mut Vec<Use>, pics: &mut Vec<String>) {
    for o in objs {
        if truthy(o, "hidden") {
            continue;
        }
        // a glow or transparency on a group reaches every icon in it
        let mut fx = inherited.to_vec();
        if truthy(o, "glow") {
            add(&mut fx, "glow added");
        }
        if num(o, "opacity").is_some_and(|v| v < 1.0) {
            add(&mut fx, "made transparent");
        }
        let a = s(o, "asset");
        match s(o, "type") {
            "icon" if !a.is_empty() => out.push(Use { asset: a.into(), place: "icon", changes: changes(o, assets.get(a), &fx) }),
            "membrane" if s(o, "brush") == "icon" && !a.is_empty() => out.push(Use { asset: a.into(), place: "icon brush", changes: changes(o, None, &fx) }),
            "legend" => {
                for r in o.get("rows").and_then(|v| v.as_array()).into_iter().flatten() {
                    let a = s(r, "asset");
                    if !a.is_empty() {
                        out.push(Use { asset: a.into(), place: "legend", changes: changes(r, assets.get(a), &fx) });
                    }
                }
            }
            "image" => pics.push(Some(s(o, "name")).filter(|n| !n.trim().is_empty()).unwrap_or("Picture").to_string()),
            "group" => walk(children(o), assets, &fx, out, pics),
            _ => {}
        }
    }
}

/// What was changed from the library drawing (CC BY asks for changes to be indicated). Moving,
/// resizing, rotating and flipping are not changes to the drawing. Mirrored in ui/js/licence.js.
pub fn changes(o: &Value, asset: Option<&Value>, fx: &[&'static str]) -> Vec<&'static str> {
    let mut c = Vec::new();
    let (tint, preset) = (s(o, "tint"), s(o, "preset"));
    let parts = o.get("slotColors").and_then(|v| v.as_array()).is_some_and(|v| v.iter().any(|x| x.as_str().is_some_and(|c| !c.is_empty())));
    // the colour recipe before any saturation/lightness change
    let recipe = o.get("baseColors").filter(|v| v.is_object()).or_else(|| o.get("colors"));
    let mapped = recipe.and_then(|v| v.as_object()).is_some_and(|m| m.iter().any(|(k, v)| v.as_str().is_some_and(|v| !v.eq_ignore_ascii_case(k))));
    if tint == "gray" || preset == "gray" {
        c.push("greyscale");
    } else if !preset.is_empty() && preset != "original" {
        c.push("recoloured (style preset)");
    } else if !tint.is_empty() {
        c.push("colour overlay");
    } else if parts {
        c.push("recoloured parts");
    } else if mapped {
        c.push("recoloured");
    }
    if num(o, "saturation").is_some_and(|v| v != 100.0) {
        c.push("saturation changed");
    }
    if num(o, "lightness").is_some_and(|v| v != 0.0) {
        c.push("lightness changed");
    }
    if asset.is_some_and(|a| labels::has_labels(s(a, "svg"))) {
        match s(o, "labels") {
            "hidden" => c.push("built-in labels hidden"),
            "detached" => c.push("built-in labels made editable"),
            _ => {}
        }
    }
    for f in fx {
        add(&mut c, *f);
    }
    c
}

/* ---------- licences ---------- */

pub struct Lic {
    pub id: String,
    pub name: String,
    pub url: &'static str,
    pub attribution: bool,
    pub share_alike: bool,
    /// MIT/BSD: the copyright and licence notice must go with copies.
    pub notice: bool,
    /// CC BY family: changes must be indicated.
    pub mark_changes: bool,
    pub commercial: bool,
    pub summary: &'static str,
}

pub fn lic(id: &str) -> Lic {
    let (name, attribution, url) = license_info(id);
    let summary = match id {
        "CC-BY-4.0" => "Creative Commons Attribution 4.0 International. You may copy, adapt and use the icon for any purpose, including commercially, provided you give appropriate credit (the creator, the source and the licence, with a link to it), indicate if you changed it, and do not suggest that the creator endorses you or your work.",
        "CC-BY-3.0" => "Creative Commons Attribution 3.0. As CC BY 4.0: use for any purpose, including commercially, with credit to the creator and the licence; when you adapt the icon, the credit must make clear that your figure uses an adapted version of the original.",
        "CC-BY-SA-4.0" => "Creative Commons Attribution-ShareAlike 4.0. As CC BY 4.0 (credit, a link to the licence, indicate changes), and in addition anything you adapt from the icon must be shared under the same or a compatible licence (CC BY-SA 4.0).",
        "CC-BY-SA-3.0" => "Creative Commons Attribution-ShareAlike 3.0. As CC BY 3.0, and in addition adaptations must be shared under the same licence, a later version of it or a compatible one.",
        "CC0-1.0" => "Creative Commons CC0 1.0 Universal, a public-domain dedication: the creator has waived their copyright as far as the law allows, so the icon may be used for any purpose without asking or giving credit. A credit is still good scholarly practice.",
        "PD" => "Public domain: not protected by copyright, for example works of the US Government such as NIH BioArt (17 U.S.C. § 105) or works marked with the Public Domain Mark. No permission or credit is legally needed; NIAID asks to be credited as the source, and other rights such as trademarks can still apply.",
        "MIT" => "MIT License. Permission to use, copy, modify, publish, distribute and sell for any purpose, on condition that the copyright notice and the licence's permission notice are included with all copies or substantial portions. Provided as is, without warranty.",
        "BSD" => "BSD 3-Clause License. Use and redistribution, with or without changes, are permitted provided the copyright notice, the list of conditions and the disclaimer go with copies, and the names of the copyright holder and contributors are not used to endorse your work without permission.",
        "USER" => "Your own file: BioCraft has no licence information for it.",
        _ => "BioCraft has no record of this licence. Check the icon's source before publishing.",
    };
    Lic {
        id: id.to_string(),
        name: if name == "Unknown licence" && !id.is_empty() { format!("Unknown licence ({id})") } else { name.to_string() },
        url,
        attribution,
        share_alike: id.starts_with("CC-BY-SA") || id.contains("-SA-"),
        notice: matches!(id, "MIT" | "BSD"),
        mark_changes: id.starts_with("CC-BY"),
        commercial: !id.contains("-NC"),
        summary,
    }
}

/// The short form the figure legend uses: CC BY 4.0, CC BY-SA 4.0, CC0 1.0, public domain, MIT.
pub fn short(id: &str) -> String {
    if id == "PD" {
        return "public domain".into();
    }
    if let Some(rest) = id.strip_prefix("CC-") {
        let mut parts: Vec<&str> = rest.split('-').collect();
        let version = parts.last().filter(|v| v.parse::<f64>().is_ok()).copied();
        if version.is_some() {
            parts.pop();
        }
        return format!("CC {}{}", parts.join("-"), version.map(|v| format!(" {v}")).unwrap_or_default());
    }
    id.replace('-', " ")
}

/* ---------- the report's facts ---------- */

/// A library icon in the figure, with every use of it folded together.
pub struct Item<'a> {
    pub id: String,
    pub asset: &'a Value,
    pub meta: &'a Value,
    pub uses: usize,
    pub places: Vec<&'static str>,
    pub changes: Vec<&'static str>,
}

impl Item<'_> {
    fn name(&self) -> &str {
        Some(s(self.meta, "name")).filter(|n| !n.is_empty()).unwrap_or(&self.id)
    }
    fn pack_name(&self) -> &str {
        Some(s(self.meta, "packName")).filter(|n| !n.is_empty()).unwrap_or(s(self.meta, "pack"))
    }
    /// CC BY asks for changes to be indicated: this icon is credited as "adapted from".
    pub fn adapted(&self) -> bool {
        !self.changes.is_empty() && lic(s(self.meta, "license")).mark_changes
    }
}

/// Material that is not from the library: My library uploads, placed SVGs and pictures.
pub struct Own<'a> {
    pub kind: &'static str,
    pub name: String,
    pub uses: usize,
    pub asset: Option<&'a Value>,
}

pub struct Facts<'a> {
    pub icons: Vec<Item<'a>>,
    pub own: Vec<Own<'a>>,
    pub figure_id: String,
}

const RECOLOURS: [&str; 4] = ["greyscale", "recoloured (style preset)", "colour overlay", "recoloured parts"];

pub fn facts(doc: &Value) -> Facts<'_> {
    let (all, pics) = uses(doc);
    let assets = doc.get("assets").unwrap_or(&Value::Null);
    let mut icons: Vec<Item> = Vec::new();
    let mut own: Vec<Own> = Vec::new();
    for u in &all {
        let Some(asset) = assets.get(&u.asset).filter(|a| a.is_object()) else { continue };
        let meta = &asset["meta"];
        let pack = s(meta, "pack");
        if pack == "user" || pack == "file" || s(meta, "license") == "USER" {
            let kind = if pack == "file" { "Placed SVG" } else { "My library upload" };
            let name = Some(s(meta, "name")).filter(|n| !n.is_empty()).unwrap_or("Untitled").to_string();
            match own.iter_mut().find(|o| o.asset.is_some_and(|a| std::ptr::eq(a, asset))) {
                Some(o) => o.uses += 1,
                None => own.push(Own { kind, name, uses: 1, asset: Some(asset) }),
            }
            continue;
        }
        match icons.iter_mut().find(|i| i.id == u.asset) {
            Some(i) => {
                i.uses += 1;
                add(&mut i.places, u.place);
                for c in &u.changes {
                    add(&mut i.changes, *c);
                }
            }
            None => icons.push(Item { id: u.asset.clone(), asset, meta, uses: 1, places: vec![u.place], changes: u.changes.clone() }),
        }
    }
    // a legend row copies its icon's colours: "recoloured" says nothing more than the colour change
    for i in &mut icons {
        if i.changes.iter().any(|c| RECOLOURS.contains(c)) {
            i.changes.retain(|c| *c != "recoloured");
        }
    }
    for p in pics {
        match own.iter_mut().find(|o| o.asset.is_none() && o.name == p) {
            Some(o) => o.uses += 1,
            None => own.push(Own { kind: "Placed picture", name: p, uses: 1, asset: None }),
        }
    }
    // this exact figure: its objects and the icons they draw
    let mut objects = String::new();
    canon(doc.get("objects").unwrap_or(&Value::Null), &mut objects);
    let mut h = Sha256::new();
    h.update(objects.as_bytes());
    for u in &all {
        h.update(b"\n");
        h.update(u.asset.as_bytes());
    }
    let figure_id = h.finalize().iter().take(6).map(|b| format!("{b:02x}")).collect();
    Facts { icons, own, figure_id }
}

/// JSON with sorted keys and numbers to 0.0001 px, so a figure keeps its id however it was saved
/// and read back (JSON floats do not always survive a round trip to the last bit).
fn canon(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                canon(&m[k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canon(x, out);
            }
            out.push(']');
        }
        Value::Number(n) => {
            let r = (n.as_f64().unwrap_or(0.0) * 1e4).round() / 1e4;
            out.push_str(&if r == 0.0 { "0".to_string() } else { format!("{r}") });
        }
        v => out.push_str(&v.to_string()),
    }
}

/// The figure-legend credit line (the app's Credits tab writes the same words: panels.js
/// legendText). CC BY icons changed in the figure are credited as "adapted from …".
pub fn legend(doc: &Value) -> String {
    legend_for(&facts(doc).icons)
}

fn legend_for(icons: &[Item]) -> String {
    let mut packs: Vec<(&str, Vec<&Item>)> = Vec::new();
    for i in icons {
        let p = s(i.meta, "pack");
        match packs.iter_mut().find(|x| x.0 == p) {
            Some(x) => x.1.push(i),
            None => packs.push((p, vec![i])),
        }
    }
    let uniq = |v: Vec<String>| -> Vec<String> {
        let mut out = Vec::new();
        for x in v {
            add(&mut out, x);
        }
        out
    };
    let mut parts = Vec::new();
    for (pack, items) in &packs {
        match *pack {
            "nih" => {
                let urls = uniq(items.iter().map(|i| { let u = s(i.meta, "source_url"); u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).unwrap_or(u).to_string() }).filter(|u| !u.is_empty()).collect());
                parts.push(format!("illustrations from NIAID NIH BioArt Source ({})", urls.join(", ")));
            }
            "servier" => {
                let lics = uniq(items.iter().map(|i| s(i.meta, "license").replacen("CC-BY-", "", 1)).collect());
                let plain = uniq(items.iter().filter(|i| !i.adapted()).map(|i| i.name().to_string()).collect());
                let adapted = uniq(items.iter().filter(|i| i.adapted()).map(|i| i.name().to_string()).collect());
                let mut names = Vec::new();
                if !plain.is_empty() {
                    names.push(plain.join(", "));
                }
                if !adapted.is_empty() {
                    names.push(format!("adapted from {}", adapted.join(", ")));
                }
                parts.push(format!("Servier Medical Art (smart.servier.com), licensed under CC BY {} ({})", lics.join("/"), names.join("; ")));
            }
            "biocanvas" => parts.push("BioCraft Originals (CC0)".into()),
            _ => {
                let group = items[0].pack_name().to_string();
                let mut by: Vec<(String, String, bool, Vec<String>)> = Vec::new(); // author, licence, adapted, names
                for i in items {
                    let author = Some(s(i.meta, "author")).filter(|a| !a.is_empty()).unwrap_or(&group).to_string();
                    let (l, ad) = (s(i.meta, "license").to_string(), i.adapted());
                    match by.iter_mut().find(|b| b.0 == author && b.1 == l && b.2 == ad) {
                        Some(b) => add(&mut b.3, i.name().to_string()),
                        None => by.push((author, l, ad, vec![i.name().to_string()])),
                    }
                }
                let list: Vec<String> = by.iter().map(|(author, l, ad, names)| format!("{}{} by {author} ({})", if *ad { "adapted from " } else { "" }, names.join(", "), short(l))).collect();
                parts.push(format!("{group}: {}", list.join("; ")));
            }
        }
    }
    if parts.is_empty() { "Figure created with BioCraft.".into() } else { format!("Created with BioCraft using {}.", parts.join("; ")) }
}

/* ---------- the report ---------- */

/// What the report says about the export itself.
#[derive(Default)]
pub struct Header {
    /// The figure's title or file name.
    pub title: String,
    /// Date, time and UTC offset of the export.
    pub exported_at: String,
    /// The exported file: format, size, pixels and DPI (see `export_line`).
    pub export: String,
    pub prepared_by: String,
    /// Where the figure will be published (all optional).
    pub publication: Publication,
    /// The exported figure as SVG, shown on the report's first page.
    pub figure_svg: Option<String>,
}

/// Where the figure is going: asked for in the Export dialog and kept in the figure as
/// `publication` {journal, manuscript, figureTitle, openAccess, date}, or passed by an agent.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct Publication {
    pub journal: String,
    pub manuscript: String,
    pub figure_title: String,
    /// "cc-by" (open access under CC BY), "oa-other" (open access under another licence),
    /// "subscription", or "" (not decided)
    pub access: String,
    pub date: String,
}

impl Publication {
    pub fn from_json(v: Option<&Value>) -> Self {
        let Some(v) = v.filter(|v| v.is_object()) else { return Self::default() };
        let g = |ks: &[&str]| ks.iter().find_map(|k| v.get(*k).and_then(|x| x.as_str())).unwrap_or("").trim().to_string();
        let access = match g(&["openAccess", "open_access", "access"]).to_lowercase().as_str() {
            "cc-by" | "cc by" | "ccby" | "cc_by" | "yes" => "cc-by",
            "oa-other" | "other" | "open-other" => "oa-other",
            "subscription" | "no" | "closed" => "subscription",
            _ => "",
        };
        Publication {
            journal: g(&["journal", "publisher"]),
            manuscript: g(&["manuscript", "manuscriptNumber", "manuscript_number"]),
            figure_title: g(&["figureTitle", "figure_title"]),
            access: access.to_string(),
            date: g(&["date", "publicationDate", "publication_date"]),
        }
    }
    pub fn is_empty(&self) -> bool {
        [&self.journal, &self.manuscript, &self.figure_title, &self.access, &self.date].iter().all(|v| v.is_empty())
    }
    pub fn access_label(&self) -> &'static str {
        match self.access.as_str() {
            "cc-by" => "Open access under CC BY",
            "oa-other" => "Open access under another licence (e.g. CC BY-NC)",
            "subscription" => "Subscription (copyright transfer or exclusive licence to the publisher)",
            _ => "",
        }
    }
    /// The report's rows for these details, the empty ones left out.
    fn rows(&self) -> Vec<(&'static str, String)> {
        [("Journal", self.journal.clone()), ("Manuscript", self.manuscript.clone()), ("Article licence", self.access_label().to_string()), ("Publication", self.date.clone())]
            .into_iter()
            .filter(|(_, v)| !v.is_empty())
            .collect()
    }
}

/// Whether the icons' licences fit where the figure is going, as (warning?, sentence); None
/// when no publication details were given. The one real conflict is share-alike (CC BY-SA)
/// material in an article that is not itself CC BY-SA.
pub fn publication_check(f: &Facts, p: &Publication) -> Option<(bool, String)> {
    if p.is_empty() {
        return None;
    }
    let journal = if p.journal.is_empty() { "the journal".to_string() } else { p.journal.clone() };
    let sa: Vec<&Item> = f.icons.iter().filter(|i| lic(s(i.meta, "license")).share_alike).collect();
    let nc: Vec<&Item> = f.icons.iter().filter(|i| !lic(s(i.meta, "license")).commercial).collect();
    let them = |v: &Vec<&Item>| if v.len() == 1 { "it" } else { "them" };
    let sa_note = |why: &str| {
        format!(
            "{} ({}) {} CC BY-SA: anything adapted from {} must be shared under CC BY-SA, {why}. Replace {} with CC BY or CC0 icons (the library's “No share-alike” licence filter) or check with {journal}.",
            plural(sa.len(), "icon", "icons"), names(&sa), if sa.len() == 1 { "is" } else { "are" }, them(&sa), them(&sa)
        )
    };
    let (mut warn, mut text) = match p.access.as_str() {
        "cc-by" if sa.is_empty() => (false, format!("Publication in {journal}, open access under CC BY: compatible. Every icon's licence allows the figure to be published, and reused by readers, under CC BY, with the credit in the legend.")),
        "cc-by" => (true, format!("Publication in {journal}, open access under CC BY: {}", sa_note("not CC BY"))),
        "oa-other" if sa.is_empty() => (false, format!("Publication in {journal}, open access under another licence: compatible. The icons' licences are more permissive than the article's, and the credit in the legend keeps their own terms visible.")),
        "oa-other" => (true, format!("Publication in {journal}, open access under another licence: {}", sa_note("not the article's licence"))),
        "subscription" if sa.is_empty() => (false, format!("Publication in {journal} (subscription): compatible. You transfer or license only your own contribution; the icons stay under their open licences, which allow this use with the credit in the legend. If the publisher asks about third-party material, it is openly licensed and credited in the legend.")),
        "subscription" => (true, format!("Publication in {journal} (subscription): {}", sa_note("which an exclusive licence to the publisher cannot honour"))),
        _ if sa.is_empty() => (false, format!("Publication in {journal}: every icon's licence allows publication, including open access under CC BY, with the credit in the legend.")),
        _ => (true, format!("Publication in {journal}: {}", sa_note("so an article under CC BY or an exclusive licence would conflict"))),
    };
    if !nc.is_empty() {
        warn = true;
        text += &format!(" {} ({}) {} under a non-commercial licence, which may not suit a commercial publisher.", plural(nc.len(), "icon", "icons"), names(&nc), if nc.len() == 1 { "is" } else { "are" });
    }
    Some((warn, text))
}

/// A plain statement of what the report records, for an editor reading it.
fn statement(h: &Header, f: &Facts) -> String {
    let title = if h.publication.figure_title.is_empty() { h.title.clone() } else { h.publication.figure_title.clone() };
    let where_ = if h.publication.journal.is_empty() { String::new() } else { format!(" in {}", h.publication.journal) };
    if f.icons.is_empty() {
        return format!("The figure “{title}” (Figure ID {}) contains no illustrations from the BioCraft library{}.", f.figure_id, if f.own.is_empty() { "" } else { "; its other material is the author's own or third-party material listed below" });
    }
    let mut packs = Vec::new();
    for i in &f.icons {
        add(&mut packs, i.pack_name());
    }
    let sa = f.icons.iter().any(|i| lic(s(i.meta, "license")).share_alike);
    let notice = f.icons.iter().any(|i| lic(s(i.meta, "license")).notice);
    let commercial = f.icons.iter().all(|i| lic(s(i.meta, "license")).commercial);
    format!(
        "The figure “{title}” (Figure ID {}) was made with BioCraft. It contains {} from {}, each used under the open licence chosen by its author or publisher and listed in this report. These licences allow the figure to be published{where_}{}{}, provided the credit below appears in the figure legend{}.{} BioCraft does not grant a licence, and none is needed from it: this statement records the icons' own licences and what they ask of you.",
        f.figure_id,
        plural(f.icons.len(), "illustration", "illustrations"),
        plural(packs.len(), "open library", "open libraries"),
        if sa { "" } else { ", including open access under CC BY" },
        if commercial { " and used commercially" } else { "" },
        if notice { " and the MIT/BSD licence notices accompany it" } else { "" },
        if sa { " The share-alike (CC BY-SA) icons need the figure to stay under CC BY-SA; see the summary." } else { "" },
    )
}

/// Now, as `2026-10-20 08:15 UTC+10:30`.
pub fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M UTC%:z").to_string()
}

fn thousands(n: u64) -> String {
    let d = n.to_string();
    let mut out = String::new();
    for (i, c) in d.chars().enumerate() {
        if i > 0 && (d.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `PNG · 178.0 × 100.0 mm · 2,102 × 1,181 px at 300 dpi`; an empty format = report only.
pub fn export_line(format: &str, dpi: f64, w_mm: f64, h_mm: f64) -> String {
    let size = format!("{w_mm:.1} × {h_mm:.1} mm");
    match format {
        "png" | "tiff" => {
            let px = |mm: f64| thousands((mm / 25.4 * dpi).round().max(1.0) as u64);
            format!("{} · {size} · {} × {} px at {} dpi", format.to_uppercase(), px(w_mm), px(h_mm), dpi.round())
        }
        "pdf" => format!("PDF (vector) · {size}"),
        "svg" => format!("SVG (vector) · {size}"),
        _ => format!("Report only, no image exported · figure {size}"),
    }
}

/// The report's sections as plain facts and sentences, shared by the PDF and the Markdown.
struct Text {
    summary: Vec<(bool, String)>, // (warning?, sentence)
    notices: Vec<(String, Vec<String>, &'static str)>, // (licence name, copyright holders, licence text)
    glossary: Vec<Lic>,
}

const OWN_NOTE: &str = "Your own or third-party material: BioCraft has no licence information for it. Make sure you hold the rights to use it, and credit it as its licence requires.";
const DISCLAIMER: &str = "BioCraft does not grant licences. Every library icon remains under the licence chosen by its author or publisher, as recorded above, and this report only documents those licences and what they ask of you. It is a convenience generated from the BioCraft library's records, not legal advice. If in doubt, check the original source of each icon and your publisher's requirements.";
const MIT_TEXT: &str = "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.";
const BSD_TEXT: &str = "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.";

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn names(items: &[&Item]) -> String {
    let v: Vec<&str> = items.iter().map(|i| i.name()).collect();
    if v.len() > 12 { format!("{} and {} more", v[..12].join(", "), v.len() - 12) } else { v.join(", ") }
}

fn text(f: &Facts, p: &Publication) -> Text {
    let icons = &f.icons;
    let mut summary = Vec::new();
    if let Some(c) = publication_check(f, p) {
        summary.push(c);
    }
    let mut lics: Vec<(String, usize)> = Vec::new();
    for i in icons {
        let l = s(i.meta, "license").to_string();
        match lics.iter_mut().find(|x| x.0 == l) {
            Some(x) => x.1 += 1,
            None => lics.push((l, 1)),
        }
    }
    lics.sort_by(|a, b| b.1.cmp(&a.1));
    let mut packs = Vec::new();
    for i in icons {
        add(&mut packs, i.pack_name());
    }
    let uses: usize = icons.iter().map(|i| i.uses).sum();
    if icons.is_empty() {
        summary.push((false, "No library icons are used in this figure.".to_string()));
    } else {
        summary.push((false, format!("{} from {} ({}), drawn {} in the figure.", plural(icons.len(), "library icon", "library icons"), plural(packs.len(), "source", "sources"), packs.join(", "), plural(uses, "time", "times"))));
        summary.push((false, format!("Licences: {}.", lics.iter().map(|(l, n)| format!("{} ({})", if l == "CC0-1.0" { "CC0 1.0".to_string() } else { lic(l).name }, plural(*n, "icon", "icons"))).collect::<Vec<_>>().join(", "))));
        let attr: Vec<&Item> = icons.iter().filter(|i| lic(s(i.meta, "license")).attribution).collect();
        summary.push((false, if attr.is_empty() {
            "Attribution required: no. Every icon is public domain or CC0; citing the sources is still good practice (the credit below is ready to paste).".to_string()
        } else {
            format!("Attribution required: yes, for {}. Put the figure-legend credit below in the legend or the acknowledgements.", plural(attr.len(), "icon", "icons"))
        }));
        let nc: Vec<&Item> = icons.iter().filter(|i| !lic(s(i.meta, "license")).commercial).collect();
        let open_ok = !icons.iter().any(|i| lic(s(i.meta, "license")).share_alike);
        summary.push(if nc.is_empty() {
            (false, format!("Allowed by every icon's licence: teaching, publication in journals, books and websites{}, and commercial use, under the conditions in this summary.", if open_ok { " (including open access under CC BY)" } else { "" }))
        } else {
            (true, format!("Commercial use: NOT allowed for {} ({}) under a non-commercial licence. Replace them before any commercial use.", plural(nc.len(), "icon", "icons"), names(&nc)))
        });
        let sa: Vec<&Item> = icons.iter().filter(|i| lic(s(i.meta, "license")).share_alike).collect();
        if !sa.is_empty() {
            summary.push((true, format!("Share-alike: {} ({}) {} CC BY-SA. If you change {} or the figure counts as an adaptation of {}, the figure must be shared under CC BY-SA (or a compatible licence). Check that your journal accepts this, or replace {} with CC BY or CC0 icons.", plural(sa.len(), "icon", "icons"), names(&sa), if sa.len() == 1 { "is" } else { "are" }, if sa.len() == 1 { "it" } else { "them" }, if sa.len() == 1 { "it" } else { "them" }, if sa.len() == 1 { "it" } else { "them" })));
        }
        let nt: Vec<&Item> = icons.iter().filter(|i| lic(s(i.meta, "license")).notice).collect();
        if !nt.is_empty() {
            summary.push((true, format!("Licence notices: {} ({}) {} under MIT or BSD terms, which ask for the copyright and licence notice to go with the figure, for example in the supplementary material. The notices are under \u{201c}Licence notices\u{201d} below.", plural(nt.len(), "icon", "icons"), names(&nt), if nt.len() == 1 { "is" } else { "are" })));
        }
        let changed: Vec<&Item> = icons.iter().filter(|i| !i.changes.is_empty()).collect();
        if !changed.is_empty() {
            let list = changed.iter().take(12).map(|i| format!("{} ({})", i.name(), i.changes.join(", "))).collect::<Vec<_>>().join("; ");
            let more = if changed.len() > 12 { format!("; and {} more (see the table)", changed.len() - 12) } else { String::new() };
            let marked = changed.iter().any(|i| i.adapted());
            summary.push((marked, format!("Changed icons: {list}{more}.{}", if marked { " CC BY asks you to indicate changes, so the credit below says \u{201c}adapted from\u{201d} for those icons." } else { " Their licences do not ask for changes to be indicated." })));
        } else {
            summary.push((false, "Changed icons: none; every icon is drawn as in the library (moving, resizing, rotating and flipping are not changes).".to_string()));
        }
    }
    if !f.own.is_empty() {
        summary.push((true, format!("Your own material: {} (see below). Make sure you hold the rights to use {}.", plural(f.own.len(), "item", "items"), if f.own.len() == 1 { "it" } else { "them" })));
    }
    let mut notices = Vec::new();
    for (id, text) in [("MIT", MIT_TEXT), ("BSD", BSD_TEXT)] {
        let mut holders = Vec::new();
        for i in icons.iter().filter(|i| s(i.meta, "license") == id) {
            add(&mut holders, Some(s(i.meta, "author")).filter(|a| !a.is_empty()).unwrap_or(i.pack_name()).to_string());
        }
        if !holders.is_empty() {
            notices.push((lic(id).name, holders, text));
        }
    }
    let mut glossary: Vec<Lic> = Vec::new();
    for (l, _) in &lics {
        if !glossary.iter().any(|g| &g.id == l) {
            glossary.push(lic(l));
        }
    }
    Text { summary, notices, glossary }
}

/* ---------- Markdown and CSV ---------- */

fn md(t: &str) -> String {
    let mut o = String::with_capacity(t.len());
    for c in t.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '#') {
            o.push('\\');
        }
        o.push(if c == '\n' { ' ' } else { c });
    }
    o
}

pub fn markdown(h: &Header, f: &Facts) -> String {
    let t = text(f, &h.publication);
    let mut o = String::from("# Licence & attribution report\n\n");
    let title = if h.publication.figure_title.is_empty() { &h.title } else { &h.publication.figure_title };
    let mut meta = vec![("Figure", md(title))];
    meta.extend(h.publication.rows().into_iter().map(|(k, v)| (k, md(&v))));
    meta.extend([("Exported", md(&h.exported_at)), ("File", md(&h.export)), ("Figure ID", format!("`{}` (first 12 hex digits of the SHA-256 of the figure's objects and icons)", f.figure_id)), ("Made with", format!("BioCraft {}", env!("CARGO_PKG_VERSION")))]);
    if !h.prepared_by.trim().is_empty() {
        meta.push(("Prepared by", md(h.prepared_by.trim())));
    }
    for (k, v) in meta.into_iter().filter(|(_, v)| !v.is_empty()) {
        o += &format!("**{k}:** {v}  \n");
    }
    o += &format!("\n{}\n", md(&statement(h, f)));
    o += "\n## Summary\n\n";
    for (warn, line) in &t.summary {
        o += &format!("- {}{}\n", if *warn { "\u{26a0}\u{fe0f} " } else { "" }, md(line));
    }
    o += "\n## Figure-legend credit (ready to paste)\n\n";
    o += &format!("> {}\n", md(&legend_for(&f.icons)));
    if !f.icons.is_empty() {
        o += "\n## Icons used\n\n| # | Icon | Library id | Source | Author | Licence | Source URL | Uses | Where | Changes |\n|---|---|---|---|---|---|---|---|---|---|\n";
        for (n, i) in f.icons.iter().enumerate() {
            let l = lic(s(i.meta, "license"));
            let url = s(i.meta, "source_url");
            o += &format!(
                "| {} | {} | `{}` | {} | {} | {} | {} | {} | {} | {} |\n",
                n + 1,
                md(i.name()),
                i.id.replace('`', "'"),
                md(i.pack_name()),
                md(s(i.meta, "author")),
                if l.url.is_empty() { md(&l.name) } else { format!("[{}]({})", md(&l.name), l.url) },
                if url.is_empty() { String::new() } else { format!("<{url}>") },
                i.uses,
                i.places.join(", "),
                if i.changes.is_empty() { "none".to_string() } else { i.changes.join(", ") }
            );
        }
    }
    if !f.own.is_empty() {
        o += "\n## Your own material\n\n";
        o += &format!("{}\n\n", md(OWN_NOTE));
        for x in &f.own {
            o += &format!("- {}: {} (used {})\n", x.kind, md(&x.name), plural(x.uses, "time", "times"));
        }
    }
    if !t.notices.is_empty() {
        o += "\n## Licence notices\n\nInclude these notices with the figure, for example in the supplementary material.\n";
        for (name, holders, body) in &t.notices {
            o += &format!("\n### {name}\n\n```\n");
            for hd in holders {
                o += &format!("Copyright (c) {hd}\n");
            }
            o += &format!("\n{body}\n```\n");
        }
    }
    if !t.glossary.is_empty() {
        o += "\n## What the licences mean\n\n";
        for g in &t.glossary {
            o += &format!("- **{}**{}: {}\n", md(&g.name), if g.url.is_empty() { String::new() } else { format!(" (<{}>)", g.url) }, md(g.summary));
        }
    }
    o += &format!("\n## Disclaimer\n\n{}\n", md(DISCLAIMER));
    o
}

fn csv_field(v: &str) -> String {
    // a leading = + - @ would make a spreadsheet read the cell as a formula
    let v = if v.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{v}") } else { v.to_string() };
    if v.contains([',', '"', '\n', '\r']) { format!("\"{}\"", v.replace('"', "\"\"")) } else { v }
}

pub fn csv(f: &Facts) -> String {
    let mut o = String::from("figure_id,icon_id,name,source,author,licence,licence_name,licence_url,attribution_required,share_alike,source_url,uses,where,changes\n");
    let row = |cells: &[&str]| cells.iter().map(|c| csv_field(c)).collect::<Vec<_>>().join(",") + "\n";
    for i in &f.icons {
        let l = lic(s(i.meta, "license"));
        let uses = i.uses.to_string();
        o += &row(&[&f.figure_id, &i.id, i.name(), i.pack_name(), s(i.meta, "author"), &l.id, &l.name, l.url, if l.attribution { "yes" } else { "no" }, if l.share_alike { "yes" } else { "no" }, s(i.meta, "source_url"), &uses, &i.places.join("; "), &i.changes.join("; ")]);
    }
    for x in &f.own {
        let uses = x.uses.to_string();
        let id = x.asset.map(|a| s(&a["meta"], "id")).unwrap_or("");
        o += &row(&[&f.figure_id, id, &x.name, x.kind, "", "USER", "Your own material", "", "check", "check", "", &uses, "", ""]);
    }
    o
}

/* ---------- PDF ---------- */

struct Face {
    data: Vec<u8>,
    index: u32,
}

/// Text widths from the font the PDF embeds, so lines can be wrapped before they are drawn.
pub struct Fonts {
    family: String,
    faces: [Option<Face>; 2],
    cache: RefCell<HashMap<(bool, char), f64>>,
}

impl Fonts {
    pub fn new(r: &Renderer) -> Self {
        use usvg::fontdb::{Family, Query, Stretch, Style, Weight};
        let db = &r.fontdb;
        let fams = [Family::Name("Arial"), Family::Name("Helvetica"), Family::Name("Liberation Sans"), Family::Name("DejaVu Sans"), Family::SansSerif];
        let find = |weight| db.query(&Query { families: &fams, weight, stretch: Stretch::Normal, style: Style::Normal });
        let load = |id| db.with_face_data(id, |d, index| Face { data: d.to_vec(), index });
        let regular = find(Weight::NORMAL);
        let family = regular.and_then(|id| db.face(id)).and_then(|f| f.families.first().map(|x| x.0.clone())).unwrap_or_else(|| "sans-serif".into());
        Fonts { family, faces: [regular.and_then(load), find(Weight::BOLD).and_then(load)], cache: RefCell::new(HashMap::new()) }
    }

    fn advance(&self, bold: bool, c: char) -> f64 {
        if let Some(v) = self.cache.borrow().get(&(bold, c)) {
            return *v;
        }
        let v = self.faces[bold as usize]
            .as_ref()
            .or(self.faces[0].as_ref())
            .and_then(|f| ttf_parser::Face::parse(&f.data, f.index).ok())
            .and_then(|face| Some(face.glyph_hor_advance(face.glyph_index(c)?)? as f64 / face.units_per_em() as f64))
            .unwrap_or(if c == ' ' { 0.28 } else { 0.56 });
        self.cache.borrow_mut().insert((bold, c), v);
        v
    }

    pub fn width(&self, t: &str, size: f64, bold: bool) -> f64 {
        t.chars().map(|c| self.advance(bold, c)).sum::<f64>() * size
    }

    /// Lines no wider than `width`; a word wider than a line (a URL, an id) breaks between
    /// characters, after a / - _ . where it can.
    pub fn wrap(&self, t: &str, width: f64, size: f64, bold: bool) -> Vec<String> {
        let mut lines = Vec::new();
        for para in t.split('\n') {
            let mut line = String::new();
            for word in para.split(' ').filter(|w| !w.is_empty()) {
                let cand = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
                if self.width(&cand, size, bold) <= width {
                    line = cand;
                    continue;
                }
                if !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                }
                let mut w = word.to_string();
                while self.width(&w, size, bold) > width {
                    let mut x = 0.0;
                    let mut cut = w.len();
                    for (i, c) in w.char_indices() {
                        x += self.advance(bold, c) * size;
                        if x > width {
                            cut = if i == 0 { c.len_utf8() } else { i };
                            break;
                        }
                    }
                    let at = w[..cut].rfind(|c: char| "/-_.?&=".contains(c)).map(|i| i + 1).filter(|&i| i > cut / 2).unwrap_or(cut);
                    lines.push(w[..at].to_string());
                    w = w[at..].to_string();
                }
                line = w;
            }
            lines.push(line);
        }
        lines
    }
}

fn xml(t: &str) -> String {
    let mut o = String::with_capacity(t.len());
    for c in t.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            c if (c as u32) < 0x20 && c != '\t' => o.push(' '),
            c => o.push(c),
        }
    }
    o
}

// A4 in points
const PW: f64 = 595.28;
const PH: f64 = 841.89;
const ML: f64 = 46.0;
const CW: f64 = PW - 2.0 * ML;
const TOP: f64 = 46.0;
const FOOT: f64 = PH - 34.0;
const BOTTOM: f64 = FOOT - 22.0;

const INK: &str = "#1c2733";
const MUTED: &str = "#5b6876";
const ACCENT: &str = "#1e7f95";
const WARN: &str = "#9a4d00";
const RULE: &str = "#d3dbe3";
const SHADE: &str = "#f1f5f8";

/// One styled run of text inside a table cell.
struct Run {
    text: String,
    size: f64,
    bold: bool,
    color: &'static str,
}

fn run(text: impl Into<String>, size: f64, bold: bool, color: &'static str) -> Run {
    Run { text: text.into(), size, bold, color }
}

struct Book<'f> {
    f: &'f Fonts,
    pages: Vec<String>,
    cur: String,
    y: f64,
}

impl<'f> Book<'f> {
    fn new_page(&mut self) {
        self.pages.push(std::mem::take(&mut self.cur));
        self.y = TOP;
    }
    /// Start a new page unless `h` more points fit on this one.
    fn room(&mut self, h: f64) {
        if self.y + h > BOTTOM && self.y > TOP + 1.0 {
            self.new_page();
        }
    }
    fn text(&mut self, x: f64, baseline: f64, t: &str, size: f64, bold: bool, color: &str, anchor: &str) {
        self.cur += &format!(
            "<text x=\"{x:.2}\" y=\"{baseline:.2}\" font-family=\"{}\" font-size=\"{size}\" font-weight=\"{}\" fill=\"{color}\"{} xml:space=\"preserve\">{}</text>",
            xml(&self.f.family),
            if bold { 700 } else { 400 },
            if anchor.is_empty() { String::new() } else { format!(" text-anchor=\"{anchor}\"") },
            xml(t)
        );
    }
    /// A wrapped paragraph `w` wide at `x`, breaking pages between lines.
    fn para(&mut self, t: &str, x: f64, w: f64, size: f64, bold: bool, color: &str) {
        let lh = size * 1.36;
        for line in self.f.wrap(t, w, size, bold) {
            self.room(lh);
            self.text(x, self.y + size * 1.02, &line, size, bold, color, "");
            self.y += lh;
        }
    }
    fn heading(&mut self, t: &str) {
        self.room(70.0); // keep a heading with what follows it
        self.y += 16.0;
        self.text(ML, self.y + 11.0, t, 11.5, true, INK, "");
        self.y += 16.0;
        self.cur += &format!("<rect x=\"{ML}\" y=\"{:.2}\" width=\"{CW}\" height=\"0.8\" fill=\"{ACCENT}\"/>", self.y);
        self.y += 8.0;
    }
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, fill: &str, stroke: &str, r: f64) {
        self.cur += &format!(
            "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" rx=\"{r}\" fill=\"{fill}\"{}/>",
            if stroke.is_empty() { String::new() } else { format!(" stroke=\"{stroke}\" stroke-width=\"0.7\"") }
        );
    }

    fn table_header(&mut self, cols: &[(&str, f64)]) {
        let mut x = ML;
        self.rect(ML, self.y, CW, 16.0, SHADE, "", 0.0);
        for (t, w) in cols {
            self.text(x + 4.0, self.y + 11.0, t, 7.0, true, MUTED, "");
            x += w;
        }
        self.y += 16.0;
    }

    /// A table with wrapped cells; `cols` are (title, width); a row's first cell may hold a
    /// thumbnail (an `<svg>` drawn into a 24 pt square). The header repeats on each page.
    fn table(&mut self, cols: &[(&str, f64)], rows: Vec<(Option<String>, Vec<Vec<Run>>)>) {
        const PAD: f64 = 4.0;
        const THUMB: f64 = 24.0;
        // the first column holds the thumbnails when it has no title
        let first = if cols[0].0.is_empty() { 1 } else { 0 };
        self.room(16.0 + THUMB + 2.0 * PAD);
        self.table_header(cols);
        for (n, (thumb, cells)) in rows.into_iter().enumerate() {
            // lay every cell out first: the row is as tall as its tallest cell
            let laid: Vec<Vec<(String, &Run)>> = cells
                .iter()
                .zip(cols.iter().skip(first))
                .map(|(runs, (_, w))| runs.iter().flat_map(|r| self.f.wrap(&r.text, w - 2.0 * PAD, r.size, r.bold).into_iter().map(move |l| (l, r))).collect())
                .collect();
            let h = laid.iter().map(|c| c.iter().map(|(_, r)| r.size * 1.3).sum::<f64>()).fold(THUMB, f64::max) + 2.0 * PAD;
            if self.y + h > BOTTOM {
                self.new_page();
                self.table_header(cols);
            }
            if n % 2 == 1 {
                self.rect(ML, self.y, CW, h, "#f8fafb", "", 0.0);
            }
            let mut x = ML;
            if first == 1 {
                if let Some(t) = &thumb {
                    self.cur += &format!("<g transform=\"translate({:.2} {:.2})\">{t}</g>", x + (cols[0].1 - THUMB) / 2.0, self.y + PAD);
                }
                x += cols[0].1;
            }
            for (c, lines) in laid.iter().enumerate() {
                let mut y = self.y + PAD;
                for (l, r) in lines {
                    y += r.size * 1.3;
                    self.text(x + PAD, y - r.size * 0.28, l, r.size, r.bold, r.color, "");
                }
                x += cols[first + c].1;
            }
            self.y += h;
            self.cur += &format!("<rect x=\"{ML}\" y=\"{:.2}\" width=\"{CW}\" height=\"0.4\" fill=\"{RULE}\"/>", self.y - 0.4);
        }
    }
}

/// A library drawing scaled into a `size` square, ids made unique with `prefix`.
fn thumb(asset: &Value, size: f64, prefix: &str) -> String {
    let (vb, inner) = asset_parts(asset);
    format!(
        "<svg width=\"{size}\" height=\"{size}\" viewBox=\"{} {} {} {}\" preserveAspectRatio=\"xMidYMid meet\">{}</svg>",
        vb[0], vb[1], vb[2], vb[3],
        icon_inner(inner, None, prefix)
    )
}

/** Value of attribute `name` in an SVG start tag. */
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let i = tag.find(&format!(" {name}=\""))? + name.len() + 3;
    Some(&tag[i..i + tag[i..].find('"')?])
}

/// The exported figure scaled to fit a w × h box at (x, y), centred across the box; returns the
/// nested `<svg>` and the height it takes. Its ids are made unique so they can't clash.
fn figure_box(svg: &str, x: f64, y: f64, w: f64, h: f64) -> Option<(String, f64)> {
    let start = svg.find("<svg")?;
    let end = start + svg[start..].find('>')?;
    let close = svg.rfind("</svg>").filter(|c| *c > end)?;
    let vb: Vec<f64> = attr(&svg[start..=end], "viewBox")?.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()).filter_map(|t| t.parse().ok()).collect();
    if vb.len() != 4 || vb[2] <= 0.0 || vb[3] <= 0.0 {
        return None;
    }
    let k = (w / vb[2]).min(h / vb[3]);
    let (fw, fh) = (vb[2] * k, vb[3] * k);
    let inner = icon_inner(&svg[end + 1..close], None, "fig-");
    Some((
        format!("<svg x=\"{:.2}\" y=\"{y:.2}\" width=\"{fw:.2}\" height=\"{fh:.2}\" viewBox=\"{} {} {} {}\" preserveAspectRatio=\"xMidYMid meet\">{inner}</svg>", x + (w - fw) / 2.0, vb[0], vb[1], vb[2], vb[3]),
        fh,
    ))
}

const LOGO: &str = include_str!("../../ui/img/biocraft-logo.svg");

fn logo(x: f64, y: f64, h: f64) -> String {
    let open = LOGO.find("<svg").and_then(|i| LOGO[i..].find('>').map(|j| i + j + 1)).unwrap_or(0);
    let close = LOGO.rfind("</svg>").unwrap_or(LOGO.len());
    let inner = icon_inner(&LOGO[open..close], None, "logo-");
    format!("<svg x=\"{x}\" y=\"{y}\" width=\"{:.2}\" height=\"{h}\" viewBox=\"0 0 1060 300\">{inner}</svg>", h * 1060.0 / 300.0)
}

/// The report as A4 pages, each a standalone SVG in points.
pub fn pages(h: &Header, f: &Facts, r: &Renderer) -> Vec<String> {
    let fonts = Fonts::new(r);
    let t = text(f, &h.publication);
    let mut b = Book { f: &fonts, pages: Vec::new(), cur: String::new(), y: TOP };

    // header
    b.cur += &logo(ML, TOP - 4.0, 30.0);
    b.text(PW - ML, TOP + 9.0, "Licence & attribution report", 15.0, true, INK, "end");
    b.text(PW - ML, TOP + 23.0, &format!("Figure ID {}", f.figure_id), 8.5, false, MUTED, "end");
    b.y = TOP + 40.0;
    b.cur += &format!("<rect x=\"{ML}\" y=\"{:.2}\" width=\"{CW}\" height=\"1.2\" fill=\"{ACCENT}\"/>", b.y);
    b.y += 12.0;
    let title = if h.publication.figure_title.is_empty() { h.title.clone() } else { h.publication.figure_title.clone() };
    let mut meta: Vec<(&str, String)> = vec![("Figure", title)];
    meta.extend(h.publication.rows());
    meta.extend([("Exported", h.exported_at.clone()), ("File", h.export.clone()), ("Figure ID", format!("{}  (first 12 hex digits of the SHA-256 of the figure's objects and icons)", f.figure_id)), ("Made with", format!("BioCraft {}", env!("CARGO_PKG_VERSION")))]);
    if !h.prepared_by.trim().is_empty() {
        meta.push(("Prepared by", h.prepared_by.trim().to_string()));
    }
    for (k, v) in meta.into_iter().filter(|(_, v)| !v.is_empty()) {
        let y0 = b.y;
        b.text(ML, y0 + 9.0, k, 8.0, true, MUTED, "");
        b.para(&v, ML + 78.0, CW - 78.0, 9.0, k == "Figure", INK);
        b.y = b.y.max(y0 + 12.5) + 1.5;
    }

    // the statement, then the figure it covers
    b.y += 8.0;
    b.para(&statement(h, f), ML, CW, 9.0, false, INK);
    if let Some(fsvg) = h.figure_svg.as_deref() {
        if let Some((_, fh)) = figure_box(fsvg, 0.0, 0.0, CW - 16.0, 210.0) {
            b.y += 10.0;
            b.room(fh + 18.0);
            let top = b.y;
            b.rect(ML, top, CW, fh + 16.0, "#ffffff", RULE, 4.0);
            if let Some((svg, _)) = figure_box(fsvg, ML + 8.0, top + 8.0, CW - 16.0, 210.0) {
                b.cur += &svg;
            }
            b.y = top + fh + 16.0;
        }
    }

    // summary box
    b.y += 10.0;
    let size = 8.8;
    let lh = size * 1.36;
    let inner_w = CW - 2.0 * 12.0 - 10.0;
    let lines: Vec<(bool, Vec<String>)> = t.summary.iter().map(|(w, l)| (*w, fonts.wrap(l, inner_w, size, false))).collect();
    let box_h = 12.0 + 16.0 + lines.iter().map(|(_, l)| l.len() as f64 * lh + 3.0).sum::<f64>() + 8.0;
    b.room(box_h.min(BOTTOM - TOP));
    let top = b.y;
    b.rect(ML, top, CW, box_h, SHADE, RULE, 5.0);
    b.text(ML + 12.0, top + 12.0 + 9.0, "Summary", 10.5, true, INK, "");
    b.y = top + 12.0 + 16.0;
    for (warn, ls) in &lines {
        b.text(ML + 12.0, b.y + size * 1.02, if *warn { "!" } else { "\u{2022}" }, size, true, if *warn { WARN } else { ACCENT }, "");
        for l in ls {
            b.text(ML + 22.0, b.y + size * 1.02, l, size, false, if *warn { WARN } else { INK }, "");
            b.y += lh;
        }
        b.y += 3.0;
    }
    b.y = top + box_h;

    // the credit
    b.heading("Figure-legend credit (ready to paste)");
    let credit = legend_for(&f.icons);
    let cl = fonts.wrap(&credit, CW - 24.0, 9.5, false);
    let ch = cl.len() as f64 * 9.5 * 1.38 + 16.0;
    b.room(ch.min(BOTTOM - TOP));
    let top = b.y;
    b.rect(ML, top, CW, ch, "#ffffff", ACCENT, 4.0);
    b.y = top + 8.0;
    for l in cl {
        b.text(ML + 12.0, b.y + 9.5 * 1.02, &l, 9.5, false, INK, "");
        b.y += 9.5 * 1.38;
    }
    b.y = top + ch;

    // the icons
    if !f.icons.is_empty() {
        b.heading(&format!("Icons used ({})", f.icons.len()));
        let cols = [("", 34.0), ("ICON", 120.0), ("SOURCE & AUTHOR", 118.0), ("LICENCE", 96.0), ("USES", 46.0), ("CHANGES", CW - 34.0 - 120.0 - 118.0 - 96.0 - 46.0)];
        let rows = f
            .icons
            .iter()
            .enumerate()
            .map(|(n, i)| {
                let l = lic(s(i.meta, "license"));
                let mut src = vec![run(i.pack_name(), 8.0, false, INK)];
                if !s(i.meta, "author").is_empty() {
                    src.push(run(s(i.meta, "author"), 8.0, false, INK));
                }
                if !s(i.meta, "source_url").is_empty() {
                    src.push(run(s(i.meta, "source_url"), 6.5, false, MUTED));
                }
                let mut lc = vec![run(&l.name, 8.0, true, if l.share_alike || !l.commercial { WARN } else { INK }), run(if l.attribution { "credit required" } else { "no credit required" }, 6.8, false, MUTED)];
                if !l.url.is_empty() {
                    lc.push(run(l.url, 6.2, false, ACCENT));
                }
                (
                    Some(thumb(i.asset, 24.0, &format!("t{n}-"))),
                    vec![
                        vec![run(format!("{}. {}", n + 1, i.name()), 8.0, true, INK), run(&i.id, 6.5, false, MUTED)],
                        src,
                        lc,
                        vec![run(format!("{}\u{d7}", i.uses), 8.0, true, INK), run(i.places.join(", "), 6.8, false, MUTED)],
                        vec![if i.changes.is_empty() { run("none", 7.5, false, MUTED) } else { run(i.changes.join(", "), 7.5, false, if i.adapted() { WARN } else { INK }) }],
                    ],
                )
            })
            .collect();
        b.table(&cols, rows);
    }

    // own material
    if !f.own.is_empty() {
        b.heading("Your own material");
        b.para(OWN_NOTE, ML, CW, 8.8, false, INK);
        b.y += 6.0;
        let cols = [("", 34.0), ("ITEM", 200.0), ("KIND", 150.0), ("USES", CW - 34.0 - 350.0)];
        let rows = f
            .own
            .iter()
            .enumerate()
            .map(|(n, x)| (x.asset.map(|a| thumb(a, 24.0, &format!("o{n}-"))), vec![vec![run(&x.name, 8.0, true, INK)], vec![run(x.kind, 8.0, false, INK)], vec![run(format!("{}\u{d7}", x.uses), 8.0, true, INK)]]))
            .collect();
        b.table(&cols, rows);
    }

    // notices, glossary, disclaimer
    if !t.notices.is_empty() {
        b.heading("Licence notices");
        b.para("Include these notices with the figure, for example in the supplementary material.", ML, CW, 8.8, false, INK);
        for (name, holders, body) in &t.notices {
            b.y += 6.0;
            b.room(40.0);
            b.para(name, ML, CW, 9.0, true, INK);
            for hd in holders {
                b.para(&format!("Copyright (c) {hd}"), ML, CW, 7.8, false, INK);
            }
            b.y += 3.0;
            for p in body.split("\n\n") {
                b.para(p, ML, CW, 7.2, false, MUTED);
                b.y += 3.0;
            }
        }
    }
    if !t.glossary.is_empty() {
        b.heading("What the licences mean");
        for g in &t.glossary {
            b.room(36.0);
            let y0 = b.y;
            b.para(&g.name, ML, 110.0, 8.8, true, INK);
            let after_name = b.y;
            b.y = y0;
            b.para(g.summary, ML + 118.0, CW - 118.0, 8.3, false, INK);
            if !g.url.is_empty() {
                b.para(g.url, ML + 118.0, CW - 118.0, 7.0, false, ACCENT);
            }
            b.y = b.y.max(after_name) + 6.0;
        }
    }
    b.heading("Disclaimer");
    b.para(DISCLAIMER, ML, CW, 8.5, false, MUTED);
    b.new_page();

    // footers, now that the page count is known
    let total = b.pages.len();
    let mut out = Vec::new();
    for (i, body) in b.pages.iter().enumerate() {
        let mut page = Book { f: &fonts, pages: Vec::new(), cur: String::new(), y: 0.0 };
        page.cur += &format!("<rect x=\"{ML}\" y=\"{:.2}\" width=\"{CW}\" height=\"0.6\" fill=\"{RULE}\"/>", FOOT - 10.0);
        page.text(ML, FOOT, &format!("BioCraft \u{b7} Licence & attribution report \u{b7} Figure ID {}", f.figure_id), 7.0, false, MUTED, "");
        page.text(PW - ML, FOOT, &format!("Page {} of {total}", i + 1), 7.0, false, MUTED, "end");
        out.push(format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"210mm\" height=\"297mm\" viewBox=\"0 0 {PW} {PH}\"><rect width=\"{PW}\" height=\"{PH}\" fill=\"#ffffff\"/>{body}{}</svg>",
            page.cur
        ));
    }
    out
}

/// The report as one vector PDF (A4, fonts embedded). If the figure on the first page can't be
/// converted (a picture in it the PDF writer can't read), the report is written without it.
pub fn pdf(h: &Header, f: &Facts, r: &Renderer) -> Result<Vec<u8>> {
    let write = |h: &Header| -> Result<Vec<u8>> {
        let mut trees = Vec::new();
        for (i, svg) in pages(h, f, r).iter().enumerate() {
            trees.push(svgclean::parse(svg.as_bytes(), &r.options()).with_context(|| format!("drawing report page {}", i + 1))?);
        }
        pages_to_pdf(&trees, Some(&format!("Licence & attribution report: {}", h.title)))
    };
    match write(h) {
        Err(_) if h.figure_svg.is_some() => {
            let bare = Header { figure_svg: None, publication: h.publication.clone(), title: h.title.clone(), exported_at: h.exported_at.clone(), export: h.export.clone(), prepared_by: h.prepared_by.clone() };
            write(&bare)
        }
        other => other,
    }
}

/// What the Export dialog shows about a figure before anything is written: what the licences
/// allow, what they ask, and (with publication details) whether they fit the journal.
pub fn summary(doc: &Value, p: &Publication) -> Value {
    let f = facts(doc);
    let mut lics: Vec<(String, usize)> = Vec::new();
    let mut packs = Vec::new();
    for i in &f.icons {
        let l = s(i.meta, "license").to_string();
        match lics.iter_mut().find(|x| x.0 == l) {
            Some(x) => x.1 += 1,
            None => lics.push((l, 1)),
        }
        add(&mut packs, i.pack_name());
    }
    let pick = |test: &dyn Fn(&Lic) -> bool| f.icons.iter().filter(|i| test(&lic(s(i.meta, "license")))).map(|i| i.name().to_string()).collect::<Vec<_>>();
    json!({
        "icons": f.icons.len(),
        "sources": packs.len(),
        "licences": lics.iter().map(|(l, n)| json!({ "id": l, "name": short(l), "count": n })).collect::<Vec<_>>(),
        "attribution": f.icons.iter().any(|i| lic(s(i.meta, "license")).attribution),
        "commercial": f.icons.iter().all(|i| lic(s(i.meta, "license")).commercial),
        "shareAlike": pick(&|l| l.share_alike),
        "notices": pick(&|l| l.notice),
        "changed": f.icons.iter().filter(|i| !i.changes.is_empty()).count(),
        "own": f.own.len(),
        "figureId": f.figure_id,
        "legend": legend_for(&f.icons),
        "check": publication_check(&f, p).map(|(warn, text)| json!({ "warn": warn, "text": text })),
    })
}

/* ---------- files ---------- */

/// Everything the report writes, plus what callers show about it.
pub struct Report {
    pub pdf: Vec<u8>,
    pub md: String,
    pub csv: String,
    pub figure_id: String,
    pub legend: String,
}

pub fn build(doc: &Value, h: &Header, r: &Renderer) -> Result<Report> {
    let f = facts(doc);
    Ok(Report { pdf: pdf(h, &f, r)?, md: markdown(h, &f), csv: csv(&f), figure_id: f.figure_id.clone(), legend: legend_for(&f.icons) })
}

/// `fig-licence.pdf/.md/.csv` beside an exported `fig.png`.
pub fn paths_beside(figure: &Path) -> [PathBuf; 3] {
    let stem = figure.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "figure".into());
    paths_for(&figure.with_file_name(format!("{stem}-licence.pdf")))
}

/// `report.pdf`, `report.md` and `report.csv` for a chosen report path.
pub fn paths_for(report: &Path) -> [PathBuf; 3] {
    ["pdf", "md", "csv"].map(|e| report.with_extension(e))
}

impl Report {
    pub fn files(&self) -> [(&'static str, &'static str, &[u8]); 3] {
        [("pdf", "application/pdf", &self.pdf), ("md", "text/markdown", self.md.as_bytes()), ("csv", "text/csv", self.csv.as_bytes())]
    }

    pub fn write(&self, paths: &[PathBuf; 3]) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for ((_, _, bytes), p) in self.files().iter().zip(paths) {
            if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(p, bytes).with_context(|| format!("writing {}", p.display()))?;
            out.push(p.display().to_string());
        }
        Ok(out)
    }

    pub fn summary(&self, paths: &[String]) -> Value {
        json!({ "files": paths, "figure_id": self.figure_id, "credit": self.legend })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(pack: &str, name: &str, license: &str, author: &str, svg: &str) -> Value {
        json!({ "svg": svg, "w": 10, "h": 10, "meta": { "id": format!("{pack}/{}", name.to_lowercase()), "pack": pack, "packName": match pack { "servier" => "Servier Medical Art", "nih" => "NIH BioArt Source", "bioicons" => "Bioicons", "healthicons" => "Health Icons", "biocanvas" => "BioCraft Originals", "user" => "My library", _ => pack }, "name": name, "license": license, "author": author, "source_url": if pack == "nih" { "https://bioart.niaid.nih.gov/bioart/7" } else { "" } } })
    }

    const BOX: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\" fill=\"#cc3333\"/></svg>";
    const LABELLED: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\" fill=\"#3366cc\"/><text x=\"1\" y=\"8\">A</text></svg>";

    fn mixed() -> Value {
        json!({
            "width": 100, "height": 60, "background": "#ffffff",
            "assets": {
                "servier/macrophage": asset("servier", "Macrophage", "CC-BY-4.0", "Servier", BOX),
                "servier/neutrophil": asset("servier", "Neutrophil", "CC-BY-4.0", "Servier", LABELLED),
                "nih/virus": asset("nih", "Virus", "PD", "NIAID", BOX),
                "bioicons/flask": asset("bioicons", "Flask", "CC-BY-SA-4.0", "Jane Doe", BOX),
                "healthicons/syringe": asset("healthicons", "Syringe", "MIT", "Health Icons (Resolve to Save Lives)", BOX),
                "biocanvas/joint": asset("biocanvas", "Synovial joint", "CC0-1.0", "", BOX),
                "user/mine": asset("user", "My blot", "USER", "", BOX),
                "servier/hidden": asset("servier", "Hidden cell", "CC-BY-4.0", "Servier", BOX)
            },
            "objects": [
                { "id": "a", "type": "icon", "asset": "servier/macrophage", "x": 0, "y": 0, "w": 10, "h": 10, "colors": { "#cc3333": "#0072b2" }, "slotColors": ["#0072b2"] },
                { "id": "b", "type": "icon", "asset": "servier/neutrophil", "x": 0, "y": 0, "w": 10, "h": 10, "labels": "hidden" },
                { "id": "c", "type": "icon", "asset": "nih/virus", "x": 0, "y": 0, "w": 10, "h": 10, "tint": "gray" },
                { "id": "d", "type": "group", "glow": { "color": "#00ff00", "size": 6 }, "children": [
                    { "id": "e", "type": "icon", "asset": "bioicons/flask", "x": 0, "y": 0, "w": 10, "h": 10 }
                ] },
                { "id": "f", "type": "icon", "asset": "healthicons/syringe", "x": 0, "y": 0, "w": 10, "h": 10, "flipX": true, "rot": 30 },
                { "id": "g", "type": "membrane", "brush": "icon", "asset": "biocanvas/joint", "pts": [[0, 0], [50, 0]] },
                { "id": "h", "type": "icon", "asset": "servier/macrophage", "x": 20, "y": 0, "w": 10, "h": 10 },
                { "id": "i", "type": "icon", "asset": "user/mine", "x": 0, "y": 0, "w": 10, "h": 10 },
                { "id": "j", "type": "image", "name": "Western blot.png", "src": "data:image/png;base64,iVBORw0KGgo=", "x": 0, "y": 0, "w": 10, "h": 10 },
                { "id": "k", "type": "icon", "asset": "servier/hidden", "hidden": true, "x": 0, "y": 0, "w": 10, "h": 10 },
                { "id": "l", "type": "legend", "x": 0, "y": 0, "w": 30, "h": 10, "rows": [{ "label": "Virus", "asset": "nih/virus" }] }
            ]
        })
    }

    #[test]
    fn classifies_licences_and_changes() {
        let doc = mixed();
        let f = facts(&doc);
        let by = |id: &str| f.icons.iter().find(|i| i.id == id).unwrap();
        // hidden objects are not in the export; own material is listed apart
        assert_eq!(f.icons.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["servier/macrophage", "servier/neutrophil", "nih/virus", "bioicons/flask", "healthicons/syringe", "biocanvas/joint"]);
        assert_eq!(f.own.iter().map(|o| (o.kind, o.name.as_str())).collect::<Vec<_>>(), [("My library upload", "My blot"), ("Placed picture", "Western blot.png")]);
        assert_eq!((by("servier/macrophage").uses, by("servier/macrophage").changes.clone()), (2, vec!["recoloured parts"]));
        assert_eq!(by("servier/neutrophil").changes, ["built-in labels hidden"]);
        assert_eq!((by("nih/virus").changes.clone(), by("nih/virus").places.clone()), (vec!["greyscale"], vec!["icon", "legend"]));
        assert_eq!(by("bioicons/flask").changes, ["glow added"]); // from its group
        assert!(by("healthicons/syringe").changes.is_empty()); // flips and rotation are not changes
        assert_eq!(by("biocanvas/joint").places, ["icon brush"]);
        // only CC BY icons are credited as adapted
        assert!(by("servier/macrophage").adapted() && by("bioicons/flask").adapted() && !by("nih/virus").adapted());
        let l = lic("CC-BY-SA-4.0");
        assert!(l.share_alike && l.attribution && l.mark_changes && l.commercial && !l.notice);
        assert!(lic("MIT").notice && !lic("PD").attribution && !lic("CC0-1.0").mark_changes);
        assert!(!lic("CC-BY-NC-4.0").commercial);
        assert_eq!([short("CC-BY-SA-4.0"), short("CC0-1.0"), short("PD"), short("MIT")], ["CC BY-SA 4.0", "CC0 1.0", "public domain", "MIT"]);
        // the figure id follows the content
        let mut moved = doc.clone();
        moved["objects"][0]["x"] = json!(5);
        assert_eq!(f.figure_id.len(), 12);
        assert_ne!(facts(&moved).figure_id, f.figure_id);
        assert_eq!(facts(&doc).figure_id, f.figure_id);
        // …but not how its numbers and keys were written
        let mut noisy = doc.clone();
        noisy["objects"][0]["x"] = json!(1e-12);
        noisy["objects"][0]["w"] = json!(10.000000000000002);
        assert_eq!(facts(&noisy).figure_id, f.figure_id);
        let reread: Value = serde_json::from_str(&serde_json::to_string_pretty(&doc).unwrap()).unwrap();
        assert_eq!(facts(&reread).figure_id, f.figure_id);
    }

    #[test]
    fn legend_credits_adaptations() {
        assert_eq!(
            legend(&mixed()),
            "Created with BioCraft using Servier Medical Art (smart.servier.com), licensed under CC BY 4.0 (adapted from Macrophage, Neutrophil); \
             illustrations from NIAID NIH BioArt Source (bioart.niaid.nih.gov/bioart/7); Bioicons: adapted from Flask by Jane Doe (CC BY-SA 4.0); \
             Health Icons: Syringe by Health Icons (Resolve to Save Lives) (MIT); BioCraft Originals (CC0)."
        );
        let mut plain = mixed();
        plain["objects"][0] = json!({ "id": "a", "type": "icon", "asset": "servier/macrophage", "x": 0, "y": 0, "w": 10, "h": 10 });
        plain["objects"][1]["labels"] = Value::Null;
        assert!(legend(&plain).starts_with("Created with BioCraft using Servier Medical Art (smart.servier.com), licensed under CC BY 4.0 (Macrophage, Neutrophil);"));
        assert_eq!(legend(&json!({ "objects": [], "assets": {} })), "Figure created with BioCraft.");
    }

    #[test]
    fn markdown_csv_and_pdf() {
        let doc = mixed();
        let f = facts(&doc);
        let h = Header { title: "Synovium | test".into(), exported_at: "2026-10-20 08:15 UTC+10:30".into(), export: export_line("png", 300.0, 178.0, 100.0), prepared_by: "A. Researcher".into(), ..Default::default() };
        assert_eq!(h.export, "PNG · 178.0 × 100.0 mm · 2,102 × 1,181 px at 300 dpi");
        let m = markdown(&h, &f);
        for want in ["**Figure:** Synovium \\| test", "Share-alike: 1 icon (Flask) is CC BY-SA", "Licence notices: 1 icon (Syringe)", "| 1 | Macrophage | `servier/macrophage` |", "Copyright (c) Health Icons (Resolve to Save Lives)", "## Your own material", "Placed picture: Western blot.png", "**CC BY-SA 4.0** (<https://creativecommons.org/licenses/by-sa/4.0/>)", "BioCraft does not grant licences"] {
            assert!(m.contains(want), "markdown lacks {want:?}:\n{m}");
        }
        let c = csv(&f);
        let lines: Vec<&str> = c.lines().collect();
        assert_eq!(lines.len(), 1 + 6 + 2);
        assert!(lines[1].starts_with(&format!("{},servier/macrophage,Macrophage,Servier Medical Art,Servier,CC-BY-4.0,CC BY 4.0,https://creativecommons.org/licenses/by/4.0/,yes,no,,2,icon,recoloured parts", f.figure_id)), "{}", lines[1]);
        assert_eq!(csv_field("=cmd()"), "'=cmd()");
        assert_eq!(csv_field("a, \"b\""), "\"a, \"\"b\"\"\"");
        let r = Renderer::new();
        let bytes = pdf(&h, &f, &r).unwrap();
        assert!(bytes.starts_with(b"%PDF"));
        // a long table runs over several pages
        let mut big = doc.clone();
        for n in 0..60 {
            let id = format!("servier/c{n}");
            big["assets"][&id] = asset("servier", &format!("Cell {n}"), "CC-BY-4.0", "Servier", BOX);
            big["objects"].as_array_mut().unwrap().push(json!({ "id": format!("n{n}"), "type": "icon", "asset": id, "x": 0, "y": 0, "w": 10, "h": 10 }));
        }
        let many = pdf_page_count(&pdf(&h, &facts(&big), &r).unwrap());
        assert!(many >= 3, "{many} pages");
        assert_eq!(paths_beside(Path::new("/x/fig.png")).map(|p| p.file_name().unwrap().to_string_lossy().to_string()), ["fig-licence.pdf", "fig-licence.md", "fig-licence.csv"]);
    }

    /// `BIOCRAFT_REPORT_OUT=<dir> cargo test -p biocraft sample_report -- --ignored` writes the
    /// sample report (PDF, Markdown, CSV and a PNG of every page) to look at.
    #[test]
    #[ignore]
    fn sample_report() {
        let dir = PathBuf::from(std::env::var("BIOCRAFT_REPORT_OUT").expect("set BIOCRAFT_REPORT_OUT"));
        let mut doc = mixed();
        if let Ok(p) = std::env::var("BIOCRAFT_REPORT_DOC") {
            doc = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        }
        let r = Renderer::new();
        let f = facts(&doc);
        let svg = crate::figure::Painter::new(&doc, &r).document(Some("#ffffff"));
        let publication = Publication { journal: "Nature Communications".into(), manuscript: "NCOMMS-26-01234".into(), figure_title: "Figure 2 | Sample figure".into(), access: "cc-by".into(), date: "2026-12-01".into() };
        let h = Header { title: "Sample figure".into(), exported_at: now(), export: export_line("png", 300.0, 178.0, 100.0), prepared_by: "A. Researcher".into(), publication, figure_svg: Some(svg) };
        std::fs::create_dir_all(&dir).unwrap();
        for (i, svg) in pages(&h, &f, &r).iter().enumerate() {
            let tree = svgclean::parse(svg.as_bytes(), &r.options()).unwrap();
            let pm = r.render_scaled(&tree, 1.4, None).unwrap();
            std::fs::write(dir.join(format!("page-{}.png", i + 1)), biocanvas_core::render::encode_png(&pm, None).unwrap()).unwrap();
        }
        build(&doc, &h, &r).unwrap().write(&paths_for(&dir.join("sample-licence.pdf"))).unwrap();
    }

    #[test]
    fn publication_details_and_check() {
        let doc = mixed();
        let f = facts(&doc);
        let p = Publication::from_json(Some(&json!({ "journal": "Arthritis Res Ther", "openAccess": "cc-by", "figureTitle": "Figure 1", "manuscript": "" })));
        assert_eq!((p.journal.as_str(), p.access.as_str(), p.figure_title.as_str()), ("Arthritis Res Ther", "cc-by", "Figure 1"));
        assert!(Publication::from_json(Some(&json!({}))).is_empty() && Publication::from_json(None).is_empty());
        assert_eq!(Publication::from_json(Some(&json!({ "open_access": "no" }))).access, "subscription");
        // the share-alike Flask conflicts with a CC BY article; without it everything fits
        let (warn, text) = publication_check(&f, &p).unwrap();
        assert!(warn && text.contains("Flask") && text.contains("not CC BY"), "{text}");
        let mut no_sa = doc.clone();
        no_sa["objects"].as_array_mut().unwrap().retain(|o| o["id"] != "d");
        let (warn, text) = publication_check(&facts(&no_sa), &p).unwrap();
        assert!(!warn && text.contains("compatible"), "{text}");
        assert!(publication_check(&f, &Publication::default()).is_none());
        // the report carries the details, the check and the statement
        let h = Header { title: "fig".into(), publication: p, ..Default::default() };
        let m = markdown(&h, &f);
        for want in ["**Figure:** Figure 1", "**Journal:** Arthritis Res Ther", "**Article licence:** Open access under CC BY", "Publication in Arthritis Res Ther, open access under CC BY", "BioCraft does not grant a licence, and none is needed from it"] {
            assert!(m.contains(want), "markdown lacks {want:?}:\n{m}");
        }
        let sm = summary(&doc, &h.publication);
        assert_eq!((sm["icons"].as_u64(), sm["commercial"].as_bool(), sm["shareAlike"][0].as_str()), (Some(6), Some(true), Some("Flask")));
        assert_eq!(sm["check"]["warn"], json!(true));
        // the figure is drawn on the first page
        let r = Renderer::new();
        let svg = crate::figure::Painter::new(&doc, &r).document(Some("#ffffff"));
        let (fig, fh) = figure_box(&svg, 50.0, 0.0, 400.0, 200.0).unwrap();
        assert!(fig.starts_with("<svg x=") && fh > 0.0 && fh <= 200.0);
        let hp = Header { figure_svg: Some(svg), ..h };
        assert!(pages(&hp, &f, &r).iter().take(2).any(|pg| pg.contains("iVBORw0KGgo=")), "the figure (with its placed picture) is drawn near the start");
        // the test picture is not a readable PNG: the report is still written, without the figure
        assert!(pdf(&hp, &f, &r).unwrap().starts_with(b"%PDF"));
    }

    fn pdf_page_count(pdf: &[u8]) -> usize {
        let s = String::from_utf8_lossy(pdf);
        s.matches("/Type /Page").count() - s.matches("/Type /Pages").count()
    }
}
