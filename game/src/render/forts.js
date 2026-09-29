// Тактические слои поверх карты:
//  • «Окопы» — все траншеи и блиндажи цветом стороны, видно даже под кронами;
//  • «Подземный» — поверхность затемнена, видны блиндажи с перекрытием и подземные ходы.

import { SIDES } from '../sim/units.js';

export const FORT_VIEWS = ['off', 'tactical', 'underground'];
export const FORT_VIEW_NAMES = { off: 'Окопы: скрыты', tactical: 'Окопы: схема', underground: 'Подземный слой' };

export function drawFortOverlay(ctx, world, view, mode, dig) {
  const { cam, canvas, dpr } = view;
  const z = cam.zoom;
  const toS = (x, y) => [(x - cam.x) * z + canvas.width / 2, (y - cam.y) * z + canvas.height / 2];
  const hw = canvas.width / 2 / z, hh = canvas.height / 2 / z;
  const items = mode === 'off' ? [] : world.forts.query({ x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh });
  const path = (line) => {
    ctx.beginPath();
    line.forEach(([x, y], i) => {
      const [sx, sy] = toS(x, y);
      i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
    });
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (mode === 'underground') {
    ctx.fillStyle = 'rgba(4,10,16,0.62)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  if (mode !== 'off') {
    const lw = Math.max(1.5 * dpr, Math.min(4 * dpr, z * 1.2));
    for (const f of items) {
      if (f.kind !== 'trench') continue;
      const col = SIDES[f.side].fill;
      path(f.line);
      ctx.lineWidth = lw + 2 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.stroke();
      ctx.lineWidth = lw;
      ctx.strokeStyle = mode === 'underground' ? 'rgba(200,200,190,0.55)' : col;
      if (f.covered) ctx.setLineDash([3 * dpr, 2 * dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const f of items) {
      if (f.kind === 'tunnel' && mode === 'underground') {
        path(f.line);
        ctx.lineWidth = Math.max(3 * dpr, z * f.width * 1.5);
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.stroke();
        ctx.lineWidth = Math.max(2 * dpr, z * f.width);
        ctx.strokeStyle = '#5fe3ff';
        ctx.setLineDash([5 * dpr, 3 * dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (f.kind === 'dugout') {
        const [sx, sy] = toS(f.x, f.y);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(f.angle);
        const w = Math.max(8 * dpr, f.w * z), h = Math.max(8 * dpr, f.h * z);
        ctx.fillStyle = mode === 'underground' ? 'rgba(95,227,255,0.25)' : SIDES[f.side].fill;
        ctx.strokeStyle = mode === 'underground' ? '#5fe3ff' : '#000';
        ctx.lineWidth = 1.5 * dpr;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        // Накаты — поперечные линии
        ctx.beginPath();
        for (let k = 1; k <= f.layers; k++) {
          const y = -h / 2 + (k * h) / (f.layers + 1);
          ctx.moveTo(-w / 2, y); ctx.lineTo(w / 2, y);
        }
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
        ctx.restore();
        if (mode === 'underground' && z > 1.2 * dpr) {
          ctx.font = `600 ${10.5 * dpr}px "PT Sans", system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const txt = `блиндаж · ${f.layers} наката · −${f.depth.toFixed(1)} м · до ${f.resist} мм`;
          ctx.lineWidth = 3 * dpr;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.strokeText(txt, sx, sy + h / 2 + 4 * dpr);
          ctx.fillStyle = '#bff3ff';
          ctx.fillText(txt, sx, sy + h / 2 + 4 * dpr);
        }
      }
      if (f.kind === 'capon' && mode === 'tactical') {
        const [sx, sy] = toS(f.x, f.y);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(f.angle);
        const s = Math.max(6 * dpr, 5 * z);
        ctx.strokeStyle = SIDES[f.side].fill;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(-s, -s); ctx.lineTo(s, -s); ctx.lineTo(s, s); ctx.lineTo(-s, s);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Предпросмотр копаемой траншеи
  if (dig && dig.points.length) {
    const pts = dig.cursor ? [...dig.points, dig.cursor] : dig.points;
    path(pts);
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.stroke();
    ctx.lineWidth = 1.6 * dpr;
    ctx.strokeStyle = '#ffd36b';
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of dig.points) {
      const [sx, sy] = toS(x, y);
      ctx.fillStyle = '#ffd36b';
      ctx.fillRect(sx - 3 * dpr, sy - 3 * dpr, 6 * dpr, 6 * dpr);
    }
  }
}
