// Non-trivial analysis helpers: robust stats + k-means (deterministic).

export function computeStats(entries) {
  const times = entries.map(e => e.startTime).filter(Number.isFinite);
  const ends = entries.map(e => e.startTime + e.duration).filter(Number.isFinite);
  const durs = entries.map(e => e.duration).filter(Number.isFinite);

  const minTime = times.length ? Math.min(...times) : 0;
  const maxTime = ends.length ? Math.max(...ends) : 0;

  const p50Duration = percentile(durs, 0.50);
  const p95Duration = percentile(durs, 0.95);

  return { minTime, maxTime, p50Duration, p95Duration };
}

export function robustZOutliers(entries, { topN = 10 } = {}) {
  const d = entries.map(e => e.duration).filter(Number.isFinite).sort((a,b)=>a-b);
  if (d.length < 8) return [];

  const med = percentileSorted(d, 0.5);
  const mad = median(d.map(x => Math.abs(x - med)).sort((a,b)=>a-b)) || 1e-9;
  // 0.6745 makes MAD comparable to stdev under normality.
  const scale = 0.6745 / mad;

  const scored = entries
    .filter(e => Number.isFinite(e.duration))
    .map(e => ({ entry: e, z: (e.duration - med) * scale }))
    .filter(o => o.z > 2.5)
    .sort((a,b)=>b.z-a.z)
    .slice(0, topN);

  return scored;
}

export function normalizeRows(rows) {
  // Standardize columns to zero mean, unit stdev.
  const n = rows.length;
  const d = rows[0].length;
  const mu = Array(d).fill(0);
  const s2 = Array(d).fill(0);
  for (const r of rows) for (let j=0;j<d;j++) mu[j] += r[j];
  for (let j=0;j<d;j++) mu[j] /= n;
  for (const r of rows) for (let j=0;j<d;j++) s2[j] += (r[j]-mu[j])**2;
  const sd = s2.map(v => Math.sqrt(v / Math.max(1, n-1)) || 1);
  return rows.map(r => r.map((x,j) => (x - mu[j]) / sd[j]));
}

export function kmeans(X, k, { seed = 1, iters = 25 } = {}) {
  const n = X.length;
  const d = X[0].length;
  const rand = mulberry32(seed);

  // k-means++ init
  const centers = [];
  centers.push(X[Math.floor(rand()*n)].slice());
  const dist = new Array(n).fill(0);
  while (centers.length < k) {
    let sum = 0;
    for (let i=0;i<n;i++) {
      dist[i] = Math.min(...centers.map(c => sqDist(X[i], c)));
      sum += dist[i];
    }
    let r = rand() * sum;
    let idx = 0;
    for (let i=0;i<n;i++) { r -= dist[i]; if (r <= 0) { idx = i; break; } }
    centers.push(X[idx].slice());
  }

  const assign = new Array(n).fill(0);

  for (let t=0;t<iters;t++) {
    let changed = 0;
    // assign
    for (let i=0;i<n;i++) {
      let best = 0;
      let bestD = Infinity;
      for (let j=0;j<k;j++) {
        const dd = sqDist(X[i], centers[j]);
        if (dd < bestD) { bestD = dd; best = j; }
      }
      if (assign[i] !== best) { assign[i] = best; changed++; }
    }

    // recompute
    const next = Array.from({length:k}, () => Array(d).fill(0));
    const cnt = new Array(k).fill(0);
    for (let i=0;i<n;i++) {
      const a = assign[i];
      cnt[a]++;
      for (let j=0;j<d;j++) next[a][j] += X[i][j];
    }
    for (let c=0;c<k;c++) {
      if (cnt[c] === 0) {
        next[c] = X[Math.floor(rand()*n)].slice();
      } else {
        for (let j=0;j<d;j++) next[c][j] /= cnt[c];
      }
    }
    for (let c=0;c<k;c++) centers[c] = next[c];
    if (!changed) break;
  }

  return { centers, assign };
}

function sqDist(a, b) {
  let s = 0;
  for (let i=0;i<a.length;i++) { const d = a[i]-b[i]; s += d*d; }
  return s;
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

function percentile(xs, p) {
  if (!xs.length) return 0;
  const a = xs.slice().sort((x,y)=>x-y);
  return percentileSorted(a, p);
}

function percentileSorted(a, p) {
  const n = a.length;
  if (!n) return 0;
  const i = (n - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return a[lo];
  const t = i - lo;
  return a[lo] * (1 - t) + a[hi] * t;
}

function median(sorted) {
  return percentileSorted(sorted, 0.5);
}
