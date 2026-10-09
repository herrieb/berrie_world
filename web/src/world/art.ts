// Procedural pixel-art sprites. Every recipe draws into a Px buffer in world (iso) space.
import type { BuildingType } from '@berrie/shared';
import { Px, hex, shade, mix, hash2, type RGB, type ColorFn, TW, TH } from './pixel';

export interface SpriteArt {
  canvas: HTMLCanvasElement;
  /** Canvas pixel of the footprint's back corner (tile origin). */
  ox: number;
  oy: number;
  /** Canvas pixel where the status beacon sits. */
  top: [number, number];
  /** Canvas pixel for chimney smoke, if any. */
  smoke?: [number, number];
}

const OUT: RGB = [20, 24, 36];
const LIT: RGB = hex(0xffd36b);
const LIT2: RGB = hex(0xffeaa8);
const DARKWIN: RGB = hex(0x2c3b58);
const FRAME: RGB = hex(0x3b3140);

/** Lighting: light comes from the upper left, so the left (south-west) wall is brighter. */
const faces = (c: RGB) => ({ top: shade(c, 1.12), left: shade(c, 0.94), right: shade(c, 0.72) });

function canvasFor(w: number, d: number, height: number, pad = 6) {
  const W = (w + d) * (TW / 2) + pad * 2;
  const H = (w + d) * (TH / 2) + height + pad * 2;
  return new Px(W, H, d * (TW / 2) + pad, height + pad);
}

/** Pattern helpers mapping wall pixels back to (u along wall, z height). */
function leftWall(px: Px, y1: number, fn: (u: number, z: number) => RGB): ColorFn {
  return (sx, sy) => {
    const u = (sx + 0.5 - px.ox) / (TW / 2) + y1;
    const z = px.oy + (u + y1) * (TH / 2) - (sy + 0.5);
    return fn(u, z);
  };
}
function rightWall(px: Px, x1: number, fn: (u: number, z: number) => RGB): ColorFn {
  return (sx, sy) => {
    const v = x1 - (sx + 0.5 - px.ox) / (TW / 2);
    const z = px.oy + (x1 + v) * (TH / 2) - (sy + 0.5);
    return fn(v, z);
  };
}

const brick = (base: RGB, f: number) => (u: number, z: number): RGB => {
  const row = Math.floor(z / 3);
  const mortar = Math.floor(z) % 3 === 0 || Math.floor(u * 8 + (row % 2) * 0.5) !== Math.floor((u + 0.03) * 8 + (row % 2) * 0.5);
  const n = hash2(Math.floor(u * 8), row, 7) * 0.12 - 0.06;
  return shade(mortar ? mix(base, [200, 190, 175], 0.35) : base, f + n);
};
const siding = (base: RGB, f: number) => (_u: number, z: number): RGB => shade(base, f - (Math.floor(z) % 3 === 0 ? 0.08 : 0));
const glass = (base: RGB, f: number) => (u: number, z: number): RGB => {
  const strip = Math.floor(u * 10) % 2 === 0;
  return shade(base, f + (strip ? 0.06 : -0.04) + (z % 6 < 1 ? -0.12 : 0));
};
const corrugated = (base: RGB, f: number) => (u: number): RGB => shade(base, f + (Math.floor(u * 16) % 2 ? 0.05 : -0.06));
const stone = (base: RGB, f: number) => (u: number, z: number): RGB => {
  const row = Math.floor(z / 4);
  const joint = Math.floor(z) % 4 === 0 || Math.floor(u * 5 + (row % 2) * 0.5) !== Math.floor((u + 0.04) * 5 + (row % 2) * 0.5);
  return shade(joint ? shade(base, 0.8) : base, f + hash2(Math.floor(u * 5), row, 3) * 0.1 - 0.05);
};

function windowsLeft(px: Px, y1: number, x0: number, x1: number, rows: [number, number][], seed: number, lit = LIT, count?: number) {
  const n = count ?? Math.max(1, Math.floor((x1 - x0) / 0.38));
  const span = (x1 - x0) / n;
  for (const [za, zb] of rows) for (let i = 0; i < n; i++) {
    const on = hash2(i, za, seed) > 0.25;
    const a = x0 + span * i + span * 0.25, b = x0 + span * (i + 1) - span * 0.25;
    px.winL(y1, a, b, za, zb, on ? lit : DARKWIN, FRAME);
    if (on) px.winL(y1, a, a + (b - a) * 0.35, zb - 2, zb, LIT2);
  }
}
function windowsRight(px: Px, x1: number, y0: number, y1: number, rows: [number, number][], seed: number, lit = LIT, count?: number) {
  const n = count ?? Math.max(1, Math.floor((y1 - y0) / 0.38));
  const span = (y1 - y0) / n;
  for (const [za, zb] of rows) for (let i = 0; i < n; i++) {
    const on = hash2(i, za, seed + 1) > 0.3;
    px.winR(x1, y0 + span * i + span * 0.25, y0 + span * (i + 1) - span * 0.25, za, zb, on ? shade(lit, 0.9) : shade(DARKWIN, 0.8), shade(FRAME, 0.8));
  }
}

