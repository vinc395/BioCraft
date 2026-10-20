//! One category tree across all sources, plus keyword refinement for sources whose own
//! categories are broad ("Human_physiology", "Cells and Organelles", "General_items"…).

pub const CATEGORIES: &[(&str, &str)] = &[
    ("immune-cells", "Immune & blood cells"),
    ("cells", "Cells & cell types"),
    ("organelles", "Organelles & cell parts"),
    ("membranes", "Membranes, receptors & channels"),
    ("proteins", "Proteins & antibodies"),
    ("nucleic-acids", "DNA, RNA & genetics"),
    ("molecules", "Molecules & chemistry"),
    ("viruses", "Viruses"),
    ("microbes", "Bacteria, fungi & microbes"),
    ("parasites", "Parasites & arthropods"),
    ("anatomy", "Anatomy & organs"),
    ("tissues", "Tissues & histology"),
    ("people", "People & medicine"),
    ("animals", "Animals & model organisms"),
    ("plants", "Plants & algae"),
    ("lab", "Lab equipment"),
    ("methods", "Methods & imaging"),
    ("shapes", "Arrows, shapes & symbols"),
    ("charts", "Charts & data"),
    ("computing", "Computing & bioinformatics"),
    ("other", "Other"),
];

pub fn category_name(id: &str) -> &'static str {
    CATEGORIES.iter().find(|c| c.0 == id).map(|c| c.1).unwrap_or("Other")
}

/// Keyword rules, tried in order. A keyword matches the start of a word; a leading `*`
/// makes it match anywhere (for suffixes like "cyte") and a trailing `$` only a whole word
/// (so "lab" doesn't catch "labelled", nor "tube" "tuberculosis").
const RULES: &[(&str, &[&str])] = &[
    ("proteins", &["antibod", "immunoglobulin", "igg", "igm", "iga", "ige", "igd", "nanobod", "cytokine", "chemokine", "interleukin", "enzyme", "kinase", "protease", "insulin", "hemoglobin", "haemoglobin", "albumin", "collagen", "fibrin", "protein", "ligand", "complement"]),
    ("viruses", &["virus", "viral", "virion", "phage", "bacteriophage", "capsid", "coronavir", "sars", "hiv", "influenza", "ebola", "zika", "*virus"]),
    ("immune-cells", &["lymphocyte", "t cell", "t-cell", "tcell", "b cell", "b-cell", "macrophage", "monocyte", "neutrophil", "eosinophil", "basophil", "mast cell", "dendritic", "nk cell", "natural killer", "plasma cell", "leukocyte", "leucocyte", "granulocyte", "erythrocyte", "red blood", "white blood", "platelet", "platetelet", "thrombocyte", "megakaryo", "erythroblast", "myeloblast", "monoblast", "hematopoie", "haematopoie", "reticulocyte", "foam cell", "phagocyt", "kupffer", "microglia", "treg", "*lymphocyte"]),
    ("nucleic-acids", &["dna", "rna", "mrna", "sirna", "chromosom", "chromatin", "gene$", "genes$", "genetic", "genome", "plasmid", "nucleotide", "histone", "crispr", "helix", "codon", "transcription", "nucleosome", "karyotype", "allele", "telomere"]),
    ("organelles", &["mitochondri", "nucleus", "nuclei", "golgi", "reticulum", "lysosom", "endosom", "vesicle", "ribosom", "centriole", "centrosom", "peroxisom", "vacuole", "cytoskelet", "microtubul", "microfilament", "actin", "chloroplast", "organelle", "nuclear pore", "exosom", "autophag", "proteasom", "nucleolus", "cilia", "cilium", "flagell", "lipid droplet", "spindle"]),
    ("membranes", &["receptor", "channel", "membrane", "bilayer", "transporter", "pump", "gpcr", "integrin", "synapse", "junction", "phospholipid", "liposome", "aquaporin"]),
    ("microbes", &["bacteri", "coccus", "cocci", "bacill", "fung", "yeast", "microb", "biofilm", "spore", "ecoli", "e coli", "streptococ", "staphylococ", "mycobacter", "salmonella", "tubercul", "archae", "mold", "mould", "*bacter"]),
    ("parasites", &["parasit", "plasmodium", "malaria", "mosquito", "tick$", "ticks$", "helminth", "trypanosom", "leishmania", "toxoplasm", "schistosom", "flea", "louse", "lice$", "sandfly", "tsetse", "nematode"]),
    ("cells", &["cell", "neuron", "stem", "embryo", "zygote", "oocyte", "egg", "sperm", "cancer", "tumou", "tumor", "fibroblast", "epitheli", "endotheli", "keratinocyte", "adipocyte", "myocyte", "hepatocyte", "astrocyte", "oligodendro", "osteo", "chondro", "organoid", "spheroid", "apoptos", "necros", "mitosis", "meiosis", "*cyte", "*blast"]),
    ("tissues", &["tissue", "epithelium", "histolog", "villi", "villus", "alveol", "extracellular matrix", "ecm", "cartilage", "dermis", "mucosa", "glomerul"]),
    ("lab", &["tube$", "tubes$", "pipet", "flask", "beaker", "petri", "well plate", "microplate", "microscope", "centrifuge", "syringe", "bottle", "vial", "cuvette", "incubator", "freezer", "fridge", "cycler", "thermocycler", "sequencer", "cytometer", "glove$", "gloves$", "rack$", "racks$", "cylinder", "funnel", "burner", "fume hood", "balance$", "electrophoresis", "gel$", "gels$", "blot", "pcr", "spectrophotometer", "plate reader", "lab$", "eppendorf", "falcon", "test tube", "dropper", "scalpel", "forceps", "goggles", "lab coat"]),
    ("molecules", &["molecule", "lipid", "glucose", "sugar", "atom", "ion$", "ions$", "chemical", "compound", "drug", "ldl", "hdl", "vldl", "cholesterol", "amino acid", "peptide", "hormone", "neurotransmitter", "atp", "water", "oxygen", "carbon", "nanoparticle", "polymer", "pill", "tablet", "capsule"]),
    ("anatomy", &["heart", "lung", "liver", "kidney", "brain", "stomach", "intestin", "colon", "bone", "muscle", "skin", "eye", "ear$", "ears$", "joint", "knee", "hip$", "hips$", "spleen", "pancrea", "thyroid", "bladder", "uterus", "ovary", "testis", "prostate", "artery", "arteri", "vein", "vessel", "skeleton", "skull", "spine", "organ$", "organs$", "body", "tooth", "teeth", "lymph node", "thymus", "gland", "breast", "placenta", "nose", "mouth", "tongue", "esophag", "oesophag", "aorta", "trachea", "bronch", "digest", "respirat", "urinary", "reproductive", "nervous system", "circulat", "cardiovascul", "physiolog"]),
    ("people", &["person", "people", "man$", "men$", "woman", "child", "baby", "patient", "doctor", "nurse", "scientist", "human figure", "researcher", "family", "elderly"]),
    ("charts", &["chart", "graph", "plot", "histogram", "heatmap", "axis", "diagram"]),
    ("shapes", &["arrow", "shape", "circle", "square", "triangle", "line$", "lines$", "bracket", "symbol", "sign$", "signs$", "hazard", "warning", "biohazard", "radioactive"]),
];

