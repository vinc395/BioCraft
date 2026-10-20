//! In-memory keyword search over the icon index. Names, tags, descriptions and categories are
//! tokenised with light stemming, and British and American spellings are folded together
//! ("tumour" = "tumor", "haematopoietic" = "hematopoietic", "fibre" = "fiber"). Biology synonyms
//! and abbreviations find each other ("RBC" → erythrocyte, "Treg" → regulatory T cell, "IL-6" =
//! "IL6" = "interleukin 6", "FACS" → flow cytometry), and prefixes and typos are tolerated
//! ("macrophge", "mitochondira"). Icons that match every word come first; after them come icons
//! that match the rarer words of a longer query ("kidney nephron": nephrons, then kidneys), so a
//! search seldom ends in "nothing found".

use crate::model::{license_info, IconMeta};
use std::collections::{HashMap, HashSet};

/// Multi-word concepts and abbreviations folded into one token: added on the index side, and
/// replacing the words on the query side, so "dendritic cell" and "DC" both look for the concept.
/// Words are compared after stemming and spelling normalisation; longer phrases come first.
const PHRASES: &[(&[&str], &str)] = &[
    (&["peripheral", "blood", "mononuclear", "cell"], "pbmc"),
    (&["induced", "pluripotent", "stem", "cell"], "ipsc"),
    (&["enzyme", "linked", "immunosorbent", "assay"], "elisa"),
    (&["g", "protein", "coupled", "receptor"], "gpcr"),
    (&["nuclear", "factor", "kappa", "b"], "nfkb"),
    (&["magnetic", "resonance", "imaging"], "mri"),
    (&["next", "generation", "sequencing"], "ngs"),
    (&["regulatory", "t", "cell"], "treg"),
    (&["antigen", "presenting", "cell"], "apc"),
    (&["hematopoietic", "stem", "cell"], "hsc"),
    (&["mesenchymal", "stem", "cell"], "msc"),
    (&["mesenchymal", "stromal", "cell"], "msc"),
    (&["fibroblast", "like", "synoviocyte"], "fls"),
    (&["inflammatory", "bowel", "disease"], "ibd"),
    (&["major", "histocompatibility", "complex"], "mhc"),
    (&["tumor", "necrosis", "factor"], "tnf"),
    (&["polymerase", "chain", "reaction"], "pcr"),
    (&["reactive", "oxygen", "species"], "ros"),
    (&["red", "blood", "cell"], "erythrocyte"),
    (&["white", "blood", "cell"], "leukocyte"),
    (&["t", "cell", "receptor"], "tcr"),
    (&["b", "cell", "receptor"], "bcr"),
    (&["car", "t", "cell"], "cart"),
    (&["sars", "cov", "2"], "sarscov2"),
    (&["sars", "cov2"], "sarscov2"),
    (&["single", "cell", "rna"], "scrna"),
    (&["nf", "kappa", "b"], "nfkb"),
    (&["nf", "k", "b"], "nfkb"),
    (&["t", "cell"], "tcell"),
    (&["t", "lymphocyte"], "tcell"),
    (&["helper", "t"], "tcell"),
    (&["b", "cell"], "bcell"),
    (&["b", "lymphocyte"], "bcell"),
    (&["nk", "cell"], "nkcell"),
    (&["natural", "killer"], "nkcell"),
    (&["plasma", "cell"], "plasmacell"),
    (&["mast", "cell"], "mastcell"),
    (&["dendritic", "cell"], "dendriticcell"),
    (&["stem", "cell"], "stemcell"),
    // the same concepts once "t cell" / "stem cell" have been folded on the query side
    (&["regulatory", "tcell"], "treg"),
    (&["tcell", "receptor"], "tcr"),
    (&["bcell", "receptor"], "bcr"),
    (&["car", "tcell"], "cart"),
    (&["hematopoietic", "stemcell"], "hsc"),
    (&["mesenchymal", "stemcell"], "msc"),
    (&["induced", "pluripotent", "stemcell"], "ipsc"),
    (&["endoplasmic", "reticulum"], "er"),
    (&["golgi", "apparatus"], "golgi"),
    (&["well", "plate"], "wellplate"),
    (&["petri", "dish"], "petri"),
    (&["test", "tube"], "testtube"),
    (&["flow", "cytometry"], "flowcytometry"),
    (&["flow", "cytometer"], "flowcytometry"),
    (&["e", "coli"], "ecoli"),
    (&["lymph", "node"], "lymphnode"),
    (&["blood", "vessel"], "bloodvessel"),
    (&["lipid", "bilayer"], "bilayer"),
    (&["cell", "membrane"], "plasmamembrane"),
    (&["plasma", "membrane"], "plasmamembrane"),
    (&["extracellular", "vesicle"], "extracellularvesicle"),
    (&["extracellular", "matrix"], "ecm"),
    (&["rheumatoid", "arthritis"], "rheumatoidarthritis"),
    (&["single", "cell"], "singlecell"),
    (&["hematoxylin", "eosin"], "hande"),
    (&["h", "e"], "hande"),
    (&["magnetic", "resonance"], "mri"),
    (&["tnf", "alpha"], "tnf"),
    (&["nf", "kb"], "nfkb"),
    (&["nfk", "b"], "nfkb"),
    // abbreviations of two letters stand for a longer concept, so they don't match every word
    // that starts with them ("DC" is not "DCIS", "RA" is not "rat")
    (&["nk"], "nkcell"),
    (&["dc"], "dendriticcell"),
    (&["ev"], "extracellularvesicle"),
    (&["ra"], "rheumatoidarthritis"),
    (&["oa"], "osteoarthritis"),
    (&["sc"], "singlecell"),
    (&["sle"], "lupus"),
    (&["tnfa"], "tnf"),
    // "FACS" stems to "fac", which would otherwise match face, factor, facial…
    (&["facs"], "flowcytometry"),
];