function pitchedRoof(px: Px, x0: number, y0: number, x1: number, y1: number, h: number, rise: number, roof: RGB, wall: RGB) {
  const o = 0.1, ym = (y0 + y1) / 2;
  px.wpoly([[x1, y0, h], [x1, y1, h], [x1, ym, h + rise]], rightWall(px, x1, siding(wall, 0.72)));
  px.wpoly([[x0 - o, y0 - o, h - 1], [x1 + o, y0 - o, h - 1], [x1 + o, ym, h + rise], [x0 - o, ym, h + rise]], shade(roof, 0.82));
  px.wpoly([[x0 - o, y1 + o, h - 1], [x1 + o, y1 + o, h - 1], [x1 + o, ym, h + rise], [x0 - o, ym, h + rise]], (sx, sy) => {
    const row = (sy + Math.floor((sx - px.ox) / 2)) % 3 === 0;
    return shade(roof, (row ? 0.9 : 1.04) + hash2(sx, sy, 5) * 0.06);
  });
  // ridge highlight
  px.wpoly([[x0 - o, ym - 0.03, h + rise], [x1 + o, ym - 0.03, h + rise], [x1 + o, ym + 0.03, h + rise], [x0 - o, ym + 0.03, h + rise]], shade(roof, 1.25));
}

function door(px: Px, y1: number, xa: number, xb: number, h: number, c: RGB = hex(0x5a3a28)) {
  px.winL(y1, xa, xb, 0, h, c, shade(c, 0.6));
  px.winL(y1, xb - (xb - xa) * 0.3, xb - (xb - xa) * 0.15, h * 0.45, h * 0.55, hex(0xe8c860));
}

function cylinder(px: Px, cx: number, cy: number, r: number, z0: number, h: number, base: RGB, bands = 8) {
  const [sx, sy] = px.p(cx, cy, z0);
  const rx = r * (TW / 2) * Math.SQRT2, ry = r * (TH / 2) * Math.SQRT2;
  for (let dx = -Math.floor(rx); dx <= Math.ceil(rx); dx++) {
    const t = dx / rx;
    if (Math.abs(t) > 1) continue;
    const e = ry * Math.sqrt(1 - t * t);
    const f = 1.08 - 0.42 * ((t + 1) / 2) + (Math.abs(t) > 0.85 ? -0.08 : 0);
    for (let y = Math.floor(sy - h); y <= Math.ceil(sy + e); y++) {
      const z = sy + e - y;
      const band = bands > 0 && Math.floor(z) % bands === 0 && z > 1 && z < h - 1;
      px.set(sx + dx, y, shade(base, f - (band ? 0.12 : 0)));
    }
  }
  for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) {
    if ((x / rx) ** 2 + (y / ry) ** 2 <= 1) px.set(sx + x, sy - h + y, shade(base, 1.18 - (x / rx) * 0.1));
  }
}

function line(px: Px, a: [number, number], b: [number, number], c: RGB) {
  const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
  for (let i = 0; i <= steps; i++) px.set(Math.round(a[0] + ((b[0] - a[0]) * i) / steps), Math.round(a[1] + ((b[1] - a[1]) * i) / steps), c);
}

function shadowPad(px: Px, w: number, d: number) {
  // soft contact shadow + paved foundation
  px.wpoly([[0.1, 0.1, 0], [w - 0.1, 0.1, 0], [w - 0.1, d - 0.1, 0], [0.1, d - 0.1, 0]], (sx, sy) => shade(hex(0x8f948f), 0.95 + hash2(sx, sy, 2) * 0.1));
  px.wpoly([[0.18, d - 0.1, 0], [w - 0.1, d - 0.1, 0], [w - 0.1, 0.18, 0], [w + 0.15, 0.4, 0], [w + 0.15, d + 0.15, 0], [0.4, d + 0.15, 0]], [20, 30, 25], 70);
}

// ---------------------------------------------------------------------------------------------
// Building recipes
// ---------------------------------------------------------------------------------------------

const ROOFS = [0xb9473a, 0x34466e, 0x2f7a78, 0x7a4b32, 0x5b4a8a, 0x3d5a8a].map(hex);
const WALLS = [0xe9dcc0, 0xd8dde6, 0xf1e6d2, 0xcfd6c4].map(hex);

function house(seed: number, roofOverride?: RGB, wallOverride?: RGB): SpriteArt {
  const tall = hash2(seed, 1) > 0.5;
  const h = tall ? 30 : 20;
  const px = canvasFor(2, 2, h + 26);
  shadowPad(px, 2, 2);
  const wall = wallOverride ?? WALLS[Math.floor(hash2(seed, 2) * WALLS.length)];
  const roof = roofOverride ?? ROOFS[Math.floor(hash2(seed, 3) * ROOFS.length)];
  const [x0, y0, x1, y1] = [0.32, 0.32, 1.68, 1.62];
  px.box(x0, y0, x1, y1, 0, h, faces(wall), { left: leftWall(px, y1, siding(wall, 0.96)), right: rightWall(px, x1, siding(wall, 0.72)) });
  px.box(x0 - 0.02, y0, x1 + 0.02, y1 + 0.02, 0, 3, faces(hex(0x8a7d6b)));
  door(px, y1, 0.55, 0.78, 12);
  windowsLeft(px, y1, 0.9, x1 - 0.1, [[5, 11]], seed, LIT, 2);
  if (tall) windowsLeft(px, y1, x0 + 0.1, x1 - 0.1, [[17, 24]], seed + 3, LIT, 3);
  windowsRight(px, x1, y0 + 0.1, y1 - 0.1, tall ? [[5, 11], [17, 24]] : [[6, 12]], seed, LIT, 2);
  // chimney
  px.box(0.55, 0.55, 0.75, 0.75, h, h + 18, faces(hex(0x8e5a48)));
  pitchedRoof(px, x0, y0, x1, y1, h, 14, roof, wall);
  px.outline(OUT);
  const top = px.p(1.0, 0.97, h + 18);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [top[0], top[1] - 4] };
}

