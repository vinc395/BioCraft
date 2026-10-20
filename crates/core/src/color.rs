//! sRGB ⇄ OKLab colour maths used for palette clustering and recolouring.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Rgb { r, g, b }
    }

    pub fn hex(&self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    pub fn parse(s: &str) -> Option<Rgb> {
        let s = s.trim().trim_start_matches('#');
        let v = |i: usize, n: usize| u8::from_str_radix(&s[i..i + n], 16).ok();
        match s.len() {
            6 => Some(Rgb::new(v(0, 2)?, v(2, 2)?, v(4, 2)?)),
            3 => Some(Rgb::new(v(0, 1)? * 17, v(1, 1)? * 17, v(2, 1)? * 17)),
            _ => None,
        }
    }

    pub fn oklab(&self) -> Oklab {
        let l = |c: u8| {
            let c = c as f32 / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        let (r, g, b) = (l(self.r), l(self.g), l(self.b));
        let l_ = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
        let m_ = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
        let s_ = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
        Oklab {
            l: 0.210_454_26 * l_ + 0.793_617_8 * m_ - 0.004_072_047 * s_,
            a: 1.977_998_5 * l_ - 2.428_592_2 * m_ + 0.450_593_7 * s_,
            b: 0.025_904_037 * l_ + 0.782_771_77 * m_ - 0.808_675_77 * s_,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklab {
    pub l: f32,
    pub a: f32,
    pub b: f32,
}

impl Oklab {
    pub fn chroma(&self) -> f32 {
        (self.a * self.a + self.b * self.b).sqrt()
    }

    /// Hue in degrees, 0..360.
    pub fn hue(&self) -> f32 {
        let h = self.b.atan2(self.a).to_degrees();
        if h < 0.0 {
            h + 360.0
        } else {
            h
        }
    }

    pub fn dist(&self, o: &Oklab) -> f32 {
        ((self.l - o.l).powi(2) + (self.a - o.a).powi(2) + (self.b - o.b).powi(2)).sqrt()
    }

    pub fn from_lch(l: f32, c: f32, h_deg: f32) -> Oklab {
        let h = h_deg.to_radians();
        Oklab { l, a: c * h.cos(), b: c * h.sin() }
    }

    fn to_linear(self) -> [f32; 3] {
        let l_ = self.l + 0.396_337_78 * self.a + 0.215_803_76 * self.b;
        let m_ = self.l - 0.105_561_346 * self.a - 0.063_854_17 * self.b;
        let s_ = self.l - 0.089_484_18 * self.a - 1.291_485_5 * self.b;
        let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
        [
            4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
            -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
            -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
        ]
    }

    pub fn in_gamut(&self) -> bool {
        self.to_linear().iter().all(|c| (-0.0005..=1.0005).contains(c))
    }

    /// Convert to sRGB, reducing chroma until the colour fits the gamut.
    pub fn to_rgb(self) -> Rgb {
        let mut c = self;
        if !c.in_gamut() {
            let (l, ch, h) = (c.l.clamp(0.0, 1.0), c.chroma(), c.hue());
            let (mut lo, mut hi) = (0.0f32, ch);
            for _ in 0..20 {
                let mid = (lo + hi) / 2.0;
                if Oklab::from_lch(l, mid, h).in_gamut() {
                    lo = mid
                } else {
                    hi = mid
                }
            }
            c = Oklab::from_lch(l, lo, h);
        }
        let g = |x: f32| {
            let x = x.clamp(0.0, 1.0);
            let v = if x <= 0.003_130_8 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
            (v * 255.0).round().clamp(0.0, 255.0) as u8
        };
        let [r, gg, b] = c.to_linear();
        Rgb::new(g(r), g(gg), g(b))
    }
}

/// Angular distance between two hues in degrees (0..180).
pub fn hue_dist(a: f32, b: f32) -> f32 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// Move `member` the way `base` moves to `target`, keeping its lightness, chroma and hue
/// offsets so highlights and shadows of a part stay highlights and shadows.
pub fn shift_like(member: Rgb, base: Rgb, target: Rgb) -> Rgb {
    let (m, b, t) = (member.oklab(), base.oklab(), target.oklab());
    let dl = m.l - b.l;
    let (bc, mc, tc) = (b.chroma(), m.chroma(), t.chroma());
    // pale bases: shift chroma additively (a ratio would explode); otherwise scale, capped
    let c = if bc > 0.06 { mc * (tc / bc).min(2.2) } else { (mc + (tc - bc)).max(0.0) };
    let dh = {
        let d = m.hue() - b.hue();
        if bc > 0.02 && mc > 0.02 {
            ((d + 540.0) % 360.0) - 180.0
        } else {
            0.0
        }
    };
    // Compress lightness offsets when the target is near black or white so shading survives.
    let l = if dl >= 0.0 {
        t.l + dl * ((1.0 - t.l) / (1.0 - b.l).max(0.05)).min(1.5)
    } else {
        t.l + dl * (t.l / b.l.max(0.05)).min(1.5)
    };
    Oklab::from_lch(l.clamp(0.0, 1.0), c, t.hue() + dh).to_rgb()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        for hex in ["#abd4eb", "#cca6bd", "#000000", "#ffffff", "#ff0000", "#123456"] {
            let c = Rgb::parse(hex).unwrap();
            assert_eq!(c.oklab().to_rgb(), c, "{hex}");
        }
    }

    #[test]
    fn shift_identity() {
        let base = Rgb::parse("#abd4eb").unwrap();
        let hi = Rgb::parse("#eaf1f9").unwrap();
        let out = shift_like(hi, base, base);
        let d = out.oklab().dist(&hi.oklab());
        assert!(d < 0.01, "{:?} vs {:?}", out, hi);
    }
}
