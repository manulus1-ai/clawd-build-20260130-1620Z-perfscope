// PerformanceObserver recorder with ID-stable entries.

let _nextId = 1;
const nextId = () => `e${_nextId++}`;

function cloneEntry(entry) {
  // We intentionally snapshot only commonly-available fields.
  const base = {
    id: nextId(),
    entryType: entry.entryType,
    name: entry.name,
    startTime: entry.startTime,
    duration: entry.duration,
  };

  if (entry.entryType === 'resource') {
    const e = entry;
    return {
      ...base,
      initiatorType: e.initiatorType,
      nextHopProtocol: e.nextHopProtocol,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      decodedBodySize: e.decodedBodySize,
      renderBlockingStatus: e.renderBlockingStatus,
      // Timing breakdown
      redirectStart: e.redirectStart,
      redirectEnd: e.redirectEnd,
      domainLookupStart: e.domainLookupStart,
      domainLookupEnd: e.domainLookupEnd,
      connectStart: e.connectStart,
      secureConnectionStart: e.secureConnectionStart,
      connectEnd: e.connectEnd,
      requestStart: e.requestStart,
      responseStart: e.responseStart,
      responseEnd: e.responseEnd,
      workerStart: e.workerStart,
      fetchStart: e.fetchStart,
    };
  }

  if (entry.entryType === 'navigation') {
    const e = entry;
    return {
      ...base,
      type: e.type,
      domContentLoadedEventEnd: e.domContentLoadedEventEnd,
      loadEventEnd: e.loadEventEnd,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      decodedBodySize: e.decodedBodySize,
      nextHopProtocol: e.nextHopProtocol,
      // Key milestones
      responseStart: e.responseStart,
      responseEnd: e.responseEnd,
      domInteractive: e.domInteractive,
    };
  }

  if (entry.entryType === 'paint') {
    // name: first-paint / first-contentful-paint
    return base;
  }

  if (entry.entryType === 'longtask') {
    // Attribution is often restricted; store what we can.
    const e = entry;
    return {
      ...base,
      // "name" indicates cross-origin relations; can be used for diagnostics.
      culprit: e.name,
    };
  }

  // mark/measure etc.
  return base;
}

export function createRecorder() {
  let obs = null;
  let cfg = null;

  function snapshot() {
    // Pull from the performance entry buffer as a one-shot.
    const types = cfg?.entryTypes || ['navigation', 'resource', 'paint', 'longtask'];
    for (const t of types) {
      try {
        performance.getEntriesByType(t).forEach((e) => cfg?.onEntry?.(cloneEntry(e)));
      } catch {
        // ignore unsupported entry types
      }
    }
  }

  async function start({ entryTypes, onEntry }) {
    cfg = { entryTypes, onEntry };

    if (!('PerformanceObserver' in window)) throw new Error('PerformanceObserver not available');

    // Kickstart with buffered entries when possible.
    try { snapshot(); } catch {}

    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) onEntry(cloneEntry(e));
    });

    // Observe each type separately to tolerate partial support.
    for (const t of entryTypes) {
      try {
        obs.observe({ type: t, buffered: true });
      } catch (e) {
        // Some browsers only support entryTypes array.
        try { obs.observe({ entryTypes: [t] }); } catch {}
      }
    }

    // Increase resource buffer for busy pages.
    try {
      performance.setResourceTimingBufferSize(1000);
    } catch {}
  }

  function stop() {
    try { obs?.disconnect(); } catch {}
    obs = null;
  }

  return { start, stop, snapshot };
}