/**
 * Server tower. `tier` reflects *confirmed* CPU capacity (1: ≤4 cores, 2: ≤16, 3: more); null = capacity not collected,
 * drawn as a neutral standard tower so the picture never implies a measurement that does not exist.
 */
function server(seed: number, tier: number | null = null): SpriteArt {
  const h = tier === 1 ? 32 : tier === 3 ? 62 : tier === 2 ? 50 : 42;
  const px = canvasFor(3, 3, h + 34);
  shadowPad(px, 3, 3);
  const body = hex(0x27324d);
  const [x0, y0, x1, y1] = [0.35, 0.45, 2.55, 2.6];
  px.box(x0, y0, x1, y1, 0, h, faces(body), { left: leftWall(px, y1, glass(body, 0.98)), right: rightWall(px, x1, glass(body, 0.74)) });
  const blue = hex(0x5cc8ff);
  for (let z = 6; z < h - 4; z += 7) {
    windowsLeft(px, y1, x0 + 0.1, x1 - 0.1, [[z, z + 3]], seed + z, blue, 6);
    windowsRight(px, x1, y0 + 0.1, y1 - 0.1, [[z, z + 3]], seed + z, blue, 5);
  }
  // LED strips at the corners
  px.wpoly([[x1 - 0.04, y1, 2], [x1, y1, 2], [x1, y1, h - 2], [x1 - 0.04, y1, h - 2]], hex(0x9be7ff));
  // lobby annex
  px.box(0.4, 2.6, 1.6, 2.92, 0, 12, faces(hex(0x3a4766)));
  px.winL(2.92, 0.7, 1.3, 1, 9, hex(0x8fdcff), hex(0x1d2538));
  // roof equipment
  px.box(x0, y0, x1, y1, h, h + 3, faces(hex(0x3d4a68)));
  px.box(0.7, 0.8, 1.2, 1.3, h + 3, h + 9, faces(hex(0x8a94a8)));
  px.box(1.5, 0.8, 2.0, 1.2, h + 3, h + 7, faces(hex(0x8a94a8)));
  // satellite dish
  const [dx, dy] = px.p(2.0, 2.0, h + 14);
  for (let y = -5; y <= 5; y++) for (let x = -7; x <= 7; x++) if ((x / 7) ** 2 + (y / 4) ** 2 <= 1) px.set(dx + x, dy + y + Math.abs(x) * 0.2, shade(hex(0xdde3ee), 1 - x * 0.02));
  line(px, px.p(2.0, 2.0, h + 3), [dx, dy], hex(0x9aa3b5));
  // antenna
  const at = px.p(1.0, 1.9, h + 30);
  line(px, px.p(1.0, 1.9, h + 3), at, hex(0xb8c0d0));
  px.outline(OUT);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [at[0], at[1] - 2] };
}

function lab(seed: number): SpriteArt {
  const h = 18;
  const px = canvasFor(2, 2, h + 34);
  shadowPad(px, 2, 2);
  const wall = hex(0xdfe4ee);
  const [x0, y0, x1, y1] = [0.3, 0.3, 1.7, 1.7];
  px.box(x0, y0, x1, y1, 0, h, faces(wall));
  px.wpoly([[x0, y1, 12], [x1, y1, 12], [x1, y1, 14], [x0, y1, 14]], hex(0x8a5cf0));
  px.wpoly([[x1, y0, 12], [x1, y1, 12], [x1, y1, 14], [x1, y0, 14]], shade(hex(0x8a5cf0), 0.75));
  windowsLeft(px, y1, x0 + 0.1, x1 - 0.1, [[4, 10]], seed, hex(0xb7a4ff), 3);
  windowsRight(px, x1, y0 + 0.1, y1 - 0.1, [[4, 10]], seed, hex(0xb7a4ff), 3);
  px.box(x0, y0, x1, y1, h, h + 2, faces(hex(0xb8bfcc)));
  // glass dome
  const [cx, cy] = px.p(1.0, 1.0, h + 2);
  const rx = 15, ry = 7.5, dh = 13;
  for (let y = -Math.ceil(ry + dh); y <= Math.ceil(ry); y++) for (let x = -rx; x <= rx; x++) {
    const inBase = (x / rx) ** 2 + (y / ry) ** 2 <= 1;
    const inDome = y <= 0 && (x / rx) ** 2 + (y / (ry + dh)) ** 2 <= 1;
    if (!inBase && !inDome) continue;
    const t = (x / rx + 1) / 2;
    const ribs = Math.abs(x) % 6 === 0;
    let c = mix(hex(0x9fe6ff), hex(0x3a7fb8), t);
    if (ribs) c = shade(c, 0.8);
    if (x < -4 && x > -9 && y < -6 && y > -13) c = hex(0xf2fbff);
    px.set(cx + x, cy + y, c);
  }
  const at = px.p(1.0, 1.0, h + 2 + 22);
  line(px, [cx, cy - ry - dh], at, hex(0xc9b8ff));
  px.outline(OUT);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [at[0], at[1] - 2] };
}

