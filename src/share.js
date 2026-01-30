// Minimal schema + forward compatibility.

export function encodeSession(session) {
  // Keep as JSON string (then compressed in app.js).
  // Future versions can change the schema but preserve "v".
  const safe = {
    v: 1,
    startedAt: session.startedAt || Date.now(),
    savedAt: session.savedAt || Date.now(),
    notes: session.notes || '',
    entries: Array.isArray(session.entries) ? session.entries : [],
  };
  return JSON.stringify(safe);
}

export function decodeSession(json) {
  const obj = JSON.parse(json);
  if (!obj || typeof obj !== 'object') throw new Error('bad session');
  if (obj.v !== 1) throw new Error('unsupported session version');
  if (!Array.isArray(obj.entries)) obj.entries = [];
  return obj;
}
