import { scaleLinear } from 'https://cdn.jsdelivr.net/npm/d3-scale@4/+esm';
import { schemeTableau10 } from 'https://cdn.jsdelivr.net/npm/d3-scale-chromatic@3/+esm';
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'https://cdn.jsdelivr.net/npm/lz-string@1.5.0/+esm';
import * as idb from 'https://cdn.jsdelivr.net/npm/idb-keyval@6/+esm';

import { createRecorder } from './recorder.js';
import { computeStats, robustZOutliers, kmeans, normalizeRows } from './stats.js';
import { drawWaterfall, pickAt, paletteForClusters } from './waterfall.js';
import { encodeSession, decodeSession } from './share.js';

const el = (id) => document.getElementById(id);

const ui = {
  btnStart: el('btnStart'),
  btnStop: el('btnStop'),
  btnSnapshot: el('btnSnapshot'),
  btnClear: el('btnClear'),
  chips: el('chips'),
  kRange: el('kRange'),
  kLabel: el('kLabel'),
  filterText: el('filterText'),
  btnPermalink: el('btnPermalink'),
  btnExport: el('btnExport'),
  btnImport: el('btnImport'),
  fileImport: el('fileImport'),
  notes: el('notes'),
  btnNewProbe: el('btnNewProbe'),
  btnCopyProbe: el('btnCopyProbe'),
  probeSnippet: el('probeSnippet'),
  wf: el('wf'),
  overlay: el('overlay'),
  legend: el('legend'),
  outliers: el('outliers').querySelector('tbody'),
  selectedKVs: el('selectedKVs'),
  diag: el('diag'),
  liveDot: el('liveDot'),
  statusText: el('statusText'),
  entryCount: el('entryCount'),
};

const ENTRY_TYPES = [
  { key: 'navigation', label: 'navigation' },
  { key: 'resource', label: 'resource' },
  { key: 'paint', label: 'paint' },
  { key: 'longtask', label: 'longtask' },
  { key: 'mark', label: 'mark' },
  { key: 'measure', label: 'measure' },
];

let state = {
  recording: false,
  enabledTypes: new Set(['navigation', 'resource', 'paint', 'longtask']),
  k: Number(ui.kRange.value),
  filter: '',
  notes: '',
  entries: [],
  selectedId: null,
  clusters: null,
  stats: null,
  outliers: [],
  sessionId: null,
  startedAt: Date.now(),

  // Remote probe: a snippet you paste into another tab to stream entries here.
  probeToken: null,
  probeConnected: false,
  probeSource: null,
};

function setStatus(text, live) {
  ui.statusText.textContent = text;
  ui.liveDot.classList.toggle('live', !!live);
}

