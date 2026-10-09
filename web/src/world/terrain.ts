import type { Biome, BlockView } from '@berrie/shared';
import { Px, hex, shade, mix, hash2, noise, type RGB, TW, TH } from './pixel';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Terrain {
  canvas: HTMLCanvasElement;
  /** World-pixel position of the canvas' top-left corner. */
  offsetX: number;
  offsetY: number;
  land: Set<string>;
  roads: Set<string>;
  trees: { x: number; y: number; kind: 'pine' | 'round' | 'bush' | 'birch' | 'rock'; seed: number }[];
  lamps: { x: number; y: number }[];
  signs: { x: number; y: number; group: string }[];
  lighthouse: { x: number; y: number } | null;
  boats: { x: number; y: number }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  biome: Biome;
}

interface Palette { grass: number; forest: number; lawn: number; sand: number; cliffTop: number; treeDensity: number }
/** Ground palettes per island biome (a purely visual, per-server choice in Server Harbor). */
export const PALETTES: Record<Biome, Palette> = {
  meadow: { grass: 0x5aa548, forest: 0x3f8a3c, lawn: 0x68b452, sand: 0xe4d096, cliffTop: 0x3e7d34, treeDensity: 1 },
  autumn: { grass: 0x8f9b44, forest: 0x8a6a34, lawn: 0x9db051, sand: 0xe4d096, cliffTop: 0x6c7832, treeDensity: 1 },
  snow: { grass: 0xdbe6ee, forest: 0xb4c6d4, lawn: 0xecf3f7, sand: 0xd2dbe2, cliffTop: 0xc4d2dc, treeDensity: 0.7 },
  desert: { grass: 0xd6b56a, forest: 0xc29a56, lawn: 0xe0c47e, sand: 0xecd9a0, cliffTop: 0xb58e4c, treeDensity: 0.2 },
  tropical: { grass: 0x4dbd4b, forest: 0x2f9848, lawn: 0x63cf5b, sand: 0xf3e3aa, cliffTop: 0x399a3a, treeDensity: 1.15 },
};
export const TREE_TINT: Record<Biome, number> = { meadow: 0xffffff, autumn: 0xffb46a, snow: 0xe6f0fa, desert: 0xd8cc98, tropical: 0xd8ffd0 };

const key = (x: number, y: number) => `${x},${y}`;
const CLIFF = 12;
export const DEEP: RGB = hex(0x1d5a86);

