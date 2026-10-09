import { Application, Container, Graphics, Polygon, Sprite, Texture, TextureSource, TilingSprite } from 'pixi.js';
import type { Biome, BlockView, EntityView, Health, WorldEvent } from '@berrie/shared';
import { BLOCK_PITCH } from '@berrie/shared';
import { effectiveHealth } from '@berrie/shared';
import {
  buildingArt, ruinsArt, scaffoldArt, treeArt, rockArt, lampArt, signpostArt, lighthouseArt, boatArt, personArt,
  vanArt, cloudArt, glowCanvas, markerArt, type SpriteArt,
} from './art';
import { buildTerrain, seaPattern, roadPath, nearestRoad, TREE_TINT, type Terrain, type Rect } from './terrain';
import { capacityTier, hostFacts, pressure } from '../ui/facts';
import { TW, TH, hex, hashStr } from './pixel';
import { HEALTH_COLOR, hexNum, iconSvg, statusText, esc } from '../ui/status';

TextureSource.defaultOptions.scaleMode = 'nearest';

export interface RendererCallbacks {
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onCamera?: () => void;
  /** Fired ~1.5 s after the user stops moving the camera. */
  onCameraSettled?: (camera: { x: number; y: number; zoom: number }) => void;
  /** Personal island arrangement: a whole island was dragged to a new offset (in tiles). */
  onIslandMoved?: (district: string, offset: { dx: number; dy: number }) => void;
}

/** Merged view of all islands, used for pathing, placement checks and bounds. */
interface World2D {
  roads: Set<string>;
  land: Set<string>;
  islands: Terrain[];
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface Island { key: string; terrain: Terrain; sprite: Sprite; props: Sprite[]; glows: Sprite[] }

/** Each server is its own island: entities belong to their host's district, everything else to 'external'. */
/** One-line capacity/usage summary for island labels — only collected values, stale ones marked with ~. */
function hostLine(e: EntityView): string {
  const f = hostFacts(e);
  if (!f) return '';
  const v = <T,>(x: { status: string; value: T | null }) => (x.status === 'confirmed' || x.status === 'stale' ? x.value : null);
  const mark = (x: { status: string }) => (x.status === 'stale' ? '~' : '');
  const parts: string[] = [];
  const cpu = v(f.cpu), mem = v(f.memory), disk = v(f.storage)?.filesystems.find((x) => x.mount === '/') ?? v(f.storage)?.filesystems[0];
  if (cpu) parts.push(`${mark(f.cpu)}${cpu.cores} cores${cpu.usagePct != null ? ` ${Math.round(cpu.usagePct)}%` : ''}`);
  if (mem?.usedPct != null) parts.push(`${mark(f.memory)}mem ${Math.round(mem.usedPct)}%`);
  if (disk) parts.push(`${mark(f.storage)}disk ${Math.round(disk.usedPct)}%`);
  const pr = pressure(f);
  const html = parts.length ? `<span class="hf">${esc(parts.join(' · '))}</span>` : '';
  return html + (pr.length ? `<span class="pr">▲ ${esc(pr[0].label)}</span>` : '');
}

export const districtOf = (e: Pick<EntityView, 'kind' | 'id' | 'hostId'>): string => (e.kind === 'host' ? e.id : e.hostId ?? 'external');

export interface RenderState {
  entities: EntityView[];
  blocks: BlockView[];
  selectedId: string | null;
  /** Entities that match the active filters; others are dimmed. null = no filter. */
  matching: Set<string> | null;
  daylight: 'auto' | 'day' | 'night';
  editLayout: boolean;
  labelDensity?: 'less' | 'auto' | 'more';
  /** Personal island offsets in tiles, keyed by district (host entity id). */
  offsets?: Record<string, { dx: number; dy: number }>;
  /** Island biome per district (from the host's Harbor appearance). */
  biomes?: Record<string, Biome>;
  /** Personal "arrange islands" mode: drag whole islands. */
  arrangeIslands?: boolean;
  /** Personal saved camera, used instead of fitting the whole world on first load. */
  initialCamera?: { x: number; y: number; zoom: number } | null;
}

interface BuildingNode {
  id: string;
  root: Container;
  sprite: Sprite;
  scaffold: Sprite | null;
  art: SpriteArt;
  artKey: string;
  rect: Rect;
  beacon: Sprite;
  beaconGlow: Sprite;
  marker: Sprite | null;
  markerKind: string | null;
  label: HTMLDivElement;
  labelKey: string;
  health: Health;
  entity: EntityView;
  smokeAt: number;
  labelW: number;
  labelH: number;
}

interface Courier {
  sprite: Sprite;
  frames: [Texture, Texture];
  path: [number, number][];
  t: number;
  speed: number;
  done: boolean;
}

interface Particle { s: Sprite; vx: number; vy: number; life: number; max: number; grow: number }

const PROBLEM: Health[] = ['unhealthy', 'unreachable', 'degraded', 'restarting'];
const isoX = (x: number, y: number) => (x - y) * (TW / 2);
const isoY = (x: number, y: number) => (x + y) * (TH / 2);

export class WorldRenderer {
  app = new Application();
  private world = new Container();
  private worldTop = new Container();
  private groundLayer = new Container();
  private islands = new Map<string, Island>();
  private arrangeGhost = new Graphics();
  private dragIsland: { district: string; start: [number, number]; delta: [number, number] } | null = null;
  private rings = new Graphics();
  private objects = new Container();
  private effects = new Container();
  private lights = new Container();
  private cloudLayer = new Container();
  private shadowLayer = new Container();
  private night = new Graphics();
  private sea!: TilingSprite;
  private seaFrames: Texture[] = [];
  private props: Container[] = [];
  private nodes = new Map<string, BuildingNode>();
  private couriers: Courier[] = [];
  private particles: Particle[] = [];
  private tex = new Map<string, Texture>();
  private terrain: World2D | null = null;
  private state: RenderState | null = null;
  private cam = { x: 0, y: 0, zoom: 2.5 };
  private camTarget: { x: number; y: number; zoom: number } | null = null;
  private fitted = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragMoved = false;
  private pinchDist = 0;
  private dragBuilding: { id: string; ghost: Graphics; tile: [number, number]; offset: [number, number] } | null = null;
  private clouds: { s: Sprite; sh: Sprite; vx: number }[] = [];
  private time = 0;
  private darkness = 0;
  private destroyed = false;