function workshop(seed: number): SpriteArt {
  const h = 18;
  const px = canvasFor(2, 2, h + 40);
  shadowPad(px, 2, 2);
  const wall = hex(0xa65640);
  const [x0, y0, x1, y1] = [0.25, 0.3, 1.75, 1.7];
  px.box(x0, y0, x1, y1, 0, h, faces(wall), { left: leftWall(px, y1, brick(wall, 0.96)), right: rightWall(px, x1, brick(wall, 0.72)) });
  // big workshop door
  px.winL(y1, 0.45, 0.95, 0, 12, hex(0x6b6f7a), hex(0x3a3d45));
  for (let z = 2; z < 12; z += 2) px.winL(y1, 0.45, 0.95, z, z + 0.6, hex(0x585c66));
  windowsLeft(px, y1, 1.05, x1 - 0.1, [[5, 12]], seed, LIT, 2);
  windowsRight(px, x1, y0 + 0.1, y1 - 0.1, [[5, 12]], seed, LIT, 3);
  // sawtooth roof
  const teeth = 3, seg = (y1 - y0) / teeth, roof = hex(0x5d6576), glassC = hex(0x8fd0e8);
  for (let k = 0; k < teeth; k++) {
    const ya = y0 + seg * k, yb = ya + seg;
    px.wpoly([[x1, ya, h], [x1, yb, h], [x1, yb, h + 9]], shade(wall, 0.65));
    px.wpoly([[x0, ya, h], [x1, ya, h], [x1, yb, h + 9], [x0, yb, h + 9]], (sx, sy) => shade(roof, 1.05 + ((sx + sy) % 4 === 0 ? -0.08 : 0)));
    px.wpoly([[x0, yb, h], [x1, yb, h], [x1, yb, h + 9], [x0, yb, h + 9]], (sx) => shade(glassC, sx % 3 === 0 ? 0.8 : 1));
  }
  // chimney with red/white band
  cylinder(px, 0.55, 0.55, 0.13, h, 26, hex(0x9a5a44), 0);
  cylinder(px, 0.55, 0.55, 0.14, h + 22, 4, hex(0xe8e2d8), 0);
  const sm = px.p(0.55, 0.55, h + 30);
  // gear sign
  const g = px.p(1.4, y1, 15);
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) { const d = Math.hypot(x, y); if (d <= 3 && d >= 1.2) px.set(g[0] + x, g[1] + y, hex(0xf0c040)); }
  px.outline(OUT);
  const top = px.p(1.25, 1.0, h + 12);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [top[0], top[1] - 2], smoke: [sm[0], sm[1] - 2] };
}

function silo(seed: number): SpriteArt {
  const px = canvasFor(2, 2, 52);
  shadowPad(px, 2, 2);
  const steel = hash2(seed, 9) > 0.5 ? hex(0xa9b6c6) : hex(0x9ec2c0);
  px.box(0.25, 1.15, 0.95, 1.75, 0, 12, faces(hex(0x6c7a8f)));
  px.winL(1.75, 0.4, 0.6, 0, 8, hex(0x3d4a5e), hex(0x2b3444));
  cylinder(px, 1.05, 0.85, 0.52, 0, 38, steel, 7);
  // ladder
  for (let z = 2; z < 38; z += 3) { const a = px.p(1.25, 1.45, z); px.set(a[0], a[1], hex(0x5a6678)); px.set(a[0] + 2, a[1], hex(0x5a6678)); }
  cylinder(px, 1.48, 1.45, 0.24, 0, 20, shade(steel, 0.95), 5);
  // top cap
  const c = px.p(1.05, 0.85, 38);
  for (let y = -3; y <= 0; y++) for (let x = -4; x <= 4; x++) if ((x / 4) ** 2 + (y / 3) ** 2 <= 1) px.set(c[0] + x, c[1] + y - 1, shade(steel, 1.2));
  px.outline(OUT);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [c[0], c[1] - 6] };
}

function cache(seed: number): SpriteArt {
  const h = 16;
  const px = canvasFor(2, 2, h + 22);
  shadowPad(px, 2, 2);
  const wall = hex(0xc8443a);
  const [x0, y0, x1, y1] = [0.42, 0.42, 1.58, 1.58];
  px.box(x0, y0, x1, y1, 0, h, faces(wall), { left: leftWall(px, y1, siding(wall, 0.96)), right: rightWall(px, x1, siding(wall, 0.72)) });
  px.box(x0 - 0.05, y0 - 0.05, x1 + 0.05, y1 + 0.05, h, h + 3, faces(hex(0xf1ece4)));
  door(px, y1, 0.6, 0.85, 11, hex(0x3b2a2a));
  // lightning bolt
  const b = px.p(1.25, y1, 8);
  const bolt = [[1, -5], [0, -4], [-1, -3], [0, -3], [1, -2], [0, -1], [-1, 0], [0, 0], [1, 1], [0, 2]];
  for (const [x, y] of bolt) px.set(b[0] + x, b[1] + y, hex(0xffe14d));
  windowsRight(px, x1, y0 + 0.1, y1 - 0.1, [[5, 11]], seed, LIT, 2);
  // crates
  px.box(1.62, 0.35, 1.85, 0.6, 0, 6, faces(hex(0x9b7448)));
  px.outline(OUT);
  const top = px.p(1.0, 1.0, h + 9);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [top[0], top[1]] };
}