/// Groups of interchangeable search terms (normalised and stemmed when the index is built).
const SYNONYMS: &[&[&str]] = &[
    &["erythrocyte", "rbc"],
    &["leukocyte", "wbc"],
    &["mitochondria", "mitochondrion", "mito"],
    &["er", "reticulum"],
    &["antibody", "immunoglobulin", "ig", "mab"],
    &["dna", "deoxyribonucleic"],
    &["rna", "ribonucleic"],
    &["mouse", "mice", "murine"],
    &["human", "person", "people", "patient"],
    &["child", "children", "kid", "pediatric"],
    &["woman", "women", "female"],
    &["man", "men", "male"],
    &["neuron", "nerve", "neural", "neuronal"],
    &["synapse", "synaptic"],
    &["cancer", "tumor", "malignant", "oncology", "neoplasm", "carcinoma"],
    &["virus", "viral", "virion"],
    &["coronavirus", "covid", "covid19", "sarscov2"],
    &["bacteria", "bacterium", "bacterial"],
    &["fungus", "fungal", "mold"],
    &["pipette", "pipet", "micropipette"],
    &["microscope", "microscopy"],
    &["heart", "cardiac", "cardio"],
    &["lung", "pulmonary"],
    &["liver", "hepatic", "hepato"],
    &["kidney", "renal"],
    &["brain", "cerebral"],
    &["stomach", "gastric", "gastro"],
    &["intestine", "intestinal", "gut", "bowel", "colon"],
    &["eye", "ocular"],
    &["tooth", "teeth", "dental"],
    &["foot", "feet"],
    &["synovium", "synovial", "synoviocyte", "synovia"],
    &["fibroblast", "fls"],
    &["platelet", "thrombocyte"],
    &["neutrophil", "pmn", "polymorphonuclear"],
    &["membrane", "bilayer"],
    &["arrow", "pointer"],
    &["bone", "osseous", "skeletal", "osteo"],
    &["muscle", "muscular", "myocyte"],
    &["skin", "dermis", "epidermis", "cutaneous"],
    &["joint", "articular"],
    &["cartilage", "chondral", "chondrocyte"],
    &["inflammation", "inflammatory", "inflamed"],
    &["fibrosis", "fibrotic"],
    &["necrosis", "necrotic"],
    &["apoptosis", "apoptotic"],
    &["infection", "infected", "infectious"],
    &["vessel", "vascular", "vasculature"],
    &["artery", "arterial"],
    &["vein", "venous"],
    &["chromosome", "karyotype"],
    &["gene", "genetic", "genome", "genomic"],
    &["syringe", "injection", "needle"],
    &["vaccine", "vaccination", "immunization"],
    &["drug", "medication", "medicine"],
    &["pill", "tablet", "capsule"],
    &["computer", "laptop", "pc"],
    &["graph", "chart", "plot"],
    &["flowcytometry", "cytometer", "cytometry"],
    &["sequencing", "sequencer", "ngs", "seq"],
    &["pcr", "thermocycler"],
    &["elisa", "immunoassay", "wellplate", "microplate"],
    &["extracellularvesicle", "exosome", "microvesicle"],
    &["mhc", "hla"],
    &["tissue", "histology"],
    &["zebrafish", "danio"],
    &["fly", "drosophila", "fruitfly"],
    &["worm", "elegan", "nematode", "helminth"],
    &["yeast", "saccharomyce"],
    &["ecoli", "escherichia"],
    &["eppendorf", "microtube", "microcentrifuge"],
    &["falcon", "conical"],
    &["blood", "hem"],
    &["diabetes", "diabetic"],
    &["obesity", "obese", "overweight"],
    &["alzheimer", "dementia"],
];

const STOP: &[&str] = &["the", "of", "a", "an", "and", "in", "with", "on", "for", "to", "icon", "svg", "image", "picture", "drawing", "illustration", "cartoon", "clipart", "vector"];

pub fn stem(t: &str) -> String {
    let n = t.len();
    if n > 4 && t.ends_with("ies") {
        return format!("{}y", &t[..n - 3]);
    }
    if n > 4 && (t.ends_with("ches") || t.ends_with("shes") || t.ends_with("sses") || t.ends_with("xes")) {
        return t[..n - 2].to_string();
    }
    if n > 3 && t.ends_with('s') && !t.ends_with("ss") && !t.ends_with("us") && !t.ends_with("is") {
        return t[..n - 1].to_string();
    }
    // Latin plurals: vertebrae → vertebra, alveoli → alveolus
    if n > 4 && t.ends_with("ae") {
        return t[..n - 1].to_string();
    }
    // alveoli, nucleoli, cocci, villi, bacilli, glomeruli, fungi, nuclei, bronchi, sulci, gyri,
    // thrombi, hippocampi (but not E. coli, Petri, Golgi)
    const LATIN_I: &[&str] = &["oli", "cci", "lli", "uli", "ngi", "clei", "nchi", "lci", "yri", "mbi", "mpi"];
    if n > 4 && t.is_ascii() && !t.ends_with("coli") && LATIN_I.iter().any(|e| t.ends_with(e)) {
        return format!("{}us", &t[..n - 1]);
    }
    t.to_string()
}