  constructor(private readonly host: HTMLElement, private readonly labelLayer: HTMLElement, private readonly cb: RendererCallbacks) {}

  async init(): Promise<void> {
    await this.app.init({ resizeTo: this.host, background: 0x1d5a86, antialias: false, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true, preference: 'webgl' });
    if (this.destroyed) { this.app.destroy(true); return; }
    this.host.appendChild(this.app.canvas);
    this.app.canvas.style.imageRendering = 'pixelated';
    this.seaFrames = [0, 1, 2, 3].map((f) => this.texFrom(`sea${f}`, () => seaPattern(f)));
    this.sea = new TilingSprite({ texture: this.seaFrames[0], width: this.app.screen.width, height: this.app.screen.height });
    this.objects.sortableChildren = true;
    this.lights.blendMode = 'add';
    this.world.addChild(this.groundLayer, this.rings, this.shadowLayer, this.objects, this.effects, this.arrangeGhost);
    this.worldTop.addChild(this.lights, this.cloudLayer);
    this.app.stage.addChild(this.sea, this.world, this.night, this.worldTop);
    this.setupInput();
    this.setupClouds();
    this.app.ticker.add((t) => this.tick(t.deltaMS));
  }

  destroy(): void {
    this.destroyed = true;
    for (const n of this.nodes.values()) n.label.remove();
    try { this.app.destroy(true, { children: true, texture: true }); } catch { /* not initialised */ }
  }

  // ------------------------------------------------------------------ textures

  private texFrom(key: string, make: () => HTMLCanvasElement): Texture {
    let t = this.tex.get(key);
    if (!t) { t = Texture.from(make()); t.source.scaleMode = 'nearest'; this.tex.set(key, t); }
    return t;
  }
  private artCache = new Map<string, SpriteArt>();
  private art(key: string, make: () => SpriteArt): SpriteArt {
    let a = this.artCache.get(key);
    if (!a) { a = make(); this.artCache.set(key, a); }
    return a;
  }
  private artTex(key: string, a: SpriteArt): Texture {
    return this.texFrom(key, () => a.canvas);
  }

  // ------------------------------------------------------------------ state sync

  private offsetOf(district: string): { dx: number; dy: number } {
    return this.state?.offsets?.[district] ?? { dx: 0, dy: 0 };
  }

  /** Layout of an entity in render space (shared layout + this user's island offset). */
  private placed(e: EntityView): Rect {
    const o = this.offsetOf(districtOf(e));
    return { x: e.layout!.x + o.dx, y: e.layout!.y + o.dy, w: e.layout!.w, h: e.layout!.h };
  }

  update(s: RenderState): void {
    this.state = s;
    if (!this.app.renderer) return;
    const withBuildings = s.entities.filter((e) => e.layout && e.lifecycle !== 'archived');
    // Group blocks and building footprints per island.
    const groups = new Map<string, { blocks: BlockView[]; rects: Rect[] }>();
    const grp = (d: string) => { let g = groups.get(d); if (!g) { g = { blocks: [], rects: [] }; groups.set(d, g); } return g; };
    for (const b of s.blocks) { const o = this.offsetOf(b.district); grp(b.district).blocks.push({ ...b, x: b.x + o.dx, y: b.y + o.dy }); }
    for (const e of withBuildings) grp(districtOf(e)).rects.push(this.placed(e));
    let changed = false;
    for (const [d, g] of groups) {
      const biome = s.biomes?.[d] ?? 'meadow';
      const key = JSON.stringify([g.blocks.map((b) => [b.x, b.y, b.size, b.group]), g.rects, biome]);
      if (this.islands.get(d)?.key !== key) { this.rebuildIsland(d, key, g.blocks, g.rects, biome); changed = true; }
    }
    for (const d of [...this.islands.keys()]) if (!groups.has(d)) { this.destroyIsland(d); changed = true; }
    if (changed || !this.terrain) this.mergeIslands();

    const seen = new Set<string>();
    for (const e of withBuildings) { seen.add(e.id); this.syncBuilding(e, s, this.placed(e)); }
    for (const [id, n] of this.nodes) if (!seen.has(id)) { n.root.destroy({ children: true }); n.label.remove(); this.nodes.delete(id); }
    this.drawRings();
    this.placeLabels();
    if (!this.fitted && this.terrain) {
      this.fitted = true;
      if (s.initialCamera) { this.cam = { ...s.initialCamera }; this.applyCamera(); } else this.fit();
    }
  }

  private rebuildIsland(district: string, key: string, blocks: BlockView[], rects: Rect[], biome: Biome): void {
    this.destroyIsland(district);
    const t = buildTerrain(blocks, rects, biome);
    const tex = Texture.from(t.canvas);
    tex.source.scaleMode = 'nearest';
    const sprite = new Sprite(tex);
    sprite.position.set(t.offsetX, t.offsetY);
    this.groundLayer.addChild(sprite);
    const isl: Island = { key, terrain: t, sprite, props: [], glows: [] };
    const glowWarm = this.texFrom('glow-warm', () => glowCanvas('rgba(255,210,120,0.9)'));
    const tint = TREE_TINT[biome] ?? 0xffffff;
    for (const tr of t.trees) {
      const a = tr.kind === 'rock' ? this.art(`rock${tr.seed % 3}`, () => rockArt(tr.seed % 3)) : this.art(`${tr.kind}${tr.seed % 5}`, () => treeArt(tr.kind as 'pine', tr.seed % 5));
      const p = this.addProp(a, `t:${tr.kind}${tr.seed % 5}${tr.kind === 'rock' ? 'r' : ''}`, tr.x, tr.y);
      if (tr.kind !== 'rock' && (biome !== 'autumn' || tr.kind !== 'pine')) p.tint = tint;
      isl.props.push(p);
    }
    for (const l of t.lamps) {
      isl.props.push(this.addProp(this.art('lamp', lampArt), 'lamp', l.x, l.y));
      const g = new Sprite(glowWarm);
      g.anchor.set(0.5);
      g.scale.set(0.9);
      g.position.set(isoX(l.x, l.y), isoY(l.x, l.y) - 17);
      g.label = 'lamp-glow';
      g.alpha = this.darkness;
      this.lights.addChild(g);
      isl.glows.push(g);
    }
    for (const sgn of t.signs) isl.props.push(this.addProp(this.art('sign', signpostArt), 'sign', sgn.x, sgn.y));
    if (t.lighthouse) isl.props.push(this.addProp(this.art('lighthouse', lighthouseArt), 'lighthouse', t.lighthouse.x, t.lighthouse.y));
    for (const b of t.boats) {
      const c = this.addProp(this.art('boat', boatArt), 'boat', b.x, b.y);
      c.label = 'boat';
      isl.props.push(c);
    }
    this.islands.set(district, isl);
  }

