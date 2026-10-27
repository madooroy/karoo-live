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
    firebaseSource, k2tSource, fromFirebase, fromK2t, merge,
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

  setInterval(renderStatus, 1000);

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
      if (finished && LIVE_ONLY.has(d.key)) return;
      const v = num(c[d.key]);
      if (d.optional && v == null) return;
      sec.append(tile(d, v));
    });
  }


  // ---------------------------------------------------------------- charts
  const CHARTS = [
    { key: "alt", label: "Elevation", fmt: (v) => { const [x, u] = U.elev(v); return [fmtNum(x, 0), u]; }, area: true, minSpan: 30 },
    { key: "spd", label: "Speed", fmt: (v) => { const [x, u] = U.speed(v); return [fmtNum(x, 1), u]; }, minSpan: 3 },
    { key: "pwr", label: "Power", fmt: (v) => [fmtNum(v, 0), "W"], minSpan: 50 },
    { key: "hr", label: "Heart rate", fmt: (v) => [fmtNum(v, 0), "bpm"], minSpan: 20 },
    { key: "cad", label: "Cadence", fmt: (v) => [fmtNum(v, 0), "rpm"], minSpan: 20 },
  ];
  let chartState = null; // {xs, rows, charts:[{def, svg, y, readout, ...}]}
  let hoverPx = null; // pointer position in chart units while the reader is inspecting

  function renderCharts() {
    const box = $("#charts-body");
    const track = (model && model.track) || [];
    const useDist = track.filter((p) => num(p.d) != null).length >= track.length * 0.8 && track.length > 1;
    const rows = track.filter((p) => (useDist ? num(p.d) != null : num(p.t) != null));
    const visible = CHARTS.filter((d) => rows.filter((p) => num(p[d.key]) != null).length >= 2);
    $("#charts").hidden = visible.length === 0;
    if (!visible.length) { chartState = null; return; }
    const xs = rows.map((p) => (useDist ? p.d : p.t));
    const x0 = xs[0], x1 = xs[xs.length - 1] === x0 ? x0 + 1 : xs[xs.length - 1];
    const W = Math.max(280, box.clientWidth || 600), H = 86, padL = 14, padR = 14, padT = 8, padB = 8;
    const sx = (x) => padL + ((x - x0) / (x1 - x0)) * (W - padL - padR);

    box.replaceChildren();
    const charts = [];
    visible.forEach((def) => {
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
      box.append(wrap);
      charts.push({ def, svg, vals, readout, sy, cross: svg.querySelector(".cross"), W });
    });

    const axis = document.createElement("div"); axis.className = "xaxis";
    const a = document.createElement("span"), b = document.createElement("span");
    if (useDist) { a.textContent = "0"; b.textContent = fmtDist(x1 - x0).join(" "); }
    else { a.textContent = new Date(x0).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); b.textContent = new Date(x1).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
    axis.append(a, b);
    box.append(axis);

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
      let v, at = "";
      if (idx == null) {
        // latest value in the track
        for (let i = c.vals.length - 1; i >= 0; i--) if (c.vals[i] != null) { v = c.vals[i]; break; }
        c.cross.setAttribute("visibility", "hidden");
      } else {
        v = c.vals[idx];
        const X = chartState.sx(chartState.xs[idx]);
        c.cross.setAttribute("x1", X); c.cross.setAttribute("x2", X); c.cross.setAttribute("visibility", "visible");
      }
      c.readout.replaceChildren();
      if (v == null) { c.readout.textContent = "—"; return; }
      const [t, u] = c.def.fmt(v);
      c.readout.append(t);
      const s = document.createElement("small"); s.textContent = u + at; c.readout.append(s);
    });
    // where on the ride
    const where = $("#chart-where");
    if (idx == null) { where.textContent = chartState.useDist ? "Drag across to inspect" : ""; if (hoverMarker) hoverMarker.remove(); hoverMarker = null; return; }
    const p = chartState.rows[idx];
    where.textContent = chartState.useDist ? `at ${fmtDist(p.d - chartState.xs[0]).join(" ")}` : new Date(p.t).toLocaleTimeString();
    if (map && num(p.lat) != null) {
      if (!hoverMarker) {
        const el = document.createElement("div"); el.className = "hover-dot";
        hoverMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
      } else hoverMarker.setLngLat([p.lng, p.lat]);
    }
  }

  function onChartPointer(e) {
    if (!chartState) return;
    const svg = chartState.charts[0].svg;
    const r = svg.getBoundingClientRect();
    hoverPx = ((e.clientX - r.left) / r.width) * chartState.W;
    setReadouts(nearestIndex(hoverPx));
  }
  $("#charts-body").addEventListener("pointermove", onChartPointer);
  $("#charts-body").addEventListener("pointerdown", onChartPointer);
  $("#charts-body").addEventListener("pointerleave", () => { hoverPx = null; setReadouts(null); });

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
      else if (model.state === "idle") { cls = "done"; text = "Not riding"; line = (model.endedAt || model.updatedAt) ? `Last ride ended ${ago(Date.now() - (model.endedAt || model.updatedAt))}` : ""; }
      else { text = "Waiting"; line = model.track.length ? "" : "No ride data yet. It appears when the rider starts recording."; }
      if (model.startedAt && model.state !== "idle") line += (line ? " · " : "") + "Started " + new Date(model.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    if (connected === false && gotFirst && fbData) line += (line ? " · " : "") + "Reconnecting…";
    pill.className = "pill " + cls;
    pill.lastChild.textContent = text;
    sub.textContent = line;
    if (problem && model) sub.textContent = line + " · " + problem;
  }

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
    renderMetrics();
    renderMap();
    // charts only need rebuilding when the track grows
    const sig = model ? `${model.track.length}|${model.track.length && model.track[model.track.length - 1].t}|${units}|${$("#charts-body").clientWidth}` : "";
    if (sig !== lastStructure) { lastStructure = sig; renderCharts(); }
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
