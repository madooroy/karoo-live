// Test double for firebase-database.js. Data lives in window.__MOCK_DB = { "<host>": { live: { <id>: {...} } } }.
// Tests change data with window.__mockSet(host, path, value); a host listed in window.__MOCK_DENY fails with
// permission-denied. Every write attempt throws, so the test fails if the viewer ever writes.
const M = (window.__mockFirebase ||= { apps: [], listeners: [] });
const hostOf = (db) => new URL(db.app.options.databaseURL).host;
function readPath(host, path) {
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
    cb({ val: () => readPath(host, r.path) });
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
    .forEach((L) => L.cb({ val: () => readPath(host, L.path) }));
};
const nope = () => { M.writes = (M.writes || 0) + 1; throw new Error("The viewer must not write"); };
export const set = nope, remove = nope;

// Viewer messages: a small model of firebase/database.rules.json for msgs/ and msgRate/.
// A host listed in window.__MOCK_MSG_NORULES behaves like a database still on the old rules.
const denied = () => Object.assign(new Error("PERMISSION_DENIED: Permission denied"), { code: "PERMISSION_DENIED" });
let pushN = 0;
export function push(r) { return { key: "-msg" + (++pushN) }; }
export function serverTimestamp() { return { ".sv": "timestamp" }; }
export async function get(r) {
  const host = hostOf(r.db);
  if (r.path === ".info/serverTimeOffset") return { val: () => 0 };
  if ((window.__MOCK_MSG_NORULES || []).includes(host)) throw denied();
  return { val: () => readPath(host, r.path) };
}
export async function update(r, values) {
  const host = hostOf(r.db);
  const paths = Object.keys(values);
  if (paths.some((p) => !/^msg(s|Rate)\//.test(p))) return nope();
  if ((window.__MOCK_MSG_NORULES || []).includes(host)) throw denied();
  const msgPath = paths.find((p) => p.startsWith("msgs/"));
  const [, share] = msgPath.split("/");
  const live = readPath(host, `live/${share}`) || {};
  const now = Date.now();
  const all = readPath(host, `msgRate/${share}/all`), mine = readPath(host, `msgRate/${share}/${values[msgPath].uid}`);
  const m = values[msgPath];
  if (live.state !== "recording" || !(live.msg && live.msg.on) || (all && now - all.t < 6000) || (mine && now - mine.t < 20000)
      || !m.from || m.from.length > 30 || !m.text || m.text.length > 100) throw denied();
  const fill = (v) => JSON.parse(JSON.stringify(v), (k, x) => (x && x[".sv"] === "timestamp" ? now : x));
  paths.forEach((p) => window.__mockSet(host, p, fill(values[p])));
  (M.sent ||= []).push(fill(m));
}
