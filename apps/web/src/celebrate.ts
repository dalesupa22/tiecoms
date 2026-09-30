/**
 * Efectos de la tanda 1.7: confeti al completar una tarea y carita triste al vencerse (≈1,2 s). Sin librerías:
 * un canvas fijo encima de todo que se borra solo. Con «reducir movimiento» no se anima nada.
 */
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const COLORS = ['#f2b233', '#e8505b', '#3aa675', '#4a7bd8', '#9b59d0', '#f07f3c'];

export function launchConfetti(origin?: { x: number; y: number }) {
  if (reduced() || typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth, H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return false; }
  ctx.scale(dpr, dpr);
  const ox = origin?.x ?? W / 2, oy = origin?.y ?? H * 0.6;
  const parts = Array.from({ length: 110 }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const v = 7 + Math.random() * 8;
    return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4, w: 6 + Math.random() * 5, h: 3 + Math.random() * 4, c: COLORS[Math.floor(Math.random() * COLORS.length)]! };
  });
  const start = performance.now();
  const DUR = 1200;
  const frame = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - DUR * 0.6) / (DUR * 0.4));
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (t < DUR) requestAnimationFrame(frame); else canvas.remove();
  };
  requestAnimationFrame(frame);
  return true;
}

/** Carita triste que sube y se desvanece sobre la tarjeta (o al centro). */
export function showSadFace(origin?: { x: number; y: number }) {
  if (reduced() || typeof document === 'undefined') return false;
  const el = document.createElement('div');
  el.className = 'fx-sad';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = '😢';
  el.style.left = `${origin?.x ?? window.innerWidth / 2}px`;
  el.style.top = `${origin?.y ?? window.innerHeight / 2}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
  return true;
}