  private destroyIsland(district: string): void {
    const isl = this.islands.get(district);
    if (!isl) return;
    isl.sprite.texture.destroy(true);
    isl.sprite.destroy();
    for (const p of isl.props) { this.props = this.props.filter((x) => x !== p); p.destroy(); }
    for (const g of isl.glows) g.destroy();
    this.islands.delete(district);
  }

  private mergeIslands(): void {
    const ts = [...this.islands.values()].map((i) => i.terrain);
    const roads = new Set<string>(), land = new Set<string>();
    for (const t of ts) { for (const r of t.roads) roads.add(r); for (const l of t.land) land.add(l); }
    if (!ts.length) { this.terrain = { roads, land, islands: [], offsetX: -400, offsetY: -200, width: 800, height: 400 }; return; }
    const x0 = Math.min(...ts.map((t) => t.offsetX)), y0 = Math.min(...ts.map((t) => t.offsetY));
    const x1 = Math.max(...ts.map((t) => t.offsetX + t.canvas.width)), y1 = Math.max(...ts.map((t) => t.offsetY + t.canvas.height));
    this.terrain = { roads, land, islands: ts, offsetX: x0, offsetY: y0, width: x1 - x0, height: y1 - y0 };
  }

  private addProp(a: SpriteArt, key: string, x: number, y: number): Sprite {
    const s = new Sprite(this.artTex(`prop:${key}`, a));
    s.position.set(isoX(x, y) - a.ox, isoY(x, y) - a.oy);
    s.zIndex = (x + y) * 10;
    this.objects.addChild(s);
    this.props.push(s);
    return s;
  }

  private syncBuilding(e: EntityView, s: RenderState, l: Rect): void {
    const seed = Math.floor(hashStr(e.id) * 4);
    const removed = e.lifecycle === 'removed';
    const facts = e.kind === 'host' ? hostFacts(e) : null;
    const tier = e.buildingType === 'server' ? capacityTier(facts) : null;
    const artKey = removed ? `ruins${seed}` : `${e.buildingType}${seed}${tier ? `t${tier}` : ''}`;
    let n = this.nodes.get(e.id);
    const art = this.art(artKey, () => (removed ? ruinsArt(seed) : buildingArt(e.buildingType, seed, { tier })));
    if (!n) {
      const root = new Container();
      const sprite = new Sprite(this.artTex(`b:${artKey}`, art));
      sprite.eventMode = 'static';
      sprite.cursor = 'pointer';
      sprite.on('pointertap', () => { if (!this.dragMoved && !this.dragBuilding) this.cb.onSelect(e.id); });
      sprite.on('pointerdown', (ev) => { if (this.state?.editLayout) this.startBuildingDrag(e.id, ev.global.x, ev.global.y); });
      root.addChild(sprite);
      const beaconGlow = new Sprite(this.texFrom('glow-white', () => glowCanvas('rgba(255,255,255,0.95)', 48)));
      beaconGlow.anchor.set(0.5);
      beaconGlow.blendMode = 'add';
      const beacon = new Sprite(this.texFrom('beacon', () => { const c = document.createElement('canvas'); c.width = c.height = 5; const x = c.getContext('2d')!; x.fillStyle = '#fff'; x.fillRect(1, 0, 3, 5); x.fillRect(0, 1, 5, 3); return c; }));
      beacon.anchor.set(0.5);
      this.lights.addChild(beaconGlow);
      this.worldTop.addChildAt(beacon, 1);
      this.objects.addChild(root);
      const label = document.createElement('div');
      label.className = 'blabel';
      label.addEventListener('click', () => this.cb.onSelect(e.id));
      this.labelLayer.appendChild(label);
      n = { id: e.id, root, sprite, scaffold: null, art, artKey, rect: { x: l.x, y: l.y, w: l.w, h: l.h }, beacon, beaconGlow, marker: null, markerKind: null, label, labelKey: '', health: e.health, entity: e, smokeAt: 0, labelW: 0, labelH: 0 };
      this.nodes.set(e.id, n);
    }
    if (n.artKey !== artKey) {
      n.sprite.texture = this.artTex(`b:${artKey}`, art);
      n.art = art;
      n.artKey = artKey;
      if (removed) this.burst(l.x + l.w / 2, l.y + l.h / 2, 0x9a9286, 14);
    }
    n.entity = e;
    n.rect = { x: l.x, y: l.y, w: l.w, h: l.h };
    const bx = isoX(l.x, l.y), by = isoY(l.x, l.y);
    n.root.position.set(bx - art.ox, by - art.oy);
    n.root.zIndex = (l.x + l.w / 2 + l.y + l.h / 2) * 10 + 4;
    const H = art.oy - art.top[1];
    const p = (x: number, y: number, z: number) => [art.ox + isoX(x, y), art.oy + isoY(x, y) - z];
    n.sprite.hitArea = new Polygon([...p(0, 0, H), ...p(l.w, 0, H), ...p(l.w, 0, 0), ...p(l.w, l.h, 0), ...p(0, l.h, 0), ...p(0, l.h, H)]);

    const h = effectiveHealth(e);
    const color = hexNum(HEALTH_COLOR[h]);
    const match = !s.matching || s.matching.has(e.id);
    // Status tints: host outage greys the building; unknown is neutral; never decorative red.
    n.sprite.tint = h === 'host_offline' ? 0x9a94b8 : h === 'unknown' ? 0xc4c8d0 : removed ? 0xb0b0b0 : 0xffffff;
    n.root.alpha = !match ? 0.28 : e.lifecycle === 'missing' ? 0.5 : 1;
    n.beacon.tint = removed ? 0x555555 : color;
    n.beaconGlow.tint = color;
    n.beacon.visible = n.beaconGlow.visible = !removed && match;
    n.beacon.position.set(bx - art.ox + art.top[0], by - art.oy + art.top[1]);
    n.beaconGlow.position.copyFrom(n.beacon.position);
    n.health = h;

    // construction scaffold while newly discovered
    const constructing = e.lifecycle === 'discovered' && !removed;
    if (constructing && !n.scaffold) {
      const sa = this.art(`scaffold${l.w}`, () => scaffoldArt(l.w));
      n.scaffold = new Sprite(this.artTex(`scaffold${l.w}`, sa));
      n.scaffold.position.set(art.ox - sa.ox, art.oy - sa.oy);
      n.root.addChild(n.scaffold);
      this.burst(l.x + l.w / 2, l.y + l.h / 2, 0xd8c8a0, 8);
    } else if (!constructing && n.scaffold) {
      n.scaffold.destroy();
      n.scaffold = null;
      this.burst(l.x + l.w / 2, l.y + l.h / 2, 0xffe680, 10);
    }

    // floating marker
    const mk = removed ? null : e.lifecycle === 'missing' ? 'missing' : h === 'host_offline' && e.kind === 'host' ? 'offline' : h === 'unhealthy' || h === 'unreachable' ? 'warn' : pressure(facts).length ? 'pressure' : null;
    if (mk !== n.markerKind) {
      n.marker?.destroy();
      n.marker = null;
      n.markerKind = mk;
      if (mk) {
        n.marker = new Sprite(this.texFrom(`marker-${mk}`, () => markerArt(mk as 'warn')));
        n.marker.anchor.set(0.5, 1);
        this.worldTop.addChild(n.marker);
      }
    }
    if (n.marker) { n.marker.position.set(n.beacon.x + 9, n.beacon.y - 2); n.marker.visible = match; }
  }