function distToRect(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export function buildTerrain(blocks: BlockView[], buildings: Rect[], biome: Biome = 'meadow'): Terrain {
  const pal = PALETTES[biome] ?? PALETTES.meadow;
  const cores: Rect[] = blocks.map((b) => ({ x: b.x, y: b.y, w: b.size + 1, h: b.size + 1 }));
  for (const r of buildings) cores.push(r);
  if (!cores.length) cores.push({ x: 0, y: 0, w: 8, h: 8 });

  const bounds = {
    minX: Math.min(...cores.map((c) => c.x)) - 12, minY: Math.min(...cores.map((c) => c.y)) - 12,
    maxX: Math.max(...cores.map((c) => c.x + c.w)) + 12, maxY: Math.max(...cores.map((c) => c.y + c.h)) + 12,
  };

  // --- classify tiles ---
  const roads = new Set<string>();
  const lots = new Set<string>();
  for (const b of blocks) {
    for (let i = 0; i <= b.size; i++) {
      roads.add(key(b.x + i, b.y)); roads.add(key(b.x + i, b.y + b.size));
      roads.add(key(b.x, b.y + i)); roads.add(key(b.x + b.size, b.y + i));
    }
    for (let i = 1; i < b.size; i++) for (let j = 1; j < b.size; j++) lots.add(key(b.x + i, b.y + j));
  }
  const land = new Set<string>();
  for (let x = bounds.minX; x <= bounds.maxX; x++) for (let y = bounds.minY; y <= bounds.maxY; y++) {
    const cx = x + 0.5, cy = y + 0.5;
    let d = Infinity;
    for (const c of cores) d = Math.min(d, distToRect(cx, cy, c));
    const margin = 3.2 + noise(x * 0.16, y * 0.16, 11) * 4.5 + noise(x * 0.5, y * 0.5, 12) * 1.2;
    if (d <= margin) land.add(key(x, y));
  }
  // fill single-tile holes / remove specks for a tidy coastline
  for (let pass = 0; pass < 2; pass++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) for (let y = bounds.minY; y <= bounds.maxY; y++) {
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => land.has(key(x + dx, y + dy))).length;
      if (!land.has(key(x, y)) && n >= 3) land.add(key(x, y));
      else if (land.has(key(x, y)) && n <= 1 && !roads.has(key(x, y))) land.delete(key(x, y));
    }
  }
  const isLand = (x: number, y: number) => land.has(key(x, y));
  const coastal = (x: number, y: number) => !isLand(x + 1, y) || !isLand(x - 1, y) || !isLand(x, y + 1) || !isLand(x, y - 1);
  const beach = (x: number, y: number) => isLand(x, y) && !roads.has(key(x, y)) && !lots.has(key(x, y)) && coastal(x, y) && noise(x * 0.2, y * 0.2, 21) < 0.42;

  // water distance to land (for shallows)
  const wdist = new Map<string, number>();
  let frontier: [number, number][] = [];
  for (const k of land) { const [x, y] = k.split(',').map(Number); frontier.push([x, y]); }
  for (let d = 1; d <= 5; d++) {
    const next: [number, number][] = [];
    for (const [x, y] of frontier) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const k = key(x + dx, y + dy);
      if (land.has(k) || wdist.has(k)) continue;
      wdist.set(k, d);
      next.push([x + dx, y + dy]);
    }
    frontier = next;
  }

  // --- canvas ---
  const sxMin = (bounds.minX - (bounds.maxY + 1)) * (TW / 2);
  const sxMax = (bounds.maxX + 1 - bounds.minY) * (TW / 2);
  const syMin = (bounds.minX + bounds.minY) * (TH / 2);
  const syMax = (bounds.maxX + bounds.maxY + 2) * (TH / 2) + CLIFF + 4;
  const W = Math.min(8192, sxMax - sxMin), H = Math.min(8192, syMax - syMin);
  const px = new Px(W, H);
  const top = (x: number, y: number): [number, number] => [(x - y) * (TW / 2) - sxMin, (x + y) * (TH / 2) - syMin];

  const diamond = (x: number, y: number, color: (u: number, v: number, sx: number, sy: number) => RGB | null) => {
    const [sx, sy] = top(x, y);
    for (let r = 0; r < TH; r++) {
      const hw = r < TH / 2 ? (r + 1) * 2 : (TH - r) * 2;
      for (let i = -hw; i < hw; i++) {
        const dx = i + 0.5, dy = r + 0.5;
        const u = (dx / (TW / 2) + dy / (TH / 2)) / 2, v = (dy / (TH / 2) - dx / (TW / 2)) / 2;
        const c = color(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)), sx + i, sy + r);
        if (c) px.set(sx + i, sy + r, c);
      }
    }
  };

  // water (only near the coast; open sea is the tiling background)
  const SHALLOW = hex(0x3fa3c8), FOAM = hex(0xd8f1f7);
  for (const [k, d] of wdist) {
    const [x, y] = k.split(',').map(Number);
    // distance at the four tile corners, bilinearly interpolated for a smooth shallow-water gradient
    const wd = (tx: number, ty: number) => (isLand(tx, ty) ? 0 : wdist.get(key(tx, ty)) ?? 6);
    const corner = (cx: number, cy: number) => (wd(cx - 1, cy - 1) + wd(cx, cy - 1) + wd(cx - 1, cy) + wd(cx, cy)) / 4;
    const c00 = corner(x, y), c10 = corner(x + 1, y), c01 = corner(x, y + 1), c11 = corner(x + 1, y + 1);
    diamond(x, y, (u, v, sx, sy) => {
      const fx = x + u, fy = y + v;
      const interp = c00 * (1 - u) * (1 - v) + c10 * u * (1 - v) + c01 * (1 - u) * v + c11 * u * v;
      let dd = interp - 0.6 + noise(fx * 0.9, fy * 0.9, 5) * 0.7;
      // distance to nearest land edge within the tile for foam
      const nearLand = d === 1 && ((isLand(x - 1, y) && u < 0.18) || (isLand(x + 1, y) && u > 0.82) || (isLand(x, y - 1) && v < 0.18) || (isLand(x, y + 1) && v > 0.82));
      if (nearLand && hash2(sx, sy, 3) > 0.25) return FOAM;
      dd = Math.min(1, Math.max(0, dd / 4));
      let c = mix(SHALLOW, DEEP, dd);
      if (hash2(sx >> 1, sy, 8) > 0.985) c = shade(c, 1.25);
      return c;
    });
  }

  // land tiles, back to front, then cliffs
  const order = [...land].map((k) => k.split(',').map(Number) as [number, number]).sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const GRASS = hex(pal.grass), FOREST = hex(pal.forest), LAWN = hex(pal.lawn), SAND = hex(pal.sand), ASPHALT = hex(0x5a5f6a), CURB = hex(0xbcb6a8);
  const rd = (x: number, y: number) => roads.has(key(x, y));
  for (const [x, y] of order) {
    const k = key(x, y);
    if (roads.has(k)) {
      const nN = rd(x, y - 1), nE = rd(x + 1, y), nS = rd(x, y + 1), nW = rd(x - 1, y);
      diamond(x, y, (u, v, sx, sy) => {
        if ((!nN && v < 0.1) || (!nS && v > 0.9) || (!nW && u < 0.1) || (!nE && u > 0.9)) return shade(CURB, 0.95 + hash2(sx, sy) * 0.1);
        const alongX = nE && nW && !nN && !nS, alongY = nN && nS && !nE && !nW;
        if (alongX && Math.abs(v - 0.5) < 0.05 && Math.floor(u * 4) % 2 === 0) return hex(0xe9d27c);
        if (alongY && Math.abs(u - 0.5) < 0.05 && Math.floor(v * 4) % 2 === 0) return hex(0xe9d27c);
        return shade(ASPHALT, 0.94 + hash2(sx, sy, 1) * 0.1);
      });
    } else if (beach(x, y)) {
      diamond(x, y, (u, v, sx, sy) => {
        const wet = (!isLand(x + 1, y) && u > 0.8) || (!isLand(x, y + 1) && v > 0.8) || (!isLand(x - 1, y) && u < 0.15) || (!isLand(x, y - 1) && v < 0.15);
        const c = shade(SAND, 0.93 + hash2(sx, sy, 4) * 0.12);
        return wet ? shade(c, 0.85) : c;
      });
    } else {
      const lot = lots.has(k);
      diamond(x, y, (u, v, sx, sy) => {
        const fx = x + u, fy = y + v;
        const patch = noise(fx * 0.35, fy * 0.35, 2);
        let c = lot ? mix(LAWN, GRASS, patch * 0.5) : mix(GRASS, FOREST, Math.min(1, patch * 1.3));
        if (lot && Math.floor((fx + fy) * 2) % 2 === 0) c = shade(c, 1.04);
        const h = hash2(sx, sy, 9);
        if (h > 0.93) c = shade(c, 1.15);
        else if (h < 0.06) c = shade(c, 0.85);
        if (lot && h > 0.995) c = [hex(0xffffff), hex(0xffd84d), hex(0xf58fb0)][Math.floor(hash2(sx, sy, 1) * 3)];
        return c;
      });
    }
    // cliff faces on edges facing the viewer
    const isBeach = beach(x, y);
    const ch = isBeach ? 3 : CLIFF;
    const faceAt = (edge: 'E' | 'S') => {
      const [ax, ay] = edge === 'E' ? top(x + 1, y) : top(x + 1, y + 1);
      const [bx, by] = edge === 'E' ? top(x + 1, y + 1) : top(x, y + 1);
      const f = edge === 'E' ? 0.7 : 0.9;
      const steps = Math.abs(bx - ax);
      for (let i = 0; i <= steps; i++) {
        const sx = ax + Math.sign(bx - ax) * i;
        const sy = ay + ((by - ay) * i) / steps;
        for (let z = 0; z < ch; z++) {
          let c: RGB;
          if (isBeach) c = shade(SAND, 0.75);
          else if (z < 2) c = shade(hex(pal.cliffTop), f);
          else {
            const layer = Math.floor((z + noise(sx * 0.2, z * 0.3, 4) * 3) / 3) % 3;
            c = shade([hex(0x8a6a4a), hex(0x766050), hex(0x9a8268)][layer], f * (0.9 + hash2(sx, z, 6) * 0.15));
          }
          px.set(sx, Math.round(sy) + z, c);
        }
      }
    };
    if (!isLand(x + 1, y)) faceAt('E');
    if (!isLand(x, y + 1)) faceAt('S');
  }

  // --- props ---
  const trees: Terrain['trees'] = [];
  const lamps: Terrain['lamps'] = [];
  const blocked = new Set<string>();
  for (const r of buildings) for (let i = -1; i <= r.w; i++) for (let j = -1; j <= r.h; j++) blocked.add(key(r.x + i, r.y + j));
  for (const [x, y] of order) {
    const k = key(x, y);
    if (roads.has(k) || blocked.has(k) || beach(x, y)) continue;
    const h = hash2(x, y, 31);
    if (lots.has(k)) {
      if (h > 0.86) trees.push({ x: x + 0.5, y: y + 0.5, kind: h > 0.95 ? 'round' : 'bush', seed: Math.floor(h * 1000) });
      continue;
    }
    const nearRoad = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => roads.has(key(x + dx, y + dy)));
    const dens = noise(x * 0.22, y * 0.22, 41);
    if (h < dens * (nearRoad ? 0.4 : 0.95) * pal.treeDensity) {
      const n = 1 + (dens > 0.55 && !nearRoad ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const r = hash2(x, y, 50 + i);
        const kind = r < 0.5 ? 'pine' : r < 0.78 ? 'round' : r < 0.9 ? 'birch' : r < 0.96 ? 'bush' : 'rock';
        trees.push({ x: x + 0.2 + hash2(x, y, 60 + i) * 0.6, y: y + 0.2 + hash2(x, y, 70 + i) * 0.6, kind, seed: Math.floor(r * 10000) });
      }
    }
  }
  for (const b of blocks) {
    for (const [cx, cy] of [[b.x, b.y], [b.x + b.size, b.y], [b.x, b.y + b.size], [b.x + b.size, b.y + b.size]]) {
      lamps.push({ x: cx + 1.15, y: cy + 1.15 });
    }
  }
  const dedupLamps = [...new Map(lamps.map((l) => [key(l.x * 10, l.y * 10), l])).values()].filter((l) => !blocked.has(key(Math.floor(l.x), Math.floor(l.y))));
  const signs = blocks.filter((b) => !b.group.startsWith('host:') && !b.group.startsWith('plaza:')).map((b) => ({ x: b.x + 1.1, y: b.y + b.size - 0.2, group: b.group }));

  // lighthouse on the front-most beach; boats in shallow water
  let lighthouse: Terrain['lighthouse'] = null;
  let best = -Infinity;
  for (const [x, y] of order) if (beach(x, y) && x + y > best) { best = x + y; lighthouse = { x: x + 0.5, y: y + 0.5 }; }
  const boats: Terrain['boats'] = [];
  for (const [k, d] of wdist) {
    if (d !== 3 || boats.length >= 3) continue;
    const [x, y] = k.split(',').map(Number);
    if (hash2(x, y, 77) > 0.985 && x + y > bounds.minX + bounds.minY + 20) boats.push({ x: x + 0.5, y: y + 0.5 });
  }

  return { canvas: px.done(), offsetX: sxMin, offsetY: syMin, land, roads, trees, lamps: dedupLamps, signs, lighthouse, boats, bounds, biome };
}

