//! Try the library search from the command line against a built library, for tuning the search:
//!
//!   cargo run -p biocanvas-core --example searchq -- [--lib library] [--top 6] "t cell" "flow cytometry" …
//!   cargo run -p biocanvas-core --example searchq -- --file queries.txt      (one query per line)
//!
//! Prints each query's number of hits (how many match every word, and how many only some) and the
//! names of the best ones.

use biocanvas_core::search::{Query, SearchIndex};
use biocanvas_core::LibraryIndex;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut opt = |k: &str| args.iter().position(|a| a == k).map(|i| {
        let v = args.remove(i + 1);
        args.remove(i);
        v
    });
    let lib = opt("--lib").unwrap_or_else(|| "library".into());
    let top: usize = opt("--top").map(|v| v.parse().unwrap()).unwrap_or(6);
    let file = opt("--file");
    // --ids: print the ids of the icons that match every word instead (one query per line)
    let ids = args.iter().position(|a| a == "--ids").map(|i| args.remove(i)).is_some();
    let mut queries = args;
    if let Some(f) = file {
        queries.extend(std::fs::read_to_string(f).unwrap().lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from));
    }
    let idx: LibraryIndex = serde_json::from_slice(&std::fs::read(format!("{lib}/index.json")).expect("index.json")).expect("parse index");
    let t = std::time::Instant::now();
    let si = SearchIndex::build(&idx.icons);
    eprintln!("indexed {} icons in {:?}", idx.icons.len(), t.elapsed());
    for q in &queries {
        let t = std::time::Instant::now();
        let r = si.search_ranked(&idx.icons, &Query { text: q, ..Default::default() });
        if ids {
            println!("{q}\t{}", r.hits[..r.full].iter().map(|&i| idx.icons[i].id.as_str()).collect::<Vec<_>>().join(","));
            continue;
        }
        let names: Vec<String> = r.hits.iter().take(top).map(|&i| idx.icons[i].name.clone()).collect();
        let partial = r.hits.len() - r.full;
        println!("{:<34} {:>5}{:<8} {:>5.1}ms  {}", q, r.full, if partial > 0 { format!(" +{partial}") } else { String::new() }, t.elapsed().as_secs_f64() * 1e3, names.join(" | "));
    }
}
