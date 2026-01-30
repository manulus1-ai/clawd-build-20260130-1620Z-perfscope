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
};

function setStatus(text, live) {
  ui.statusText.textContent = text;
  ui.liveDot.classList.toggle('live', !!live);
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

  ui.diag.innerHTML = `
    <div class="kvs">
      <div>supported</div><div class="mono">${escapeHtml(supp.join(', ')) || '—'}</div>
      <div>longtask</div><div class="mono">${longtaskSupported ? 'supported' : 'not supported'}</div>
      <div>entries</div><div class="mono">${entries.length}</div>
      <div>p50 duration</div><div class="mono">${fmtMs(s.p50Duration || 0)}</div>
      <div>p95 duration</div><div class="mono">${fmtMs(s.p95Duration || 0)}</div>
      <div>time span</div><div class="mono">${fmtMs(s.maxTime - s.minTime)}</div>
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
    onHover: (id) => {
      ui.overlay.textContent = '';
      ui.overlay.style.pointerEvents = 'none';
      ui.wf.style.cursor = id ? 'pointer' : 'default';
    }
  });

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

const recorder = createRecorder();
installHandlers(recorder);

await loadFromPermalinkOrStorage();

// Keep UI consistent if hash changes (paste shared link)
window.addEventListener('hashchange', loadFromPermalinkOrStorage);