  private drawRings(): void {
    const g = this.rings;
    g.clear();
    if (!this.state) return;
    for (const n of this.nodes.values()) {
      const sel = n.id === this.state.selectedId;
      const prob = PROBLEM.includes(n.health) && n.entity.lifecycle !== 'removed';
      if (!sel && !prob) continue;
      const { x, y, w, h } = n.rect;
      const pad = sel ? 0.25 : 0.12;
      const pts = [[x - pad, y - pad], [x + w + pad, y - pad], [x + w + pad, y + h + pad], [x - pad, y + h + pad]].flatMap(([a, b]) => [isoX(a, b), isoY(a, b)]);
      const c = sel ? 0x7fd6ff : hexNum(HEALTH_COLOR[n.health]);
      g.poly(pts).fill({ color: c, alpha: sel ? 0.18 : 0.22 }).stroke({ width: sel ? 1.5 : 1, color: c, alpha: 0.9 });
    }
  }

  // ------------------------------------------------------------------ labels (DOM overlay)

  private placeLabels(): void {
    if (!this.state) return;
    const z = this.cam.zoom;
    const W = this.app.screen.width, H = this.app.screen.height;
    const items: { n: BuildingNode; sx: number; sy: number; prio: number }[] = [];
    for (const n of this.nodes.values()) {
      const e = n.entity;
      const st = statusText(e);
      const selected = e.id === this.state.selectedId;
      const problem = PROBLEM.includes(n.health) || e.lifecycle === 'missing' || n.health === 'host_offline';
      const match = !this.state.matching || this.state.matching.has(e.id);
      // Zoom-level detail: far out only problems/selection keep labels; very far, labels become compact.
      const density = this.state.labelDensity ?? 'auto';
      const threshold = density === 'more' ? 0.75 : density === 'less' ? 1.9 : 1.15;
      const show = match && (selected || problem || e.kind === 'host' || z >= threshold || this.nodes.size <= 12);
      const compact = z < 0.9 && !selected;
      const hf = e.kind === 'host' ? hostLine(e) : '';
      const key = `${e.displayName}|${st.text}|${st.color}|${compact}|${selected}|${e.inventoryUncertain}|${e.buildingType}|${e.lifecycle}|${hf}`;
      if (key !== n.labelKey) {
        n.labelKey = key;
        n.label.className = `blabel${selected ? ' sel' : ''}${compact ? ' compact' : ''}${e.lifecycle === 'removed' ? ' removed' : ''}${e.lifecycle === 'missing' ? ' missing' : ''}${e.inventoryUncertain ? ' uncertain' : ''}`;
        n.label.style.setProperty('--st', st.color);
        n.label.innerHTML = compact
          ? `<span class="dot"></span><span class="nm">${esc(e.displayName)}</span>`
          : `<span class="ic">${iconSvg(e.buildingType, 14)}</span><span class="tx"><span class="nm">${esc(e.displayName)}</span><span class="st"><span class="dot"></span>${esc(st.text)}${e.inventoryUncertain ? ' · stale' : ''}</span>${hf}</span>`;
        n.labelW = 0;
      }
      const sx = n.beacon.x * z + this.world.x, sy = (n.beacon.y - 8) * z + this.world.y;
      const vis = show && sx > -150 && sx < W + 150 && sy > -60 && sy < H + 60;
      n.label.style.display = vis ? '' : 'none';
      n.label.style.zIndex = selected ? '5' : problem ? '3' : '1';
      if (vis) items.push({ n, sx, sy, prio: selected ? 0 : problem ? 1 : e.kind === 'host' ? 2 : 3 });
    }
    // Measure (one layout pass), then place greedily by priority, avoiding overlaps.
    for (const it of items) if (!it.n.labelW) { it.n.labelW = it.n.label.offsetWidth; it.n.labelH = it.n.label.offsetHeight; }
    items.sort((a, b) => a.prio - b.prio || a.sy - b.sy);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const hit = (r: { x: number; y: number; w: number; h: number }) => placed.some((p) => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h);
    for (const it of items) {
      const w = it.n.labelW + 4, h = it.n.labelH + 6;
      let r = { x: it.sx - w / 2, y: it.sy - h, w, h };
      let tries = 0;
      while (hit(r) && tries < 2) { r = { ...r, y: r.y - h * 0.62 }; tries++; }
      if (hit(r) && it.prio >= 3) { it.n.label.style.display = 'none'; continue; }
      placed.push(r);
      it.n.label.style.transform = `translate(${Math.round(it.sx)}px, ${Math.round(r.y + h)}px) translate(-50%, -100%)`;
    }
  }