function tower(seed: number): SpriteArt {
  const px = canvasFor(2, 2, 70);
  shadowPad(px, 2, 2);
  const hut = hash2(seed, 4) > 0.5 ? hex(0x4b5f80) : hex(0x5d6f5e);
  px.box(0.25, 0.9, 0.95, 1.7, 0, 12, faces(hut));
  px.winL(1.7, 0.4, 0.62, 0, 8, hex(0x2d3446), hex(0x1d2230));
  px.winL(1.7, 0.7, 0.88, 4, 9, hex(0x7fe0a0), hex(0x1d2230));
  px.box(0.25, 0.9, 0.95, 1.7, 12, 14, faces(hex(0x8a94a8)));
  // lattice tower
  const legs: [number, number][] = [[1.05, 0.35], [1.6, 0.35], [1.6, 0.9], [1.05, 0.9]];
  const apex: [number, number] = [1.33, 0.63];
  const H = 58;
  const steel = hex(0xd65a3c), steel2 = hex(0xeeeae4);
  const at = (l: [number, number], t: number) => px.p(l[0] + (apex[0] - l[0]) * t * 0.8, l[1] + (apex[1] - l[1]) * t * 0.8, H * t);
  for (const [i, l] of legs.entries()) {
    if (i === 0) continue; // hidden back leg drawn faint
    line(px, at(l, 0), at(l, 1), steel);
  }
  line(px, at(legs[0], 0), at(legs[0], 1), shade(steel, 0.6));
  for (let k = 0; k < 6; k++) {
    const t0 = k / 6, t1 = (k + 1) / 6;
    line(px, at(legs[1], t0), at(legs[2], t1), k % 2 ? steel2 : steel);
    line(px, at(legs[2], t0), at(legs[3], t1), k % 2 ? steel : steel2);
    line(px, at(legs[1], t1), at(legs[2], t1), steel2);
    line(px, at(legs[2], t1), at(legs[3], t1), steel2);
  }
  const tip = px.p(apex[0], apex[1], H + 10);
  line(px, px.p(apex[0], apex[1], H * 0.8), tip, hex(0xd0d4dc));
  // dish
  const d = px.p(1.5, 0.9, 34);
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= 9) px.set(d[0] + x + 3, d[1] + y, shade(hex(0xe6e9f0), 1 - x * 0.03));
  px.outline(OUT, 150);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [tip[0], tip[1] - 1] };
}

function depot(seed: number): SpriteArt {
  const h = 18;
  const px = canvasFor(2, 2, h + 18);
  shadowPad(px, 2, 2);
  const wall = hash2(seed, 6) > 0.5 ? hex(0xc9a46a) : hex(0x7f9a76);
  const [x0, y0, x1, y1] = [0.2, 0.32, 1.8, 1.62];
  px.box(x0, y0, x1, y1, 0, h, faces(wall), { left: leftWall(px, y1, corrugated(wall, 0.96)), right: rightWall(px, x1, corrugated(wall, 0.72)) });
  // roller doors
  for (const [a, b] of [[0.35, 0.8], [0.95, 1.4]]) {
    px.winL(y1, a, b, 0, 12, hex(0x9aa2ad), hex(0x4a505a));
    for (let z = 1; z < 12; z += 2) px.winL(y1, a, b, z, z + 0.5, hex(0x7d8590));
  }
  windowsRight(px, x1, y0 + 0.15, y1 - 0.15, [[10, 14]], seed, LIT, 3);
  // barrel roof
  const ym = (y0 + y1) / 2;
  px.wpoly([[x1, y0, h], [x1, y1, h], [x1, y1 - 0.15, h + 6], [x1, ym, h + 8], [x1, y0 + 0.15, h + 6]], shade(wall, 0.66));
  for (let k = 0; k < 4; k++) {
    const ya = y0 + ((y1 - y0) * k) / 4, yb = y0 + ((y1 - y0) * (k + 1)) / 4;
    const za = h + [0, 6, 8, 6][k], zb = h + [6, 8, 6, 0][k];
    px.wpoly([[x0 - 0.05, ya, za], [x1 + 0.05, ya, za], [x1 + 0.05, yb, zb], [x0 - 0.05, yb, zb]], (sx) => shade(hex(0x9aa6b4), [0.85, 0.95, 1.08, 1.15][k] + (sx % 3 === 0 ? -0.06 : 0)));
  }
  // crates & pallet
  px.box(1.83, 1.3, 1.98, 1.5, 0, 5, faces(hex(0x9b7448)));
  px.box(1.83, 1.55, 1.98, 1.75, 0, 5, faces(hex(0xa98050)));
  px.box(1.83, 1.4, 1.98, 1.62, 5, 10, faces(hex(0x8d6a40)));
  px.outline(OUT);
  const top = px.p(1.0, ym, h + 10);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [top[0], top[1] - 2] };
}

function clocktower(seed: number): SpriteArt {
  const px = canvasFor(2, 2, 76);
  shadowPad(px, 2, 2);
  const st = hex(0xbdb4a2);
  px.box(0.35, 0.35, 1.65, 1.65, 0, 14, faces(st), { left: leftWall(px, 1.65, stone(st, 0.96)), right: rightWall(px, 1.65, stone(st, 0.72)) });
  door(px, 1.65, 0.85, 1.15, 10, hex(0x4a3324));
  windowsRight(px, 1.65, 0.5, 1.5, [[5, 10]], seed, LIT, 2);
  const [x0, y0, x1, y1] = [0.65, 0.65, 1.35, 1.35];
  px.box(x0, y0, x1, y1, 14, 52, faces(st), { left: leftWall(px, y1, stone(st, 0.96)), right: rightWall(px, x1, stone(st, 0.72)) });
  windowsRight(px, x1, y0 + 0.15, y1 - 0.15, [[22, 30]], seed + 2, LIT, 1);
  // clock face
  const c = px.p(1.0, y1, 42);
  for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) {
    const d = Math.hypot(x, y * 1.1);
    if (d <= 5) px.set(c[0] + x, c[1] + y, d > 4.2 ? hex(0x6b5a3a) : hex(0xf6f1e3));
  }
  line(px, c, [c[0], c[1] - 3], hex(0x222222));
  line(px, c, [c[0] + 2, c[1] + 1], hex(0x222222));
  // pyramid roof
  const roof = hex(0x3c5a8f), apex: [number, number, number] = [1.0, 1.0, 68];
  const o = 0.08;
  px.wpoly([[x0 - o, y0 - o, 52], [x1 + o, y0 - o, 52], apex], shade(roof, 0.8));
  px.wpoly([[x0 - o, y0 - o, 52], [x0 - o, y1 + o, 52], apex], shade(roof, 0.9));
  px.wpoly([[x0 - o, y1 + o, 52], [x1 + o, y1 + o, 52], apex], (sx, sy) => shade(roof, 1.05 + ((sx + sy) % 3 === 0 ? -0.07 : 0)));
  px.wpoly([[x1 + o, y0 - o, 52], [x1 + o, y1 + o, 52], apex], shade(roof, 0.72));
  px.outline(OUT);
  const tip = px.p(...apex);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [tip[0], tip[1] - 3] };
}

