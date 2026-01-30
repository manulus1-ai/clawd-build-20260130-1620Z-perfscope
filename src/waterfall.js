import { scaleLinear } from 'https://cdn.jsdelivr.net/npm/d3-scale@4/+esm';
import { schemeTableau10 } from 'https://cdn.jsdelivr.net/npm/d3-scale-chromatic@3/+esm';

export function paletteForClusters(k) {
  const base = schemeTableau10;
  const colors = Array.from({ length: k }, (_, i) => base[i % base.length]);
  const labels = Array.from({ length: k }, (_, i) => `cluster ${i}`);
  return { colors, labels };
}

// Draw a waterfall of entries on canvas.
// Returns a "pick" object used for click picking.
export function drawWaterfall(canvas, entries, { clusters, clusterColors } = {}) {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const W = Math.floor(rect.width * dpr);
  const H = Math.floor(rect.height * dpr);
  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');

  const pad = 12 * dpr;
  const rowH = 14 * dpr;
  const gap = 2 * dpr;
  const axisH = 18 * dpr;

  const sorted = entries
    .slice()
    .sort((a, b) => a.startTime - b.startTime);

  const minT = sorted.length ? Math.min(...sorted.map(e => e.startTime)) : 0;
  const maxT = sorted.length ? Math.max(...sorted.map(e => e.startTime + e.duration)) : 1;

  const x = scaleLinear().domain([minT, maxT]).range([pad, W - pad]);

  // Reserve space for axis + as many rows as fit.
  const maxRows = Math.max(1, Math.floor((H - pad - axisH) / (rowH + gap)));

  // Heuristic ordering: group by type, then by start time.
  const orderKey = (e) => {
    const pri = ({ navigation: 0, paint: 1, longtask: 2, resource: 3, mark: 4, measure: 5 })[e.entryType] ?? 9;
    return pri * 1e9 + e.startTime;
  };

  const rows = sorted
    .slice()
    .sort((a, b) => orderKey(a) - orderKey(b))
    .slice(0, maxRows);

  // Background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, W, H);

  // Vertical gridlines
  const ticks = 8;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= ticks; i++) {
    const t = minT + (i / ticks) * (maxT - minT);
    const xx = x(t);
    ctx.beginPath();
    ctx.moveTo(xx, pad);
    ctx.lineTo(xx, H - pad - axisH);
    ctx.stroke();
  }

  // Bars
  const pickRects = [];
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    const y = pad + i * (rowH + gap);
    const x0 = x(e.startTime);
    const x1 = x(e.startTime + Math.max(0.5, e.duration));
    const w = Math.max(1, x1 - x0);

    let color = 'rgba(124,212,255,0.42)';
    if (clusters && clusters.has(e.id)) {
      const c = clusters.get(e.id);
      color = clusterColors?.[c] || color;
    } else {
      // per-type fallback
      const typeColor = {
        navigation: 'rgba(125,255,178,0.40)',
        paint: 'rgba(124,212,255,0.50)',
        longtask: 'rgba(255,204,102,0.55)',
        resource: 'rgba(180,160,255,0.35)',
        mark: 'rgba(255,255,255,0.20)',
        measure: 'rgba(255,255,255,0.25)',
      }[e.entryType];
      if (typeColor) color = typeColor;
    }

    ctx.fillStyle = color;
    roundRect(ctx, x0, y, w, rowH, 4 * dpr);
    ctx.fill();

    // Labels (mono-ish)
    ctx.fillStyle = 'rgba(233,238,255,0.85)';
    ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
    const label = `${e.entryType}: ${shorten(nameTail(e.name), 44)}`;
    ctx.fillText(label, Math.min(x0 + 4 * dpr, W - pad - 120 * dpr), y + rowH - 3 * dpr);

    pickRects.push({ id: e.id, x: x0, y, w, h: rowH });
  }

  // Axis
  const axisY = H - pad - axisH + 10 * dpr;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
  for (let i = 0; i <= ticks; i++) {
    const t = minT + (i / ticks) * (maxT - minT);
    const xx = x(t);
    ctx.fillText(fmtMs(t - minT), xx - 18 * dpr, axisY);
  }

  return { dpr, pickRects };
}

export function pickAt(canvas, pick, ev) {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * pick.dpr;
  const y = (ev.clientY - rect.top) * pick.dpr;
  const hit = pick.pickRects.find(r => x >= r.x && x <= (r.x + r.w) && y >= r.y && y <= (r.y + r.h));
  return hit?.id || null;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h/2, w/2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms/1000).toFixed(2)}s`;
}

function nameTail(url) {
  if (!url) return '';
  try {
    const u = new URL(url, location.href);
    return u.pathname.split('/').slice(-2).join('/') || u.host;
  } catch {
    return url;
  }
}

function shorten(s, n) {
  s = s || '';
  if (s.length <= n) return s;
  return s.slice(0, n-1) + '…';
}