/// British spellings as American ones, so either finds both (applied after stemming, to the index
/// and the query alike).
fn spelling(t: &str) -> String {
    const WORDS: &[(&str, &str)] = &[
        ("grey", "gray"), ("mould", "mold"), ("ageing", "aging"), ("aluminium", "aluminum"),
        ("artefact", "artifact"), ("licence", "license"), ("defence", "defense"), ("programme", "program"),
        ("cortice", "cortex"), ("matrice", "matrix"), ("apice", "apex"), ("vertice", "vertex"), ("indice", "index"),
    ];
    if let Some((_, us)) = WORDS.iter().find(|(uk, _)| *uk == t) {
        return us.to_string();
    }
    let mut w = t.to_string();
    // whole stems, wherever they occur
    const PARTS: &[(&str, &str)] = &[
        ("oesoph", "esoph"), ("oestr", "estr"), ("oedem", "edem"), ("foet", "fet"), ("coeli", "celi"),
        ("rrhoea", "rrhea"), ("pnoea", "pnea"), ("amoeb", "ameb"), ("homoeo", "homeo"),
        ("sulph", "sulf"), ("signall", "signal"), ("labell", "label"), ("modell", "model"), ("travell", "travel"),
        ("channell", "channel"), ("tunnell", "tunnel"), ("counsell", "counsel"), ("cancell", "cancel"),
        ("fuell", "fuel"), ("levell", "level"), ("aetiol", "etiol"),
    ];
    for (uk, us) in PARTS {
        if w.contains(uk) {
            w = w.replace(uk, us);
        }
    }
    // "our" words and their derivatives: tumour(s), colourful, behavioural, favourite
    const OUR: &[&str] = &[
        "colour", "tumour", "odour", "humour", "behaviour", "favour", "labour", "vapour", "rigour", "honour", "harbour",
        "neighbour", "armour", "savour", "flavour", "clamour", "valour", "vigour", "splendour", "endeavour", "rumour", "saviour",
    ];
    if let Some(p) = OUR.iter().find(|p| w.starts_with(*p)) {
        w = format!("{}r{}", &p[..p.len() - 2], &w[p.len()..]);
    }
    // haem → hem, anaemia → anemia, paediatric → pediatric (not a leading "ae": aerobic, aedes)
    if w.len() >= 5 {
        let first = w.chars().next().map_or(0, char::len_utf8);
        if let Some(i) = w[first..].find("ae") {
            w.replace_range(first + i..first + i + 2, "e");
        }
    }
    // centre, fibre, litre, micrometre → center, fiber, liter, micrometer
    if w.len() >= 5 && (w.ends_with("tre") || w.ends_with("bre")) {
        let n = w.len();
        w = format!("{}{}er", &w[..n - 3], &w[n - 3..n - 2]);
    }
    // analogue, catalogue, homologue → analog, catalog, homolog
    if w.len() >= 7 && w.ends_with("ogue") {
        w.truncate(w.len() - 2);
    }
    // -ise / -isation / -yse → -ize / -ization / -yze
    for (uk, us) in [("isation", "ization"), ("ising", "izing"), ("ised", "ized"), ("yse", "yze"), ("ysed", "yzed"), ("ysing", "yzing")] {
        if w.len() >= uk.len() + 3 && w.ends_with(uk) {
            w = format!("{}{}", &w[..w.len() - uk.len()], us);
            break;
        }
    }
    if w.len() >= 7 && w.ends_with("ise") {
        w.replace_range(w.len() - 2..w.len() - 1, "z");
    }
    w
}

/// A word as the index stores it: stemmed, then American spelling.
fn canon(w: &str) -> String {
    spelling(&stem(w))
}

/// Greek letters as words, so "TNF-α" = "TNF alpha" and "NF-κB" = "NF kappa B".
fn greek(c: char) -> Option<&'static str> {
    Some(match c {
        'α' => "alpha",
        'β' => "beta",
        'γ' => "gamma",
        'δ' => "delta",
        'ε' => "epsilon",
        'θ' => "theta",
        'κ' => "kappa",
        'λ' => "lambda",
        'μ' | 'µ' => "mu",
        'σ' => "sigma",
        'ω' => "omega",
        _ => return None,
    })
}