function post(seed: number): SpriteArt {
  const art = house(seed, hex(0x2f5fa8), hex(0xf0d67a));
  return art;
}

function shop(seed: number): SpriteArt {
  const h = 18;
  const px = canvasFor(2, 2, h + 22);
  shadowPad(px, 2, 2);
  const wall = WALLS[Math.floor(hash2(seed, 2) * WALLS.length)];
  const [x0, y0, x1, y1] = [0.35, 0.35, 1.65, 1.6];
  px.box(x0, y0, x1, y1, 0, h, faces(wall), { left: leftWall(px, y1, brick(shade(wall, 0.92), 0.98)), right: rightWall(px, x1, brick(shade(wall, 0.92), 0.72)) });
  px.winL(y1, 0.5, 1.15, 2, 10, LIT, FRAME);
  door(px, y1, 1.25, 1.5, 11);
  windowsRight(px, x1, y0 + 0.1, y1 - 0.1, [[6, 12]], seed, LIT, 2);
  // striped awning
  const aw = ROOFS[Math.floor(hash2(seed, 8) * ROOFS.length)];
  px.wpoly([[x0, y1, 14], [x1, y1, 14], [x1, y1 + 0.28, 9], [x0, y1 + 0.28, 9]], (sx) => (Math.floor((sx - px.ox) / 3) % 2 ? shade(aw, 1.1) : hex(0xf4efe6)));
  px.box(x0, y0, x1, y1, h, h + 3, faces(shade(wall, 0.8)));
  // roof sign
  px.box(0.7, 1.0, 1.4, 1.08, h + 3, h + 10, faces(hex(0x2c3448)));
  px.outline(OUT);
  const top = px.p(1.05, 1.04, h + 14);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [top[0], top[1]] };
}

export function buildingArt(type: BuildingType, seed: number, opts: { tier?: number | null } = {}): SpriteArt {
  switch (type) {
    case 'server': return server(seed, opts.tier ?? null);
    case 'lab': return lab(seed);
    case 'workshop': return workshop(seed);
    case 'silo': return silo(seed);
    case 'cache': return cache(seed);
    case 'tower': return tower(seed);
    case 'depot': return depot(seed);
    case 'clocktower': return clocktower(seed);
    case 'post': return post(seed);
    case 'shop': return shop(seed);
    case 'house':
    case 'townhall':
    default: return house(seed);
  }
}

/** Collapsed building after a confirmed removal. */
export function ruinsArt(seed: number): SpriteArt {
  const px = canvasFor(2, 2, 18);
  px.wpoly([[0.2, 0.2, 0], [1.8, 0.2, 0], [1.8, 1.8, 0], [0.2, 1.8, 0]], (sx, sy) => shade(hex(0x6e6a62), 0.8 + hash2(sx, sy, seed) * 0.25));
  px.box(0.3, 1.4, 0.9, 1.6, 0, 9, faces(hex(0x8d8579)));
  px.box(1.4, 0.3, 1.6, 0.8, 0, 6, faces(hex(0x8d8579)));
  for (let i = 0; i < 26; i++) {
    const x = 0.3 + hash2(i, 1, seed) * 1.4, y = 0.3 + hash2(i, 2, seed) * 1.4;
    const s = 0.06 + hash2(i, 3, seed) * 0.1;
    px.box(x, y, x + s, y + s, 0, 1 + hash2(i, 4, seed) * 4, faces(shade(hex(0x9a9286), 0.7 + hash2(i, 5, seed) * 0.4)));
  }
  // charred beam
  px.box(0.8, 0.9, 1.5, 1.0, 0, 2, faces(hex(0x3a2e26)));
  px.outline(OUT, 140);
  const top = px.p(1, 1, 14);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [top[0], top[1]] };
}

/** Scaffolding overlay for buildings under construction. */
export function scaffoldArt(w: number): SpriteArt {
  const H = w === 3 ? 50 : 36;
  const px = canvasFor(w, w, H + 6);
  const wood = hex(0xb07a3e), plank = hex(0xd9a95a);
  const poles: [number, number][] = [[0.2, w - 0.2], [w - 0.2, w - 0.2], [w - 0.2, 0.2], [w / 2, w - 0.2], [w - 0.2, w / 2]];
  for (const [x, y] of poles) line(px, px.p(x, y, 0), px.p(x, y, H), wood);
  for (let z = 10; z <= H; z += 12) {
    line(px, px.p(0.2, w - 0.2, z), px.p(w - 0.2, w - 0.2, z), plank);
    line(px, px.p(w - 0.2, w - 0.2, z), px.p(w - 0.2, 0.2, z), plank);
    line(px, px.p(0.2, w - 0.2, z - 10), px.p(w / 2, w - 0.2, z), wood);
    line(px, px.p(w - 0.2, w - 0.2, z - 10), px.p(w - 0.2, w / 2, z), wood);
  }
  // crane hook
  const t = px.p(w - 0.2, w - 0.2, H);
  line(px, t, [t[0] - 14, t[1] - 4], hex(0xf0c040));
  line(px, [t[0] - 14, t[1] - 4], [t[0] - 14, t[1] + 6], hex(0x888888));
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [t[0], t[1]] };
}

