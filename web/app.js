/* Karoo Live viewer — https://github.com/madooroy/karoo-live
 *
 * URL parameters:
 *   db   Firebase Realtime Database: project id ("my-proj"), host, or full URL
 *   id   share id written by the Karoo Live extension
 *   k2t  optional KarooTracker (k2tracker.drakey.co.uk) id: Hammerhead's own live
 *        tracking feed, used on its own or to fill gaps when the Firebase feed is quiet
 *   units  optional "imperial" | "metric" to override the rider's setting
 */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);

  const KL = window.KarooLive;
  const { STALE_MS, SAFE_ID, normalizeHost, num, fmtNum, fmtDuration, ago,
    firebaseSource, k2tSource, sendMessage, splitMessage, MSG_PART, fromFirebase, fromK2t, merge,
    STYLE_LIGHT, STYLE_DARK, EMPTY_LINE, css, isDark, lineOf } = KL;

  // ---------------------------------------------------------------- units
  let unitsOverride = params.get("units");
  try { unitsOverride = unitsOverride || localStorage.getItem("karoolive.units"); } catch (e) { /* storage blocked */ }
  let units = unitsOverride || "metric"; // replaced by the rider's preference unless the viewer chose
  const { U, fmtDist } = KL.unitFormatters(() => units);

  // ---------------------------------------------------------------- page
  const dbHost = normalizeHost(params.get("db") || "");
  const shareId = SAFE_ID.test(params.get("id") || "") ? params.get("id") : "";
  const k2tId = SAFE_ID.test((params.get("k2t") || "").split("/").pop()) ? (params.get("k2t") || "").split("/").pop() : "";

  if (!(dbHost && shareId) && !k2tId) { showLanding(); return; }

  $("#live").hidden = false;
  let fbData = null, k2tData = null, problem = "", model = null;
  let gotFirst = false;
  let connected = null; // Firebase connection state (null until known)

  function update() {
    model = merge(fbData, k2tData);
    render();
  }

  if (dbHost && shareId) {
    firebaseSource(dbHost, shareId,
      (tree) => { gotFirst = true; problem = ""; fbData = fromFirebase(tree); update(); },
      (msg) => { problem = msg; render(); },
      (isUp) => { connected = isUp; renderStatus(); });
  }
  if (k2tId) k2tSource(k2tId, (d) => { gotFirst = true; k2tData = fromK2t(d); update(); },
    (msg) => { if (!fbData) { problem = msg; render(); } });

  setInterval(() => { renderStatus(); renderMessaging(); }, 1000);

  // ---------------------------------------------------------------- map
  let map, mapReady = false, riderMarker, riderEl, hoverMarker, follow = true, fitted = false;

  function initMap() {
    if (map) return;
    if (!window.maplibregl) { $("#map-msg").hidden = false; return; }
    map = new maplibregl.Map({
      container: "map",
      style: isDark() ? STYLE_DARK : STYLE_LIGHT,
      center: [-40, 40],
      zoom: 1.5,
      attributionControl: { compact: true },
      cooperativeGestures: matchMedia("(pointer: coarse)").matches, // two fingers to pan on phones, so the page scrolls
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    window.karooLiveMap = map; // handy for debugging in the browser console
    map.on("load", () => {
      map.addSource("route", { type: "geojson", data: EMPTY_LINE });
      map.addSource("track", { type: "geojson", data: EMPTY_LINE });
      map.addLayer({ id: "route", type: "line", source: "route",
        layout: { "line-join": "round" },
        paint: { "line-color": css("--route"), "line-width": 4, "line-opacity": 0.85, "line-dasharray": [2, 1.5] } });
      map.addLayer({ id: "track-casing", type: "line", source: "track",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": isDark() ? "#0f0f0e" : "#ffffff", "line-width": 9, "line-opacity": 0.9 } });
      map.addLayer({ id: "track", type: "line", source: "track",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": css("--track"), "line-width": 5 } });
      mapReady = true;
      renderMap();
    });
    map.on("dragstart", (e) => { if (e.originalEvent) { follow = false; $("#recenter").hidden = false; } });
    map.on("error", (e) => console.warn("Map:", e && e.error ? e.error.message : e));
  }

  function setRider(lat, lng, brg) {
    if (!riderMarker) {
      riderEl = document.createElement("div");
      riderEl.className = "rider";
      riderEl.setAttribute("aria-label", "Rider position");
      riderMarker = new maplibregl.Marker({ element: riderEl, rotationAlignment: "map" }).setLngLat([lng, lat]).addTo(map);
    }
    riderEl.classList.toggle("heading", brg != null);
    riderMarker.setLngLat([lng, lat]).setRotation(brg || 0);
  }

  function renderMap() {
    initMap();
    if (!map || !model) return;
    const pts = model.track.map((p) => [p.lat, p.lng]);
    const c = model.cur;
    const hasPos = num(c.lat) != null && num(c.lng) != null;
    if (hasPos && (!pts.length || pts[pts.length - 1][0] !== c.lat || pts[pts.length - 1][1] !== c.lng)) pts.push([c.lat, c.lng]);
    const routePts = model.route ? model.route.points : [];
    $("#legend-route").hidden = !model.route;
    if (hasPos) setRider(c.lat, c.lng, num(c.brg));
    if (!mapReady) return;
    map.getSource("track").setData(lineOf(pts));
    map.getSource("route").setData(lineOf(routePts));

    if (!fitted) {
      map.resize(); // the page layout may have changed since the map was created
      const all = [...pts, ...routePts];
      if (all.length > 1) {
        const b = new maplibregl.LngLatBounds();
        all.forEach(([lat, lng]) => b.extend([lng, lat]));
        map.fitBounds(b, { padding: 48, maxZoom: 15, duration: 0 });
        fitted = true;
      } else if (hasPos) { map.jumpTo({ center: [c.lng, c.lat], zoom: 15 }); fitted = true; }
    } else if (follow && hasPos && model.state === "recording") {
      // keep the rider comfortably inside the view
      const p = map.project([c.lng, c.lat]), el = map.getContainer();
      const mx = 24, my = 24; // only move when the rider is (nearly) off the visible map
      if (p.x < mx || p.y < my || p.x > el.clientWidth - mx || p.y > el.clientHeight - my) map.easeTo({ center: [c.lng, c.lat], duration: 600 });
    }
  }

  $("#recenter").addEventListener("click", () => {
    follow = true; $("#recenter").hidden = true;
    const c = model && model.cur;
    if (c && num(c.lat) != null) map.easeTo({ center: [c.lng, c.lat], zoom: Math.max(map.getZoom(), 14) });
  });

  // ---------------------------------------------------------------- metrics
  const PRIMARY = [
    { key: "spd", color: "spd", label: "Speed", tag: "3s", fmt: (v) => { const [x, u] = U.speed(v); return [fmtNum(x, 1), u]; },
      foot: (c) => c.avgSpd != null ? "avg " + U.speed(c.avgSpd).map((x, i) => i ? x : fmtNum(x, 1)).join(" ") : "" },
    { key: "pwr", color: "pwr", label: "Power", tag: "3s", fmt: (v) => [fmtNum(v, 0), "W"],
      foot: (c) => [c.avgPwr != null ? `avg ${fmtNum(c.avgPwr, 0)} W` : "", c.np != null ? `NP ${fmtNum(c.np, 0)} W` : ""].filter(Boolean).join(" · ") },
    { key: "hr", color: "hr", label: "Heart rate", tag: "", fmt: (v) => [fmtNum(v, 0), "bpm"], foot: () => "" },
    { key: "cad", color: "cad", label: "Cadence", tag: "3s", fmt: (v) => [fmtNum(v, 0), "rpm"], foot: () => "" },
  ];
  const SECONDARY = [
    { key: "dist", label: "Distance", fmt: (v) => fmtDist(v) },
    { key: "el", label: "Elapsed", fmt: (v) => [fmtDuration(v), ""] },
    { key: "rt", label: "Moving", fmt: (v) => [fmtDuration(v), ""] },
    { key: "gain", label: "Climbed", fmt: (v) => { const [x, u] = U.elev(v); return [fmtNum(x, 0), u]; } },
    { key: "alt", label: "Elevation", fmt: (v) => { const [x, u] = U.elev(v); return [fmtNum(x, 0), u]; } },
    { key: "grade", label: "Grade", fmt: (v) => [fmtNum(v, 1), "%"] },
    { key: "toGo", label: "To go", fmt: (v) => fmtDist(v), optional: true },
    { key: "climbLeft", label: "Climb left", fmt: (v) => { const [x, u] = U.elev(v); return [fmtNum(x, 0), u]; }, optional: true },
    { key: "temp", label: "Temp", fmt: (v) => { const [x, u] = U.temp(v); return [fmtNum(x, 0), u]; }, optional: true },
    { key: "gear", label: "Gear", optional: true, liveOnly: true, fmt: () => [gearText((model && model.cur) || {}), ""] },
    { key: "shifts", label: "Shifts", optional: true, fmt: (v) => [fmtNum(v, 0), ""] },
    { key: "avgGear", label: "Avg gear", optional: true, finishedOnly: true, fmt: (v) => [fmtNum(v, 1), ""] },
    { key: "bat", label: "Battery", fmt: (v) => [fmtNum(v, 0), "%"] },
  ];

  function tile(def, value, extraClass) {
    const el = document.createElement("div");
    el.className = "metric " + (extraClass || "");
    const label = document.createElement("div"); label.className = "label";
    const left = document.createElement("span");
    if (def.color) { const sw = document.createElement("i"); sw.className = "swatch"; sw.style.background = `var(--c-${def.color})`; sw.setAttribute("aria-hidden", "true"); left.append(sw); }
    left.append(def.label);
    label.append(left);
    if (def.tag) { const s = document.createElement("small"); s.textContent = def.tag; label.append(s); }
    const val = document.createElement("div"); val.className = "value";
    if (value == null) { val.textContent = "—"; val.classList.add("na"); }
    else {
      const [text, unit] = def.fmt(value);
      val.append(text);
      if (unit) { const u = document.createElement("span"); u.className = "unit"; u.textContent = unit; val.append(u); }
    }
    el.append(label, val);
    return el;
  }

  /** "7" for a gearbox, "2 × 9" for front and rear derailleurs. */
  function gearText(p, gear) {
    const g = num(gear ?? p.gear);
    if (g == null) return "—";
    return num(p.fg) != null ? `${fmtNum(p.fg, 0)} × ${fmtNum(g, 0)}` : fmtNum(g, 0);
  }

  // After the ride: averages instead of live values (cadence average ignores coasting, like most apps).
  function trackStats(key, skipZero) {
    const vals = ((model && model.track) || []).map((p) => num(p[key])).filter((v) => v != null && (!skipZero || v > 0));
    if (!vals.length) return null;
    return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, max: Math.max(...vals) };
  }
  const SUMMARY = [
    { key: "spd", color: "spd", label: "Avg speed",
      value: (c) => num(c.avgSpd) ?? (trackStats("spd") || {}).avg,
      fmt: (v) => { const [x, u] = U.speed(v); return [fmtNum(x, 1), u]; },
      foot: () => { const s = trackStats("spd"); return s ? "max " + U.speed(s.max).map((x, i) => (i ? x : fmtNum(x, 1))).join(" ") : ""; } },
    { key: "pwr", color: "pwr", label: "Avg power",
      value: (c) => num(c.avgPwr) ?? (trackStats("pwr") || {}).avg,
      fmt: (v) => [fmtNum(v, 0), "W"],
      foot: (c) => (c.np != null ? `NP ${fmtNum(c.np, 0)} W` : "") },
    { key: "hr", color: "hr", label: "Avg heart rate",
      value: () => (trackStats("hr") || {}).avg,
      fmt: (v) => [fmtNum(v, 0), "bpm"],
      foot: () => { const s = trackStats("hr"); return s ? `max ${fmtNum(s.max, 0)} bpm` : ""; } },
    { key: "cad", color: "cad", label: "Avg cadence",
      value: () => (trackStats("cad", true) || {}).avg,
      fmt: (v) => [fmtNum(v, 0), "rpm"],
      foot: () => "" },
  ];
  // Values that only make sense while riding.
  const LIVE_ONLY = new Set(["alt", "grade", "toGo", "climbLeft"]);

  function renderMetrics() {
    const c = (model && model.cur) || {};
    const stale = !model || model.state !== "recording" || isStale();
    const prim = $("#metrics-primary"); prim.replaceChildren();
    // Only show sensor tiles this rider actually has: a metric appears once it has had a value
    // this ride. Speed always shows (GPS provides it). With no ride data yet, show them all.
    const hasRide = model && (model.track.length || Object.keys(c).length);
    const seen = (key) => key === "spd" || !hasRide || num(c[key]) != null || model.track.some((p) => num(p[key]) != null);
    const finished = hasRide && model.state === "idle";
    if (finished) {
      SUMMARY.filter((d) => seen(d.key)).forEach((d) => {
        const v = d.value(c);
        const t = tile(d, v == null ? null : v, "card");
        const foot = document.createElement("div"); foot.className = "foot"; foot.textContent = d.foot(c);
        t.append(foot);
        prim.append(t);
      });
    } else {
      PRIMARY.filter((d) => seen(d.key)).forEach((d) => {
        // Instant values are meaningless once the rider has stopped or the signal is gone.
        const v = stale && model && model.state !== "paused" ? null : num(c[d.key]);
        const t = tile(d, v, "card");
        const foot = document.createElement("div"); foot.className = "foot"; foot.textContent = d.foot(c);
        t.append(foot);
        prim.append(t);
      });
    }
    const sec = $("#metrics-secondary"); sec.replaceChildren();
    SECONDARY.forEach((d) => {
      if (finished && (LIVE_ONLY.has(d.key) || d.liveOnly)) return;
      if (!finished && d.finishedOnly) return;
      const v = d.key === "avgGear" ? (trackStats("gear") || {}).avg ?? null : num(c[d.key]);
      if (d.optional && v == null) return;
      sec.append(tile(d, v));
    });
  }


  // ---------------------------------------------------------------- charts
  const CHARTS = [
    { key: "alt", label: "Elevation", short: "Elev", fmt: (v) => { const [x, u] = U.elev(v); return [fmtNum(x, 0), u]; }, area: true, minSpan: 30 },
    { key: "spd", label: "Speed", fmt: (v) => { const [x, u] = U.speed(v); return [fmtNum(x, 1), u]; }, minSpan: 3 },
    { key: "pwr", label: "Power", fmt: (v) => [fmtNum(v, 0), "W"], minSpan: 50 },
    { key: "hr", label: "Heart rate", short: "HR", fmt: (v) => [fmtNum(v, 0), "bpm"], minSpan: 20 },
    { key: "cad", label: "Cadence", short: "Cad", fmt: (v) => [fmtNum(v, 0), "rpm"], minSpan: 20 },
    { key: "gear", label: "Gear", fmt: (v) => [fmtNum(v, 0), ""], minSpan: 3, step: true },
  ];
  let chartState = null; // {xs, rows, charts:[{def, svg, y, readout, ...}]}
  let hoverPx = null;
  let quickKey = "alt";
  try { quickKey = localStorage.getItem("karoolive.quick") || "alt"; } catch (e) { /* storage blocked */ } // pointer position in chart units while the reader is inspecting

  /** Draws one metric's chart; shared by the full chart list and the chart under the map. */
  function drawChart(def, rows, xs, sx, W, H) {
    const padL = 14, padR = 14, padT = 8, padB = 8;
    const vals = rows.map((p) => num(p[def.key]));
    const present = vals.filter((v) => v != null);
    const vmin = Math.min(...present), vmax = Math.max(...present);
    const span = Math.max(vmax - vmin, def.minSpan || 1);
    const lo = vmin - span * 0.08, hi = vmin + span * 1.08;
    const sy = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

    // break the line where samples are missing or there is a long time gap
    let d = "", area = "", open = false, segStart = null, lastX = null;
    const gapMs = 120000;
    rows.forEach((p, i) => {
      const v = vals[i];
      const gap = i > 0 && num(p.t) != null && num(rows[i - 1].t) != null && p.t - rows[i - 1].t > gapMs;
      if (v == null || gap) {
        if (open && def.area) area += `L${lastX.toFixed(1)},${H - padB}L${segStart.toFixed(1)},${H - padB}Z`;
        open = false;
        if (v == null) return;
      }
      const X = sx(xs[i]), Y = sy(v);
      if (!open) { d += `M${X.toFixed(1)},${Y.toFixed(1)}`; if (def.area) area += `M${X.toFixed(1)},${Y.toFixed(1)}`; segStart = X; open = true; }
      else if (def.step) { d += `H${X.toFixed(1)}V${Y.toFixed(1)}`; }
      else { d += `L${X.toFixed(1)},${Y.toFixed(1)}`; if (def.area) area += `L${X.toFixed(1)},${Y.toFixed(1)}`; }
      lastX = X;
    });
    if (open && def.area) area += `L${lastX.toFixed(1)},${H - padB}L${segStart.toFixed(1)},${H - padB}Z`;

    const wrap = document.createElement("div"); wrap.className = "chart";
    wrap.style.setProperty("--chart-color", `var(--c-${def.key})`);
    const title = document.createElement("div"); title.className = "chart-title";
    const name = document.createElement("span");
    const sw = document.createElement("i"); sw.className = "swatch"; sw.setAttribute("aria-hidden", "true");
    name.append(sw, def.label);
    const range = document.createElement("small"); range.className = "range";
    range.textContent = `${def.fmt(vmin)[0]}–${def.fmt(vmax).join(" ")}`;
    name.append(range);
    const readout = document.createElement("span"); readout.className = "readout";
    title.append(name, readout);
    const [hiTxt, unit] = def.fmt(vmax), [loTxt] = def.fmt(vmin);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${def.label} over the ride, from ${loTxt} to ${hiTxt} ${unit}`);
    svg.innerHTML =
      `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${padT}" y2="${padT}"/>` +
      `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/>` +
      (def.area ? `<path class="area" d="${area}"/>` : "") +
      `<path class="series" d="${d}" vector-effect="non-scaling-stroke"/>` +
      `<line class="cross" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden" vector-effect="non-scaling-stroke"/>`;
    wrap.append(title, svg);
    return { def, svg, vals, readout, sy, cross: svg.querySelector(".cross"), W, wrap };
  }

  function renderCharts() {
    const box = $("#charts-body");
    const track = (model && model.track) || [];
    const useDist = track.filter((p) => num(p.d) != null).length >= track.length * 0.8 && track.length > 1;
    const rows = track.filter((p) => (useDist ? num(p.d) != null : num(p.t) != null));
    const visible = CHARTS.filter((d) => rows.filter((p) => num(p[d.key]) != null).length >= 2);
    $("#charts").hidden = visible.length === 0;
    if (!visible.length) { chartState = null; $("#quick").hidden = true; return; }
    const xs = rows.map((p) => (useDist ? p.d : p.t));
    const x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
    const W = Math.max(280, box.clientWidth || 600), H = 86, padL = 14, padR = 14, padT = 8, padB = 8;
    const sx = (x) => padL + ((x - x0) / (x1 - x0)) * (W - padL - padR);

    box.replaceChildren();
    const charts = [];
    visible.forEach((def) => {
      const c = drawChart(def, rows, xs, sx, W, H);
      box.append(c.wrap);
      charts.push(c);
    });

    const axis = document.createElement("div"); axis.className = "xaxis";
    const a = document.createElement("span"), b = document.createElement("span");
    if (useDist) { a.textContent = "0"; b.textContent = fmtDist(x1 - x0).join(" "); }
    else { a.textContent = new Date(x0).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); b.textContent = new Date(x1).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
    axis.append(a, b);
    box.append(axis);

    // One chart under the map (picker chooses which), so phones see map + chart together.
    const quick = $("#quick"), qBody = $("#quick-body"), qPick = $("#quick-pick");
    quick.hidden = false;
    if (!visible.some((d) => d.key === quickKey)) quickKey = visible[0].key;
    qPick.replaceChildren();
    visible.forEach((d) => {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "chip" + (d.key === quickKey ? " on" : "");
      btn.style.setProperty("--chart-color", `var(--c-${d.key})`);
      btn.setAttribute("aria-pressed", String(d.key === quickKey));
      btn.textContent = d.short || d.label;
      btn.addEventListener("click", () => {
        quickKey = d.key;
        try { localStorage.setItem("karoolive.quick", quickKey); } catch (e) { /* ignore */ }
        lastStructure = ""; render();
      });
      qPick.append(btn);
    });
    const qc = drawChart(visible.find((d) => d.key === quickKey), rows, xs, sx, W, 96);
    qBody.replaceChildren(qc.wrap);
    charts.push(qc);

    chartState = { rows, xs, sx, charts, useDist, W, padL, padR };
    setReadouts(hoverPx == null ? null : nearestIndex(hoverPx));
    renderTable(rows, useDist);
  }

  function nearestIndex(px) {
    const { xs, sx } = chartState;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < xs.length; i++) { const dd = Math.abs(sx(xs[i]) - px); if (dd < bestD) { bestD = dd; best = i; } }
    return best;
  }

  function setReadouts(idx) {
    if (!chartState) return;
    chartState.charts.forEach((c) => {
      let v, at = "", row = null;
      if (idx == null) {
        // latest value in the track
        for (let i = c.vals.length - 1; i >= 0; i--) if (c.vals[i] != null) { v = c.vals[i]; row = chartState.rows[i]; break; }
        c.cross.setAttribute("visibility", "hidden");
      } else {
        v = c.vals[idx];
        row = chartState.rows[idx];
        const X = chartState.sx(chartState.xs[idx]);
        c.cross.setAttribute("x1", X); c.cross.setAttribute("x2", X); c.cross.setAttribute("visibility", "visible");
      }
      c.readout.replaceChildren();
      if (v == null) { c.readout.textContent = "—"; return; }
      const [t, u] = c.def.key === "gear" ? [gearText(row || {}, v), ""] : c.def.fmt(v);
      c.readout.append(t);
      const s = document.createElement("small"); s.textContent = u + at; c.readout.append(s);
    });
    // where on the ride
    const wheres = [$("#chart-where"), $("#quick-where")];
    if (idx == null) {
      wheres.forEach((w) => { w.textContent = chartState.useDist ? "Drag across to inspect" : ""; });
      if (hoverMarker) hoverMarker.remove(); hoverMarker = null; return;
    }
    const p = chartState.rows[idx];
    const whereText = chartState.useDist ? `at ${fmtDist(p.d - chartState.xs[0]).join(" ")}` : new Date(p.t).toLocaleTimeString();
    wheres.forEach((w) => { w.textContent = whereText; });
    if (map && num(p.lat) != null) {
      if (!hoverMarker) {
        const el = document.createElement("div"); el.className = "hover-dot";
        hoverMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
      } else hoverMarker.setLngLat([p.lng, p.lat]);
    }
  }

  function onChartPointer(e) {
    if (!chartState) return;
    const svg = e.target.closest && e.target.closest(".chart") ? e.target.closest(".chart").querySelector("svg") : chartState.charts[0].svg;
    const r = svg.getBoundingClientRect();
    hoverPx = ((e.clientX - r.left) / r.width) * chartState.W;
    setReadouts(nearestIndex(hoverPx));
  }
  $("#charts-body").addEventListener("pointermove", onChartPointer);
  $("#charts-body").addEventListener("pointerdown", onChartPointer);
  $("#charts-body").addEventListener("pointerleave", () => { hoverPx = null; setReadouts(null); });
  $("#quick-body").addEventListener("pointermove", onChartPointer);
  $("#quick-body").addEventListener("pointerdown", onChartPointer);
  $("#quick-body").addEventListener("pointerleave", () => { hoverPx = null; setReadouts(null); });

  function renderTable(rows, useDist) {
    const body = $("#table-body"); body.replaceChildren();
    if (!rows.length) return;
    const step = Math.max(1, Math.ceil(rows.length / 40));
    for (let i = 0; i < rows.length; i += step) {
      const p = rows[i];
      const tr = document.createElement("tr");
      const cells = [
        useDist ? fmtDist(p.d - rows[0].d).join(" ") : new Date(p.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        num(p.spd) != null ? U.speed(p.spd).map((x, j) => (j ? x : fmtNum(x, 1))).join(" ") : "—",
        num(p.pwr) != null ? fmtNum(p.pwr, 0) : "—",
        num(p.hr) != null ? fmtNum(p.hr, 0) : "—",
        num(p.cad) != null ? fmtNum(p.cad, 0) : "—",
        num(p.alt) != null ? U.elev(p.alt).map((x, j) => (j ? x : fmtNum(x, 0))).join(" ") : "—",
      ];
      cells.forEach((c) => { const td = document.createElement("td"); td.textContent = c; tr.append(td); });
      body.append(tr);
    }
  }

  // ---------------------------------------------------------------- splits
  // Per mile or km (following the rider's units), like Garmin LiveTrack. Time is moving time:
  // stretches where the rider covered no ground (stops, pauses) are left out.
  const SPLIT_LENGTHS = [1, 5, 10];
  let splitLen = null; // null = choose automatically
  try { splitLen = Number(localStorage.getItem("karoolive.split")) || null; } catch (e) { /* storage blocked */ }

  function computeSplits(rows, L) {
    const out = [];
    const get = (i) => out[i] || (out[i] = { i, dist: 0, time: 0, gain: 0, w: {}, sum: {} });
    const add = (s, k, v, wt) => { if (v == null || wt <= 0) return; s.w[k] = (s.w[k] || 0) + wt; s.sum[k] = (s.sum[k] || 0) + v * wt; };
    const mid = (a, b, k, skipZero) => {
      let x = num(a[k]), y = num(b[k]);
      if (skipZero) { if (x === 0) x = null; if (y === 0) y = null; }
      return x != null && y != null ? (x + y) / 2 : (x ?? y);
    };
    let ref = null;
    for (let j = 1; j < rows.length; j++) {
      const a = rows[j - 1], b = rows[j];
      const dd = b.d - a.d, dt = b.t - a.t;
      // climbing, with 1 m hysteresis so sensor noise doesn't add up
      const alt = num(b.alt);
      if (alt != null) {
        if (ref == null) ref = num(a.alt) ?? alt;
        if (alt > ref + 1) { get(Math.floor(Math.max(0, b.d) / L)).gain += alt - ref; ref = alt; }
        else if (alt < ref - 1) ref = alt;
      }
      if (!(dt > 0) || !(dd > 0) || dd / (dt / 1000) < 0.5) continue; // stopped
      const v = { pwr: mid(a, b, "pwr"), hr: mid(a, b, "hr"), cad: mid(a, b, "cad", true) };
      let start = Math.max(0, a.d);
      const end = b.d;
      while (start < end - 1e-6) {
        const idx = Math.floor(start / L + 1e-9);
        const segEnd = Math.min(end, (idx + 1) * L);
        const wt = dt * ((segEnd - start) / dd);
        const s = get(idx);
        s.dist += segEnd - start; s.time += wt;
        Object.keys(v).forEach((k) => add(s, k, v[k], wt));
        start = segEnd;
      }
    }
    return out.filter(Boolean);
  }

  function renderSplits() {
    const box = $("#splits");
    const rows = ((model && model.track) || []).filter((p) => num(p.t) != null && num(p.d) != null);
    const unitM = units === "imperial" ? 1609.344 : 1000;
    const total = rows.length > 1 ? rows[rows.length - 1].d : 0;
    if (rows.length < 2 || total < unitM * 0.5) { box.hidden = true; return; }
    box.hidden = false;
    const auto = SPLIT_LENGTHS.find((n) => total / (n * unitM) <= 20) || SPLIT_LENGTHS[SPLIT_LENGTHS.length - 1];
    const len = SPLIT_LENGTHS.includes(splitLen) && total >= splitLen * unitM ? splitLen : auto;
    const uName = units === "imperial" ? "mi" : "km";

    const pick = $("#split-pick"); pick.replaceChildren();
    SPLIT_LENGTHS.filter((n) => n === 1 || total >= n * unitM).forEach((n) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip" + (n === len ? " on" : "");
      b.setAttribute("aria-pressed", String(n === len));
      b.textContent = `${n} ${uName}`;
      b.addEventListener("click", () => {
        splitLen = n;
        try { localStorage.setItem("karoolive.split", String(n)); } catch (e) { /* ignore */ }
        renderSplits();
      });
      pick.append(b);
    });
    if (pick.children.length < 2) pick.replaceChildren();

    const L = len * unitM;
    const splits = computeSplits(rows, L).filter((s) => s.dist >= L * 0.05);
    const tot = { dist: 0, time: 0, gain: 0, w: {}, sum: {} };
    splits.forEach((s) => {
      tot.dist += s.dist; tot.time += s.time; tot.gain += s.gain;
      Object.keys(s.w).forEach((k) => { tot.w[k] = (tot.w[k] || 0) + s.w[k]; tot.sum[k] = (tot.sum[k] || 0) + s.sum[k]; });
    });
    const avg = (s, k) => (s.w[k] ? s.sum[k] / s.w[k] : null);
    const COLS = [
      { label: "Time", cell: (s) => (s.time ? fmtDuration(s.time) : "—") },
      { label: "Speed", color: "spd", cell: (s) => (s.time ? fmtNum(U.speed(s.dist / (s.time / 1000))[0], 1) : "—"), unit: () => U.speed(1)[1] },
      { label: "Climb", color: "alt", key: "alt", cell: (s) => fmtNum(U.elev(s.gain)[0], 0), unit: () => U.elev(1)[1] },
      { label: "Power", color: "pwr", key: "pwr", cell: (s) => (avg(s, "pwr") != null ? fmtNum(avg(s, "pwr"), 0) : "—"), unit: () => "W" },
      { label: "HR", color: "hr", key: "hr", cell: (s) => (avg(s, "hr") != null ? fmtNum(avg(s, "hr"), 0) : "—") },
      { label: "Cad", color: "cad", key: "cad", cell: (s) => (avg(s, "cad") != null ? fmtNum(avg(s, "cad"), 0) : "—") },
    ].filter((c) => !c.key || rows.some((p) => num(p[c.key]) != null));

    const head = $("#split-head"); head.replaceChildren();
    const htr = document.createElement("tr");
    [{ label: uName }, ...COLS].forEach((c) => {
      const th = document.createElement("th");
      if (c.color) { const i = document.createElement("i"); i.style.background = `var(--c-${c.color})`; i.setAttribute("aria-hidden", "true"); th.append(i); }
      th.append(c.label);
      const u = document.createElement("small"); u.textContent = c.unit ? c.unit() : c.label === "HR" ? "bpm" : c.label === "Cad" ? "rpm" : "\u00a0"; th.append(u);
      htr.append(th);
    });
    head.append(htr);

    const body = $("#split-body"); body.replaceChildren();
    const live = model.state !== "idle";
    splits.forEach((s, n) => {
      const tr = document.createElement("tr");
      const full = s.dist >= L * 0.995;
      const first = document.createElement("td");
      // full splits are labelled by where they end (1, 2, 3… or 5, 10, 15…); a partial one by its length
      first.textContent = full ? String((s.i + 1) * len) : `+${fmtNum(s.dist / unitM, 2)}`;
      if (!full) { first.className = "part"; first.title = live && n === splits.length - 1 ? "In progress" : "Partial split"; }
      tr.append(first);
      COLS.forEach((c) => { const td = document.createElement("td"); td.textContent = c.cell(s); tr.append(td); });
      body.append(tr);
    });

    const foot = $("#split-foot"); foot.replaceChildren();
    if (splits.length > 1) {
      const tr = document.createElement("tr");
      const first = document.createElement("td"); first.textContent = fmtNum(tot.dist / unitM, 1); first.title = "Total";
      tr.append(first);
      COLS.forEach((c) => { const td = document.createElement("td"); td.textContent = c.cell(tot); tr.append(td); });
      foot.append(tr);
    }
  }

  // ---------------------------------------------------------------- status
  function isStale() { return model && model.updatedAt && Date.now() - model.updatedAt > STALE_MS; }

  function renderStatus() {
    const pill = $("#status"), sub = $("#sub");
    let cls = "", text = "Waiting", line = "";
    if (problem && !model) { text = "Offline"; line = problem; }
    else if (!model) { text = "Waiting"; line = gotFirst ? "No ride data yet. It appears when the rider starts recording." : "Connecting…"; }
    else {
      const age = model.updatedAt ? Date.now() - model.updatedAt : null;
      if (model.state === "recording" && !isStale()) { cls = "live"; text = "Live"; line = age != null ? `Updated ${ago(age)}` : ""; }
      else if (model.state === "recording") { cls = "lost"; text = "Signal lost"; line = `Last update ${ago(age)}. The rider may be out of coverage.`; }
      else if (model.state === "paused") { cls = "paused"; text = "Paused"; line = age != null ? `Updated ${ago(age)}` : ""; }
      else if (model.state === "idle") {
        cls = "done"; text = "Not riding";
        const end = model.endedAt || model.updatedAt;
        const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        line = end ? `Last ride ended ${ago(Date.now() - end)}` : "";
        if (end && model.startedAt && model.track.length) line += ` · ${clock(model.startedAt)}–${clock(end)}`;
      }
      else { text = "Waiting"; line = model.track.length ? "" : "No ride data yet. It appears when the rider starts recording."; }
      if (model.startedAt && model.state !== "idle") line += (line ? " · " : "") + "Started " + new Date(model.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    if (connected === false && gotFirst && fbData) line += (line ? " · " : "") + "Reconnecting…";
    pill.className = "pill " + cls;
    pill.lastChild.textContent = text;
    sub.textContent = line;
    if (problem && model) sub.textContent = line + " · " + problem;
  }

  // ---------------------------------------------------------------- send a message
  let msgOpen = false, msgBusy = false;
  try { $("#msg-from").value = localStorage.getItem("karoolive.from") || ""; } catch (e) { /* storage blocked */ }
  function msgInfo() { return fbData && fbData.msg && fbData.msg.on ? fbData.msg : null; }
  function msgAllowed() { return !!(msgInfo() && model && model.state === "recording" && !isStale()); }
  function setNote(text, cls) { const n = $("#msg-note"); n.textContent = text; n.className = "msg-note " + (cls || ""); }
  function renderMessaging() {
    const offered = !!msgInfo();
    $("#msg-open").hidden = !offered || msgOpen || !msgAllowed();
    $("#msg").hidden = !offered || !msgOpen;
    $("#msg-send").disabled = msgBusy || !msgAllowed();
    if (msgOpen) renderSent();
    if (msgOpen && !msgBusy && !msgAllowed() && !$("#msg-note").classList.contains("ok")) setNote("Messages open again when the rider is recording.");
    else if (msgOpen && !msgBusy && msgAllowed() && $("#msg-note").textContent.startsWith("Messages open again")) setNote("");
  }
  function updateCount() {
    const text = $("#msg-text").value, parts = splitMessage(text);
    const count = $("#msg-count");
    count.textContent = `${text.length}/100` + (parts.length > 1 ? ` · arrives in ${parts.length} parts` : "");
    count.classList.toggle("warn", text.trim().length > MSG_PART);
    const box = $("#msg-preview"), list = $("#msg-preview-parts");
    box.hidden = parts.length < 2;
    list.replaceChildren();
    if (parts.length < 2) return;
    const from = ($("#msg-from").value.trim() || "Your name").toUpperCase();
    parts.forEach((p, i) => {
      const b = document.createElement("div"); b.className = "kbanner";
      const t = document.createElement("b"); t.textContent = `${from} ${i + 1}/${parts.length}`;
      const d = document.createElement("span"); d.textContent = p;
      b.append(t, d); list.append(b);
    });
  }
  $("#msg-from").addEventListener("input", updateCount);

  // What this viewer has sent during the current ride (kept on this device only, like Garmin's list).
  function sentKey() { return model && model.startedAt ? `karoolive.sent.${dbHost}.${shareId}.${model.startedAt}` : null; }
  function loadSent() { try { return JSON.parse(localStorage.getItem(sentKey()) || "[]"); } catch (e) { return []; } }
  function saveSent(list) {
    try {
      localStorage.setItem(sentKey(), JSON.stringify(list.slice(-30)));
      // forget earlier rides on this link
      Object.keys(localStorage).filter((k) => k.startsWith(`karoolive.sent.${dbHost}.${shareId}.`) && k !== sentKey()).forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* storage blocked */ }
  }
  let sentShown = "";
  function renderSent() {
    const list = sentKey() ? loadSent() : [];
    const sig = sentKey() + "|" + list.length;
    if (sig === sentShown) return;
    sentShown = sig;
    $("#msg-sent").hidden = !list.length;
    const ol = $("#msg-sent-list"); ol.replaceChildren();
    list.forEach((m) => {
      const li = document.createElement("li");
      const time = document.createElement("time"); time.textContent = new Date(m.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      li.append(time, " ", m.text);
      ol.append(li);
    });
  }
  $("#msg-text").addEventListener("input", updateCount);
  $("#msg-open").addEventListener("click", () => {
    msgOpen = true; setNote(""); renderMessaging();
    $("#msg-open").setAttribute("aria-expanded", "true");
    ($("#msg-from").value ? $("#msg-text") : $("#msg-from")).focus();
  });
  $("#msg-cancel").addEventListener("click", () => { msgOpen = false; renderMessaging(); });
  $("#msg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const from = $("#msg-from").value.trim().slice(0, 30), text = $("#msg-text").value.trim().slice(0, 100);
    const info = msgInfo();
    if (!from || !text || !info || msgBusy) return;
    try { localStorage.setItem("karoolive.from", from); } catch (err) { /* ignore */ }
    msgBusy = true; renderMessaging(); setNote("Sending…");
    try {
      await sendMessage(dbHost, info.key, shareId, from, text, (ms) => setNote(`Messages are spaced out a little. Sending in ${Math.ceil(ms / 1000)} s…`));
      if (sentKey()) { const list = loadSent(); list.push({ t: Date.now(), text }); saveSent(list); renderSent(); }
      $("#msg-text").value = ""; updateCount();
      setNote("Sent. It pops up on the rider's Karoo within about a minute.", "ok");
    } catch (err) {
      setNote(err.message || "Couldn't send.", "bad");
    }
    msgBusy = false; renderMessaging();
  });

  let lastStructure = "";
  function render() {
    if (model) {
      if (!unitsOverride && model.units) units = model.units;
      const name = model.name || "Rider";
      $("#rider").textContent = name;
      document.title = `${name} · Karoo Live`;
    }
    $("#units").textContent = units === "imperial" ? "mi" : "km";
    renderStatus();
    renderMessaging();
    renderMetrics();
    renderMap();
    // charts only need rebuilding when the track grows
    const sig = model ? `${model.track.length}|${model.track.length && model.track[model.track.length - 1].t}|${units}|${$("#charts-body").clientWidth}` : "";
    if (sig !== lastStructure) { lastStructure = sig; renderCharts(); renderSplits(); }
  }

  $("#units").addEventListener("click", () => {
    units = units === "imperial" ? "metric" : "imperial";
    unitsOverride = units;
    try { localStorage.setItem("karoolive.units", units); } catch (e) { /* ignore */ }
    lastStructure = ""; render();
  });
  let resizeT;
  addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (map) map.resize(); lastStructure = ""; render(); }, 200); });

  $("#copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); $("#copy").textContent = "Copied"; }
    catch (e) { prompt("Copy this link:", location.href); }
    setTimeout(() => { $("#copy").textContent = "Share"; }, 1600);
  });

  render();

  // ---------------------------------------------------------------- landing
  function showLanding() {
    $("#landing").hidden = false;
    document.title = "Karoo Live";
    $("#open-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const v = $("#open-input").value.trim();
      if (!v) return;
      const hint = $("#open-hint");
      // A full link (with or without https://) opens directly.
      if (/[?&]id=/.test(v) || /^(https?:\/\/)?[^\s]+\?/i.test(v)) {
        location.href = /^https?:\/\//i.test(v) ? v : "https://" + v;
        return;
      }
      const id = v.split("/").pop();
      // KarooTracker / Hammerhead tracking ids are 8 characters; Karoo Live ids need the whole link.
      if (/^[A-Za-z0-9]{8}$/.test(id)) { location.search = "?k2t=" + encodeURIComponent(id); return; }
      hint.textContent = "That looks like part of a Karoo Live link. Paste the whole link: it starts with https://mybikeride.live/?db=…";
      hint.hidden = false;
    });
  }
})();