/// A Latin letter with an accent (or a ligature) as plain letters in the same case, so "naïve" =
/// "naive", "Sjögren" = "Sjogren", "Behçet" = "Behcet" and "Guillain-Barré" = "Guillain-Barre".
fn unaccent(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => "A",
        'ç' | 'ć' | 'č' => "c",
        'Ç' | 'Ć' | 'Č' => "C",
        'ď' | 'đ' => "d",
        'Ď' | 'Đ' => "D",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ė' | 'Ę' | 'Ě' => "E",
        'ğ' => "g",
        'Ğ' => "G",
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ı' => "i",
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' | 'İ' => "I",
        'ł' => "l",
        'Ł' => "L",
        'ñ' | 'ń' | 'ň' => "n",
        'Ñ' | 'Ń' | 'Ň' => "N",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => "o",
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' | 'Ő' => "O",
        'ř' => "r",
        'Ř' => "R",
        'ś' | 'š' | 'ş' | 'ș' => "s",
        'Ś' | 'Š' | 'Ş' | 'Ș' => "S",
        'ť' | 'ţ' | 'ț' => "t",
        'Ť' | 'Ţ' | 'Ț' => "T",
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => "u",
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' | 'Ů' | 'Ű' => "U",
        'ý' | 'ÿ' => "y",
        'Ý' | 'Ÿ' => "Y",
        'ź' | 'ż' | 'ž' => "z",
        'Ź' | 'Ż' | 'Ž' => "Z",
        'ß' => "ss",
        'æ' => "ae",
        'Æ' => "AE",
        'œ' => "oe",
        'Œ' => "OE",
        _ => return None,
    })
}

/// Text with its Latin accents dropped (also combining ones, as in a decomposed "ï"): the index
/// and the query alike, so a search never depends on how a name was typed.
fn plain(s: &str) -> std::borrow::Cow<'_, str> {
    if s.is_ascii() {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ('\u{300}'..='\u{36f}').contains(&c) {
            continue;
        }
        match unaccent(c) {
            Some(t) => out.push_str(t),
            None => out.push(c),
        }
    }
    std::borrow::Cow::Owned(out)
}

/// A word of the text, lower-case.
struct Word {
    text: String,
    /// joined to the word before by a hyphen or by nothing at all ("IL-6", "CD4", "camelCase")
    joined: bool,
    /// a camelCase word kept whole ("mRNA", "IgG"): where its parts meet
    split: Option<usize>,
}

/// The words of `s`: letters and digits, camelCase split ("macrophageM1" → macrophage, m1) except
/// after a short lower-case start ("mRNA", "siRNA", "IgG", "mAb", "ChIP" stay whole), Greek
/// letters as words, accents dropped.
fn words(s: &str) -> Vec<Word> {
    let s = plain(s);
    let mut out: Vec<Word> = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    let mut joined = false; // the word being built is joined to the previous one
    let mut attached = true; // nothing but hyphens since the previous word
    let mut split: Option<usize> = None;
    let flush = |out: &mut Vec<Word>, cur: &mut String, joined: bool, split: Option<usize>| {
        if !cur.is_empty() {
            out.push(Word { text: std::mem::take(cur), joined, split });
        }
    };
    for ch in s.chars() {
        let g = greek(ch);
        if g.is_some() || !ch.is_alphanumeric() {
            flush(&mut out, &mut cur, joined, split.take());
            if let Some(g) = g {
                out.push(Word { text: g.to_string(), joined: !out.is_empty() && attached, split: None });
                attached = true;
            } else if ch != '-' && ch != '+' {
                attached = false;
            }
            prev_lower = false;
            continue;
        }
        if cur.is_empty() {
            joined = !out.is_empty() && attached;
            attached = true;
        } else if ch.is_uppercase() && prev_lower {
            if cur.chars().count() <= 2 && split.is_none() {
                split = Some(cur.len());
            } else {
                flush(&mut out, &mut cur, joined, split.take());
                joined = true;
            }
        }
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
        cur.extend(ch.to_lowercase());
    }
    flush(&mut out, &mut cur, joined, split);
    out
}

/// Short names that a number belongs to even across a space ("interleukin 6" = "IL-6"), and
/// what they join as.
fn join_alias(w: &str) -> Option<&'static str> {
    Some(match w {
        "interleukin" | "il" => "il",
        "interferon" | "ifn" => "ifn",
        "cd" => "cd",
        _ => return None,
    })
}

/// A short name and the number written onto it ("IL-6", "CD4", "COVID-19") as one token.
fn joined_number(a: &str, a_joined_next: bool, d: &str) -> Option<String> {
    if d.is_empty() || d.len() > 3 || !d.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(alias) = join_alias(a) {
        return Some(format!("{alias}{d}"));
    }
    (a_joined_next && (1..=5).contains(&a.len()) && a.bytes().all(|b| b.is_ascii_lowercase())).then(|| format!("{a}{d}"))
}

/// Lower-case words, camelCase split, stop words dropped, stemmed, American spelling. Numbers
/// written onto a short name are joined to it; on the query side (`query`) they replace the two
/// words, on the index side they are added.
pub fn tokenize_with(s: &str, query: bool) -> Vec<String> {
    let ws: Vec<Word> = words(s).into_iter().filter(|w| !STOP.contains(&w.text.as_str())).collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < ws.len() {
        let w = canon(&ws[i].text);
        if let Some(next) = ws.get(i + 1) {
            if let Some(t) = joined_number(&w, next.joined, &next.text) {
                if query {
                    out.push(t);
                    i += 2;
                    continue;
                }
                out.push(t);
            }
        }
        // the index also keeps the parts of "mRNA" (m, rna) so "RNA" still finds it
        if let (false, Some(k)) = (query, ws[i].split) {
            out.push(canon(&ws[i].text[..k]));
            out.push(canon(&ws[i].text[k..]));
        }
        out.push(w);
        i += 1;
    }
    out
}