// ---------------------------------------------------------------------------------------------
// Props & characters
// ---------------------------------------------------------------------------------------------

export function treeArt(kind: 'pine' | 'round' | 'bush' | 'birch', seed: number): SpriteArt {
  const px = new Px(28, 44, 14, 38);
  // shadow
  for (let y = -3; y <= 3; y++) for (let x = -9; x <= 9; x++) if ((x / 9) ** 2 + (y / 3.5) ** 2 <= 1) px.set(px.ox + x + 3, px.oy + y, [18, 40, 22], 80);
  const g = [hex(0x2f7d3a), hex(0x3c9a45), hex(0x276a33), hex(0x4aa84f)][Math.floor(hash2(seed, 1) * 4)];
  if (kind === 'pine') {
    px.rect(px.ox - 1, px.oy - 8, 2, 8, hex(0x5a3b24));
    const tiers = 3 + (hash2(seed, 2) > 0.5 ? 1 : 0);
    for (let t = 0; t < tiers; t++) {
      const base = px.oy - 5 - t * 7, hw = 9 - t * 2;
      for (let y = 0; y < 11; y++) {
        const w = Math.round(hw * (y / 10));
        for (let x = -w; x <= w; x++) px.set(px.ox + x, base - 10 + y, shade(shade(g, 0.8), x < 0 ? 1.12 : 0.85 + hash2(x, y + t * 20, seed) * 0.12));
      }
    }
  } else if (kind === 'birch') {
    px.rect(px.ox - 1, px.oy - 14, 2, 14, hex(0xeae6dc));
    for (let y = 0; y < 14; y += 3) px.set(px.ox - 1, px.oy - 14 + y, hex(0x333333));
    blob(px, px.ox, px.oy - 20, 7, 9, hex(0x8cc85a), seed);
  } else if (kind === 'bush') {
    blob(px, px.ox, px.oy - 4, 7, 4.5, shade(g, 1.05), seed);
    if (hash2(seed, 5) > 0.6) for (let i = 0; i < 4; i++) px.set(px.ox - 4 + Math.floor(hash2(i, 9, seed) * 9), px.oy - 6 + Math.floor(hash2(i, 8, seed) * 4), hex(0xf27fa0));
  } else {
    px.rect(px.ox - 1, px.oy - 10, 3, 10, hex(0x5a3b24));
    blob(px, px.ox, px.oy - 19, 10, 10, g, seed);
  }
  px.outline([14, 30, 18], 170);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [px.ox, 0] };
}

function blob(px: Px, cx: number, cy: number, rx: number, ry: number, c: RGB, seed: number) {
  for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++) for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) {
    const n = hash2(Math.floor((x + 20) / 3), Math.floor((y + 20) / 3), seed) * 0.25;
    if ((x / rx) ** 2 + (y / ry) ** 2 > 1 - n * 0.6) continue;
    const light = (-x - y) / (rx + ry);
    const clump = hash2(Math.floor((x + 20) / 2), Math.floor((y + 20) / 2), seed + 3) > 0.7 ? 0.08 : 0;
    px.set(cx + x, cy + y, shade(c, 0.86 + light * 0.32 + clump));
  }
}

export function rockArt(seed: number): SpriteArt {
  const px = new Px(16, 12, 8, 9);
  blob(px, 8, 7, 5 + hash2(seed, 1) * 2, 3.5, hex(0x9a9a92), seed);
  px.outline([40, 40, 40], 140);
  return { canvas: px.done(), ox: 8, oy: 9, top: [8, 2] };
}

export function lampArt(): SpriteArt {
  const px = new Px(10, 26, 5, 24);
  px.rect(4, 6, 2, 18, hex(0x3a3f4c));
  px.rect(2, 3, 6, 3, hex(0x2a2e38));
  px.rect(3, 6, 4, 2, hex(0xffe9a8));
  px.rect(3, 23, 4, 2, hex(0x2a2e38));
  return { canvas: px.done(), ox: 5, oy: 24, top: [5, 7] };
}

export function signpostArt(): SpriteArt {
  const px = new Px(22, 26, 11, 24);
  px.rect(10, 8, 2, 16, hex(0x6a4528));
  px.rect(2, 3, 18, 8, hex(0xb07a3e));
  px.rect(3, 4, 16, 6, hex(0xc98f4c));
  for (let x = 4; x < 18; x += 3) px.rect(x, 6, 2, 1, hex(0x6a4528));
  px.outline([30, 22, 14], 160);
  return { canvas: px.done(), ox: 11, oy: 24, top: [11, 3] };
}

export function lighthouseArt(): SpriteArt {
  const px = new Px(30, 66, 15, 60);
  for (let y = 0; y < 44; y++) {
    const w = 6 - Math.floor(y / 12);
    for (let x = -w; x <= w; x++) {
      const red = Math.floor(y / 8) % 2 === 1;
      px.set(15 + x, 58 - y, shade(red ? hex(0xd0443a) : hex(0xf4f0e8), x < 0 ? 1.05 : 0.8));
    }
  }
  px.rect(10, 8, 11, 7, hex(0x2c3448));
  px.rect(11, 9, 9, 5, hex(0xfff2a8));
  for (let x = 8; x <= 22; x++) px.set(x, 7, hex(0xd0443a));
  for (let y = 2; y < 7; y++) for (let x = -(6 - y); x <= 6 - y; x++) px.set(15 + x, y + 1, hex(0xb53a31));
  px.rect(8, 15, 15, 2, hex(0x3a3f4c));
  px.outline(OUT, 170);
  return { canvas: px.done(), ox: 15, oy: 60, top: [15, 11] };
}