/// Map a source category to a base category; `true` means "broad — refine by keywords".
fn base_category(src: &str) -> (&'static str, bool) {
    let s = src.to_ascii_lowercase().replace(['_', '-'], " ");
    let s = s.trim();
    let first = s.split(',').next().unwrap_or("").trim();
    match first {
        // Bioicons
        "human physiology" => ("anatomy", true),
        "animals" => ("animals", false),
        "blood immunology" => ("immune-cells", true),
        "general items" => ("other", true),
        "lab apparatus" => ("lab", false),
        "microbiology" => ("microbes", true),
        "intracellular components" => ("organelles", true),
        "nucleic acids" | "genetics" | "genomics" | "epigenetics" | "molecular biology" => ("nucleic-acids", false),
        "plants algae" | "plants" => ("plants", false),
        "chemistry" | "amino acids" | "nanotechnology" => ("molecules", false),
        "cell membrane" | "receptors channels" => ("membranes", false),
        "parasites" | "arthropods" => ("parasites", false),
        "scientific graphs" | "data visualization" => ("charts", false),
        "tissues" | "extracellular matrix" => ("tissues", true),
        "cell culture" => ("lab", true),
        "safety symbols" | "shapes" | "symbols" => ("shapes", false),
        "oncology" | "cell types" | "cell lines" | "neuroscience" | "cells and organelles" | "cellular processes" | "cell scenes" => ("cells", true),
        "machine learning" | "chemo  and bioinformatics" | "chemo and bioinformatics" | "computer hardware" => ("computing", false),
        "procedures" | "imaging" | "techniques" | "diagnostics" => ("methods", true),
        "people other" | "people" | "conditions" | "medications" | "specialties" | "family planning" => ("people", true),
        "viruses" => ("viruses", false),
        "molecular modelling" | "peptides" | "proteins" => ("proteins", true),
        "molecules" => ("molecules", true),
        "anatomy" | "body" => ("anatomy", true),
        "equipment" | "devices" | "objects" => ("lab", true),
        "bacteria" | "fungi" => ("microbes", false),
        "blood" => ("immune-cells", true),
        // Reactome icon library
        "cell element" | "cell elements" => ("organelles", true),
        "cell type" => ("cells", true),
        "compound" | "compounds" => ("molecules", false),
        "human tissue" => ("tissues", true),
        "ion channel" | "ion channels" | "receptor" | "receptors" => ("membranes", true),
        "protein" => ("proteins", true),
        other => guess_from_label(other),
    }
}