function randToken(){
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function buildProbeSnippet(){
  const token = state.probeToken || (state.probeToken = randToken());
  // Use window.open with a stable name so it reuses the existing PerfScope tab.
  const perfscopeUrl = location.origin + location.pathname;
  const types = ['navigation','resource','paint','longtask','mark','measure'];

  return `(() => {
  const PERF_SCOPE = ${JSON.stringify(perfscopeUrl)};
  const TOKEN = ${JSON.stringify(token)};
  const ENTRY_TYPES = ${JSON.stringify(types)};

  const win = window.open(PERF_SCOPE, 'perfscope');
  if (!win) {
    console.warn('[PerfScope probe] Popup blocked. Open PerfScope first, then re-run this snippet.');
    return;
  }

  const send = (kind, payload={}) => {
    win.postMessage({ __perfscope: true, token: TOKEN, kind, payload }, '*');
  };

  const pick = (obj, keys) => {
    const out = {};
    for (const k of keys) {
      if (obj[k] != null) out[k] = obj[k];
    }
    return out;
  };

  const serialize = (e) => {
    const base = {
      name: e.name,
      entryType: e.entryType,
      startTime: e.startTime,
      duration: e.duration,
    };
    // ResourceTiming / NavigationTiming extras (when present)
    Object.assign(base, pick(e, [
      'initiatorType','nextHopProtocol','transferSize','encodedBodySize','decodedBodySize','renderBlockingStatus',
      'domainLookupStart','domainLookupEnd','connectStart','secureConnectionStart','connectEnd',
      'requestStart','responseStart','responseEnd'
    ]));
    return base;
  };

  const buf = [];
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (!buf.length) return;
    const batch = buf.splice(0, buf.length);
    send('entries', { timeOrigin: performance.timeOrigin, entries: batch });
  };
  const enqueue = (list) => {
    for (const e of list) buf.push(serialize(e));
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  };

  send('hello', { href: location.href, ua: navigator.userAgent, timeOrigin: performance.timeOrigin });

  // Seed with existing buffered entries when available.
  try {
    for (const t of ENTRY_TYPES) {
      const existing = performance.getEntriesByType?.(t);
      if (existing && existing.length) enqueue(existing);
    }
  } catch {}

  const observers = [];
  for (const t of ENTRY_TYPES) {
    try {
      const po = new PerformanceObserver((list) => enqueue(list.getEntries()));
      po.observe({ type: t, buffered: true });
      observers.push(po);
    } catch {}
  }

  console.log('[PerfScope probe] Streaming started. Keep this tab open; stop by reloading the page or closing this tab.');
})();`;
}

function refreshProbeUI(){
  ui.probeSnippet.value = buildProbeSnippet();
}

function renderChips() {
  ui.chips.innerHTML = '';
  for (const t of ENTRY_TYPES) {
    const b = document.createElement('button');
    b.className = 'chip ' + (state.enabledTypes.has(t.key) ? 'on' : '');
    b.textContent = t.label;
    b.addEventListener('click', () => {
      if (state.enabledTypes.has(t.key)) state.enabledTypes.delete(t.key);
      else state.enabledTypes.add(t.key);
      renderChips();
      recompute();
    });
    ui.chips.appendChild(b);
  }
}

function filteredEntries() {
  const q = state.filter.trim().toLowerCase();
  return state.entries.filter(e => {
    if (!state.enabledTypes.has(e.entryType)) return false;
    if (!q) return true;
    return (e.name || '').toLowerCase().includes(q);
  });
}

function recompute() {
  const entries = filteredEntries();

  state.stats = computeStats(entries);

  // Vectorize entries for k-means on [startTime, duration, transferSize/encodedBodySize]
  const rows = entries
    .filter(e => e.entryType === 'resource' || e.entryType === 'navigation')
    .map(e => ({
      id: e.id,
      x: e.startTime,
      y: e.duration,
      z: (e.transferSize ?? e.encodedBodySize ?? 0),
      type: e.entryType,
    }));

  let clusters = null;
  if (rows.length >= state.k) {
    const X = normalizeRows(rows.map(r => [r.x, r.y, Math.log10(1 + r.z)]));
    const km = kmeans(X, state.k, { seed: 1337, iters: 30 });
    clusters = new Map();
    rows.forEach((r, i) => clusters.set(r.id, km.assign[i]));
  }
  state.clusters = clusters;

  const out = robustZOutliers(entries, { topN: 12 });
  state.outliers = out;

  render(entries);
  persistDebounced();
}

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms/1000).toFixed(2)}s`;
}

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n|0} B`;
  const kb = n/1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb/1024).toFixed(2)} MB`;
}

function renderSelected(entries) {
  const e = entries.find(x => x.id === state.selectedId);
  ui.selectedKVs.innerHTML = '';
  const add = (k, v) => {
    const dk = document.createElement('div'); dk.textContent = k;
    const dv = document.createElement('div');
    dv.innerHTML = `<code>${String(v)}</code>`;
    ui.selectedKVs.append(dk, dv);
  };
  if (!e) {
    add('hint', 'click a bar in the waterfall');
    return;
  }
  add('entryType', e.entryType);
  add('name', e.name || '');
  add('startTime', fmtMs(e.startTime));
  add('duration', fmtMs(e.duration));
  if (e.initiatorType) add('initiatorType', e.initiatorType);
  if (e.nextHopProtocol) add('nextHopProtocol', e.nextHopProtocol);
  if (e.transferSize != null) add('transferSize', fmtBytes(e.transferSize));
  if (e.encodedBodySize != null) add('encodedBodySize', fmtBytes(e.encodedBodySize));
  if (e.decodedBodySize != null) add('decodedBodySize', fmtBytes(e.decodedBodySize));
  if (e.renderBlockingStatus) add('renderBlockingStatus', e.renderBlockingStatus);

  // Resource timing breakdown (when available and same-origin or TAO-enabled)
  if (e.entryType === 'resource' && Number.isFinite(e.responseStart) && Number.isFinite(e.startTime)) {
    const dns = (e.domainLookupEnd || 0) - (e.domainLookupStart || 0);
    const tcp = (e.connectEnd || 0) - (e.connectStart || 0);
    const tls = e.secureConnectionStart ? (e.connectEnd - e.secureConnectionStart) : 0;
    const ttfb = (e.responseStart || 0) - (e.requestStart || 0);
    const dl = (e.responseEnd || 0) - (e.responseStart || 0);
    if (dns > 0) add('dns', fmtMs(dns));
    if (tcp > 0) add('tcp', fmtMs(tcp));
    if (tls > 0) add('tls', fmtMs(tls));
    if (ttfb > 0) add('ttfb', fmtMs(ttfb));
    if (dl > 0) add('download', fmtMs(dl));
  }
  if (state.clusters && state.clusters.has(e.id)) add('cluster', state.clusters.get(e.id));
}

function renderOutliers() {
  ui.outliers.innerHTML = '';
  for (const o of state.outliers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${o.z.toFixed(2)}</td>
      <td><span class="pill">${o.entry.entryType}</span></td>
      <td class="mono">${fmtMs(o.entry.duration)}</td>
      <td class="mono" title="${o.entry.name}">${escapeHtml(shorten(o.entry.name, 68))}</td>
    `;
    tr.addEventListener('click', () => {
      state.selectedId = o.entry.id;
      render(filteredEntries());
    });
    ui.outliers.appendChild(tr);
  }
}