  // ------------------------------------------------------------------ events → animations

  /** Visualise an observed event. Nothing is animated without a real event behind it. */
  onEvent(ev: WorldEvent): void {
    if (!this.terrain) return;
    const from = ev.entityId ? this.nodes.get(ev.entityId) : undefined;
    const to = ev.relatedEntityId ? this.nodes.get(ev.relatedEntityId) : undefined;
    const c = (from ?? to)?.rect;
    switch (ev.type) {
      case 'http.request': if (from && to) this.courier(from.rect, to.rect, 'person', 0xffffff, 0xf4f0e8); break;
      case 'ai.request_started': if (from && to) this.courier(from.rect, to.rect, 'person', 0x8a5cf0, 0xc9b8ff); break;
      case 'ai.request_completed': if (from && to) this.courier(from.rect, to.rect, 'person', 0x8a5cf0, 0x7fe0a0); break;
      case 'automation.executed': if (from && to) this.courier(from.rect, to.rect, 'van', 0xf08a3c); else if (c) this.burst(c.x + 1, c.y + 1, 0xf08a3c, 6); break;
      case 'task.executed': if (from && to) this.courier(from.rect, to.rect, 'person', 0x3fa36a, 0xd8b070); else if (c) this.burst(c.x + 1, c.y + 1, 0x3fd17a, 5); break;
      case 'container.started': if (from && to) this.courier(to.rect, from.rect, 'person', 0x3fd17a, 0x3fd17a); break;
      case 'deployment.changed': {
        const hostNode = from?.entity.hostId ? this.nodes.get(from.entity.hostId) : undefined;
        if (from && hostNode) this.courier(hostNode.rect, from.rect, 'van', 0x4aa8ff);
        break;
      }
      case 'action.performed': {
        const hostNode = from?.entity.hostId ? this.nodes.get(from.entity.hostId) : undefined;
        if (from && hostNode) this.courier(hostNode.rect, from.rect, 'person', 0xf2b33d, 0xf2b33d);
        break;
      }
      case 'service.unhealthy': case 'service.unreachable': case 'container.stopped': case 'host.offline':
        if (c) this.burst(c.x + c.w / 2, c.y + c.h / 2, 0xef4b4b, 10); break;
      case 'service.recovered': case 'host.online':
        if (c) this.burst(c.x + c.w / 2, c.y + c.h / 2, 0x3fd17a, 16); break;
      case 'alert': if (c) this.burst(c.x + c.w / 2, c.y + c.h / 2, 0xf2b33d, 10); break;
      default: break;
    }
  }

  private courier(a: Rect, b: Rect, kind: 'person' | 'van', color: number, carry?: number): void {
    if (!this.terrain || this.couriers.length > 40) return;
    const ra = nearestRoad(this.terrain.roads, a), rb = nearestRoad(this.terrain.roads, b);
    let path: [number, number][] | null = ra && rb ? roadPath(this.terrain.roads, ra, rb) : null;
    // No walking on water: between islands without a road, the event stays in the feed only.
    if (!path && Math.hypot(a.x - b.x, a.y - b.y) > 30) return;
    if (!path || path.length > 160) path = [[a.x + a.w / 2, a.y + a.h], [b.x + b.w / 2, b.y + b.h]];
    else path = path.map(([x, y]) => [x + 0.5, y + 0.5]);
    path = [[a.x + a.w / 2, a.y + a.h / 2], ...path, [b.x + b.w / 2, b.y + b.h / 2]];
    let frames: [Texture, Texture];
    if (kind === 'van') {
      const t = this.artTex(`van${color}`, this.art(`van${color}`, () => vanArt(hex(color))));
      frames = [t, t];
    } else {
      const rgb = hex(color), cr = carry !== undefined ? hex(carry) : null;
      frames = [0, 1].map((f) => this.artTex(`p${color}-${carry}-${f}`, this.art(`p${color}-${carry}-${f}`, () => personArt(rgb, f as 0, cr)))) as [Texture, Texture];
    }
    const s = new Sprite(frames[0]);
    s.anchor.set(0.5, 0.92);
    this.objects.addChild(s);
    this.couriers.push({ sprite: s, frames, path, t: 0, speed: kind === 'van' ? 4.2 : 2.6, done: false });
  }

  private burst(x: number, y: number, color: number, n: number): void {
    const tex = this.texFrom('px', () => { const c = document.createElement('canvas'); c.width = c.height = 2; const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, 2, 2); return c; });
    for (let i = 0; i < n; i++) {
      const s = new Sprite(tex);
      s.tint = color;
      s.anchor.set(0.5);
      s.position.set(isoX(x, y) + (Math.random() - 0.5) * 20, isoY(x, y) - 10 - Math.random() * 14);
      this.effects.addChild(s);
      this.particles.push({ s, vx: (Math.random() - 0.5) * 30, vy: -20 - Math.random() * 30, life: 0, max: 700 + Math.random() * 500, grow: 0 });
    }
  }