export function boatArt(): SpriteArt {
  const px = new Px(24, 26, 12, 22);
  px.poly([[2, 18], [22, 18], [18, 23], [6, 23]], hex(0x8a5a3a));
  px.poly([[3, 18], [21, 18], [20, 19], [4, 19]], hex(0xd8c8a8));
  px.rect(12, 2, 1, 16, hex(0x5a3b24));
  px.poly([[13, 3], [13, 16], [21, 16]], hex(0xf4f0e8));
  px.poly([[11, 5], [11, 16], [4, 16]], hex(0xe2dccf));
  px.outline(OUT, 150);
  return { canvas: px.done(), ox: 12, oy: 22, top: [12, 2] };
}

/** Walking villager, 2 frames. */
export function personArt(shirt: RGB, frame: 0 | 1, carry: RGB | null): SpriteArt {
  const px = new Px(12, 16, 6, 15);
  px.rect(3, 14, 6, 2, [10, 20, 10], 70);
  px.rect(4, 2, 4, 4, hex(0xf0c8a0));
  px.rect(4, 1, 4, 2, hex(0x4a3020));
  px.rect(3, 6, 6, 5, shirt);
  px.rect(3, 6, 2, 5, shade(shirt, 1.15));
  if (frame === 0) { px.rect(4, 11, 2, 4, hex(0x2f3c5e)); px.rect(7, 11, 2, 3, hex(0x2f3c5e)); }
  else { px.rect(4, 11, 2, 3, hex(0x2f3c5e)); px.rect(7, 11, 2, 4, hex(0x2f3c5e)); }
  if (carry) { px.rect(8, 6, 4, 4, carry); px.rect(8, 6, 4, 1, shade(carry, 1.3)); }
  px.outline(OUT, 190);
  return { canvas: px.done(), ox: 6, oy: 15, top: [6, 0] };
}

/** Small delivery van along the x axis; mirror for y. */
export function vanArt(body: RGB): SpriteArt {
  const px = new Px(30, 26, 15, 18);
  px.ox = 15; px.oy = 12;
  px.box(-0.35, -0.18, 0.35, 0.18, 2, 10, faces(body));
  px.box(0.35, -0.18, 0.55, 0.18, 2, 7, faces(shade(body, 1.1)));
  px.winR(0.55, -0.12, 0.12, 4, 6.5, hex(0x9fd8ff));
  for (const [x, y] of [[-0.25, 0.18], [0.35, 0.18]] as [number, number][]) {
    const [sx, sy] = px.p(x, y, 1);
    px.rect(sx - 1, sy - 1, 3, 3, hex(0x1a1a1a));
  }
  px.outline(OUT, 190);
  const t = px.p(0, 0, 10);
  return { canvas: px.done(), ox: px.ox, oy: px.oy, top: [t[0], t[1]] };
}

export function cloudArt(seed: number, shadow: boolean): HTMLCanvasElement {
  const W = 120, H = 54;
  const px = new Px(W, H);
  const puffs = 5 + Math.floor(hash2(seed, 1) * 4);
  for (let i = 0; i < puffs; i++) {
    const cx = 20 + hash2(i, 2, seed) * 80, cy = 22 + hash2(i, 3, seed) * 14, r = 10 + hash2(i, 4, seed) * 12;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue;
      if (shadow) px.set(cx + x, cy + y * 0.5 + 10, [10, 30, 40], 255);
      else px.set(cx + x, cy + y * 0.7, y > r * 0.3 ? hex(0xd8e2ee) : hex(0xffffff));
    }
  }
  return px.done();
}

export function glowCanvas(color: string, size = 64): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** Floating marker sign: '!' warning, '?' unknown/missing, '✓' recovery. */
export function markerArt(kind: 'warn' | 'missing' | 'ok' | 'offline' | 'pressure'): HTMLCanvasElement {
  const px = new Px(13, 17);
  const bg = kind === 'warn' ? hex(0xef4b4b) : kind === 'ok' ? hex(0x3fd17a) : kind === 'offline' ? hex(0xa58bff) : kind === 'pressure' ? hex(0xf08a3c) : hex(0x8a94a6);
  for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) {
    if (Math.abs(x - 6) + Math.abs(y - 6) <= 6) px.set(x, y, Math.abs(x - 6) + Math.abs(y - 6) === 6 ? shade(bg, 0.6) : bg);
  }
  const W: RGB = [255, 255, 255];
  if (kind === 'warn') { px.rect(6, 3, 1, 5, W); px.rect(6, 9, 1, 1, W); }
  else if (kind === 'missing') { px.rect(5, 3, 3, 1, W); px.rect(8, 4, 1, 2, W); px.rect(6, 6, 2, 1, W); px.rect(6, 7, 1, 1, W); px.rect(6, 9, 1, 1, W); }
  else if (kind === 'ok') { px.set(4, 6, W); px.set(5, 7, W); px.set(6, 8, W); px.set(7, 7, W); px.set(8, 6, W); px.set(9, 5, W); }
  else if (kind === 'pressure') { px.rect(4, 8, 1, 2, W); px.rect(6, 6, 1, 4, W); px.rect(8, 3, 1, 7, W); } // rising bars: resource pressure
  else { px.rect(4, 5, 5, 1, W); px.rect(4, 7, 5, 1, W); }
  px.rect(6, 13, 1, 4, hex(0x3a3f4c));
  return px.done();
}