function renderDiagnostics(entries) {
  const s = state.stats;
  const supp = PerformanceObserver?.supportedEntryTypes || [];
  const longtaskSupported = supp.includes('longtask');

  const counts = new Map();
  for (const e of entries) counts.set(e.entryType, (counts.get(e.entryType) || 0) + 1);
  const countStr = [...counts.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  ');

  ui.diag.innerHTML = `
    <div class="kvs">
      <div>supported</div><div class="mono">${escapeHtml(supp.join(', ')) || '—'}</div>
      <div>longtask</div><div class="mono">${longtaskSupported ? 'supported' : 'not supported'}</div>
      <div>entries</div><div class="mono">${entries.length}</div>
      <div>types</div><div class="mono">${escapeHtml(countStr || '—')}</div>
      <div>p50 duration</div><div class="mono">${fmtMs(s.p50Duration || 0)}</div>
      <div>p95 duration</div><div class="mono">${fmtMs(s.p95Duration || 0)}</div>
      <div>time span</div><div class="mono">${fmtMs(s.maxTime - s.minTime)}</div>
      <div>shortcuts</div><div class="mono">r: start/stop • s: snapshot • /: filter</div>
    </div>
    <div style="height:8px"></div>
    <div class="small">Tip: for cross-origin timing details, your resources must send <code>Timing-Allow-Origin</code>.</div>
  `;
}

function render(entries) {
  ui.entryCount.textContent = `${entries.length} entries`;

  const { colors, labels } = paletteForClusters(state.k);
  ui.legend.innerHTML = '';
  if (state.clusters) {
    labels.forEach((lbl, i) => {
      const div = document.createElement('div');
      div.innerHTML = `<span class="swatch" style="background:${colors[i]}"></span>cluster ${i}`;
      ui.legend.appendChild(div);
    });
  } else {
    const div = document.createElement('div');
    div.textContent = 'clusters: n/a (need at least k resource/navigation entries)';
    ui.legend.appendChild(div);
  }

  const pick = drawWaterfall(ui.wf, entries, {
    clusters: state.clusters,
    clusterColors: colors,
  });

  // Hover tooltip
  ui.wf.onmousemove = (ev) => {
    const id = pickAt(ui.wf, pick, ev);
    ui.wf.style.cursor = id ? 'pointer' : 'default';
    const e = id ? entries.find(x => x.id === id) : null;
    if (!e) { ui.overlay.innerHTML = ''; return; }

    const rect = ui.wf.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    ui.overlay.innerHTML = `
      <div class="tooltip" style="left:${Math.min(rect.width-20, x+12)}px; top:${Math.min(rect.height-20, y+12)}px;">
        <div class="mono">${escapeHtml(e.entryType)} <span class="t">${fmtMs(e.duration)}</span></div>
        <div class="mono" style="margin-top:4px">${escapeHtml(shorten(e.name || '', 92))}</div>
      </div>
    `;
  };
  ui.wf.onmouseleave = () => { ui.overlay.innerHTML = ''; };

  renderSelected(entries);
  renderOutliers();
  renderDiagnostics(entries);

  // Click handling based on current draw's pick function
  ui.wf.onclick = (ev) => {
    const id = pickAt(ui.wf, pick, ev);
    if (!id) return;
    state.selectedId = id;
    render(entries);
  };
}

const persistDebounced = debounce(async () => {
  const session = {
    v: 1,
    startedAt: state.startedAt,
    savedAt: Date.now(),
    notes: state.notes,
    entries: state.entries,
  };
  await idb.set('perfscope:lastSession', session);
}, 350);

async function loadFromPermalinkOrStorage() {
  if (location.hash.startsWith('#s=')) {
    try {
      const payload = location.hash.slice(3);
      const json = decompressFromEncodedURIComponent(payload);
      const session = decodeSession(json);
      state.entries = session.entries;
      state.notes = session.notes || '';
      ui.notes.value = state.notes;
      setStatus('loaded from permalink', false);
      recompute();
      return;
    } catch (e) {
      console.warn('Bad permalink', e);
    }
  }

  const last = await idb.get('perfscope:lastSession');
  if (last?.entries) {
    state.entries = last.entries;
    state.notes = last.notes || '';
    ui.notes.value = state.notes;
    setStatus('restored last session (IndexedDB)', false);
  } else {
    setStatus('idle', false);
  }
  recompute();
}

function installHandlers(recorder) {
  ui.btnStart.onclick = async () => {
    state.recording = true;
    state.startedAt = Date.now();
    setStatus('recording…', true);
    ui.btnStart.disabled = true;
    ui.btnStop.disabled = false;

    await recorder.start({
      entryTypes: [...state.enabledTypes],
      onEntry: (e) => {
        state.entries.push(e);
        if (state.entries.length % 20 === 0) recompute();
        else ui.entryCount.textContent = `${filteredEntries().length} entries`;
      }
    });

    recompute();
  };

  ui.btnStop.onclick = () => {
    state.recording = false;
    recorder.stop();
    setStatus('stopped', false);
    ui.btnStart.disabled = false;
    ui.btnStop.disabled = true;
    recompute();
  };

  ui.btnSnapshot.onclick = () => {
    recorder.snapshot();
    recompute();
  };

  ui.btnClear.onclick = async () => {
    state.entries = [];
    state.selectedId = null;
    location.hash = '';
    await idb.del('perfscope:lastSession');
    setStatus('cleared', false);
    recompute();
  };

  ui.kRange.oninput = () => {
    state.k = Number(ui.kRange.value);
    ui.kLabel.textContent = String(state.k);
    recompute();
  };

  ui.filterText.oninput = () => {
    state.filter = ui.filterText.value;
    recompute();
  };

  ui.notes.oninput = () => {
    state.notes = ui.notes.value;
    persistDebounced();
  };

  ui.btnExport.onclick = () => {
    const session = { v: 1, startedAt: state.startedAt, savedAt: Date.now(), notes: state.notes, entries: state.entries };
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `perfscope-session-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  ui.btnImport.onclick = () => ui.fileImport.click();
  ui.fileImport.onchange = async () => {
    const f = ui.fileImport.files?.[0];
    if (!f) return;
    const text = await f.text();
    const session = JSON.parse(text);
    state.entries = session.entries || [];
    state.notes = session.notes || '';
    ui.notes.value = state.notes;
    setStatus('imported', false);
    recompute();
  };

  ui.btnPermalink.onclick = async () => {
    const session = { v: 1, startedAt: state.startedAt, savedAt: Date.now(), notes: state.notes, entries: state.entries };
    const json = encodeSession(session);
    const hash = '#s=' + compressToEncodedURIComponent(json);
    const url = location.origin + location.pathname + hash;
    await navigator.clipboard.writeText(url);
    setStatus('permalink copied', false);
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function shorten(s, n) {
  s = s || '';
  if (s.length <= n) return s;
  return s.slice(0, n-1) + '…';
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Boot
renderChips();
ui.kLabel.textContent = String(state.k);

// Remote probe UI
state.probeToken = randToken();
refreshProbeUI();
ui.btnNewProbe?.addEventListener('click', () => {
  state.probeToken = randToken();
  state.probeConnected = false;
  state.probeSource = null;
  refreshProbeUI();
  setStatus('new probe token created', false);
});
ui.btnCopyProbe?.addEventListener('click', async () => {
  try{
    await navigator.clipboard.writeText(ui.probeSnippet.value);
    setStatus('probe snippet copied', false);
  } catch {
    // fallback: select text
    ui.probeSnippet.focus();
    ui.probeSnippet.select();
    setStatus('select/copy the snippet manually', false);
  }
});

// Receive entries from a remote probe via postMessage.
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.__perfscope !== true) return;
  if (d.token !== state.probeToken) return;

  state.probeConnected = true;
  state.probeSource = d.payload?.href || ev.origin || 'remote';

  if (d.kind === 'hello'){
    setStatus('remote probe connected', true);
    return;
  }

  if (d.kind === 'entries'){
    const incoming = Array.isArray(d.payload?.entries) ? d.payload.entries : [];
    // Assign ids locally and tag as remote.
    for (const e of incoming){
      state.entries.push({
        id: crypto.randomUUID?.() || ('r_' + Math.random().toString(16).slice(2)),
        ...e,
        _remote: true,
      });
    }
    ui.entryCount.textContent = `${filteredEntries().length} entries`;
    // recompute occasionally to keep UI responsive
    if (state.entries.length % 40 === 0) recompute();
    persistDebounced();
  }
});

const recorder = createRecorder();
installHandlers(recorder);

await loadFromPermalinkOrStorage();

// Keep UI consistent if hash changes (paste shared link)
window.addEventListener('hashchange', loadFromPermalinkOrStorage);

// Re-render on resize (canvas is resolution dependent)
window.addEventListener('resize', debounce(() => render(filteredEntries()), 150));

// Keyboard shortcuts
window.addEventListener('keydown', (ev) => {
  if (ev.target && ['INPUT','TEXTAREA','SELECT'].includes(ev.target.tagName)) {
    // allow / to focus filter even when not already typing
    if (ev.key !== '/') return;
  }
  if (ev.key === 'r' || ev.key === 'R') {
    ev.preventDefault();
    if (state.recording) ui.btnStop.click();
    else ui.btnStart.click();
  }
  if (ev.key === 's' || ev.key === 'S') {
    ev.preventDefault();
    ui.btnSnapshot.click();
  }
  if (ev.key === '/') {
    ev.preventDefault();
    ui.filterText.focus();
  }
});
