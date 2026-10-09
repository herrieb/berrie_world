// Low-level pixel drawing on an ImageData buffer, plus isometric helpers.
// World units: tiles on x/y, pixels on z. One tile is a 32x16 diamond.

export const TW = 32;
export const TH = 16;

export type RGB = [number, number, number];

export function hex(c: number): RGB {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

export function shade(c: RGB, f: number): RGB {
  return f >= 1
    ? [c[0] + (255 - c[0]) * (f - 1), c[1] + (255 - c[1]) * (f - 1), c[2] + (255 - c[2]) * (f - 1)].map(Math.round) as RGB
    : [c[0] * f, c[1] * f, c[2] * f].map(Math.round) as RGB;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as RGB;
}

/** Deterministic hash → [0,1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise. */
export function noise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * s(xf) + (c - a) * s(yf) + (a - b - c + d) * s(xf) * s(yf);
}

export type ColorFn = (px: number, py: number) => RGB | null;

export class Px {
  readonly img: ImageData;
  readonly canvas: HTMLCanvasElement;

  constructor(readonly w: number, readonly h: number, public ox = 0, public oy = 0) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.img = new ImageData(w, h);
  }

  set(x: number, y: number, c: RGB, a = 255): void {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const d = this.img.data;
    if (a >= 255) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; return; }
    const t = a / 255;
    const da = d[i + 3] / 255;
    const oa = t + da * (1 - t);
    if (oa <= 0) return;
    d[i] = (c[0] * t + d[i] * da * (1 - t)) / oa;
    d[i + 1] = (c[1] * t + d[i + 1] * da * (1 - t)) / oa;
    d[i + 2] = (c[2] * t + d[i + 2] * da * (1 - t)) / oa;
    d[i + 3] = oa * 255;
  }

  alpha(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.img.data[(y * this.w + x) * 4 + 3];
  }

  rect(x: number, y: number, w: number, h: number, c: RGB, a = 255): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, a);
  }

  /** Project world (tile x, tile y, pixel z) to canvas pixels. */
  p(x: number, y: number, z = 0): [number, number] {
    return [this.ox + (x - y) * (TW / 2), this.oy + (x + y) * (TH / 2) - z];
  }

  /** Rasterise a polygon (screen coords) using pixel-centre sampling for crisp pixel-art edges. */
  poly(pts: [number, number][], color: RGB | ColorFn, a = 255): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    for (let py = Math.floor(minY); py <= Math.ceil(maxY); py++) {
      for (let px = Math.floor(minX); px <= Math.ceil(maxX); px++) {
        const cx = px + 0.5, cy = py + 0.5;
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > cy) !== (yj > cy) && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (!inside) continue;
        const c = typeof color === 'function' ? color(px, py) : color;
        if (c) this.set(px, py, c, a);
      }
    }
  }

  /** Polygon from world points. */
  wpoly(pts: [number, number, number][], color: RGB | ColorFn, a = 255): void {
    this.poly(pts.map(([x, y, z]) => this.p(x, y, z)), color, a);
  }

  /** Axis-aligned iso box: footprint [x0,x1]×[y0,y1], from z0 to z1. Draws the two visible walls and the top. */
  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, c: { top: RGB; left: RGB; right: RGB }, wallFn?: { left?: ColorFn; right?: ColorFn; top?: ColorFn }): void {
    this.wpoly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], wallFn?.left ?? c.left);
    this.wpoly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], wallFn?.right ?? c.right);
    this.wpoly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], wallFn?.top ?? c.top);
  }

  /** Window on the left (y = y1) wall. */
  winL(y1: number, xa: number, xb: number, za: number, zb: number, c: RGB, frame?: RGB): void {
    if (frame) this.wpoly([[xa - 0.03, y1, za - 1], [xb + 0.03, y1, za - 1], [xb + 0.03, y1, zb + 1], [xa - 0.03, y1, zb + 1]], frame);
    this.wpoly([[xa, y1, za], [xb, y1, za], [xb, y1, zb], [xa, y1, zb]], c);
  }

  /** Window on the right (x = x1) wall. */
  winR(x1: number, ya: number, yb: number, za: number, zb: number, c: RGB, frame?: RGB): void {
    if (frame) this.wpoly([[x1, ya - 0.03, za - 1], [x1, yb + 0.03, za - 1], [x1, yb + 0.03, zb + 1], [x1, ya - 0.03, zb + 1]], frame);
    this.wpoly([[x1, ya, za], [x1, yb, za], [x1, yb, zb], [x1, ya, zb]], c);
  }

  /** 1px dark outline around opaque pixels — classic pixel-art readability. */
  outline(c: RGB = [22, 26, 38], a = 200): void {
    const src = new Uint8ClampedArray(this.img.data);
    const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < this.w && y < this.h && src[(y * this.w + x) * 4 + 3] > 40;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (opaque(x, y)) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) this.set(x, y, c, a);
    }
  }

  done(): HTMLCanvasElement {
    this.canvas.getContext('2d')!.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}