/// Unknown source labels (Servier kit names, PhyloPic groups…): guess from the label itself.
fn guess_from_label(l: &str) -> (&'static str, bool) {
    let has = |k: &[&str]| k.iter().any(|w| l.contains(w));
    if has(&["bacteri", "archae", "fung", "protist", "yeast", "microb"]) {
        ("microbes", true)
    } else if has(&["virus", "viral"]) {
        ("viruses", false)
    } else if has(&["insect", "arachnid", "tick", "mite", "parasit", "worm", "nematod"]) {
        ("parasites", true)
    } else if has(&["plant", "alga", "tree", "flower"]) {
        ("plants", false)
    } else if has(&["mammal", "bird", "fish", "reptil", "amphib", "animal", "vertebrat", "mollus", "crustac", "rodent", "primate"]) {
        ("animals", true)
    } else if has(&["immun", "blood", "haemat", "hemat"]) {
        ("immune-cells", true)
    } else if has(&["cell", "cyto"]) {
        ("cells", true)
    } else if has(&["equipment", "laborator"]) || l == "lab" || l.starts_with("lab ") {
        ("lab", true)
    } else if has(&["anatom", "organ", "system", "heart", "brain", "bone", "muscle", "skin", "eye", "digest", "respirat", "urin", "reproduct", "endocrin", "nervous", "cardio", "arter", "vein", "lymph", "joint", "skeleton"]) {
        ("anatomy", true)
    } else if has(&["people", "patient", "medic", "health", "hospital"]) {
        ("people", true)
    } else if has(&["chem", "molec", "drug", "pharma", "lipid"]) {
        ("molecules", true)
    } else if has(&["gene", "dna", "rna", "chromosom"]) {
        ("nucleic-acids", true)
    } else {
        ("other", true)
    }
}

fn text_of(name: &str, tags: &[String]) -> String {
    let mut t = String::from(" ");
    for part in std::iter::once(name).chain(tags.iter().map(|s| s.as_str())) {
        for w in part
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
        {
            t.push_str(w);
            t.push(' ');
        }
    }
    t
}

fn rule_hit(text: &str, kw: &str) -> bool {
    if let Some(k) = kw.strip_prefix('*') {
        text.contains(k)
    } else if let Some(k) = kw.strip_suffix('$') {
        text.contains(&format!(" {k} "))
    } else {
        text.contains(&format!(" {kw}"))
    }
}

/// Unified category for an icon from its source category and name/tags.
pub fn categorize(source_category: &str, name: &str, tags: &[String]) -> &'static str {
    let (base, broad) = base_category(source_category);
    let text = text_of(name, tags);
    // Antibodies are filed under "Blood_Immunology" by several sources but are proteins.
    if base == "immune-cells" || base == "cells" || base == "membranes" {
        if RULES[0].1.iter().take(7).any(|k| rule_hit(&text, k)) {
            return "proteins";
        }
    }
    if !broad {
        return base;
    }
    for (cat, kws) in RULES {
        if kws.iter().any(|k| rule_hit(&text, k)) {
            return cat;
        }
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn examples() {
        let t: Vec<String> = vec![];
        assert_eq!(categorize("Blood_Immunology", "neutrophil-granulocyte-1", &t), "immune-cells");
        assert_eq!(categorize("Blood_Immunology", "igG-immunoglobulin", &t), "proteins");
        assert_eq!(categorize("Human_physiology", "heart-anatomy", &t), "anatomy");
        assert_eq!(categorize("Cells and Organelles", "Macrophage", &t), "immune-cells");
        assert_eq!(categorize("Cells and Organelles", "Mitochondrion", &t), "organelles");
        assert_eq!(categorize("Lab_apparatus", "eppendorf tube", &t), "lab");
        assert_eq!(categorize("Human_physiology", "lesion", &t), "anatomy");
        assert_eq!(categorize("Human_physiology", "digestive-system-labeled", &t), "anatomy");
        assert_eq!(categorize("Human_physiology", "vein valve", &["Human physiology".to_string()]), "anatomy");
        assert_eq!(categorize("General_items", "tuberculosis", &t), "microbes");
        assert_eq!(categorize("General_items", "glass test tube", &t), "lab");
        assert_eq!(categorize("Human_physiology", "mandible", &t), "anatomy");
    }
}