  private smoke(n: BuildingNode): void {
    if (!n.art.smoke) return;
    const tex = this.texFrom('smoke', () => glowCanvas('rgba(230,230,230,0.8)', 16));
    const s = new Sprite(tex);
    s.anchor.set(0.5);
    s.scale.set(0.3);
    s.alpha = 0.4;
    s.position.set(n.root.x + n.art.smoke[0], n.root.y + n.art.smoke[1]);
    this.effects.addChild(s);
    this.particles.push({ s, vx: 3 + Math.random() * 2, vy: -8 - Math.random() * 3, life: 0, max: 2200, grow: 0.16 });
  }

  // ------------------------------------------------------------------ ambient

  private setupClouds(): void {
    for (let i = 0; i < 3; i++) {
      const s = new Sprite(this.texFrom(`cloud${i % 3}`, () => cloudArt(i % 3, false)));
      const sh = new Sprite(this.texFrom(`cloudsh${i % 3}`, () => cloudArt(i % 3, true)));
      s.alpha = 0.32;
      sh.alpha = 0.08;
      this.cloudLayer.addChild(s);
      this.shadowLayer.addChild(sh);
      this.clouds.push({ s, sh, vx: 4 + Math.random() * 4 });
    }
    this.placeCloudsRandomly();
  }

  private placeCloudsRandomly(): void {
    const b = this.worldBounds();
    for (const c of this.clouds) {
      c.s.position.set(b.x + Math.random() * b.w, b.y + Math.random() * b.h - 80);
      c.sh.position.set(c.s.x + 30, c.s.y + 120);
    }
  }

  private worldBounds(): { x: number; y: number; w: number; h: number } {
    if (!this.terrain) return { x: -400, y: -200, w: 800, h: 400 };
    return { x: this.terrain.offsetX, y: this.terrain.offsetY, w: this.terrain.width, h: this.terrain.height };
  }

  private computeDarkness(): number {
    const mode = this.state?.daylight ?? 'auto';
    if (mode === 'day') return 0;
    if (mode === 'night') return 1;
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    if (h >= 7.5 && h <= 18.5) return 0;
    if (h > 18.5 && h < 21) return (h - 18.5) / 2.5;
    if (h > 5 && h < 7.5) return 1 - (h - 5) / 2.5;
    return 1;
  }

  private tick(dt: number): void {
    this.time += dt;
    const ds = dt / 1000;
    // camera easing
    if (this.camTarget) {
      const k = Math.min(1, ds * 6);
      this.cam.x += (this.camTarget.x - this.cam.x) * k;
      this.cam.y += (this.camTarget.y - this.cam.y) * k;
      this.cam.zoom += (this.camTarget.zoom - this.cam.zoom) * k;
      if (Math.abs(this.camTarget.x - this.cam.x) < 0.5 && Math.abs(this.camTarget.zoom - this.cam.zoom) < 0.005) this.camTarget = null;
      this.applyCamera();
    }
    // sea
    const f = Math.floor(this.time / 600) % 4;
    if (this.sea.texture !== this.seaFrames[f]) this.sea.texture = this.seaFrames[f];
    // night
    const dk = this.computeDarkness();
    if (Math.abs(dk - this.darkness) > 0.001 || this.time < 100) {
      this.darkness = dk;
      this.night.clear().rect(0, 0, this.app.screen.width, this.app.screen.height).fill({ color: 0x0a1433, alpha: dk * 0.5 });
      for (const l of this.lights.children) if (l.label === 'lamp-glow') l.alpha = dk;
    }
    // beacons & markers
    const pulse = (Math.sin(this.time / 220) + 1) / 2;
    for (const n of this.nodes.values()) {
      const bad = PROBLEM.includes(n.health) || n.health === 'host_offline';
      n.beaconGlow.alpha = bad ? 0.45 + pulse * 0.55 : 0.35 + this.darkness * 0.3;
      n.beaconGlow.scale.set(bad ? 0.5 + pulse * 0.35 : 0.4);
      if (n.marker) n.marker.y = n.beacon.y - 2 - Math.abs(Math.sin(this.time / 300)) * 4;
      // chimney smoke only while the service is actually running healthy
      if (n.art.smoke && n.health === 'healthy' && n.entity.lifecycle === 'active' && this.time > n.smokeAt) {
        n.smokeAt = this.time + 1400 + Math.random() * 900;
        this.smoke(n);
      }
      if (n.scaffold && Math.random() < ds * 1.5) this.burst(n.rect.x + Math.random() * n.rect.w, n.rect.y + n.rect.h, 0xc8b890, 1);
    }
    // couriers
    for (const c of this.couriers) {
      let i = Math.floor(c.t);
      if (i >= c.path.length - 1) { c.done = true; continue; }
      // advance by distance so speed is constant on short road steps and long fallback segments alike
      c.t += (ds * c.speed) / (Math.hypot(c.path[i + 1][0] - c.path[i][0], c.path[i + 1][1] - c.path[i][1]) || 1);
      i = Math.floor(c.t);
      if (i >= c.path.length - 1) { c.done = true; continue; }
      const [ax, ay] = c.path[i], [bx, by] = c.path[i + 1];
      const k = c.t - i;
      const x = ax + (bx - ax) * k, y = ay + (by - ay) * k;
      c.sprite.position.set(isoX(x, y), isoY(x, y));
      c.sprite.zIndex = (x + y) * 10 + 6;
      c.sprite.texture = c.frames[Math.floor(this.time / 160) % 2];
      c.sprite.scale.x = isoX(bx, by) < isoX(ax, ay) ? -1 : 1;
    }
    for (const c of this.couriers.filter((c) => c.done)) c.sprite.destroy();
    this.couriers = this.couriers.filter((c) => !c.done);
    // particles
    for (const p of this.particles) {
      p.life += dt;
      p.s.x += p.vx * ds;
      p.s.y += p.vy * ds;
      if (!p.grow) p.vy += 60 * ds;
      else p.s.scale.set(p.s.scale.x + p.grow * ds);
      p.s.alpha = Math.max(0, 1 - p.life / p.max) * (p.grow ? 0.6 : 1);
    }
    for (const p of this.particles.filter((p) => p.life >= p.max)) p.s.destroy();
    this.particles = this.particles.filter((p) => p.life < p.max);
    // clouds
    const b = this.worldBounds();
    for (const c of this.clouds) {
      c.s.x += c.vx * ds;
      if (c.s.x > b.x + b.w + 100) { c.s.x = b.x - 200; c.s.y = b.y + Math.random() * b.h - 80; }
      c.sh.position.set(c.s.x + 30, c.s.y + 120);
      c.s.visible = c.sh.visible = this.cam.zoom < 2.2;
    }
    // boats bob
    for (const p of this.props) if (p.label === 'boat') p.pivot.y = Math.sin(this.time / 700 + p.x) * 1.2;
  }

