# PerfScope

PerfScope is a **client-side performance lab**: it records `PerformanceObserver` streams (resource/navigation/paint/longtask/mark/measure), renders a **waterfall timeline**, and runs **local analytics**:

- **Robust outlier detection** (median + MAD → robust z-score) on entry duration
- **k-means clustering** (k-means++ init, deterministic seed) over `[startTime, duration, log(transferSize)]` for *resource/navigation* entries
- **Complex state** persisted to IndexedDB + shareable **permalinks** (compressed URL hash)

This is meant for broad dev/tech audiences who want to understand *what the browser saw*, not just run a synthetic audit.

## External libraries (CDN)
- `d3-scale@4` + `d3-scale-chromatic@3` (scales + color palettes) via jsDelivr ESM
- `lz-string@1.5.0` (permalink compression)
- `idb-keyval@6` (IndexedDB persistence)

## How to use
1. Open the site.
2. Click **Start recording**.
3. Interact with the page (or open other tabs / do a navigation). Click **Snapshot** to pull buffered entries.
4. Click a bar in the waterfall to inspect details.
5. Click **Copy permalink** to share the captured session.
6. Use **Export JSON** / **Import JSON** for offline transfer.

## Notes
- Cross-origin Resource Timing fields may be zeroed unless the response includes `Timing-Allow-Origin`.
- `longtask` entries are supported mainly in Chromium.

## Implementation checklist (high-level)
1. Define UX scope: record, visualize, cluster, outliers, share.
2. Research: PerformanceObserver types, ResourceTiming, Long Tasks, TAO header.
3. Implement `PerformanceObserver` recorder with buffered support.
4. Normalize entry snapshots into a stable JSON schema.
5. Add canvas-based waterfall renderer with ticks + labels.
6. Add click-picking + hover tooltip to inspect entries.
7. Implement robust statistics (median + MAD) and outlier table.
8. Implement deterministic k-means++ clustering.
9. Colorize bars by cluster; fallback colors by entryType.
10. Add filters: entry types + URL substring.
11. Persist last session to IndexedDB.
12. Add permalink encoding/decoding via `lz-string`.
13. Add export/import JSON for portability.
14. Add resource timing breakdown (dns/tcp/tls/ttfb/download).
15. Add keyboard shortcuts and resize-aware rendering.
16. Add GitHub Pages workflow.

## License
MIT