/// Index-side tokens (see `tokenize_with`).
pub fn tokenize(s: &str) -> Vec<String> {
    tokenize_with(s, false)
}

/// Add concept tokens for known phrases. With `replace` (query side), the phrase words are
/// replaced by the concept, so every remaining token must still match.
fn fold_phrases(tokens: &mut Vec<String>, replace: bool) {
    // the phrase words as the index stores them, worked out once
    // (and the concept too, so a name that is the concept word itself, "Golgi", "Petri", matches it)
    static CANON: std::sync::OnceLock<Vec<(Vec<String>, String)>> = std::sync::OnceLock::new();
    let phrases = CANON.get_or_init(|| PHRASES.iter().map(|(ws, c)| (ws.iter().map(|w| canon(w)).collect(), canon(c))).collect());
    for (want, concept) in phrases {
        let n = want.len();
        if tokens.len() < n {
            continue;
        }
        let mut i = 0;
        while i + n <= tokens.len() {
            if (0..n).all(|k| tokens[i + k] == want[k]) {
                if replace {
                    tokens.splice(i..i + n, [concept.to_string()]);
                } else {
                    tokens.push(concept.to_string());
                    i += n;
                    continue;
                }
            }
            i += 1;
        }
    }
}

/// The useful part of a description: not the source's boilerplate ("Servier Medical Art kit …,
/// slide 7.", "Silhouette of … from PhyloPic."), and not more than the first 30 words.
fn description_text(d: &str) -> String {
    let d = match d.find("Servier Medical Art") {
        Some(i) => &d[..i],
        None => d,
    };
    if d.starts_with("Silhouette of") && d.contains("PhyloPic") {
        return String::new();
    }
    d.split_whitespace().take(30).collect::<Vec<_>>().join(" ")
}

struct Doc {
    tokens: Vec<(String, f32)>,
    name_lc: String,
}

pub struct SearchIndex {
    docs: Vec<Doc>,
    synonyms: HashMap<String, Vec<String>>,
}

/// Search results: indices into the icons, best first. The first `full` match every word of the
/// query; the rest match only some of them.
pub struct Ranked {
    pub hits: Vec<usize>,
    pub full: usize,
}

#[derive(Default)]
pub struct Query<'a> {
    pub text: &'a str,
    pub category: Option<&'a str>,
    pub pack: Option<&'a str>,
    /// "any" | "free" (no attribution needed) | "nosa" (no share-alike)
    pub license: Option<&'a str>,
    pub only: Option<&'a HashSet<String>>,
    pub include_hidden: bool,
}

/// Whether the edit distance between `a` and `b` (swapping two neighbouring letters counts as one
/// edit) is at most `k`.
fn within(a: &str, b: &str, k: usize) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len().abs_diff(b.len()) > k {
        return false;
    }
    let w = b.len() + 1;
    let mut d = vec![0usize; (a.len() + 1) * w];
    for j in 0..w {
        d[j] = j;
    }
    for i in 1..=a.len() {
        d[i * w] = i;
        let mut row_min = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (d[(i - 1) * w + j] + 1).min(d[i * w + j - 1] + 1).min(d[(i - 1) * w + j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(d[(i - 2) * w + j - 2] + 1);
            }
            d[i * w + j] = v;
            row_min = row_min.min(v);
        }
        if row_min > k {
            return false;
        }
    }
    d[a.len() * w + b.len()] <= k
}

/// How well a document token matches a query alternative (`own`: the user's word, not a synonym).
fn score(dt: &str, w: f32, alt: &str, own: bool) -> f32 {
    if dt == alt {
        return 10.0;
    }
    // author and source names only match exactly what was typed
    if w < 0.65 || !own && alt.len() < 5 {
        return 0.0;
    }
    if alt.len() >= 2 && dt.starts_with(alt) {
        return 6.0 - (dt.len() - alt.len()).min(6) as f32 * 0.4;
    }
    if !own {
        return 0.0;
    }
    // "mitochondrial" finds mitochondria, "pancreatic" pancreas, "neuronal" neuron (but "chemokine"
    // not "chemo", "macrophage" not "macro")
    if dt.len() >= 5 && alt.starts_with(dt) && alt.len() - dt.len() <= 3 {
        return 2.2;
    }
    if alt.len() >= 4 && dt.contains(alt) {
        return 3.0;
    }
    if alt.len() >= 5 && dt.len() >= 4 && dt.as_bytes()[0] == alt.as_bytes()[0] {
        if within(dt, alt, 1) {
            return 2.5;
        }
        if alt.len() >= 8 && within(dt, alt, 2) {
            return 2.0;
        }
    }
    0.0
}

