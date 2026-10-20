//! BioCanvas core: everything that is not UI — the icon library and its search, SVG
//! normalisation, colour slots for recolouring, and raster/PDF export.

pub mod color;
pub mod library;
pub mod model;
pub mod palette;
pub mod render;
pub mod search;
pub mod svgclean;
pub mod taxonomy;

pub use library::Library;
pub use model::*;
pub use render::Renderer;
pub use resvg::usvg;
