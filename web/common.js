/* Karoo Live — helpers shared by the single-rider viewer (app.js) and the group view (group.js).
 * https://github.com/madooroy/karoo-live
 *
 * Plain script (no modules, no build step): exposes window.KarooLive.
 */
(() => {
  "use strict";

  const STALE_MS = 150 * 1000;
  const SAFE_ID = /^[A-Za-z0-9_-]{4,64}$/;

  // ---------------------------------------------------------------- utils
  /** "my-proj", a host or a full URL → "my-proj-default-rtdb.firebaseio.com" (or "" if it isn't a Firebase RTDB host). */
  function normalizeHost(input) {
    if (!input) return "";
    let s = input.trim().replace(/^https?:\/\//i, "").split("/")[0].split("?")[0].toLowerCase();
    if (!s.includes(".")) s = s.endsWith("-default-rtdb") ? s + ".firebaseio.com" : s + "-default-rtdb.firebaseio.com";
    return /^[a-z0-9.-]+$/.test(s) && (s.endsWith(".firebaseio.com") || s.endsWith(".firebasedatabase.app")) ? s : "";
  }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  function decodePolyline(str, precision = 5) {
    const out = []; let i = 0, lat = 0, lng = 0; const f = Math.pow(10, precision);
    while (i < str.length) {
      for (const which of [0, 1]) {
        let shift = 0, result = 0, b;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += d; else lng += d;
      }
      out.push([lat / f, lng / f]);
    }
    return out;
  }

  /** Great-circle distance in metres. */
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // ---------------------------------------------------------------- formatting
  function fmtNum(v, digits) {
    return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function fmtDuration(ms) {
    if (ms == null) return null;
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  }
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  /** Unit converters bound to a getter for the current unit system ("metric" | "imperial"). */
  function unitFormatters(getUnits) {
    const imp = () => getUnits() === "imperial";
    const U = {
      speed: (ms) => imp() ? [ms * 2.236936, "mph"] : [ms * 3.6, "km/h"],
      dist: (m) => imp() ? [m / 1609.344, "mi"] : [m / 1000, "km"],
      elev: (m) => imp() ? [m * 3.28084, "ft"] : [m, "m"],
      temp: (c) => imp() ? [c * 9 / 5 + 32, "°F"] : [c, "°C"],
    };
    function fmtDist(m) {
      const [v, u] = U.dist(m);
      return [fmtNum(v, Math.abs(v) < 100 ? (Math.abs(v) < 10 ? 2 : 1) : 0), u];
    }
    return { U, fmtDist };
  }

  // ---------------------------------------------------------------- data sources
  const FIREBASE = "https://www.gstatic.com/firebasejs/12.19.0/";
  let sdk = null; // Promise<{initializeApp, db}>
  const apps = new Map(); // app name → {database}
  function loadFirebase() {
    if (!sdk) {
      sdk = Promise.all([import(FIREBASE + "firebase-app.js"), import(FIREBASE + "firebase-database.js")])
        .then(([app, db]) => ({ initializeApp: app.initializeApp, db }));
      sdk.catch(() => { sdk = null; }); // allow a retry
    }
    return sdk;
  }

  /** Subscribes (read-only) to /live/<id> with the official Firebase SDK, which handles reconnects and deltas.
   *  Each database host gets its own named Firebase app, so one page can follow riders in several projects. */
  async function firebaseSource(host, id, onData, onProblem, onConnection, appName) {
    let fb;
    try { fb = await loadFirebase(); } catch (e) {
      onProblem("Couldn't load the live data library. Check your connection and reload.");
      return;
    }
    const name = appName || "karoo-live";
    let entry = apps.get(name);
    if (!entry) {
      const app = fb.initializeApp({ databaseURL: `https://${host}` }, name);
      entry = { database: fb.db.getDatabase(app) };
      apps.set(name, entry);
    }
    fb.db.onValue(
      fb.db.ref(entry.database, `live/${id}`),
      (snap) => onData(snap.val()),
      (err) => onProblem(/permission/i.test(err && (err.code || err.message) || "")
        ? "This link isn't readable. The rider may need to check their database rules."
        : "Can't reach the rider's database."),
    );
    if (onConnection) fb.db.onValue(fb.db.ref(entry.database, ".info/connected"), (snap) => onConnection(snap.val() === true));
  }

  // ---------------------------------------------------------------- viewer messages
  // A viewer signs in anonymously (no account; the id is remembered by the browser) so the database rules
  // can limit each sender separately: 3 a minute per person, 10 a minute per ride overall.
  const MSG_GAP_SENDER = 20000, MSG_GAP_ALL = 6000;
  const msgApps = new Map();
  async function messenger(host, apiKey) {
    const k = host + "|" + apiKey;
    if (!msgApps.has(k)) {
      msgApps.set(k, (async () => {
        const [appMod, db, auth] = await Promise.all([
          import(FIREBASE + "firebase-app.js"), import(FIREBASE + "firebase-database.js"), import(FIREBASE + "firebase-auth.js")]);
        const app = appMod.initializeApp({ apiKey, databaseURL: `https://${host}` }, "msg-" + host);
        return { db, auth, a: auth.getAuth(app), database: db.getDatabase(app) };
      })());
      msgApps.get(k).catch(() => msgApps.delete(k));
    }
    return msgApps.get(k);
  }

  class MessageError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
  }

  /** Milliseconds this viewer must wait before the rules accept another message (0 = now). */
  async function messageWait(m, shareId) {
    const { db, a, database } = m;
    const read = async (path) => (await db.get(db.ref(database, path))).val();
    const [mine, all, offset] = await Promise.all([
      read(`msgRate/${shareId}/${a.currentUser.uid}`), read(`msgRate/${shareId}/all`), read(".info/serverTimeOffset")]);
    const now = Date.now() + (offset || 0);
    const until = Math.max(mine ? mine.t + MSG_GAP_SENDER : 0, all ? all.t + MSG_GAP_ALL : 0);
    return Math.max(0, until - now);
  }

  /**
   * Sends one message to the rider. onWait(ms) is called while it waits for a free slot.
   * Throws MessageError with kind "setup" (rider's Firebase not ready), "closed" (not recording) or "failed".
   */
  async function sendMessage(host, apiKey, shareId, from, text, onWait) {
    let m;
    try {
      m = await messenger(host, apiKey);
      if (!m.a.currentUser) await m.auth.signInAnonymously(m.a);
    } catch (e) {
      const code = (e && e.code) || "";
      if (/operation-not-allowed|admin-restricted|configuration-not-found|api-key/.test(code)) {
        throw new MessageError("setup", "This rider hasn't finished setting up messages (Anonymous sign-in and sign-ups in Firebase).");
      }
      throw new MessageError("failed", "Couldn't connect. Check your connection and try again.");
    }
    const { db, a, database } = m;
    for (let attempt = 0; attempt < 6; attempt++) {
      let wait;
      try { wait = await messageWait(m, shareId); }
      catch (e) { throw new MessageError("setup", "This rider hasn't finished setting up messages (database rules)."); }
      if (wait > 0) { onWait && onWait(wait); await new Promise((r) => setTimeout(r, wait + 300)); }
      const id = db.push(db.ref(database, `msgs/${shareId}`)).key;
      const ts = db.serverTimestamp();
      try {
        await db.update(db.ref(database), {
          [`msgs/${shareId}/${id}`]: { from, text, ts, uid: a.currentUser.uid },
          // field by field: the rules check each one, so a rate record can't be reset or deleted
          [`msgRate/${shareId}/all/t`]: ts, [`msgRate/${shareId}/all/id`]: id,
          [`msgRate/${shareId}/${a.currentUser.uid}/t`]: ts, [`msgRate/${shareId}/${a.currentUser.uid}/id`]: id,
        });
        return;
      } catch (e) {
        // Denied: someone else may have taken the slot a moment earlier, or the ride stopped. Check again.
        if (!/permission/i.test((e && (e.code || e.message)) || "")) throw new MessageError("failed", "Couldn't send. Check your connection and try again.");
        const w = await messageWait(m, shareId).catch(() => 0);
        if (w === 0) throw new MessageError("closed", "The rider isn't recording right now, so messages are off.");
      }
    }
    throw new MessageError("failed", "Lots of messages right now. Please try again in a minute.");
  }

  /** Polls a KarooTracker feed (a copy of Hammerhead's live tracking). */
  function k2tSource(id, onData, onProblem, everyMs = 10000) {
    const url = `https://storagekarootrack.blob.core.windows.net/tracking/${encodeURIComponent(id)}`;
    function poll() {
      fetch(`${url}?${Date.now()}`, { cache: "no-store" })
        .then((r) => {
          if (r.status === 404) { onProblem(`No KarooTracker feed found for "${id}". Check the link.`); return null; }
          return r.ok ? r.json() : null;
        })
        .then((d) => { if (d) onData(d); })
        .catch(() => onProblem("Can't reach KarooTracker right now."))
        .finally(() => setTimeout(poll, everyMs));
    }
    poll();
  }

  // ---------------------------------------------------------------- normalize
  function fromFirebase(t) {
    if (!t || typeof t !== "object") return null;
    const track = Object.values(t.track || {})
      .filter((p) => p && num(p.lat) != null && num(p.lng) != null)
      .sort((a, b) => a.t - b.t)
      // Derailleurs: chart the rear gear as "gear" (front gear kept as fg for the label).
      .map((p) => (num(p.gear) == null && num(p.rg) != null ? { ...p, gear: p.rg } : p));
    let route = null;
    if (t.route && typeof t.route.poly === "string") {
      try { route = { points: decodePolyline(t.route.poly), name: t.route.name || "", dist: num(t.route.dist) }; } catch (e) { route = null; }
    }
    return {
      source: "karoo-live",
      name: typeof t.name === "string" ? t.name : "",
      units: t.units === "imperial" ? "imperial" : t.units === "metric" ? "metric" : null,
      state: ["recording", "paused", "idle"].includes(t.state) ? t.state : "unknown",
      updatedAt: num(t.updatedAt) || num(t.lastTest),
      startedAt: num(t.startedAt),
      endedAt: num(t.endedAt),
      cur: (() => {
        const c = t.cur && typeof t.cur === "object" ? { ...t.cur } : {};
        if (num(c.gear) == null && num(c.rg) != null) c.gear = c.rg;
        return c;
      })(),
      route,
      track,
      // Viewer messages: the rider's switch, plus the project's public web key needed to sign in anonymously.
      msg: t.msg && typeof t.msg === "object" && t.msg.on === true && typeof t.msg.key === "string" ? { on: true, key: t.msg.key } : null,
    };
  }

  function fromK2t(d) {
    if (!d || typeof d !== "object") return null;
    const info = {};
    (d.activityInfo || []).forEach((a) => { if (a && a.key && a.value) info[a.key] = num(a.value.value); });
    const cur = {};
    if (d.location && num(d.location.lat) != null) {
      cur.lat = d.location.lat; cur.lng = d.location.lng;
      if (num(d.bearing) != null) cur.brg = d.bearing;
    }
    const map = {
      TYPE_DISTANCE_ID: "dist", TYPE_ELAPSED_TIME_ID: "el", TYPE_AVERAGE_SPEED_ID: "avgSpd",
      TYPE_ELEVATION_GAIN_ID: "gain", TYPE_BATTERY_PERCENT_ID: "bat",
    };
    Object.entries(map).forEach(([k, v]) => { if (info[k] != null) cur[v] = info[k]; });
    const s = String(d.state || "").toLowerCase();
    const state = s === "idle" ? "idle" : s === "paused" ? "paused" : s ? "recording" : "unknown";
    const track = (d.locations || []).map((p) => Array.isArray(p) ? { lat: p[0], lng: p[1] } : { lat: p.lat, lng: p.lng })
      .filter((p) => num(p.lat) != null && num(p.lng) != null);
    let route = null;
    if (d.route && typeof d.route.routePolyline === "string") {
      try { route = { points: decodePolyline(d.route.routePolyline), name: "" }; } catch (e) { route = null; }
    }
    return {
      source: "k2t",
      name: typeof d.riderName === "string" ? d.riderName : "",
      units: d.units === "IMPERIAL" ? "imperial" : d.units === "METRIC" ? "metric" : null,
      state,
      updatedAt: Date.parse(d.updatedAt) || null,
      startedAt: null,
      endedAt: null,
      cur, route, track,
    };
  }

  function merge(fb, kt) {
    if (!fb && !kt) return null;
    if (!fb) return kt;
    if (!kt) return fb;
    // Hammerhead's feed only fills in while it shows a ride; between rides it's stale.
    if (kt.state !== "recording" && kt.state !== "paused") return fb;
    const fbFresh = fb.updatedAt && (!kt.updatedAt || fb.updatedAt >= kt.updatedAt - 60000);
    const base = fbFresh ? fb : { ...fb, state: kt.state, updatedAt: kt.updatedAt, cur: { ...fb.cur, lat: kt.cur.lat, lng: kt.cur.lng, brg: kt.cur.brg } };
    const cur = { ...kt.cur, ...base.cur };
    return {
      ...base,
      name: fb.name || kt.name,
      units: fb.units || kt.units,
      cur,
      route: fb.route || kt.route,
      track: fb.track.length ? fb.track : kt.track,
    };
  }

  // ---------------------------------------------------------------- map helpers
  // Vector maps from OpenFreeMap (free, no key) drawn with MapLibre GL.
  const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
  const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
  const EMPTY_LINE = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } };
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function lineOf(points, properties) {
    return { type: "Feature", properties: properties || {}, geometry: { type: "LineString", coordinates: points.map(([lat, lng]) => [lng, lat]) } };
  }

  window.KarooLive = {
    STALE_MS, SAFE_ID, normalizeHost, num, decodePolyline, haversine,
    fmtNum, fmtDuration, ago, unitFormatters,
    loadFirebase, firebaseSource, k2tSource, sendMessage, fromFirebase, fromK2t, merge,
    STYLE_LIGHT, STYLE_DARK, EMPTY_LINE, css, isDark, lineOf,
  };
})();
