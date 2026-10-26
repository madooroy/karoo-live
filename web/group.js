/* Karoo Live group view — https://github.com/madooroy/karoo-live
 *
 * Follows several riders on one map. The group lives entirely in the URL:
 *
 *   group.html?v=1&n=<ride name>&r=<rider>&r=<rider>…      (readable form)
 *   group.html#z=<deflate + base64url of {"v":1,"n":…,"r":[…]}>   (compact form for long groups)
 *
 * Each <rider> token is one of:
 *   <db>~<shareId>[~<name>]     Karoo Live rider. <db> is a Firebase project id ("my-proj"),
 *                               "<proj>@<region>" for a regional database, or a full host.
 *   k2t~<id>[~<name>]           KarooTracker feed (Hammerhead's own live tracking)
 *   x~<name>~<url>              Another tracker's page (Garmin LiveTrack, Wahoo, Strava Beacon…):
 *                               listed with a link, not drawn on the map
 *   units=imperial|metric       optional, overrides the riders' own preference
 *
 * Every rider is a "source" (see SOURCES below) that produces the same normalized model
 * as the single-rider page, so a future source (an organizer-hosted event server, say)
 * only needs a new entry there. Reads are read-only and go straight to each rider's own
 * database; nothing is sent anywhere else.
 */
