//! How many subjects of an outside icon list the library already has: each name (without its
//! bracketed qualifiers) is searched, leaving out some packs, and the best hits are written as JSON
//! lines for review.
//!
//!   cargo run --release -p biocanvas-core --example coverage -- names.tsv out.jsonl [--lib library] [--exclude biocanvas,user]
//!
//! names.tsv: category <TAB> subcategory <TAB> name, one per line.

use biocanvas_core::search::{Query, SearchIndex};
use biocanvas_core::LibraryIndex;
use serde_json::json;
use std::io::Write;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut opt = |k: &str| args.iter().position(|a| a == k).map(|i| {
        let v = args.remove(i + 1);
        args.remove(i);
        v
    });
    let lib = opt("--lib").unwrap_or_else(|| "library".into());
    let exclude: Vec<String> = opt("--exclude").unwrap_or_else(|| "biocanvas,user".into()).split(',').map(String::from).collect();
    let (names, out) = (&args[0], &args[1]);
    let idx: LibraryIndex = serde_json::from_slice(&std::fs::read(format!("{lib}/index.json")).unwrap()).unwrap();
    let si = SearchIndex::build(&idx.icons);
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
    let text = std::fs::read_to_string(names).unwrap();
    let open = |i: &usize| !exclude.contains(&idx.icons[*i].pack);
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut f = line.split('\t');
        let (cat, sub, name) = (f.next().unwrap_or(""), f.next().unwrap_or(""), f.next().unwrap_or(""));
        // the subject without "(editable)", "(cross-section)", "(large 1)"…
        let mut q = String::new();
        let mut depth = 0;
        for c in name.chars() {
            match c {
                '(' | '[' => depth += 1,
                ')' | ']' => depth = (depth - 1).max(0),
                _ if depth == 0 => q.push(c),
                _ => {}
            }
        }
        let q = q.split_whitespace().collect::<Vec<_>>().join(" ");
        let r = si.search_ranked(&idx.icons, &Query { text: &q, ..Default::default() });
        let full: Vec<usize> = r.hits[..r.full].iter().copied().filter(|i| open(i)).collect();
        let shown: Vec<usize> = if full.is_empty() { r.hits[r.full..].iter().copied().filter(|i| open(i)).take(3).collect() } else { full.iter().copied().take(3).collect() };
        let top: Vec<_> = shown.iter().map(|&i| json!([idx.icons[i].id, idx.icons[i].name, idx.icons[i].pack, idx.icons[i].tags])).collect();
        writeln!(w, "{}", json!({ "cat": cat, "sub": sub, "name": name, "q": q, "full": full.len(), "top": top })).unwrap();
    }
}
