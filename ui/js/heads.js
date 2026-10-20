// Arrowheads and dash patterns, shared by lines (render.js) and path-arrow brushes (brush.js).

const n = (v) => (Math.round(v * 1000) / 1000).toString();

export const HEADS = ["none", "arrow", "open", "bar", "dot", "diamond"];

/** How far each head kind cuts back the line under it, as a fraction of the head size. */
export const TRIM = { arrow: 0.7, diamond: 0.9, dot: 0.45, open: 0.05, bar: 0, none: 0 };

/** Head size for a stroke width (and the object's head scale). */
export const headSize = (sw, scale = 1) => Math.max(7, sw * 4.2) * (scale || 1);

/** An arrowhead at tip p, pointing along the unit direction d, of size s. */
export function head(kind, [px, py], [dx, dy], s, color, sw) {
  const nx = -dy, ny = dx;
  const bx = px - dx * s, by = py - dy * s;
  switch (kind) {
    case "arrow": {
      const w = s * 0.46;
      return `<path d="M${n(px)} ${n(py)}L${n(bx + nx * w)} ${n(by + ny * w)}L${n(px - dx * s * 0.78)} ${n(py - dy * s * 0.78)}L${n(bx - nx * w)} ${n(by - ny * w)}Z" fill="${color}"/>`;
    }
    case "open": {
      const w = s * 0.5;
      return `<path d="M${n(bx + nx * w)} ${n(by + ny * w)}L${n(px)} ${n(py)}L${n(bx - nx * w)} ${n(by - ny * w)}" fill="none" stroke="${color}" stroke-width="${n(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    case "bar": {
      const w = s * 0.62;
      return `<path d="M${n(px + nx * w)} ${n(py + ny * w)}L${n(px - nx * w)} ${n(py - ny * w)}" stroke="${color}" stroke-width="${n(sw * 1.35)}" stroke-linecap="round"/>`;
    }
    case "dot":
      return `<circle cx="${n(px - dx * s * 0.3)}" cy="${n(py - dy * s * 0.3)}" r="${n(s * 0.32)}" fill="${color}"/>`;
    case "diamond": {
      const w = s * 0.32, mx = px - dx * s * 0.5, my = py - dy * s * 0.5;
      return `<path d="M${n(px)} ${n(py)}L${n(mx + nx * w)} ${n(my + ny * w)}L${n(px - dx * s)} ${n(py - dy * s)}L${n(mx - nx * w)} ${n(my - ny * w)}Z" fill="${color}"/>`;
    }
    default:
      return "";
  }
}

/** How far a head reaches sideways from the line (for bounding boxes). */
export const headReach = (kind, s) => (!kind || kind === "none" ? 0 : s * (kind === "bar" ? 0.62 : 0.5));

export function dashArray(kind, sw) {
  if (!kind) return "";
  if (kind === "dot") return `${n(sw * 0.01 + 0.01)} ${n(sw * 2.2)}`;
  if (kind === "dash") return `${n(sw * 3.5)} ${n(sw * 2.4)}`;
  if (kind === "long") return `${n(sw * 7)} ${n(sw * 3)}`;
  return kind;
}