  // ------------------------------------------------------------------ camera & input

  private applyCamera(): void {
    const W = this.app.screen.width, H = this.app.screen.height;
    const z = this.cam.zoom;
    for (const c of [this.world, this.worldTop]) {
      c.scale.set(z);
      c.position.set(Math.round(W / 2 - this.cam.x * z), Math.round(H / 2 - this.cam.y * z));
    }
    this.sea.width = W;
    this.sea.height = H;
    this.sea.tileScale.set(z);
    this.sea.tilePosition.set(this.world.x, this.world.y);
    this.placeLabels();
    this.cb.onCamera?.();
    if (this.fitted && this.cb.onCameraSettled) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.cb.onCameraSettled?.(this.camera()), 1500);
    }
  }

  private settleTimer: number | undefined;

  camera(): { x: number; y: number; zoom: number } {
    return { x: Math.round(this.cam.x), y: Math.round(this.cam.y), zoom: Math.round(this.cam.zoom * 100) / 100 };
  }

  setCamera(c: { x: number; y: number; zoom: number }): void {
    this.camTarget = { ...c };
  }

  fit(): void {
    if (!this.terrain) return;
    const occupied = [...this.nodes.values()].map((n) => n.rect);
    const rs = occupied.length ? occupied : [{ x: 0, y: 0, w: 8, h: 8 }];
    const xs = rs.flatMap((r) => [isoX(r.x, r.y + r.h), isoX(r.x + r.w, r.y)]);
    const ys = rs.flatMap((r) => [isoY(r.x, r.y) - 60, isoY(r.x + r.w, r.y + r.h)]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = this.app.screen.width, H = this.app.screen.height;
    const zoom = Math.max(0.3, Math.min(3.5, Math.min((W * 0.7) / (maxX - minX + 120), (H * 0.75) / (maxY - minY + 120))));
    this.cam = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
    this.applyCamera();
  }

  focus(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    const { x, y, w, h } = n.rect;
    this.camTarget = { x: isoX(x + w / 2, y + h / 2), y: isoY(x + w / 2, y + h / 2) - 20, zoom: Math.max(this.cam.zoom, 2.6) };
  }

  zoomBy(f: number, sx = this.app.screen.width / 2, sy = this.app.screen.height / 2): void {
    const z0 = this.cam.zoom;
    const z1 = Math.max(0.25, Math.min(6, z0 * f));
    const wx = (sx - this.world.x) / z0, wy = (sy - this.world.y) / z0;
    this.cam.zoom = z1;
    this.cam.x = wx - (sx - this.app.screen.width / 2) / z1;
    this.cam.y = wy - (sy - this.app.screen.height / 2) / z1;
    this.camTarget = null;
    this.applyCamera();
  }

  centerOnWorld(wx: number, wy: number): void {
    this.camTarget = { x: wx, y: wy, zoom: this.cam.zoom };
  }

  /** Data for the minimap. */
  minimap(): { terrain: World2D | null; nodes: { rect: Rect; color: string }[]; view: { x: number; y: number; w: number; h: number } } {
    const z = this.cam.zoom;
    return {
      terrain: this.terrain,
      nodes: [...this.nodes.values()].map((n) => ({ rect: n.rect, color: n.entity.lifecycle === 'removed' ? '#555' : HEALTH_COLOR[n.health] })),
      view: { x: -this.world.x / z, y: -this.world.y / z, w: this.app.screen.width / z, h: this.app.screen.height / z },
    };
  }

  private screenToTile(sx: number, sy: number): [number, number] {
    const wx = (sx - this.world.x) / this.cam.zoom, wy = (sy - this.world.y) / this.cam.zoom;
    return [(wx / (TW / 2) + wy / (TH / 2)) / 2, (wy / (TH / 2) - wx / (TW / 2)) / 2];
  }

  private setupInput(): void {
    const el = this.app.canvas;
    el.style.touchAction = 'none';
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY); }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      this.dragMoved = false;
      if (this.state?.arrangeIslands && this.pointers.size === 1) this.startIslandDrag(e.offsetX, e.offsetY);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (this.dragBuilding) { this.moveBuildingDrag(e.offsetX, e.offsetY); return; }
      if (this.dragIsland) { this.moveIslandDrag(e.offsetX, e.offsetY); this.dragMoved = true; return; }
      if (!prev) return;
      const cur = { x: e.offsetX, y: e.offsetY };
      this.pointers.set(e.pointerId, cur);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist) this.zoomBy(d / this.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        this.pinchDist = d;
        this.dragMoved = true;
        return;
      }
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) {
        if (!this.dragMoved && Math.hypot(dx, dy) < 3) return;
        this.dragMoved = true;
        this.camTarget = null;
        this.cam.x -= dx / this.cam.zoom;
        this.cam.y -= dy / this.cam.zoom;
        this.applyCamera();
      }
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.dragBuilding) this.endBuildingDrag();
      if (this.dragIsland) this.endIslandDrag();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    // click on empty ground clears selection
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointertap', (e) => { if (e.target === this.app.stage && !this.dragMoved) this.cb.onSelect(null); });
    this.app.renderer.on('resize', () => { this.app.stage.hitArea = this.app.screen; this.darkness = -1; this.applyCamera(); });
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      const step = 40 / this.cam.zoom;
      if (e.key === '+' || e.key === '=') this.zoomBy(1.2);
      else if (e.key === '-') this.zoomBy(1 / 1.2);
      else if (e.key === 'ArrowLeft') { this.cam.x -= step; this.applyCamera(); }
      else if (e.key === 'ArrowRight') { this.cam.x += step; this.applyCamera(); }
      else if (e.key === 'ArrowUp') { this.cam.y -= step; this.applyCamera(); }
      else if (e.key === 'ArrowDown') { this.cam.y += step; this.applyCamera(); }
      else if (e.key === 'Escape') this.cb.onSelect(null);
    });
  }

  // ------------------------------------------------------------------ personal island arrangement

  private islandAt(sx: number, sy: number): string | null {
    const [tx, ty] = this.screenToTile(sx, sy);
    const k = `${Math.floor(tx)},${Math.floor(ty)}`;
    for (const [d, isl] of this.islands) if (isl.terrain.land.has(k)) return d;
    return null;
  }

  private islandBox(d: string, delta: [number, number] = [0, 0]): Rect {
    const b = this.islands.get(d)!.terrain.bounds;
    return { x: b.minX + 8 + delta[0], y: b.minY + 8 + delta[1], w: b.maxX - b.minX - 16, h: b.maxY - b.minY - 16 };
  }

  private islandFits(d: string, delta: [number, number]): boolean {
    const r = this.islandBox(d, delta);
    for (const other of this.islands.keys()) {
      if (other === d) continue;
      const o = this.islandBox(other);
      if (r.x < o.x + o.w + 4 && o.x < r.x + r.w + 4 && r.y < o.y + o.h + 4 && o.y < r.y + r.h + 4) return false;
    }
    return true;
  }

  private startIslandDrag(sx: number, sy: number): void {
    const d = this.islandAt(sx, sy);
    if (!d) return;
    this.dragIsland = { district: d, start: this.screenToTile(sx, sy), delta: [0, 0] };
  }

  private moveIslandDrag(sx: number, sy: number): void {
    const di = this.dragIsland!;
    const [tx, ty] = this.screenToTile(sx, sy);
    // Snap to whole city blocks so roads keep lining up visually.
    di.delta = [Math.round((tx - di.start[0]) / BLOCK_PITCH) * BLOCK_PITCH, Math.round((ty - di.start[1]) / BLOCK_PITCH) * BLOCK_PITCH];
    const r = this.islandBox(di.district, di.delta);
    const ok = this.islandFits(di.district, di.delta);
    const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].flatMap(([a, b]) => [isoX(a, b), isoY(a, b)]);
    this.arrangeGhost.clear().poly(pts).fill({ color: ok ? 0x5ab0ff : 0xef4b4b, alpha: 0.18 }).stroke({ width: 2, color: ok ? 0x5ab0ff : 0xef4b4b, alpha: 0.9 });
  }

  private endIslandDrag(): void {
    const di = this.dragIsland!;
    this.dragIsland = null;
    this.arrangeGhost.clear();
    if ((di.delta[0] || di.delta[1]) && this.islandFits(di.district, di.delta)) {
      const o = this.offsetOf(di.district);
      this.cb.onIslandMoved?.(di.district, { dx: o.dx + di.delta[0], dy: o.dy + di.delta[1] });
    }
    setTimeout(() => { this.dragMoved = false; }, 0);
  }

  // ------------------------------------------------------------------ layout editor

  private startBuildingDrag(id: string, sx: number, sy: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    const [tx, ty] = this.screenToTile(sx, sy);
    const ghost = new Graphics();
    this.effects.addChild(ghost);
    this.dragBuilding = { id, ghost, tile: [n.rect.x, n.rect.y], offset: [tx - n.rect.x, ty - n.rect.y] };
    this.moveBuildingDrag(sx, sy);
  }

  private moveBuildingDrag(sx: number, sy: number): void {
    const d = this.dragBuilding!;
    const n = this.nodes.get(d.id)!;
    const [tx, ty] = this.screenToTile(sx, sy);
    const x = Math.round(tx - d.offset[0]), y = Math.round(ty - d.offset[1]);
    d.tile = [x, y];
    const r = { x, y, w: n.rect.w, h: n.rect.h };
    const ok = this.canPlace(d.id, r);
    const pts = [[x, y], [x + r.w, y], [x + r.w, y + r.h], [x, y + r.h]].flatMap(([a, b]) => [isoX(a, b), isoY(a, b)]);
    d.ghost.clear().poly(pts).fill({ color: ok ? 0x3fd17a : 0xef4b4b, alpha: 0.35 }).stroke({ width: 1, color: ok ? 0x3fd17a : 0xef4b4b });
  }

  private canPlace(id: string, r: Rect): boolean {
    if (!this.terrain) return false;
    for (const n of this.nodes.values()) {
      if (n.id === id) continue;
      const o = n.rect;
      if (r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h) return false;
    }
    for (let i = 0; i < r.w; i++) for (let j = 0; j < r.h; j++) if (this.terrain.roads.has(`${r.x + i},${r.y + j}`)) return false;
    return true;
  }

  private endBuildingDrag(): void {
    const d = this.dragBuilding!;
    this.dragBuilding = null;
    d.ghost.destroy();
    const n = this.nodes.get(d.id);
    if (!n) return;
    const [x, y] = d.tile;
    if ((x !== n.rect.x || y !== n.rect.y) && this.canPlace(d.id, { x, y, w: n.rect.w, h: n.rect.h })) {
      // The shared layout is stored without this user's personal island offset.
      const o = this.offsetOf(districtOf(n.entity));
      this.cb.onMove(d.id, x - o.dx, y - o.dy);
    }
    this.dragMoved = true;
    setTimeout(() => { this.dragMoved = false; }, 0);
  }
}
