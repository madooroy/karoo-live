// Test double for firebase-database.js. Data lives in window.__MOCK_DB = { "<host>": { live: { <id>: {...} } } }.
// Tests change data with window.__mockSet(host, path, value); a host listed in window.__MOCK_DENY fails with
// permission-denied. Every write attempt throws, so the test fails if the viewer ever writes.
const M = (window.__mockFirebase ||= { apps: [], listeners: [] });
const hostOf = (db) => new URL(db.app.options.databaseURL).host;
function get(host, path) {
  let v = (window.__MOCK_DB || {})[host];
  for (const k of path.split("/").filter(Boolean)) v = v == null ? undefined : v[k];
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}
export function getDatabase(app) { return { app }; }
export function ref(db, path) { return { db, path }; }
export function onValue(r, cb, errCb) {
  const host = hostOf(r.db);
  const L = { host, path: r.path, cb, errCb };
  M.listeners.push(L);
  setTimeout(() => {
    if (r.path === ".info/connected") return cb({ val: () => true });
    if ((window.__MOCK_DENY || []).includes(host)) return errCb && errCb({ code: "PERMISSION_DENIED", message: "permission_denied" });
    cb({ val: () => get(host, r.path) });
  }, 20 + Math.random() * 60);
  return () => { M.listeners.splice(M.listeners.indexOf(L), 1); };
}
window.__mockSet = (host, path, value) => {
  const db = (window.__MOCK_DB ||= {});
  let o = (db[host] ||= {});
  const keys = path.split("/").filter(Boolean);
  keys.slice(0, -1).forEach((k) => { o = (o[k] ||= {}); });
  o[keys[keys.length - 1]] = value;
  M.listeners.filter((L) => L.host === host && L.path !== ".info/connected" && (path + "/").startsWith(L.path + "/"))
    .forEach((L) => L.cb({ val: () => get(host, L.path) }));
};
const nope = () => { M.writes = (M.writes || 0) + 1; throw new Error("The viewer must not write"); };
export const set = nope, update = nope, push = nope, remove = nope;
