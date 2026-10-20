//! Library data model shared by the builder, the app and the UI (serialised as JSON).

use serde::{Deserialize, Serialize};

/// A group of colours in an icon that recolour together (a "part": membrane, nucleus…).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Slot {
    /// The heaviest colour of the part; setting a new slot colour maps `base` onto it.
    pub base: String,
    /// Every colour of the part, `base` included.
    pub members: Vec<String>,
    /// Share of the icon's painted area, 0..1.
    pub weight: f32,
    /// "color" for chromatic parts, "dark"/"light" for neutral ones (outlines, highlights).
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IconMeta {
    /// Stable id: "<pack>/<slug>".
    pub id: String,
    pub name: String,
    pub pack: String,
    /// Unified BioCanvas category id (see `taxonomy`).
    pub category: String,
    /// The source's own category label.
    #[serde(default)]
    pub subcategory: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub description: String,
    pub author: String,
    /// SPDX-like licence id: CC0-1.0, PD, CC-BY-3.0, CC-BY-4.0, CC-BY-SA-4.0, MIT, BSD…
    pub license: String,
    #[serde(default)]
    pub source_url: String,
    /// Cleaned SVG, relative to the library root.
    pub file: String,
    /// PNG thumbnail, relative to the library root.
    pub thumb: String,
    pub w: f32,
    pub h: f32,
    #[serde(default)]
    pub slots: Vec<Slot>,
    /// Contains embedded bitmaps (recolouring only affects the vector parts).
    #[serde(default)]
    pub raster: bool,
    /// Other ids that are colour/style variants of this icon.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<String>,
    /// Variants are kept out of search results; they show under their primary icon.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Visual style: "soft" (Servier-like shading), "line" (outlined, NIH-like), "flat", "glyph".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub style: String,
    /// For colour variants stored as a recolour of another icon's file: original → new colour.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub colors: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub url: String,
    /// How to credit this source in a figure legend.
    #[serde(default)]
    pub credit: String,
    #[serde(default)]
    pub count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CategoryInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct LibraryIndex {
    pub version: u32,
    #[serde(default)]
    pub built: String,
    pub packs: Vec<PackInfo>,
    pub categories: Vec<CategoryInfo>,
    pub icons: Vec<IconMeta>,
}

/// Licence facts used for filtering and the credits panel.
pub fn license_info(id: &str) -> (&'static str, bool, &'static str) {
    // (display name, attribution required, url)
    match id {
        "CC0-1.0" => ("CC0 1.0 (public domain)", false, "https://creativecommons.org/publicdomain/zero/1.0/"),
        "PD" => ("Public domain", false, "https://creativecommons.org/publicdomain/mark/1.0/"),
        "CC-BY-3.0" => ("CC BY 3.0", true, "https://creativecommons.org/licenses/by/3.0/"),
        "CC-BY-4.0" => ("CC BY 4.0", true, "https://creativecommons.org/licenses/by/4.0/"),
        "CC-BY-SA-3.0" => ("CC BY-SA 3.0", true, "https://creativecommons.org/licenses/by-sa/3.0/"),
        "CC-BY-SA-4.0" => ("CC BY-SA 4.0", true, "https://creativecommons.org/licenses/by-sa/4.0/"),
        "MIT" => ("MIT", true, "https://opensource.org/license/mit"),
        "BSD" => ("BSD", true, "https://opensource.org/license/bsd-3-clause"),
        "USER" => ("Your own file", false, ""),
        _ => ("Unknown licence", true, ""),
    }
}
