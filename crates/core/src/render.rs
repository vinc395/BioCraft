//! Rasterising (thumbnails, PNG/TIFF export at a chosen DPI) and vector PDF export.

use crate::color::Rgb;
use crate::svgclean;
use anyhow::{anyhow, bail, Result};
use resvg::tiny_skia::{self, Pixmap};
use resvg::usvg;
use std::sync::Arc;

/// Largest raster export we allow (≈ A3 at 1200 dpi).
const MAX_PIXELS: u64 = 330_000_000;

pub struct Renderer {
    pub fontdb: Arc<usvg::fontdb::Database>,
}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}

impl Renderer {
    pub fn new() -> Self {
        let mut db = usvg::fontdb::Database::new();
        db.load_system_fonts();
        Renderer { fontdb: Arc::new(db) }
    }

    pub fn options(&self) -> usvg::Options<'static> {
        svgclean::safe_options(self.fontdb.clone())
    }

    pub fn parse(&self, data: &[u8]) -> Result<usvg::Tree> {
        svgclean::parse(data, &self.options())
    }

    /// Render so the longer side is `max_px`, centred on a transparent square canvas.
    pub fn thumbnail(&self, tree: &usvg::Tree, max_px: u32) -> Result<Pixmap> {
        let size = tree.size();
        let scale = max_px as f32 / size.width().max(size.height());
        let mut pm = Pixmap::new(max_px, max_px).ok_or_else(|| anyhow!("bad thumbnail size"))?;
        let dx = (max_px as f32 - size.width() * scale) / 2.0;
        let dy = (max_px as f32 - size.height() * scale) / 2.0;
        let ts = tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, dx, dy);
        resvg::render(tree, ts, &mut pm.as_mut());
        Ok(pm)
    }

    /// Render at `scale` × the SVG's CSS-pixel size, optionally over a solid background.
    pub fn render_scaled(&self, tree: &usvg::Tree, scale: f32, background: Option<Rgb>) -> Result<Pixmap> {
        let size = tree.size();
        let w = (size.width() * scale).ceil().max(1.0) as u32;
        let h = (size.height() * scale).ceil().max(1.0) as u32;
        if w as u64 * h as u64 > MAX_PIXELS {
            bail!("{w}×{h} px is too large to export; lower the DPI or the figure size");
        }
        let mut pm = Pixmap::new(w, h).ok_or_else(|| anyhow!("could not allocate {w}×{h} image"))?;
        if let Some(bg) = background {
            pm.fill(tiny_skia::Color::from_rgba8(bg.r, bg.g, bg.b, 255));
        }
        resvg::render(tree, tiny_skia::Transform::from_scale(scale, scale), &mut pm.as_mut());
        Ok(pm)
    }
}

fn straight_rgba(pm: &Pixmap) -> Vec<u8> {
    let mut out = Vec::with_capacity(pm.data().len());
    for p in pm.pixels() {
        let c = p.demultiply();
        out.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    out
}

/// PNG with the physical resolution (pHYs) set, so journals read the right DPI.
pub fn encode_png(pm: &Pixmap, dpi: Option<f32>) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut buf, pm.width(), pm.height());
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Default);
        if let Some(dpi) = dpi {
            let ppm = (dpi / 0.0254).round() as u32;
            enc.set_pixel_dims(Some(png::PixelDimensions { xppu: ppm, yppu: ppm, unit: png::Unit::Meter }));
        }
        let mut w = enc.write_header()?;
        w.write_image_data(&straight_rgba(pm))?;
    }
    Ok(buf)
}

/// LZW-compressed RGBA TIFF with its resolution in dots per inch.
pub fn encode_tiff(pm: &Pixmap, dpi: f32) -> Result<Vec<u8>> {
    use tiff::encoder::{colortype, compression::Lzw, Rational, TiffEncoder};
    use tiff::tags::ResolutionUnit;
    let mut cur = std::io::Cursor::new(Vec::new());
    {
        let mut enc = TiffEncoder::new(&mut cur)?;
        let mut img = enc.new_image_with_compression::<colortype::RGBA8, _>(pm.width(), pm.height(), Lzw)?;
        img.resolution(ResolutionUnit::Inch, Rational { n: dpi.round().max(1.0) as u32, d: 1 });
        img.write_data(&straight_rgba(pm))?;
    }
    Ok(cur.into_inner())
}

/// Vector PDF; page size follows the SVG's width/height (mm in → mm out).
pub fn to_pdf(tree: &usvg::Tree) -> Result<Vec<u8>> {
    let conv = svg2pdf::ConversionOptions { embed_text: true, ..Default::default() };
    let page = svg2pdf::PageOptions { dpi: 96.0 };
    svg2pdf::to_pdf(tree, conv, page).map_err(|e| anyhow!("PDF export failed: {e:?}"))
}

/// One vector PDF with a page per SVG, each page the size of its SVG (CSS px → pt). Every page
/// is converted on its own and placed as a form XObject, so fonts are embedded per page.
pub fn pages_to_pdf(pages: &[usvg::Tree], title: Option<&str>) -> Result<Vec<u8>> {
    use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref, TextStr};
    use std::collections::HashMap;
    if pages.is_empty() {
        bail!("no pages to write");
    }
    let mut alloc = Ref::new(1);
    let catalog_id = alloc.bump();
    let tree_id = alloc.bump();
    let mut pdf = Pdf::new();
    let mut kids = Vec::new();
    let name = Name(b"P");
    for tree in pages {
        let conv = svg2pdf::ConversionOptions { embed_text: true, ..Default::default() };
        let (chunk, svg_id) = svg2pdf::to_chunk(tree, conv).map_err(|e| anyhow!("PDF export failed: {e:?}"))?;
        let mut map = HashMap::new();
        let chunk = chunk.renumber(|old| *map.entry(old).or_insert_with(|| alloc.bump()));
        let svg_id = map[&svg_id];
        let (page_id, content_id) = (alloc.bump(), alloc.bump());
        // the XObject is a 1 × 1 unit square: scale it up to the page
        let (w, h) = (tree.size().width() * 0.75, tree.size().height() * 0.75);
        let mut page = pdf.page(page_id);
        page.media_box(Rect::new(0.0, 0.0, w, h));
        page.parent(tree_id);
        page.contents(content_id);
        page.resources().x_objects().pair(name, svg_id);
        page.finish();
        let mut content = Content::new();
        content.transform([w, 0.0, 0.0, h, 0.0, 0.0]).x_object(name);
        pdf.stream(content_id, &content.finish());
        pdf.extend(&chunk);
        kids.push(page_id);
    }
    pdf.catalog(catalog_id).pages(tree_id);
    pdf.pages(tree_id).kids(kids.iter().copied()).count(kids.len() as i32);
    let mut info = pdf.document_info(alloc.bump());
    info.creator(TextStr("BioCraft"));
    if let Some(t) = title {
        info.title(TextStr(t));
    }
    info.finish();
    Ok(pdf.finish())
}