impl SearchIndex {
    pub fn build(icons: &[IconMeta]) -> Self {
        let mut synonyms: HashMap<String, Vec<String>> = HashMap::new();
        for group in SYNONYMS {
            let group: Vec<String> = group.iter().map(|t| canon(t)).collect();
            for t in &group {
                let alts = group.iter().filter(|o| *o != t).cloned();
                synonyms.entry(t.clone()).or_default().extend(alts);
            }
        }
        let docs = icons
            .iter()
            .map(|m| {
                let mut tokens: Vec<(String, f32)> = Vec::new();
                let mut add = |s: &str, w: f32, fold: bool| {
                    let mut t = tokenize(s);
                    if fold {
                        fold_phrases(&mut t, false);
                    }
                    for tok in t {
                        match tokens.iter_mut().find(|x| x.0 == tok) {
                            Some(x) => x.1 = x.1.max(w),
                            None => tokens.push((tok, w)),
                        }
                    }
                };
                add(&m.name, 3.0, true);
                for t in &m.tags {
                    add(t, 2.0, true);
                }
                add(&m.subcategory, 1.0, true);
                add(crate::taxonomy::category_name(&m.category), 0.8, false);
                add(&description_text(&m.description), 0.7, true);
                add(&m.author, 0.6, false);
                add(&m.pack, 0.5, false);
                Doc { tokens, name_lc: plain(&m.name).to_lowercase() }
            })
            .collect();
        SearchIndex { docs, synonyms }
    }

    fn passes(&self, m: &IconMeta, q: &Query) -> bool {
        if m.hidden && !q.include_hidden {
            return false;
        }
        if let Some(c) = q.category {
            if !c.is_empty() && m.category != c {
                return false;
            }
        }
        if let Some(p) = q.pack {
            if !p.is_empty() && m.pack != p {
                return false;
            }
        }
        match q.license {
            Some("free") if license_info(&m.license).1 => return false,
            Some("nosa") if m.license.contains("-SA") => return false,
            _ => {}
        }
        if let Some(only) = q.only {
            if !only.contains(&m.id) {
                return false;
            }
        }
        true
    }

    /// Indices into `icons`, best first.
    pub fn search(&self, icons: &[IconMeta], q: &Query) -> Vec<usize> {
        self.search_ranked(icons, q).hits
    }

