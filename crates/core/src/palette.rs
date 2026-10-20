//! Groups an icon's colours into recolourable "slots", the way BioRender exposes a few colour
//! wells per icon: each slot is one visual part (membrane, nucleus, granules…) with all of its
//! shades, so changing the slot colour keeps highlights and shadows intact.
//!
//! Parts are told apart by hue *and* lightness (a pale-green cytoplasm and a dark-green nucleus
//! are two parts), while small areas of a nearby colour are treated as shading of the part they
//! sit beside (a Servier highlight crescent, a darker rim).

use crate::color::{hue_dist, Oklab, Rgb};
use crate::model::Slot;

const MAX_COLOR_SLOTS: usize = 8;
const CHROMA_COLOR: f32 = 0.035;
const CHROMA_TINT: f32 = 0.012;
/// Distances at which two colours count as different parts.
const HUE_STEP: f32 = 24.0;
const L_STEP: f32 = 0.2;
const C_STEP: f32 = 0.1;
/// Clusters smaller than this share of the coloured area are shading of a neighbour.
const MINOR: f32 = 0.06;

struct Cluster {
    base: (Rgb, Oklab),
    members: Vec<(Rgb, f32, Oklab)>,
    weight: f32,
}

fn part_dist(a: &Oklab, b: &Oklab) -> f32 {
    let dh = hue_dist(a.hue(), b.hue()) / HUE_STEP;
    let dl = (a.l - b.l) / L_STEP;
    let dc = (a.chroma() - b.chroma()) / C_STEP;
    (dh * dh + dl * dl + dc * dc).sqrt()
}

pub fn slots(colors: &[(Rgb, f32)]) -> Vec<Slot> {
    let total: f32 = colors.iter().map(|c| c.1).sum::<f32>().max(1e-9);
    let mut sorted: Vec<(Rgb, f32, Oklab)> = colors.iter().map(|&(c, w)| (c, w, c.oklab())).collect();
    sorted.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));

    let mut chroma: Vec<Cluster> = Vec::new();
    let mut tints: Vec<(Rgb, f32, Oklab)> = Vec::new();
    let mut neutrals: Vec<(Rgb, f32, Oklab)> = Vec::new();

    for &(c, w, lab) in &sorted {
        let ch = lab.chroma();
        if ch >= CHROMA_COLOR {
            let best = chroma
                .iter_mut()
                .map(|k| (part_dist(&k.base.1, &lab), k))
                .filter(|(d, _)| *d <= 1.0)
                .min_by(|a, b| a.0.total_cmp(&b.0));
            match best {
                Some((_, k)) => {
                    k.members.push((c, w, lab));
                    k.weight += w;
                }
                None => chroma.push(Cluster { base: (c, lab), members: vec![(c, w, lab)], weight: w }),
            }
        } else if ch >= CHROMA_TINT {
            tints.push((c, w, lab));
        } else {
            neutrals.push((c, w, lab));
        }
    }

    // Small clusters close in hue to a bigger one are its highlights/shadows.
    let colored: f32 = chroma.iter().map(|k| k.weight).sum::<f32>().max(1e-9);
    loop {
        chroma.sort_by(|a, b| b.weight.total_cmp(&a.weight));
        let Some(i) = (1..chroma.len()).rev().find(|&i| chroma[i].weight / colored < MINOR && {
            let h = chroma[i].base.1.hue();
            chroma[..i].iter().any(|k| hue_dist(k.base.1.hue(), h) <= 30.0)
        }) else { break };
        let small = chroma.remove(i);
        let h = small.base.1.hue();
        let k = chroma
            .iter_mut()
            .filter(|k| hue_dist(k.base.1.hue(), h) <= 30.0)
            .min_by(|a, b| part_dist(&a.base.1, &small.base.1).total_cmp(&part_dist(&b.base.1, &small.base.1)))
            .unwrap();
        k.weight += small.weight;
        k.members.extend(small.members);
    }

    // Faintly tinted whites/greys (highlights, rims) follow the nearest-hue part.
    for (c, w, lab) in tints {
        let h = lab.hue();
        let best = chroma
            .iter_mut()
            .map(|k| (hue_dist(k.base.1.hue(), h), k))
            .filter(|(d, _)| *d <= 35.0)
            .min_by(|a, b| a.0.total_cmp(&b.0));
        match best {
            Some((_, k)) => {
                k.members.push((c, w, lab));
                k.weight += w;
            }
            None => neutrals.push((c, w, lab)),
        }
    }

    // Too many parts: fold the smallest into its nearest neighbour.
    while chroma.len() > MAX_COLOR_SLOTS {
        chroma.sort_by(|a, b| b.weight.total_cmp(&a.weight));
        let small = chroma.pop().unwrap();
        let k = chroma
            .iter_mut()
            .min_by(|a, b| part_dist(&a.base.1, &small.base.1).total_cmp(&part_dist(&b.base.1, &small.base.1)))
            .unwrap();
        k.weight += small.weight;
        k.members.extend(small.members);
    }
    chroma.sort_by(|a, b| b.weight.total_cmp(&a.weight));

    let mut out: Vec<Slot> = chroma
        .into_iter()
        .map(|k| to_slot(k.base.0, k.members, k.weight / total, "color"))
        .collect();

    let (dark, light): (Vec<_>, Vec<_>) = neutrals.into_iter().partition(|n| n.2.l < 0.6);
    for (group, kind) in [(dark, "dark"), (light, "light")] {
        if group.is_empty() {
            continue;
        }
        let weight: f32 = group.iter().map(|g| g.1).sum();
        let base = group.iter().max_by(|a, b| a.1.total_cmp(&b.1)).unwrap().0;
        out.push(to_slot(base, group, weight / total, kind));
    }
    out
}

fn to_slot(base: Rgb, mut members: Vec<(Rgb, f32, Oklab)>, weight: f32, kind: &str) -> Slot {
    members.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    members.dedup_by(|a, b| a.0 == b.0);
    Slot {
        base: base.hex(),
        members: members.iter().map(|m| m.0.hex()).collect(),
        weight: (weight * 1000.0).round() / 1000.0,
        kind: kind.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn c(h: &str, w: f32) -> (Rgb, f32) {
        (Rgb::parse(h).unwrap(), w)
    }

    #[test]
    fn lymphocyte_like() {
        // Servier B lymphocyte: blue body + white-ish highlight + small dark rim, mauve nucleus.
        let s = slots(&[c("#abd4eb", 100.0), c("#eaf1f9", 30.0), c("#cca6bd", 60.0), c("#7a9bb0", 6.0)]);
        assert_eq!(s.len(), 2, "{s:?}");
        assert_eq!(s[0].base, "#abd4eb");
        assert!(s[0].members.contains(&"#eaf1f9".to_string()));
        assert!(s[0].members.contains(&"#7a9bb0".to_string()));
        assert_eq!(s[1].base, "#cca6bd");
    }

    #[test]
    fn same_hue_parts_split_by_lightness() {
        // pale green cytoplasm and a dark green nucleus are two parts
        let s = slots(&[c("#d9ebc1", 100.0), c("#6e8f3e", 45.0), c("#c5dca8", 10.0)]);
        assert_eq!(s.iter().filter(|x| x.kind == "color").count(), 2, "{s:?}");
    }
}
