import { useEffect, useRef } from 'react';
import type { WorldRenderer } from '../world/WorldRenderer';
import { TW, TH } from '../world/pixel';

const W = 168, H = 104;

export function Minimap({ renderer, tick, entitiesKey }: { renderer: WorldRenderer; tick: number; entitiesKey: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const geo = useRef({ scale: 1, ox: 0, oy: 0 });

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const { terrain, nodes, view } = renderer.minimap();
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#163f5e';
    ctx.fillRect(0, 0, W, H);
    if (!terrain) return;
    const tw = terrain.canvas.width, th = terrain.canvas.height;
    const scale = Math.min(W / tw, H / th);
    const ox = (W - tw * scale) / 2, oy = (H - th * scale) / 2;
    geo.current = { scale, ox: ox - terrain.offsetX * scale, oy: oy - terrain.offsetY * scale };
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(terrain.canvas, ox, oy, tw * scale, th * scale);
    const g = geo.current;
    for (const n of nodes) {
      const cx = ((n.rect.x + n.rect.w / 2) - (n.rect.y + n.rect.h / 2)) * (TW / 2);
      const cy = ((n.rect.x + n.rect.w / 2) + (n.rect.y + n.rect.h / 2)) * (TH / 2);
      ctx.fillStyle = n.color;
      ctx.fillRect(Math.round(g.ox + cx * g.scale) - 2, Math.round(g.oy + cy * g.scale) - 2, 4, 4);
    }
    ctx.strokeStyle = '#7fd6ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(g.ox + view.x * g.scale, g.oy + view.y * g.scale, view.w * g.scale, view.h * g.scale);
  }, [renderer, tick, entitiesKey]);

  const onClick = (e: React.MouseEvent) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const g = geo.current;
    renderer.centerOnWorld((e.clientX - r.left - g.ox) / g.scale, (e.clientY - r.top - g.oy) / g.scale);
  };

  return <canvas className="minimap" ref={ref} width={W} height={H} onClick={onClick} title="Minimap — click to move the camera" />;
}