    /// Indices into `icons`, best first: those that match every word of the query, then (for a
    /// query of two or more words) those that match its rarer words, ranked by how much of it
    /// they match.
    pub fn search_ranked(&self, icons: &[IconMeta], q: &Query) -> Ranked {
        let mut qt = tokenize_with(q.text, true);
        fold_phrases(&mut qt, true);
        let mut seen = HashSet::new();
        qt.retain(|t| seen.insert(t.clone()));
        // each query word with its synonyms: (token, weight, typed by the user)
        let groups: Vec<Vec<(String, f32, bool)>> = qt
            .iter()
            .map(|t| {
                let mut alts = vec![(t.clone(), 1.0f32, true)];
                if let Some(s) = self.synonyms.get(t) {
                    alts.extend(s.iter().map(|x| (x.clone(), 0.85, false)));
                }
                alts
            })
            .collect();
        let q_lc = plain(q.text.trim()).to_lowercase();
        let ng = groups.len();

        // every icon that matches at least one word, with how well it matches each
        let mut rows: Vec<(usize, Vec<f32>)> = Vec::new();
        let mut df = vec![0usize; ng];
        let mut n_docs = 0usize;
        for (i, m) in icons.iter().enumerate() {
            if !self.passes(m, q) {
                continue;
            }
            n_docs += 1;
            if ng == 0 {
                rows.push((i, Vec::new()));
                continue;
            }
            let doc = &self.docs[i];
            let mut best = vec![0.0f32; ng];
            for (g, alts) in groups.iter().enumerate() {
                for (dt, w) in &doc.tokens {
                    for (alt, aw, own) in alts {
                        best[g] = best[g].max(score(dt, *w, alt, *own) * w * aw);
                    }
                }
            }
            if best.iter().any(|&b| b > 0.0) {
                for g in 0..ng {
                    if best[g] > 0.0 {
                        df[g] += 1;
                    }
                }
                rows.push((i, best));
            }
        }

        if ng == 0 {
            // browsing: biology first (category order), richest sources first, then by name
            let cat = |m: &IconMeta| crate::taxonomy::CATEGORIES.iter().position(|c| c.0 == m.category).unwrap_or(99);
            let pack = |m: &IconMeta| ["biocanvas", "servier", "nih", "bioicons", "scidraw", "dbcls", "user", "healthicons"].iter().position(|p| *p == m.pack).unwrap_or(9);
            let mut hits: Vec<usize> = rows.into_iter().map(|r| r.0).collect();
            hits.sort_by(|&a, &b| {
                let (x, y) = (&icons[a], &icons[b]);
                cat(x).cmp(&cat(y)).then(pack(x).cmp(&pack(y))).then(x.name.to_lowercase().cmp(&y.name.to_lowercase()))
            });
            let full = hits.len();
            return Ranked { hits, full };
        }

        // rarer words weigh more: "nephron" says more than "kidney", "nucleus" more than "cell";
        // a number or a one- or two-letter word ("B cell 1", "M1") never makes a partial match
        // on its own
        // A word that nothing in the library matches ("T cell exhaustion") can't be covered by any
        // icon, so it neither weighs in nor counts towards how many words must match.
        let idf: Vec<f32> = df
            .iter()
            .zip(&qt)
            .map(|(&d, t)| {
                if d == 0 {
                    return 0.0;
                }
                let w = (1.0 + n_docs as f32 / (1.0 + d as f32)).ln();
                if t.len() <= 2 || t.bytes().all(|b| b.is_ascii_digit()) { w * 0.25 } else { w }
            })
            .collect();
        let idf_sum: f32 = idf.iter().sum();
        let known = df.iter().filter(|&&d| d > 0).count();
        let need = known.div_ceil(2).max(1);
        let mut full: Vec<(f32, usize)> = Vec::new();
        let mut partial: Vec<(usize, f32, usize)> = Vec::new();
        for (i, best) in rows {
            let doc = &self.docs[i];
            let matched = best.iter().filter(|&&b| b > 0.0).count();
            if matched == ng {
                let mut total: f32 = best.iter().sum();
                if doc.name_lc == q_lc {
                    total += 25.0;
                } else if doc.name_lc.starts_with(&q_lc) {
                    total += 10.0;
                }
                total -= doc.name_lc.len().min(60) as f32 * 0.05;
                full.push((total, i));
            } else if ng >= 2 && matched >= need {
                // how much of the query (by rarity) it covers, and how well: a word in the name or
                // tags counts fully, one only in the description or close by a typo about half
                let cover: f32 = (0..ng).map(|g| idf[g] * (best[g] / 15.0).min(1.0)).sum::<f32>() / idf_sum.max(1e-6);
                if cover >= 0.4 {
                    let quality: f32 = (0..ng).map(|g| best[g] * idf[g]).sum::<f32>() / idf_sum.max(1e-6);
                    partial.push((matched, cover * 100.0 + quality - doc.name_lc.len().min(60) as f32 * 0.05, i));
                }
            }
        }
        full.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        partial.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.total_cmp(&a.1)).then(a.2.cmp(&b.2)));
        let n_full = full.len();
        let hits = full.into_iter().map(|h| h.1).chain(partial.into_iter().map(|h| h.2)).collect();
        Ranked { hits, full: n_full }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn icon(id: &str, name: &str) -> IconMeta {
        IconMeta {
            id: id.into(),
            name: name.into(),
            pack: "t".into(),
            category: "cells".into(),
            subcategory: String::new(),
            tags: vec![],
            description: String::new(),
            author: String::new(),
            license: "CC0-1.0".into(),
            source_url: String::new(),
            file: String::new(),
            thumb: String::new(),
            w: 1.0,
            h: 1.0,
            slots: vec![],
            raster: false,
            variants: vec![],
            hidden: false,
            style: String::new(),
            colors: Default::default(),
        }
    }

    fn sorted(mut v: Vec<usize>) -> Vec<usize> {
        v.sort();
        v
    }

    #[test]
    fn finds_synonyms_and_phrases() {
        let icons = vec![icon("a", "T lymphocyte"), icon("b", "Erythrocytes"), icon("c", "Macrophage M1"), icon("d", "B lymphocyte")];
        let idx = SearchIndex::build(&icons);
        let q = |t| idx.search(&icons, &Query { text: t, ..Default::default() });
        assert_eq!(q("t cell"), vec![0]);
        assert_eq!(q("RBC"), vec![1]);
        assert_eq!(q("macrophag"), vec![2]);
        assert_eq!(q("macrophge"), vec![2]); // typo
        assert_eq!(q("lymphocytes").len(), 2);
    }

    #[test]
    fn flow_cytometry_and_facs_find_each_other() {
        let icons = vec![icon("a", "Flow Cytometer"), icon("b", "Facs"), icon("c", "Old man face"), icon("d", "Release factor"), icon("e", "Flow cytometer cell sorter")];
        let idx = SearchIndex::build(&icons);
        let q = |t| sorted(idx.search(&icons, &Query { text: t, ..Default::default() }));
        assert_eq!(q("flow cytometry"), vec![0, 1, 4]);
        assert_eq!(q("FACS"), vec![0, 1, 4]); // not face or factor
        assert_eq!(q("cytometer"), vec![0, 1, 4]);
        assert_eq!(q("face"), vec![2]);
    }

    #[test]
    fn british_and_american_spellings_match() {
        let icons = vec![
            icon("a", "Tumor cell"), icon("b", "Hematopoietic stem cell"), icon("c", "Esophagus"), icon("d", "Muscle fiber"),
            icon("e", "Leukemia"), icon("f", "Estrogen receptor"), icon("g", "Signaling protein"), icon("h", "Haemoglobin"),
            icon("i", "Lung alveoli"), icon("j", "Vertebrae"),
        ];
        let idx = SearchIndex::build(&icons);
        let q = |t| idx.search(&icons, &Query { text: t, ..Default::default() });
        assert_eq!(q("tumour"), vec![0]);
        assert_eq!(q("tumours"), vec![0]);
        assert_eq!(q("haematopoietic"), vec![1]);
        assert_eq!(q("oesophagus"), vec![2]);
        assert_eq!(q("fibres"), vec![3]);
        assert_eq!(q("leukaemia"), vec![4]);
        assert_eq!(q("oestrogen"), vec![5]);
        assert_eq!(q("signalling"), vec![6]);
        assert_eq!(q("hemoglobin"), vec![7]);
        assert_eq!(q("alveolus"), vec![8]);
        assert_eq!(q("vertebra"), vec![9]);
    }

    #[test]
    fn numbers_greek_letters_and_abbreviations() {
        let icons = vec![
            icon("a", "IL-6"), icon("b", "IL6R"), icon("c", "TLR2:1,2:6 heterodimer"), icon("d", "TNF"), icon("e", "Regulatory T cell"),
            icon("f", "Dendritic cell"), icon("g", "MHC class II"), icon("h", "NF-kB"), icon("i", "Interleukin 6"), icon("j", "B cell 1"),
            icon("k", "COVID-19 virus"), icon("l", "Rat"),
        ];
        let idx = SearchIndex::build(&icons);
        let q = |t| sorted(idx.search(&icons, &Query { text: t, ..Default::default() }));
        assert_eq!(q("IL-6"), vec![0, 1, 8]);
        assert_eq!(q("IL6"), vec![0, 1, 8]);
        assert_eq!(q("interleukin 6"), vec![0, 1, 8]);
        assert_eq!(q("TNF-α"), vec![3]);
        assert_eq!(q("TNF alpha"), vec![3]);
        assert_eq!(q("Treg"), vec![4]);
        assert_eq!(q("DC"), vec![5]);
        assert_eq!(q("HLA"), vec![6]);
        assert_eq!(q("NF-κB"), vec![7]);
        assert_eq!(q("NFkB"), vec![7]);
        assert_eq!(q("B cell 1"), vec![9]);
        assert_eq!(q("covid19"), vec![10]);
        assert_eq!(q("rat"), vec![11]);
    }

    #[test]
    fn typos_with_swapped_or_missing_letters() {
        let icons = vec![icon("a", "Mitochondria"), icon("b", "Fibroblast"), icon("c", "Neutrophil"), icon("d", "Osteoclast")];
        let idx = SearchIndex::build(&icons);
        let q = |t| idx.search(&icons, &Query { text: t, ..Default::default() });
        assert_eq!(q("mitochondira"), vec![0]);
        assert_eq!(q("fibroblsat"), vec![1]);
        assert_eq!(q("neutrofil"), vec![2]);
        assert_eq!(q("osteoclsat"), vec![3]);
        assert_eq!(q("mitochondrial"), vec![0]);
    }

    #[test]
    fn partial_matches_come_after_full_ones_and_skip_common_words() {
        let mut icons = vec![icon("a", "Nephron"), icon("b", "Kidney"), icon("c", "Kidney nephron cross section"), icon("d", "Flow Cytometer")];
        // plenty of "cell" icons make "cell" a common word
        for i in 0..40 {
            icons.push(icon(&format!("c{i}"), &format!("Cell type {i}")));
        }
        icons.push(icon("n", "Nucleus"));
        let idx = SearchIndex::build(&icons);
        let r = idx.search_ranked(&icons, &Query { text: "kidney nephron", ..Default::default() });
        assert_eq!(r.full, 1);
        assert_eq!(r.hits[0], 2);
        assert_eq!(sorted(r.hits[1..].to_vec()), vec![0, 1]);
        let r = idx.search_ranked(&icons, &Query { text: "flow cytometry machine", ..Default::default() });
        assert_eq!((r.full, r.hits.clone()), (0, vec![3]));
        // "nucleus of a cell": the nucleus (a cell part by its category), not every cell
        let r = idx.search_ranked(&icons, &Query { text: "nucleus of a cell", ..Default::default() });
        assert_eq!(r.hits, vec![44]);
        // one word never gives partial matches
        let r = idx.search_ranked(&icons, &Query { text: "liver", ..Default::default() });
        assert!(r.hits.is_empty());
    }

    #[test]
    fn spelling_rules() {
        for (uk, us) in [
            ("colour", "color"), ("colourful", "colorful"), ("behavioural", "behavioral"), ("haematology", "hematology"),
            ("anaemia", "anemia"), ("paediatric", "pediatric"), ("centre", "center"), ("micrometre", "micrometer"),
            ("analogue", "analog"), ("organisation", "organization"), ("analyse", "analyze"), ("diarrhoea", "diarrhea"),
            ("sulphate", "sulfate"), ("grey", "gray"), ("aerobic", "aerobic"), ("flour", "flour"), ("tour", "tour"),
        ] {
            assert_eq!(spelling(uk), us, "{uk}");
        }
    }

    #[test]
    fn accents_and_words_nothing_matches() {
        let mut icons = vec![icon("a", "Naive CD4+ T cell"), icon("b", "Sjögren syndrome salivary gland"), icon("c", "Reactive oxygen species (ROS)")];
        for i in 0..30 {
            icons.push(icon(&format!("t{i}"), &format!("T cell {i}")));
        }
        let idx = SearchIndex::build(&icons);
        let q = |t| idx.search_ranked(&icons, &Query { text: t, ..Default::default() });
        assert_eq!(q("naïve T cell").hits[0], 0);
        assert_eq!(q("Sjogren").hits, vec![1]);
        assert_eq!(q("sjögren").hits, vec![1]);
        assert_eq!(q("reactive oxygen species").hits, vec![2]);
        // a word nothing matches leaves the rest of the query to find what it can
        let r = q("T cell exhaustion");
        assert_eq!(r.full, 0);
        assert!(r.hits.len() >= 30, "{}", r.hits.len());
    }
}