(() => {
  "use strict";

  const KL = window.KarooLive;
  const { STALE_MS, SAFE_ID, normalizeHost, num, haversine, fmtNum, fmtDuration, ago,
    firebaseSource, k2tSource, fromFirebase, fromK2t, STYLE_LIGHT, STYLE_DARK, css, isDark, lineOf } = KL;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const FORMAT_VERSION = 1;
  const OLD_MS = 12 * 3600 * 1000;   // data older than this is a previous ride, not this one
  const BUNCH_M = 300;               // riders closer than this along the course ride together
  const OFF_ROUTE_M = 250;           // farther than this from the planned route counts as off route
  const LONG_URL = 1500;             // above this, suggest the compact link or a link shortener
  const MAX_RIDERS = 30;

  // Colors chosen to stay apart for common color-vision deficiencies (based on the Okabe–Ito set)
  // and to read on both the light and the dark map. `ink` is the text color on top (≥ 4.5:1);
  // tracks are outlined in their ink color too, which keeps every line ≥ 2.9:1 against its outline.
  // Riders also get a number, so color is never the only cue; riders 9+ get a dashed track.
  const PALETTE = [
    { c: "#0072b2", ink: "#ffffff" }, // blue
    { c: "#d55e00", ink: "#000000" }, // vermillion
    { c: "#009e73", ink: "#000000" }, // bluish green
    { c: "#cc79a7", ink: "#000000" }, // reddish purple
    { c: "#e69f00", ink: "#000000" }, // orange
    { c: "#56b4e9", ink: "#000000" }, // sky blue
    { c: "#7b3fa0", ink: "#ffffff" }, // purple
    { c: "#9a6324", ink: "#ffffff" }, // brown
  ];

  // ---------------------------------------------------------------- group encoding
  function shortHost(host) {
    let m = /^([a-z0-9-]+)-default-rtdb\.firebaseio\.com$/.exec(host);
    if (m) return m[1];
    m = /^([a-z0-9-]+)-default-rtdb\.([a-z0-9-]+)\.firebasedatabase\.app$/.exec(host);
    if (m) return `${m[1]}@${m[2]}`;
    return host;
  }
  function expandHost(s) {
    const m = /^([a-z0-9-]+)@([a-z0-9-]+)$/i.exec(s || "");
    if (m) return normalizeHost(`${m[1].toLowerCase()}-default-rtdb.${m[2].toLowerCase()}.firebasedatabase.app`);
    return normalizeHost(s || "");
  }
  const cleanName = (s) => String(s || "").replace(/[~\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  const isHttpUrl = (s) => { try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:"; } catch (e) { return false; } };

  /** Token → rider spec, or null if it's not valid. */
  function parseToken(tok) {
    const parts = String(tok || "").split("~");
    if (parts[0] === "x") {
      const url = parts.slice(2).join("~");
      return isHttpUrl(url) ? { kind: "link", name: cleanName(parts[1]) || "Rider", url } : null;
    }
    if (parts[0] === "k2t") return SAFE_ID.test(parts[1] || "") ? { kind: "k2t", id: parts[1], name: cleanName(parts[2]) } : null;
    const host = expandHost(parts[0]);
    return host && SAFE_ID.test(parts[1] || "") ? { kind: "fb", host, id: parts[1], name: cleanName(parts[2]) } : null;
  }
  function tokenOf(s) {
    if (s.kind === "link") return `x~${cleanName(s.name) || "Rider"}~${s.url}`;
    const head = s.kind === "k2t" ? `k2t~${s.id}` : `${shortHost(s.host)}~${s.id}`;
    return s.name ? `${head}~${cleanName(s.name)}` : head;
  }
  const specKey = (s) => s.kind === "link" ? "x:" + s.url : s.kind === "k2t" ? "k:" + s.id : `f:${s.host}/${s.id}`;

  function groupUrl(group) {
    const p = new URLSearchParams();
    p.set("v", String(FORMAT_VERSION));
    if (group.name) p.set("n", group.name);
    group.riders.forEach((s) => p.append("r", tokenOf(s)));
    return `${location.origin}${location.pathname}?${p.toString()}`;
  }

  const b64url = {
    enc: (bytes) => { let s = ""; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
    dec: (str) => { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
  };
  async function pipeBytes(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  async function compactUrl(group) {
    if (typeof CompressionStream === "undefined") return null;
    const json = JSON.stringify({ v: FORMAT_VERSION, n: group.name || undefined, r: group.riders.map(tokenOf) });
    const z = await pipeBytes(new TextEncoder().encode(json), new CompressionStream("deflate-raw"));
    return `${location.origin}${location.pathname}#z=${b64url.enc(z)}`;
  }

  /** Reads the group from a URL's query and hash (either form). */
  async function readGroup(href) {
    const u = new URL(href, location.href);
    const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
    let name = "", tokens = [], units = null;
    if (hash.get("z") && typeof DecompressionStream !== "undefined") {
      try {
        const raw = await pipeBytes(b64url.dec(hash.get("z")), new DecompressionStream("deflate-raw"));
        const obj = JSON.parse(new TextDecoder().decode(raw));
        if (obj && Array.isArray(obj.r)) { name = obj.n || ""; tokens = obj.r; units = obj.u || null; }
      } catch (e) { console.warn("Couldn't read the compact group link", e); }
    }
    for (const p of [u.searchParams, hash]) {
      if (!name && p.get("n")) name = p.get("n");
      tokens = tokens.concat(p.getAll("r"));
      units = units || p.get("units");
    }
    const seen = new Set(), riders = [];
    tokens.map(parseToken).filter(Boolean).forEach((s) => { const k = specKey(s); if (!seen.has(k)) { seen.add(k); riders.push(s); } });
    return { name: cleanName(name).slice(0, 60), riders: riders.slice(0, MAX_RIDERS), units: units === "imperial" || units === "metric" ? units : null };
  }

  /** One pasted line → rider specs (a group link can hold many). */
  async function parseLine(line) {
    line = line.trim();
    if (!line) return [];
    const m = /(https?:\/\/\S+)/i.exec(line);
    if (!m) {
      const tok = parseToken(line);
      if (tok) return [tok];
      const id = line.split(/[\s/]/).filter(Boolean).pop();
      return id && SAFE_ID.test(id) ? [{ kind: "k2t", id, name: "" }] : [];
    }
    const url = m[1].replace(/[),.;]+$/, "");
    const label = cleanName(line.replace(m[1], "").replace(/^[\s:–—-]+|[\s:–—-]+$/g, ""));
    let u; try { u = new URL(url); } catch (e) { return []; }
    if (/group(\.html)?$/.test(u.pathname) && (u.searchParams.has("r") || /[#&]z=|[#&]r=/.test(u.hash))) return (await readGroup(url)).riders;
    const db = expandHost(u.searchParams.get("db") || ""), id = u.searchParams.get("id") || "";
    if (db && SAFE_ID.test(id)) return [{ kind: "fb", host: db, id, name: label }];
    const k2t = (u.searchParams.get("k2t") || "").split("/").pop();
    if (SAFE_ID.test(k2t)) return [{ kind: "k2t", id: k2t, name: label }];
    if (/k2tracker|karootrack/i.test(u.hostname)) {
      const last = u.pathname.split("/").filter(Boolean).pop();
      if (last && SAFE_ID.test(last)) return [{ kind: "k2t", id: last, name: label }];
    }
    return [{ kind: "link", url, name: label || trackerName(u.hostname) }];
  }
  function trackerName(host) {
    if (/garmin/i.test(host)) return "Garmin LiveTrack";
    if (/wahoo/i.test(host)) return "Wahoo Live Track";
    if (/strava/i.test(host)) return "Strava Beacon";
    if (/hammerhead/i.test(host)) return "Hammerhead";
    return host.replace(/^www\./, "");
  }
  function viewerLink(s) {
    const base = new URL("./", location.href).href;
    if (s.kind === "fb") return `${base}?db=${encodeURIComponent(shortHost(s.host))}&id=${encodeURIComponent(s.id)}`;
    if (s.kind === "k2t") return `${base}?k2t=${encodeURIComponent(s.id)}`;
    return s.url;
  }

  // ---------------------------------------------------------------- units & theme
  let unitsOverride = null;
  try { unitsOverride = localStorage.getItem("karoolive.units"); } catch (e) { /* storage blocked */ }
  let units = unitsOverride || "metric";
  const { U, fmtDist } = KL.unitFormatters(() => units);
  const distText = (m) => fmtDist(m).join(" ");

  // ---------------------------------------------------------------- start
  // A compact link keeps the group after "#", which changes without a page load: start over.
  addEventListener("hashchange", () => location.reload());
  readGroup(location.href).then((group) => {
    if (!group.riders.length) showBuilder(group);
    else startGroup(group);
  });

  // ================================================================ builder
  function showBuilder(initial) {
    $("#builder").hidden = false;
    $("#group").hidden = true;
    document.title = "Group ride · Karoo Live";
    const list = initial.riders.slice();
    $("#build-name").value = initial.name || "";

    function renderList() {
      const ol = $("#build-list"); ol.replaceChildren();
      list.forEach((s, i) => {
        const li = el("li");
        const sw = el("span", "bswatch", String(i + 1));
        const pal = PALETTE[i % PALETTE.length];
        sw.style.background = pal.c; sw.style.color = pal.ink;
        const txt = el("span", "build-item");
        const kind = s.kind === "fb" ? "Karoo Live" : s.kind === "k2t" ? "KarooTracker" : trackerName(new URL(s.url).hostname);
        txt.append(el("b", null, s.name || (s.kind === "link" ? "Rider" : "Name from their Karoo")), el("small", null, ` · ${kind} · ${s.kind === "link" ? new URL(s.url).hostname : s.id}`));
        const name = el("button", "linkbtn", "Rename");
        name.type = "button";
        name.addEventListener("click", () => {
          const v = prompt("Name to show for this rider (leave empty to use the name from their device):", s.name || "");
          if (v != null) { s.name = cleanName(v); if (s.kind === "link" && !s.name) s.name = "Rider"; update(); }
        });
        const up = el("button", "linkbtn", "↑"); up.type = "button"; up.setAttribute("aria-label", "Move up"); up.disabled = i === 0;
        up.addEventListener("click", () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; update(); });
        const rm = el("button", "linkbtn", "Remove"); rm.type = "button";
        rm.addEventListener("click", () => { list.splice(i, 1); update(); });
        li.append(sw, txt, name, up, rm);
        ol.append(li);
      });
    }

    async function update() {
      renderList();
      const group = { name: cleanName($("#build-name").value).slice(0, 60), riders: list };
      $("#build-out").hidden = !list.length;
      if (!list.length) return;
      const readable = groupUrl(group);
      let url = readable, note = `${readable.length} characters.`;
      if (readable.length > LONG_URL) {
        const compact = await compactUrl(group);
        if (compact && compact.length < readable.length) { url = compact; note = `Compact link, ${compact.length} characters.`; }
        if (url.length > LONG_URL) note += " Some messaging apps cut links this long. You can shorten it with any link shortener; the shortener only stores the link, not anyone's ride.";
      }
      $("#build-url").value = url;
      $("#build-len").textContent = note;
    }

    $("#build-add").addEventListener("click", async () => {
      const lines = $("#build-links").value.split(/\n+/);
      let added = 0, dupes = 0; const bad = [];
      for (const line of lines) {
        const specs = await parseLine(line);
        if (!specs.length && line.trim()) bad.push(line.trim());
        specs.forEach((s) => {
          if (list.some((x) => specKey(x) === specKey(s))) { dupes++; return; }
          if (list.length >= MAX_RIDERS) return;
          list.push(s); added++;
        });
      }
      $("#build-links").value = bad.join("\n");
      const msgs = [];
      if (added) msgs.push(`Added ${added} rider${added > 1 ? "s" : ""}.`);
      if (dupes) msgs.push(`${dupes} already in the group.`);
      if (bad.length) msgs.push(`Couldn't read ${bad.length} line${bad.length > 1 ? "s" : ""} (left in the box).`);
      if (list.length >= MAX_RIDERS) msgs.push(`A group holds up to ${MAX_RIDERS} riders.`);
      $("#build-msg").textContent = msgs.join(" ");
      update();
    });
    $("#build-name").addEventListener("input", update);
    $("#build-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("#build-url").value); $("#build-copy").textContent = "Copied"; }
      catch (e) { $("#build-url").select(); }
      setTimeout(() => { $("#build-copy").textContent = "Copy"; }, 1600);
    });
    $("#build-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (list.length) location.href = $("#build-url").value;
    });
    update();
  }

  // ================================================================ live group
  /** Sources turn a rider spec into normalized models (same shape as the single-rider page). */
  const SOURCES = {
    fb: (r, onModel, onProblem, onConnection) => firebaseSource(r.spec.host, r.spec.id,
      (tree) => onModel(fromFirebase(tree)), onProblem, onConnection, "kl-" + r.spec.host),
    k2t: (r, onModel, onProblem) => k2tSource(r.spec.id, (d) => onModel(fromK2t(d)), onProblem, 15000),
    link: () => {},
  };

  function startGroup(group) {
    $("#group").hidden = false;
    $("#builder").hidden = true;
    if (group.units) unitsOverride = group.units, units = group.units;
    const gname = group.name || "Group ride";
    $("#gname").textContent = gname;
    document.title = `${gname} · Karoo Live`;

    const riders = group.riders.map((spec, i) => ({
      i, spec, num: i + 1,
      color: PALETTE[i % PALETTE.length].c, ink: PALETTE[i % PALETTE.length].ink, dashed: i >= PALETTE.length,
      model: null, problem: "", connected: null, got: false,
      progress: null, lastProgress: null, offRoute: false, toGo: null, // course position
      marker: null, markerEl: null,
    }));
    const tracked = riders.filter((r) => r.spec.kind !== "link");
    const links = riders.filter((r) => r.spec.kind === "link");
    const nameOf = (r) => r.spec.name || (r.model && r.model.name) || `Rider ${r.num}`;

    let selected = null;           // rider whose details are open
    let view = { mode: "all", followId: null, userMoved: false };
    let sortMode = null;           // "togo" | "dist"; chosen once a route is known
    let route = null;              // {points, cum, len, poly, from}
    let dataDirty = true;
    let map, mapReady = false, mapDirty = true, fittedOnce = false, routeFitted = false, accuracyOn = false;

    // ------------------------------------------------ subscribe
    tracked.forEach((r) => {
      SOURCES[r.spec.kind](r,
        (model) => { r.got = true; r.problem = ""; r.model = model; onData(r); },
        (msg) => { r.problem = msg; dataDirty = true; kick(); },
        (up) => { r.connected = up; });
    });
    function onData(r) {
      if (!unitsOverride && r.model && r.model.units && riders.find((x) => x.model && x.model.units) === r) units = r.model.units;
      pickRoute();
      computeProgress(r);
      dataDirty = true;
      kick();
    }

    // ------------------------------------------------ status
    function statusOf(r, now) {
      const m = r.model;
      if (!m) return r.problem ? "error" : "waiting";
      const age = m.updatedAt ? now - m.updatedAt : null;
      if (age != null && age > OLD_MS) return "none";
      if (m.state === "recording") return age != null && age > STALE_MS ? "lost" : "live";
      if (m.state === "paused") return "paused";
      if (m.state === "idle") return m.track.length || m.endedAt ? "finished" : "none";
      return hasPos(r) ? "live" : "waiting";
    }
    const STATUS = {
      live: ["Live", "live"], lost: ["Signal lost", "lost"], paused: ["Paused", "paused"],
      finished: ["Finished", "done"], none: ["Not started", "none"], waiting: ["Connecting", "none"], error: ["Can't load", "lost"],
    };
    const onCourse = (s) => s === "live" || s === "lost" || s === "paused" || s === "finished";
    function hasPos(r) { const c = r.model && r.model.cur; return !!c && num(c.lat) != null && num(c.lng) != null; }

    // ------------------------------------------------ route & progress
    function pickRoute() {
      if (route) return;
      const r = tracked.find((x) => x.model && x.model.route && x.model.route.points.length > 1 && statusOf(x, Date.now()) !== "none");
      if (!r) return;
      const pts = r.model.route.points, cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
      route = { points: pts, cum, len: num(r.model.route.dist) || cum[cum.length - 1], name: r.model.route.name || "", from: r, sig: routeSig(pts) };
      if (!sortMode) sortMode = "togo";
      tracked.forEach(computeProgress);
      mapDirty = true;
    }

    function routeSig(pts) {
      const a = pts[0], b = pts[pts.length - 1], mid = pts[pts.length >> 1];
      return [pts.length, a, mid, b].join("|");
    }

    /** Distance along the planned route of the point nearest (lat,lng), preferring the
     *  stretch closest to `hint` so out-and-back and looped routes resolve correctly. */
    function project(lat, lng, hint) {
      const pts = route.points, cosLat = Math.cos(lat * Math.PI / 180), M = 111320;
      let best = null;
      for (let i = 1; i < pts.length; i++) {
        const ax = (pts[i - 1][1] - lng) * M * cosLat, ay = (pts[i - 1][0] - lat) * M;
        const bx = (pts[i][1] - lng) * M * cosLat, by = (pts[i][0] - lat) * M;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
        const px = ax + t * dx, py = ay + t * dy, d = Math.sqrt(px * px + py * py);
        if (d > OFF_ROUTE_M) continue;
        const along = route.cum[i - 1] + t * (route.cum[i] - route.cum[i - 1]);
        const score = hint == null ? d : Math.abs(along - hint) + d * 4;
        if (!best || score < best.score) best = { along, d, score };
      }
      return best;
    }

    function computeProgress(r) {
      const m = r.model;
      r.toGo = null; r.offRoute = false;
      if (!m) { r.progress = null; return; }
      const c = m.cur, dist = num(c.dist);
      if (!route) { r.progress = dist; return; }
      // A Karoo navigating the same route reports its own distance to go: use it.
      if (m.route && num(c.toGo) != null && routeSig(m.route.points) === route.sig) {
        const len = num(m.route.dist) || route.len;
        r.progress = Math.max(0, len - c.toGo); r.toGo = c.toGo; r.lastProgress = r.progress; return;
      }
      if (!hasPos(r)) { r.progress = r.lastProgress; return; }
      const hint = r.lastProgress != null ? r.lastProgress : dist != null ? Math.min(dist, route.len) : null;
      const p = project(c.lat, c.lng, hint);
      if (p) { r.progress = p.along; r.lastProgress = p.along; r.toGo = Math.max(0, route.len - p.along); }
      else { r.offRoute = true; r.progress = r.lastProgress; r.toGo = r.lastProgress != null ? route.len - r.lastProgress : null; }
    }

    const sortKey = (r) => (sortMode === "dist" || !route) ? num(r.model && r.model.cur.dist) : r.progress;

    /** Time behind the leader: when was the leader where this rider is now? Needs the leader's
     *  track with distance and time on each point (Karoo Live riders have both). */
    function timeGap(leader, r) {
      const lm = leader.model, rm = r.model;
      if (!lm || !rm || !rm.updatedAt) return null;
      const lDist = num(lm.cur.dist), lk = sortKey(leader), rk = sortKey(r);
      if (lDist == null || lk == null || rk == null) return null;
      const target = lDist - (lk - rk);
      const pts = lm.track.filter((p) => num(p.d) != null && num(p.t) != null);
      if (pts.length < 2 || target < pts[0].d || target > lDist) return null;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].d >= target) {
          const a = pts[i - 1], b = pts[i], f = b.d === a.d ? 0 : (target - a.d) / (b.d - a.d);
          const t = a.t + f * (b.t - a.t);
          const gap = rm.updatedAt - t;
          return gap >= 0 && gap < 24 * 3600 * 1000 ? gap : null;
        }
      }
      return null;
    }

    function ranking(now) {
      const st = new Map(tracked.map((r) => [r, statusOf(r, now)]));
      const ranked = tracked.filter((r) => onCourse(st.get(r)) && (hasPos(r) || sortKey(r) != null));
      ranked.sort((a, b) => {
        const ka = sortKey(a), kb = sortKey(b);
        if (ka == null && kb == null) return a.i - b.i;
        if (ka == null) return 1;
        if (kb == null) return -1;
        return kb - ka || a.i - b.i;
      });
      // Finished riders head the list (like finishers in a race), but the gaps are measured
      // to the leader of the riders still on the road.
      ranked.sort((a, b) => (st.get(a) === "finished" ? 0 : 1) - (st.get(b) === "finished" ? 0 : 1));
      const rest = tracked.filter((r) => !ranked.includes(r));
      const leader = ranked.find((r) => st.get(r) !== "finished" && sortKey(r) != null) || null;
      return { st, ranked, rest, leader };
    }

    // ================================================================ map
    const isMapEvent = (e) => !!(e && e.originalEvent);

    function initMap() {
      if (map) return;
      if (!window.maplibregl) { $("#map-msg").hidden = false; return; }
      map = new maplibregl.Map({
        container: "map",
        style: isDark() ? STYLE_DARK : STYLE_LIGHT,
        center: [-40, 40], zoom: 1.5,
        attributionControl: { compact: true },
        cooperativeGestures: matchMedia("(pointer: coarse)").matches,
        dragRotate: false, pitchWithRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
      window.karooLiveMap = map;
      map.on("style.load", () => { addLayers(); mapReady = true; mapDirty = true; renderMap(); });
      const moved = (e) => { if (isMapEvent(e)) { view.userMoved = true; renderViewTools(); } };
      map.on("dragstart", moved); map.on("zoomstart", moved);
      map.on("moveend", declutter);
      map.on("error", (e) => console.warn("Map:", e && e.error ? e.error.message : e));
    }

    function addLayers() {
      const dark = isDark();
      const fc = { type: "FeatureCollection", features: [] };
      if (!map.getSource("route")) map.addSource("route", { type: "geojson", data: fc });
      if (!map.getSource("tracks")) map.addSource("tracks", { type: "geojson", data: fc });
      if (!map.getSource("acc")) map.addSource("acc", { type: "geojson", data: fc });
      map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": css("--route-band"), "line-width": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 12], "line-opacity": dark ? 0.5 : 0.45 } });
      map.addLayer({ id: "acc", type: "fill", source: "acc", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.15, "fill-outline-color": ["get", "color"] } });
      map.addLayer({ id: "track-casing", type: "line", source: "tracks", layout: { "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "z"] },
        paint: { "line-color": ["get", "casing"], "line-width": ["case", ["get", "sel"], 9, 6.5], "line-opacity": ["case", ["get", "dim"], 0.5, 0.9] } });
      const trackPaint = { "line-color": ["get", "color"], "line-width": ["case", ["get", "sel"], 5.5, 3.5], "line-opacity": ["case", ["get", "dim"], 0.45, 1] };
      map.addLayer({ id: "track", type: "line", source: "tracks", filter: ["!", ["get", "dashed"]],
        layout: { "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "z"] }, paint: trackPaint });
      map.addLayer({ id: "track-dashed", type: "line", source: "tracks", filter: ["get", "dashed"],
        layout: { "line-join": "round", "line-sort-key": ["get", "z"] }, paint: { ...trackPaint, "line-dasharray": [2, 1.2] } });
    }

    function circle(lat, lng, radius) {
      const pts = [], n = 40, dLat = radius / 111320, dLng = radius / (111320 * Math.cos(lat * Math.PI / 180));
      for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
      return { type: "Polygon", coordinates: [pts] };
    }

    function ensureMarker(r) {
      if (r.marker) return;
      const root = el("button", "gm");
      root.type = "button";
      root.style.setProperty("--c", r.color); root.style.setProperty("--ink", r.ink);
      const arrow = el("span", "gm-arrow"); arrow.setAttribute("aria-hidden", "true");
      const dot = el("span", "gm-dot", String(r.num));
      const label = el("span", "gm-label");
      root.append(arrow, dot, label);
      root.addEventListener("click", (e) => { e.stopPropagation(); select(r, true); });
      r.markerEl = root;
      r.marker = new maplibregl.Marker({ element: root, anchor: "center" }).setLngLat([0, 0]).addTo(map);
    }

    function renderMap() {
      initMap();
      if (!map) return;
      const now = Date.now(), { st, ranked } = ranking(now);
      const order = new Map(ranked.map((r, i) => [r, i + 1]));
      // markers (HTML, so they carry a name, a number and an accessible label)
      tracked.forEach((r) => {
        const s = st.get(r), show = hasPos(r) && s !== "none";
        if (!show) { if (r.marker) { r.marker.remove(); r.marker = null; } return; }
        ensureMarker(r);
        const c = r.model.cur, brg = num(c.brg);
        r.marker.setLngLat([c.lng, c.lat]);
        const e = r.markerEl;
        e.classList.toggle("stale", s === "lost");
        e.classList.toggle("done", s === "finished" || s === "paused");
        e.classList.toggle("sel", selected === r);
        e.classList.toggle("heading", brg != null && s === "live");
        e.style.setProperty("--brg", `${brg || 0}deg`);
        e.style.zIndex = selected === r ? 1000 : 500 - (order.get(r) || 400);
        const lbl = e.querySelector(".gm-label");
        lbl.textContent = s === "lost" ? `${nameOf(r)} · ${ago(now - r.model.updatedAt)}` : nameOf(r);
        e.setAttribute("aria-label", `${nameOf(r)}, rider ${r.num}${order.get(r) ? `, position ${order.get(r)}` : ""}, ${STATUS[s][0]}`);
      });
      if (!mapReady || !mapDirty) { declutter(); return; }
      mapDirty = false;

      map.getSource("route").setData(route ? lineOf(route.points) : { type: "FeatureCollection", features: [] });
      $("#legend-route").hidden = !route;
      const feats = [];
      tracked.forEach((r) => {
        const s = st.get(r);
        if (!r.model || s === "none") return;
        const pts = r.model.track.map((p) => [p.lat, p.lng]);
        if (hasPos(r)) { const c = r.model.cur, l = pts[pts.length - 1]; if (!l || l[0] !== c.lat || l[1] !== c.lng) pts.push([c.lat, c.lng]); }
        if (pts.length < 2) return;
        feats.push(lineOf(pts, { color: r.color, casing: r.ink === "#000000" ? "#262626" : "#ffffff", dashed: r.dashed, sel: selected === r, dim: (selected && selected !== r) || s === "lost", z: selected === r ? 100 : 50 - r.i }));
      });
      map.getSource("tracks").setData({ type: "FeatureCollection", features: feats });
      const acc = selected && hasPos(selected) ? num(selected.model.cur.acc) : null;
      accuracyOn = acc != null && acc >= 15;
      map.getSource("acc").setData(accuracyOn ? { type: "Feature", properties: { color: selected.color }, geometry: circle(selected.model.cur.lat, selected.model.cur.lng, acc) } : { type: "FeatureCollection", features: [] });
      moveCamera(st);
      declutter();
    }

    function moveCamera(st) {
      if (!mapReady) return;
      const el2 = map.getContainer();
      if (view.mode === "follow") {
        const r = riders.find((x) => x.i === view.followId);
        if (!r || !hasPos(r)) return;
        const c = r.model.cur, p = map.project([c.lng, c.lat]);
        const mx = el2.clientWidth * 0.25, my = el2.clientHeight * 0.25;
        if (!fittedOnce) { map.jumpTo({ center: [c.lng, c.lat], zoom: 14 }); fittedOnce = true; return; }
        if (p.x < mx || p.y < my || p.x > el2.clientWidth - mx || p.y > el2.clientHeight - my) map.easeTo({ center: [c.lng, c.lat], duration: 700 });
        return;
      }
      if (view.userMoved) return;
      if (view.mode === "route") {
        if (!route || routeFitted) return;
        const b = new maplibregl.LngLatBounds(); route.points.forEach(([la, ln]) => b.extend([ln, la]));
        map.fitBounds(b, { padding: 40, maxZoom: 15, duration: fittedOnce ? 600 : 0 });
        routeFitted = true; fittedOnce = true; return;
      }
      // "Everyone": riders on the road first; if nobody is, everyone with a position.
      let pts = tracked.filter((r) => hasPos(r) && ["live", "lost", "paused"].includes(st.get(r)));
      if (!pts.length) pts = tracked.filter((r) => hasPos(r) && st.get(r) !== "none");
      if (!pts.length) {
        if (route && !fittedOnce) { const b = new maplibregl.LngLatBounds(); route.points.forEach(([la, ln]) => b.extend([ln, la])); map.fitBounds(b, { padding: 40, duration: 0 }); fittedOnce = true; }
        return;
      }
      map.resize();
      const b = new maplibregl.LngLatBounds();
      pts.forEach((r) => b.extend([r.model.cur.lng, r.model.cur.lat]));
      const pad = { top: 56, bottom: 100, left: 48, right: 48 }; // room for the labels and the view buttons
      const cam = map.cameraForBounds(b, { padding: pad, maxZoom: 15 });
      if (!cam) return;
      const zoom = Math.min(15, cam.zoom);
      if (!fittedOnce) { map.jumpTo({ center: cam.center, zoom }); fittedOnce = true; return; }
      const out = pts.some((r) => {
        const p = map.project([r.model.cur.lng, r.model.cur.lat]);
        return p.x < 24 || p.y < 40 || p.x > el2.clientWidth - 24 || p.y > el2.clientHeight - 90;
      });
      if (out || Math.abs(map.getZoom() - zoom) > 0.9) map.easeTo({ center: cam.center, zoom, duration: 800 });
    }

    /** Hide name labels that would overlap a more important one (selected first, then race order). */
    function declutter() {
      if (!map) return;
      const { ranked, rest } = ranking(Date.now());
      const order = [...(selected ? [selected] : []), ...ranked, ...rest].filter((r, i, a) => r.markerEl && a.indexOf(r) === i);
      const boxes = [];
      order.forEach((r) => {
        const p = map.project(r.marker.getLngLat());
        const lbl = r.markerEl.querySelector(".gm-label");
        const w = Math.min(160, lbl.textContent.length * 7 + 14), h = 20;
        const box = { x: p.x - w / 2, y: p.y + 18, w, h };
        const dot = { x: p.x - 16, y: p.y - 16, w: 32, h: 32 };
        const hit = (a) => boxes.some((b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
        const hide = r !== selected && hit(box);
        lbl.classList.toggle("hidden", hide);
        boxes.push(dot);
        if (!hide) boxes.push(box);
      });
    }

    // ------------------------------------------------ map view controls
    function setView(mode, followId) {
      view = { mode, followId: followId == null ? null : followId, userMoved: false };
      routeFitted = false;
      if (mode === "follow") fittedOnce = false;
      renderViewTools();
      mapDirty = true; renderMap();
    }
    function renderViewTools() {
      const all = $("#view-all"), rt = $("#view-route"), fol = $("#view-follow");
      rt.hidden = !route;
      all.setAttribute("aria-pressed", String(view.mode === "all" && !view.userMoved));
      rt.setAttribute("aria-pressed", String(view.mode === "route" && !view.userMoved));
      all.textContent = view.userMoved && view.mode !== "follow" ? "Fit everyone" : "Everyone";
      const r = view.mode === "follow" ? riders.find((x) => x.i === view.followId) : null;
      fol.hidden = !r;
      if (r) { fol.replaceChildren(); const d = el("span", "chipdot", String(r.num)); d.style.background = r.color; d.style.color = r.ink; fol.append(d, `Following ${nameOf(r)}`, el("span", "x", "×")); fol.setAttribute("aria-label", `Following ${nameOf(r)}. Stop following`); }
    }
    $("#view-all").addEventListener("click", () => setView("all"));
    $("#view-route").addEventListener("click", () => setView("route"));
    $("#view-follow").addEventListener("click", () => setView("all"));

    // ================================================================ list
    function select(r, fromMap) {
      selected = selected === r && !fromMap ? null : r;
      mapDirty = true;
      render();
      if (selected) {
        const li = document.querySelector(`[data-rider="${r.i}"]`);
        if (li && fromMap) li.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    // Live numbers for the details panel. A sensor shows only if this rider has sent it this ride.
    const DETAIL = [
      { key: "spd", color: "spd", label: "Speed", instant: true, always: true, fmt: (v) => { const [x, u] = U.speed(v); return [fmtNum(x, 1), u]; } },
      { key: "pwr", color: "pwr", label: "Power 3s", instant: true, sensor: true, fmt: (v) => [fmtNum(v, 0), "W"] },
      { key: "hr", color: "hr", label: "Heart rate", instant: true, sensor: true, fmt: (v) => [fmtNum(v, 0), "bpm"] },
      { key: "cad", color: "cad", label: "Cadence", instant: true, sensor: true, fmt: (v) => [fmtNum(v, 0), "rpm"] },
      { key: "dist", label: "Distance", fmt: (v) => fmtDist(v) },
      { key: "_togo", label: "To go", fmt: (v) => fmtDist(v) },
      { key: "rt", label: "Moving", fmt: (v) => [fmtDuration(v), ""] },
      { key: "el", label: "Elapsed", fmt: (v) => [fmtDuration(v), ""] },
      { key: "avgSpd", label: "Avg speed", fmt: (v) => { const [x, u] = U.speed(v); return [fmtNum(x, 1), u]; } },
      { key: "avgPwr", label: "Avg power", fmt: (v) => [fmtNum(v, 0), "W"] },
      { key: "np", label: "NP", fmt: (v) => [fmtNum(v, 0), "W"] },
      { key: "gain", label: "Climbed", fmt: (v) => { const [x, u] = U.elev(v); return [fmtNum(x, 0), u]; } },
      { key: "alt", color: "alt", label: "Elevation", fmt: (v) => { const [x, u] = U.elev(v); return [fmtNum(x, 0), u]; } },
      { key: "grade", label: "Grade", instant: true, fmt: (v) => [fmtNum(v, 1), "%"] },
      { key: "climbLeft", label: "Climb left", fmt: (v) => { const [x, u] = U.elev(v); return [fmtNum(x, 0), u]; } },
      { key: "temp", label: "Temp", fmt: (v) => { const [x, u] = U.temp(v); return [fmtNum(x, 0), u]; } },
      { key: "bat", label: "Battery", fmt: (v) => [fmtNum(v, 0), "%"] },
    ];

    function detailPanel(r, s, gapText) {
      const box = el("div", "rdetail");
      const m = r.model, c = (m && m.cur) || {};
      const live = s === "live";
      const seen = (k) => num(c[k]) != null || (m && m.track.some((p) => num(p[k]) != null));
      const grid = el("div", "rgrid");
      DETAIL.forEach((d) => {
        let v = d.key === "_togo" ? r.toGo : num(c[d.key]);
        if (d.sensor && !seen(d.key)) return;            // no such sensor on this bike
        if (!d.always && !d.sensor && v == null) return;  // nothing to show
        if (d.instant && !live) v = null;                 // instant values mean nothing once stopped or lost
        const t = el("div", "rm");
        const rl = el("div", "rl");
        if (d.color) { const sw = el("i", "swatch"); sw.style.background = `var(--c-${d.color})`; sw.setAttribute("aria-hidden", "true"); rl.append(sw); }
        rl.append(d.label);
        t.append(rl);
        const val = el("div", "rv");
        if (v == null) { val.textContent = "—"; val.classList.add("na"); }
        else { const [x, u] = d.fmt(v); val.append(x); if (u) val.append(el("span", "u", u)); }
        t.append(val); grid.append(t);
      });
      if (!grid.children.length) grid.append(el("p", "hint", "No numbers yet."));
      box.append(grid);
      const notes = [];
      if (m && m.updatedAt) notes.push(`Last update ${new Date(m.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      if (m && m.startedAt && s !== "none") notes.push(`started ${new Date(m.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      if (r.spec.kind === "k2t") notes.push("position from Hammerhead's tracking (no sensor data)");
      if (num(c.acc) != null && hasPos(r)) notes.push(`GPS ±${fmtNum(c.acc, 0)} m`);
      if (gapText) notes.push(gapText);
      if (notes.length) box.append(el("p", "rnote", notes.join(" · ")));
      const acts = el("div", "racts");
      if (hasPos(r) && s !== "none") {
        const following = view.mode === "follow" && view.followId === r.i;
        const fb = el("button", "iconbtn", following ? "Stop following" : "Follow on map");
        fb.type = "button";
        fb.addEventListener("click", (e) => { e.stopPropagation(); following ? setView("all") : setView("follow", r.i); render(); });
        acts.append(fb);
      }
      const full = el("a", "iconbtn", "Full view ↗");
      full.href = viewerLink(r.spec); full.target = "_blank"; full.rel = "noopener";
      acts.append(full);
      box.append(acts);
      return box;
    }

    function renderList(now) {
      const { st, ranked, rest, leader } = ranking(now);
      const ol = $("#riders"); ol.replaceChildren();
      const useToGo = route && sortMode !== "dist";
      let prev = null;
      [...ranked, ...rest].forEach((r) => {
        const s = st.get(r), rankIdx = ranked.indexOf(r);
        const k = sortKey(r);
        // a gap row between bunches, like a race broadcast
        const prevDone = prev && st.get(prev) === "finished";
        if (prevDone && s !== "finished" && rankIdx > 0) ol.append(el("li", "gaprow quiet", "On the road"));
        else if (prev && rankIdx > 0 && k != null && sortKey(prev) != null && sortKey(prev) - k > BUNCH_M) {
          const g = el("li", "gaprow");
          const tg = timeGap(prev, r);
          g.textContent = `gap ${distText(sortKey(prev) - k)}${tg != null ? " · " + fmtDuration(tg) : ""}`;
          g.setAttribute("aria-hidden", "true");
          ol.append(g);
        }
        if (rankIdx < 0 && prev && ranked.includes(prev)) ol.append(el("li", "gaprow quiet", "Not on the road"));
        prev = r;

        const li = el("li", "rider-row " + s);
        li.dataset.rider = r.i;
        if (selected === r) li.classList.add("open");
        const head = el("button", "rhead");
        head.type = "button";
        head.setAttribute("aria-expanded", String(selected === r));
        head.addEventListener("click", () => select(r));
        const badge = el("span", "rbadge", String(r.num));
        badge.style.background = r.color; badge.style.color = r.ink;
        if (r.dashed) badge.classList.add("dashed");
        const main = el("span", "rmain");
        const top = el("span", "rtop");
        const nm = el("span", "rname", nameOf(r));
        const [stText, stCls] = STATUS[s];
        const pill = el("span", "pill sm " + stCls);
        pill.append(el("span", "dot"), stText);
        top.append(nm, pill);
        if (r.offRoute && onCourse(s)) top.append(el("span", "flag", "Off route"));
        const c = (r.model && r.model.cur) || {};
        const line1 = [];
        if (onCourse(s) && useToGo && r.toGo != null) line1.push(`${distText(r.toGo)} to go`);
        if (onCourse(s) && num(c.dist) != null) line1.push(`${distText(c.dist)} ridden`);
        if (!line1.length && s === "waiting") line1.push(r.problem ? r.problem : "Waiting for data");
        if (!line1.length && s === "error") line1.push(r.problem);
        if (!line1.length && s === "none") line1.push(r.model && r.model.updatedAt ? `No ride yet today · last ride ${ago(now - r.model.updatedAt)}` : "No ride yet today");
        const l1 = el("span", s === "error" ? "rline wrap" : "rline", line1.join(" · "));
        const line2 = [];
        let gapText = "";
        if (s === "finished") {
          const end = r.model.endedAt || r.model.updatedAt;
          if (end) line2.push(el("span", "lead", `finished ${new Date(end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`));
          if (num(c.el) != null) line2.push(el("span", "age", fmtDuration(c.el)));
        } else if (leader && rankIdx >= 0 && k != null) {
          if (r === leader) line2.push(el("b", "lead", ranked.length > 1 ? "Leading" : "Ahead"));
          else {
            const tg = timeGap(leader, r);
            gapText = `${distText(sortKey(leader) - k)} behind${tg != null ? `, about ${fmtDuration(tg)}` : ""}`;
            line2.push(el("span", "gap", `−${distText(sortKey(leader) - k)}${tg != null ? " · +" + fmtDuration(tg) : ""}`));
          }
        }
        if (r.model && r.model.updatedAt && s !== "none" && s !== "finished") {
          const age = now - r.model.updatedAt;
          line2.push(el("span", s === "lost" ? "age warn" : "age", s === "lost" ? `last seen ${ago(age)}` : `updated ${ago(age)}`));
        }
        const bat = num(c.bat);
        if (bat != null && bat <= 20 && onCourse(s) && s !== "finished") line2.push(el("span", "warn", `battery ${fmtNum(bat, 0)}%`));
        const l2 = el("span", "rline r2");
        line2.forEach((x, i) => { if (i) l2.append(" · "); l2.append(x); });
        main.append(top, l1);
        if (l2.childNodes.length) main.append(l2);
        head.append(badge, main);
        if (rankIdx >= 0) { const pos = el("span", "rpos", String(rankIdx + 1)); pos.setAttribute("aria-label", `position ${rankIdx + 1}`); head.append(pos); }
        li.append(head);
        if (selected === r) li.append(detailPanel(r, s, gapText));
        ol.append(li);
      });
      if (!tracked.length) ol.append(el("li", "gaprow quiet", "No riders with live data in this group."));

      // other trackers
      $("#others").hidden = !links.length;
      const ul = $("#others-list"); ul.replaceChildren();
      links.forEach((r) => {
        const li = el("li", "other-row");
        const badge = el("span", "rbadge", String(r.num)); badge.style.background = r.color; badge.style.color = r.ink;
        const a = el("a", "iconbtn", "Open ↗"); a.href = r.spec.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.setAttribute("aria-label", `Open ${r.spec.name}'s live tracking`);
        const txt = el("span", "rmain");
        txt.append(el("span", "rname", r.spec.name), el("span", "rline", trackerName(new URL(r.spec.url).hostname)));
        li.append(badge, txt, a);
        ul.append(li);
      });

      // sort control
      $("#sort-togo").hidden = !route;
      $("#sort-togo").setAttribute("aria-pressed", String(!!useToGo));
      $("#sort-dist").setAttribute("aria-pressed", String(!useToGo));
      return { st, ranked, leader };
    }

    $("#sort-togo").addEventListener("click", () => { sortMode = "togo"; render(); });
    $("#sort-dist").addEventListener("click", () => { sortMode = "dist"; render(); });

    // ================================================================ header
    function renderHeader(st, ranked, leader) {
      const counts = { live: 0, lost: 0, paused: 0, finished: 0 };
      st.forEach((s) => { if (counts[s] != null) counts[s]++; });
      const pill = $("#gstatus");
      let cls = "", text = "Waiting";
      if (counts.live) { cls = "live"; text = `${counts.live} live`; }
      else if (counts.lost) { cls = "lost"; text = "Signal lost"; }
      else if (counts.paused) { cls = "paused"; text = "Paused"; }
      else if (counts.finished) { cls = "done"; text = "Finished"; }
      pill.className = "pill " + cls;
      pill.lastChild.textContent = text;
      const bits = [];
      const onRoad = counts.live + counts.lost + counts.paused;
      bits.push(`${tracked.length + links.length} rider${tracked.length + links.length === 1 ? "" : "s"}`);
      if (onRoad) bits.push(`${onRoad} on the road`);
      if (counts.lost) bits.push(`${counts.lost} without signal`);
      if (counts.finished) bits.push(`${counts.finished} finished`);
      const active = ranked.filter((r) => st.get(r) !== "finished" && sortKey(r) != null);
      if (active.length > 1) bits.push(`spread ${distText(sortKey(active[0]) - sortKey(active[active.length - 1]))}`);
      if (route && route.name) bits.push(route.name);
      if (!tracked.some((r) => r.got) && tracked.length) bits.splice(1, 0, "connecting…");
      if (tracked.some((r) => r.connected === false && r.got)) bits.push("reconnecting…");
      $("#gsub").textContent = bits.join(" · ");
      $("#units").textContent = units === "imperial" ? "mi" : "km";
      $("#theme span").textContent = isDark() ? "Light" : "Dark";
    }

    // ================================================================ render loop
    function render() {
      const now = Date.now();
      const { st, ranked, leader } = renderList(now);
      renderHeader(st, ranked, leader);
      renderViewTools();
      renderMap();
      dataDirty = false;
    }
    // Data arrives in bursts from many riders: redraw at most a few times a second,
    // and once a second anyway so "updated 12 s ago" and stale flags stay current.
    let lastStatusSig = "";
    setInterval(() => {
      if (dataDirty) { mapDirty = true; render(); return; }
      const now = Date.now();
      const sig = tracked.map((r) => statusOf(r, now)).join();
      if (sig !== lastStatusSig) { lastStatusSig = sig; mapDirty = true; }
      render();
    }, 1000);
    // Redraw soon after new data arrives, coalescing bursts from many riders.
    let kickPending = false;
    function kick() {
      if (kickPending) return;
      kickPending = true;
      setTimeout(() => { kickPending = false; if (dataDirty) { mapDirty = true; render(); } }, 250);
    }

    // ================================================================ controls
    $("#units").addEventListener("click", () => {
      units = units === "imperial" ? "metric" : "imperial";
      unitsOverride = units;
      try { localStorage.setItem("karoolive.units", units); } catch (e) { /* ignore */ }
      render();
    });
    $("#theme").addEventListener("click", () => {
      const next = isDark() ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("karoolive.theme", next); } catch (e) { /* ignore */ }
      if (map) { mapReady = false; map.setStyle(next === "dark" ? STYLE_DARK : STYLE_LIGHT, { diff: false }); }
      render();
    });
    $("#edit").addEventListener("click", () => {
      $("#group").hidden = true;
      history.pushState(null, "", location.pathname);
      showBuilder({ name: group.name, riders: group.riders.map((s) => ({ ...s })) });
    });
    $("#copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(location.href); $("#copy").textContent = "Copied"; }
      catch (e) { prompt("Copy this link:", location.href); }
      setTimeout(() => { $("#copy").textContent = "Share"; }, 1600);
    });
    let resizeT;
    addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (map) map.resize(); mapDirty = true; render(); }, 200); });
    addEventListener("popstate", () => location.reload());

    render();
    window.karooLiveGroup = { riders, ranking: () => ranking(Date.now()), get route() { return route; }, get view() { return view; } }; // for debugging and tests
  }
})();
