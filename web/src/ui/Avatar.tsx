import { useEffect, useRef } from 'react';
import type { Avatar as AvatarSpec } from '@berrie/shared';

const STYLES = ['Sprite', 'Robot', 'Slime', 'Ghost', 'Cat', 'Knight', 'Mage', 'Frog'];
export const AVATAR_STYLES = STYLES;
export const AVATAR_COLORS = ['#4aa8ff', '#3fd17a', '#f2b33d', '#ef6b6b', '#a77bf3', '#3fc5c5', '#f08ac0', '#c8c8c8'];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
}

/** 10×10 pixel character, mirrored horizontally; style picks a silhouette, seed fills in the details. */
function draw(ctx: CanvasRenderingContext2D, a: AvatarSpec) {
  const r = rng(a.seed * 7919 + a.style * 104729);
  const N = 10;
  ctx.clearRect(0, 0, N, N);
  const shade = (hex: string, f: number) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  const px = (x: number, y: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); ctx.fillRect(N - 1 - x, y, 1, 1); };
  ctx.fillStyle = '#0f1a2e';
  ctx.fillRect(0, 0, N, N);
  const body = a.color, dark = shade(a.color, 0.62), light = shade(a.color, 1.3);
  // silhouette masks (left half, 5 columns × 10 rows): 1 = body
  const masks: string[][] = [
    ['00000', '00111', '01111', '11111', '11111', '11111', '01111', '00111', '00110', '00000'],
    ['00110', '00010', '01111', '11111', '11111', '11111', '11111', '01111', '01001', '01101'],
    ['00000', '00000', '00011', '00111', '01111', '11111', '11111', '11111', '11111', '00000'],
    ['00000', '00111', '01111', '11111', '11111', '11111', '11111', '11111', '10101', '00000'],
    ['10000', '11000', '11111', '11111', '11111', '01111', '00111', '01111', '01111', '00000'],
    ['00011', '00111', '01111', '01111', '01111', '00111', '01111', '11111', '11011', '00011'],
    ['00001', '00011', '00111', '01111', '11111', '01111', '00111', '01111', '11111', '00000'],
    ['00000', '01100', '11110', '11111', '11111', '11111', '01111', '11111', '10011', '00000'],
  ];
  const m = masks[a.style % masks.length];
  for (let y = 0; y < N; y++) for (let x = 0; x < 5; x++) if (m[y][x] === '1') px(x, y, y < 3 ? light : y > 7 ? dark : body);
  // random freckles/armor bits, mirrored
  for (let i = 0; i < 4; i++) {
    const x = 1 + Math.floor(r() * 4), y = 3 + Math.floor(r() * 5);
    if (m[y][x] === '1') px(x, y, r() > 0.5 ? dark : light);
  }
  // eyes
  const ey = 3 + Math.floor(r() * 2);
  px(3, ey, '#ffffff');
  px(3, ey + 1, '#16213a');
  // mouth
  if (r() > 0.3) { ctx.fillStyle = '#16213a'; ctx.fillRect(4, ey + 3, 2, 1); }
}

export function Avatar({ avatar, size = 28, title }: { avatar: AvatarSpec | null | undefined; size?: number; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const a = avatar ?? { seed: 1, color: '#7f8ba3', style: 0 };
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) draw(ctx, a);
  }, [a.seed, a.color, a.style]);
  return <canvas ref={ref} width={10} height={10} className="avatar" title={title} style={{ width: size, height: size }} />;
}