/** Tileable deep-water pattern for the open sea background. */
export function seaPattern(frame: number): HTMLCanvasElement {
  const px = new Px(64, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    const w = Math.sin((x + frame * 2) * 0.2 + Math.sin(y * 0.4) * 2) * 0.5 + 0.5;
    let c = shade(DEEP, 0.95 + w * 0.06);
    if (hash2(x, y, frame + 1) > 0.992) c = shade(DEEP, 1.35);
    px.set(x, y, c);
  }
  return px.done();
}

/** Breadth-first path along road tiles. */
export function roadPath(roads: Set<string>, from: [number, number], to: [number, number]): [number, number][] | null {
  const start = key(...from), goal = key(...to);
  if (!roads.has(start) || !roads.has(goal)) return null;
  const prev = new Map<string, string | null>([[start, null]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift()!;
    if (cur === goal) break;
    const [x, y] = cur.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = key(x + dx, y + dy);
      if (roads.has(n) && !prev.has(n)) { prev.set(n, cur); q.push(n); }
    }
    if (prev.size > 20000) return null;
  }
  if (!prev.has(goal)) return null;
  const path: [number, number][] = [];
  for (let c: string | null = goal; c; c = prev.get(c) ?? null) path.unshift(c.split(',').map(Number) as [number, number]);
  return path;
}

/** Nearest road tile to a rectangle (building footprint). */
export function nearestRoad(roads: Set<string>, r: Rect): [number, number] | null {
  let best: [number, number] | null = null, bd = Infinity;
  for (let i = -1; i <= r.w; i++) for (let j = -1; j <= r.h; j++) {
    const x = r.x + i, y = r.y + j;
    if (!roads.has(key(x, y))) continue;
    const d = Math.abs(i - r.w / 2) + Math.abs(j - r.h / 2);
    if (d < bd) { bd = d; best = [x, y]; }
  }
  if (best) return best;
  for (let rad = 2; rad < 8; rad++) for (let i = -rad; i <= r.w + rad; i++) for (let j = -rad; j <= r.h + rad; j++) {
    if (roads.has(key(r.x + i, r.y + j))) return [r.x + i, r.y + j];
  }
  return null;
}
