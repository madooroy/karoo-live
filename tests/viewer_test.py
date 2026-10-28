"""Headless Chromium tests for the viewer pages, against a mocked Firebase SDK.

    cd tests && npm install          # MapLibre, so no CDN is needed
    pip install playwright && playwright install chromium   (or set PLAYWRIGHT_BROWSERS_PATH)
    python viewer_test.py            # screenshots go to tests/out/

Network is fully stubbed: gstatic Firebase → tests/mock-firebase, unpkg MapLibre → node_modules,
OpenFreeMap style → a blank style, KarooTracker → a fixture, fonts → empty.
"""
import functools
import http.server
import json
import math
import os
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
WEB = ROOT.parent / "web"
OUT = ROOT / "out"
MAPLIBRE = ROOT / "node_modules" / "maplibre-gl" / "dist"
OUT.mkdir(exist_ok=True)

NOW = int(time.time() * 1000)
MIN = 60 * 1000

# ------------------------------------------------------------------ fixtures
def encode_polyline(points, precision=5):
    f = 10 ** precision
    out, plat, plng = [], 0, 0
    for lat, lng in points:
        ilat, ilng = round(lat * f), round(lng * f)
        for d in (ilat - plat, ilng - plng):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return "".join(out)


def haversine(a, b):
    r = math.pi / 180
    dlat, dlng = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlng / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1, math.sqrt(h)))


# A ~60 km loop with some wiggle, sampled every ~150 m.
C = (42.80, -71.70)
ROUTE = []
for i in range(400):
    a = 2 * math.pi * i / 400
    rad = 0.075 + 0.01 * math.sin(5 * a)
    ROUTE.append((round(C[0] + rad * math.sin(a), 5), round(C[1] + rad * 1.35 * math.cos(a), 5)))
CUM = [0.0]
for i in range(1, len(ROUTE)):
    CUM.append(CUM[-1] + haversine(ROUTE[i - 1], ROUTE[i]))
ROUTE_LEN = CUM[-1]
POLY = encode_polyline(ROUTE)


def at(dist):
    """Point and bearing on the route at a distance along it."""
    for i in range(1, len(CUM)):
        if CUM[i] >= dist:
            a, b = ROUTE[i - 1], ROUTE[i]
            f = (dist - CUM[i - 1]) / (CUM[i] - CUM[i - 1])
            brg = (math.degrees(math.atan2((b[1] - a[1]) * math.cos(math.radians(a[0])), b[0] - a[0])) + 360) % 360
            return (a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])), brg
    return ROUTE[-1], 0


def rider(name, dist, *, state="recording", updated=NOW - 10_000, speed=7.5, sensors=("pwr", "hr", "cad"),
          navigating=True, started=NOW - 3 * 3600 * 1000, ended=None, units="metric", acc=6):
    """A /live/<id> node as the Karoo extension writes it."""
    track = {}
    t0, t1 = started, updated
    n = max(2, int(dist // 400))
    for k in range(n + 1):
        d = dist * k / n
        (lat, lng), _ = at(d)
        t = int(t0 + (t1 - t0) * k / n)
        p = {"t": t, "lat": round(lat, 6), "lng": round(lng, 6), "alt": 120 + 40 * math.sin(d / 3000), "spd": speed, "d": round(d)}
        if "pwr" in sensors: p["pwr"] = 180 + (k % 7) * 9
        if "hr" in sensors: p["hr"] = 132 + (k % 5)
        if "cad" in sensors: p["cad"] = 86
        track[f"p{t}"] = p
    (lat, lng), brg = at(dist)
    cur = {"lat": round(lat, 6), "lng": round(lng, 6), "brg": round(brg), "acc": acc, "alt": 130, "spd": speed,
           "dist": round(dist), "el": t1 - t0, "rt": t1 - t0 - 5 * MIN, "gain": round(dist / 90), "avgSpd": 7.1,
           "bat": 64, "grade": 1.5, "temp": 14}
    if "pwr" in sensors: cur.update(pwr=212, avgPwr=181, np=195)
    if "hr" in sensors: cur["hr"] = 138
    if "cad" in sensors: cur["cad"] = 88
    node = {"name": name, "units": units, "state": state, "startedAt": started, "updatedAt": updated, "cur": cur, "track": track}
    if navigating:
        node["route"] = {"poly": POLY, "name": "Monadnock Loop", "dist": round(ROUTE_LEN)}
        cur["toGo"] = round(ROUTE_LEN - dist)
    if ended:
        node["endedAt"] = ended
    return node


HOST_A = "club-rides-default-rtdb.firebaseio.com"
HOST_B = "ben-karoo-default-rtdb.firebaseio.com"
HOST_EU = "dev-k3-default-rtdb.europe-west1.firebasedatabase.app"
HOST_DENIED = "locked-down-default-rtdb.firebaseio.com"

DB = {
    HOST_A: {"live": {
        "anaShare01": rider("Ana", 31_000),                                                  # leader, full sensors
        "caraShare1": rider("Cara", 30_880, sensors=(), navigating=False, speed=7.3),       # bunched with Ana, speed only, projected
        "eliShare01": rider("Eli", ROUTE_LEN - 20, state="idle", updated=NOW - 20 * MIN, ended=NOW - 20 * MIN),  # finished
        "gusShare01": rider("Gus", 52_000, state="idle", updated=NOW - 50 * 3600 * 1000, ended=NOW - 50 * 3600 * 1000),  # last week's ride
    }},
    HOST_B: {"live": {
        "benShare01": rider("Ben", 29_400, sensors=("hr",), units="imperial"),              # 1.6 km back, HR only
        "fayShare01": rider("Fay", 24_000, state="paused", updated=NOW - 9 * MIN),           # paused at a café
    }},
    HOST_EU: {"live": {
        "devShare01": rider("Dev", 26_500, updated=NOW - 6 * MIN, sensors=("pwr",)),        # signal lost
    }},
    HOST_DENIED: {"live": {"hidden0001": rider("Hidden", 1000)}},
}

# Ben and Fay have viewer messages switched on (Fay is paused, so she can't receive any right now).
for _id in ("benShare01", "fayShare01"):
    DB[HOST_B]["live"][_id]["msg"] = {"on": True, "key": "test-web-key"}

(k2t_lat, k2t_lng), k2t_brg = at(27_800)
K2T = {
    "riderName": "Kim (KarooTracker)", "state": "RECORDING", "units": "METRIC",
    "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime((NOW - 30_000) / 1000)),
    "location": {"lat": k2t_lat, "lng": k2t_lng}, "bearing": k2t_brg,
    "activityInfo": [{"key": "TYPE_DISTANCE_ID", "value": {"value": 27_800}}, {"key": "TYPE_BATTERY_PERCENT_ID", "value": {"value": 12}}],
    "locations": [list(at(d)[0]) for d in range(0, 27_800, 600)],
}

GROUP_TOKENS = [
    "club-rides~anaShare01", "ben-karoo~benShare01", "club-rides~caraShare1", "dev-k3@europe-west1~devShare01",
    "club-rides~eliShare01", "ben-karoo~fayShare01", "club-rides~gusShare01", "k2t~kimK2tId01",
    "locked-down~hidden0001~Hidden rider", "x~Sam~https://livetrack.garmin.com/session/abc-123/token/XYZ",
]

BLANK_STYLE = {"version": 8, "sources": {}, "layers": [{"id": "bg", "type": "background", "paint": {"background-color": "#e9e8e3"}}]}
BLANK_DARK = {"version": 8, "sources": {}, "layers": [{"id": "bg", "type": "background", "paint": {"background-color": "#1c1c1b"}}]}

# ------------------------------------------------------------------ server & browser
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(WEB)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def stub_network(ctx, *, deny=(HOST_DENIED,)):
    mock = ROOT / "mock-firebase"
    ctx.route("https://www.gstatic.com/firebasejs/**", lambda r: r.fulfill(
        path=str(mock / r.request.url.rsplit("/", 1)[-1]), headers={"content-type": "text/javascript", "access-control-allow-origin": "*"}))
    ctx.route("https://unpkg.com/maplibre-gl@*/dist/*", lambda r: r.fulfill(path=str(MAPLIBRE / r.request.url.rsplit("/", 1)[-1])))
    ctx.route("https://tiles.openfreemap.org/styles/**", lambda r: r.fulfill(
        json=BLANK_DARK if r.request.url.endswith("dark") else BLANK_STYLE, headers={"access-control-allow-origin": "*"}))
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
    ctx.route("https://fonts.gstatic.com/**", lambda r: r.abort())
    ctx.route("https://storagekarootrack.blob.core.windows.net/**", lambda r: r.fulfill(
        json=K2T, headers={"access-control-allow-origin": "*"}) if "kimK2tId01" in r.request.url else r.fulfill(status=404))
    ctx.add_init_script(f"window.__MOCK_DB = {json.dumps(DB)}; window.__MOCK_DENY = {json.dumps(list(deny))};")


FAILS = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)
        if os.environ.get("GITHUB_ACTIONS"):
            print("::error::" + msg.replace("\n", " ")[:900])


def watch_console(page, errors):
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))


def group_url(base, tokens=GROUP_TOKENS, name="Saturday Monadnock loop"):
    from urllib.parse import urlencode
    return f"{base}/group.html?" + urlencode([("v", "1"), ("n", name)] + [("r", t) for t in tokens])


def row_names(page):
    return page.eval_on_selector_all("#riders .rider-row .rname", "els => els.map(e => e.textContent)")


def row_status(page, name):
    return page.evaluate("""(n) => { const r = [...document.querySelectorAll('#riders .rider-row')].find(li => li.querySelector('.rname').textContent === n);
        return r ? { cls: r.className, pill: r.querySelector('.pill').textContent, text: r.innerText } : null; }""", name)


# ------------------------------------------------------------------ tests
def test_group(browser, base):
    print("group view, phone, light")
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, color_scheme="light", has_touch=True, is_mobile=True)
    stub_network(ctx)
    page = ctx.new_page()
    errors = []
    watch_console(page, errors)
    page.goto(group_url(base))
    page.wait_for_function("document.querySelectorAll('#riders .rider-row').length === 9 && !document.querySelector('#riders').innerText.includes('Waiting for data')", timeout=15000)
    page.wait_for_timeout(1500)

    check(page.title().startswith("Saturday Monadnock loop"), "title uses the ride name")
    apps = page.evaluate("window.__mockFirebase.apps.map(a => a.name + ' ' + a.databaseURL)")
    check(len(apps) == 4, f"one Firebase app per database host (got {len(apps)}: {apps})")
    check(any("europe-west1.firebasedatabase.app" in a for a in apps), "regional host expanded from proj@region")
    names = row_names(page)
    print("    order:", names)
    check(names[:2] == ["Ana", "Cara"] or names[:2] == ["Eli", "Ana"], "leaders first")
    check(names[0] == "Eli", "finished rider who completed the route ranks first by distance to go")
    check(names.index("Ana") < names.index("Cara") < names.index("Ben") < names.index("Kim (KarooTracker)") < names.index("Dev") < names.index("Fay"),
          "on-road riders sorted by distance to go")
    check(set(names[-2:]) == {"Gus", "Hidden rider"}, "not-started and unreadable riders at the bottom")
    check(row_status(page, "Eli")["pill"] == "Finished", "finished state")
    check(row_status(page, "Dev")["pill"] == "Signal lost" and "last seen 6 min ago" in row_status(page, "Dev")["text"], "stale rider flagged as signal lost with last-seen time")
    check(row_status(page, "Fay")["pill"] == "Paused", "paused state")
    check(row_status(page, "Ana")["pill"] == "Live", "live state")
    check(row_status(page, "Gus")["pill"] == "Not started", "last week's ride isn't shown as today's")
    check(row_status(page, "Hidden rider")["pill"] == "Can't load" and "isn't readable" in row_status(page, "Hidden rider")["text"], "permission error explained")
    check("Leading" in row_status(page, "Ana")["text"] and "finished" in row_status(page, "Eli")["text"], "leader on the road labelled; finisher shows finish time")
    ben = row_status(page, "Ben")["text"]
    check("−1." in ben and "+" in ben, f"gap to leader shown with distance and time ({ben!r})")
    check("battery 12%" in row_status(page, "Kim (KarooTracker)")["text"], "low battery flagged")
    gaps = page.eval_on_selector_all("#riders .gaprow", "els => els.map(e => e.textContent)")
    print("    gap rows:", gaps)
    check(any(g.startswith("gap ") for g in gaps), "gap rows between bunches")
    ana_i, cara_i = names.index("Ana"), names.index("Cara")
    check(page.evaluate("""() => { const kids=[...document.querySelectorAll('#riders > li')]; const a=kids.findIndex(l=>l.innerText.startsWith('1')||0);
        const iA=kids.findIndex(l=>l.querySelector&&l.querySelector('.rname')?.textContent==='Ana'); const iC=kids.findIndex(l=>l.querySelector('.rname')?.textContent==='Cara');
        return iC === iA + 1; }"""), "Ana and Cara ride together (no gap row between them)")
    others = page.inner_text("#others")
    check("Sam" in others and "Garmin LiveTrack" in others, "Garmin LiveTrack rider listed under other trackers")
    markers = page.eval_on_selector_all(".gm", "els => els.length")
    check(markers == 7, f"markers for riders with a position today (got {markers})")
    check(page.locator(".gm.stale").count() == 1, "stale marker faded")
    check(page.evaluate("getComputedStyle(document.querySelector('.gm-dot')).backgroundColor") != "", "markers coloured")
    check(page.is_visible("#legend-route"), "planned route legend shown")
    check(page.evaluate("window.karooLiveMap.getSource('tracks').serialize().data.features.length") == 7, "a track per rider on the road (incl. finished/stale/paused)")
    check(page.evaluate("window.karooLiveMap.getSource('route').serialize().data.geometry.coordinates.length") == 400, "shared route drawn")
    # everyone in view
    inview = page.evaluate("""() => { const m = window.karooLiveMap, b = m.getBounds();
        return window.karooLiveGroup.riders.filter(r => r.marker && !r.markerEl.classList.contains('done')).every(r => b.contains(r.marker.getLngLat())); }""")
    check(inview, "everyone on the road fits in view")
    # markers sit exactly on their coordinates (catches CSS that breaks MapLibre's positioning)
    off = page.evaluate("""() => { const m = window.karooLiveMap, mc = m.getContainer().getBoundingClientRect();
        return Math.max(...window.karooLiveGroup.riders.filter(r => r.marker).map(r => { const p = m.project(r.marker.getLngLat()), b = r.markerEl.getBoundingClientRect();
          return Math.hypot(b.left + b.width / 2 - mc.left - p.x, b.top + b.height / 2 - mc.top - p.y); })); }""")
    check(off < 2, f"markers drawn at their positions (worst offset {off:.1f}px)")
    page.screenshot(path=str(OUT / "group-phone-light.png"), full_page=True)

    # details: only the sensors the rider has
    page.click("#riders .rider-row:has(.rname:text-is('Ben')) .rhead")
    page.wait_for_selector(".rdetail")
    labels = page.eval_on_selector_all(".rdetail .rl", "els => els.map(e => e.textContent)")
    print("    Ben details:", labels)
    sw = page.evaluate("getComputedStyle(document.querySelector('.rdetail .rl .swatch')).backgroundColor")
    check(sw == "rgb(42, 120, 214)", f"detail tiles use the viewer's metric colors (speed swatch {sw})")
    check("Heart rate" in labels and "Power 3s" not in labels and "Cadence" not in labels, "Ben's details show HR but no power/cadence")
    check(page.locator(".gm.sel").count() == 1, "selected rider highlighted on the map")
    page.click("#riders .rider-row:has(.rname:text-is('Cara')) .rhead")
    labels = page.eval_on_selector_all(".rdetail .rl", "els => els.map(e => e.textContent)")
    check(not any(x in labels for x in ("Heart rate", "Power 3s", "Cadence")) and "Speed" in labels, "Cara (no sensors) shows speed but no sensor tiles")
    page.click("#riders .rider-row:has(.rname:text-is('Dev')) .rhead")
    dev_speed = page.evaluate("[...document.querySelectorAll('.rdetail .rm')].find(m => m.querySelector('.rl').textContent==='Speed').querySelector('.rv').textContent")
    check(dev_speed == "—", "stale rider's instant numbers blanked")
    page.screenshot(path=str(OUT / "group-phone-detail.png"), full_page=True)

    # follow one rider
    page.click("#riders .rider-row:has(.rname:text-is('Dev')) .racts button")
    page.wait_for_timeout(900)
    check(page.is_visible("#view-follow") and "Following Dev" in page.inner_text("#view-follow"), "follow chip shown")
    centered = page.evaluate("""() => { const m = window.karooLiveMap, r = window.karooLiveGroup.riders.find(x => x.model && x.model.name==='Dev');
        const p = m.project(r.marker.getLngLat()), c = m.getContainer(); return Math.abs(p.x - c.clientWidth/2) < 30 && Math.abs(p.y - c.clientHeight/2) < 30; }""")
    check(centered, "map centered on the followed rider")
    page.click("#view-follow")
    check(page.is_hidden("#view-follow"), "stop following returns to everyone")

    # sort by distance ridden
    page.click("#sort-dist")
    names2 = row_names(page)
    check(names2[0] == "Eli" and names2.index("Ana") < names2.index("Ben"), "sort by distance ridden")
    page.click("#sort-togo")

    # live update: Ben surges ahead of Ana, Dev's signal comes back
    page.evaluate(f"""() => {{ const n = {json.dumps(rider('Ben', 31_400, sensors=('hr',), units='imperial', updated=NOW))};
        n.updatedAt = Date.now(); window.__mockSet('{HOST_B}', 'live/benShare01', n);
        const d = {json.dumps(rider('Dev', 27_000, sensors=('pwr',)))}; d.updatedAt = Date.now(); window.__mockSet('{HOST_EU}', 'live/devShare01', d); }}""")
    page.wait_for_timeout(1300)
    names3 = row_names(page)
    print("    after update:", names3)
    check(names3.index("Ben") < names3.index("Ana"), "list re-sorts on live updates")
    check(row_status(page, "Dev")["pill"] == "Live", "signal-lost clears when data returns")
    check(page.evaluate("window.__mockFirebase.writes || 0") == 0, "viewer never writes to anyone's database")

    # the Find-My style accuracy circle for a selected rider
    page.click("#riders .rider-row:has(.rname:text-is('Ana')) .rhead")
    page.wait_for_timeout(300)
    check(page.evaluate("window.karooLiveMap.getSource('acc').serialize().data.type") == "FeatureCollection", "no accuracy ring when GPS is precise")

    # units
    page.click("#units")
    check("mi" in page.inner_text("#riders"), "units toggle")
    page.click("#units")
    check(not errors, f"no console errors ({errors[:3]})")
    ctx.close()


def test_group_dark_desktop(browser, base):
    print("group view, desktop, dark, theme toggle")
    ctx = browser.new_context(viewport={"width": 1366, "height": 860}, color_scheme="dark")
    stub_network(ctx)
    page = ctx.new_page()
    errors = []
    watch_console(page, errors)
    page.goto(group_url(base))
    page.wait_for_function("document.querySelectorAll('#riders .rider-row').length === 9", timeout=15000)
    page.wait_for_timeout(1500)
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    check(bg == "rgb(15, 15, 14)", f"dark theme follows the system ({bg})")
    side = page.evaluate("""() => { const m = document.querySelector('.gmapcard').getBoundingClientRect(), l = document.querySelector('.glist').getBoundingClientRect(); return l.left > m.right - 1; }""")
    check(side, "map and list side by side on wide screens")
    page.click("#riders .rider-row:has(.rname:text-is('Ana')) .rhead")
    page.screenshot(path=str(OUT / "group-desktop-dark.png"))
    page.click("#theme")
    page.wait_for_timeout(1200)
    bg2 = page.evaluate("getComputedStyle(document.body).backgroundColor")
    check(bg2 == "rgb(244, 244, 241)", f"theme toggle switches to light ({bg2})")
    check(page.evaluate("window.karooLiveMap.getStyle().layers.some(l => l.id === 'track')") and
          page.evaluate("window.karooLiveMap.getSource('tracks').serialize().data.features.length") == 7, "map layers rebuilt after the theme switch")
    page.screenshot(path=str(OUT / "group-desktop-light.png"))
    page.reload()
    page.wait_for_function("document.querySelectorAll('#riders .rider-row').length === 9", timeout=15000)
    check(page.evaluate("document.documentElement.dataset.theme") == "light", "theme choice remembered")
    page.click("#theme")
    hr = page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--c-hr').trim()")
    check(hr == "#e66767", f"manual dark theme gets the dark metric colors ({hr})")
    check(not errors, f"no console errors ({errors[:3]})")
    ctx.close()


def test_builder(browser, base):
    print("group builder")
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme="light")
    stub_network(ctx)
    page = ctx.new_page()
    errors = []
    watch_console(page, errors)
    page.goto(f"{base}/group.html")
    check(page.is_visible("#builder") and page.is_hidden("#group"), "builder shown when the URL has no riders")
    page.fill("#build-name", "Coffee ride")
    page.fill("#build-links", "\n".join([
        "https://mybikeride.live/?db=club-rides&id=anaShare01",
        "https://mybikeride.live/?db=https%3A%2F%2Fben-karoo-default-rtdb.firebaseio.com&id=benShare01",
        "https://mybikeride.live/?db=dev-k3-default-rtdb.europe-west1.firebasedatabase.app&id=devShare01",
        "https://mybikeride.live/?k2t=kimK2tId01",
        "Sam: https://livetrack.garmin.com/session/abc-123/token/XYZ",
        "https://mybikeride.live/?db=club-rides&id=anaShare01",
        "not a link at all !!",
    ]))
    page.click("#build-add")
    page.wait_for_timeout(300)
    items = page.eval_on_selector_all("#build-list li", "els => els.map(e => e.innerText)")
    check(len(items) == 5, f"5 riders parsed, duplicate skipped ({len(items)})")
    check("1 already in the group" in page.inner_text("#build-msg") and "Couldn't read 1 line" in page.inner_text("#build-msg"), "duplicates and bad lines reported")
    check(page.input_value("#build-links") == "not a link at all !!", "unreadable line left in the box")
    url = page.input_value("#build-url")
    print("    ", url)
    check("r=club-rides%7EanaShare01" in url and "dev-k3%40europe-west1" in url and "r=x%7ESam%7Ehttps" in url, "compact readable tokens")
    page.click("#build-form button[type=submit]")
    page.wait_for_function("document.querySelectorAll('#riders .rider-row').length === 4", timeout=15000)
    check(page.inner_text("#gname") == "Coffee ride", "group opens from the built link")
    page.wait_for_timeout(800)
    # edit → builder pre-filled
    page.click("#edit")
    check(page.is_visible("#builder") and page.locator("#build-list li").count() == 5, "edit returns to a pre-filled builder")

    # a big group switches to the compact (#z=) link and round-trips
    many = "\n".join(f"https://mybikeride.live/?db=the-very-long-cycling-club-project-name-{i % 3}&id=riderShare{i:02d}" for i in range(28))
    page.fill("#build-links", many)
    page.click("#build-add")
    page.wait_for_timeout(500)
    url2 = page.input_value("#build-url")
    note = page.inner_text("#build-len")
    print("    big group:", len(url2), "chars;", note)
    check("#z=" in url2, "long group uses the compact link")
    page.goto(url2)
    page.wait_for_function("document.querySelectorAll('#riders .rider-row').length === 29", timeout=15000)
    check(page.locator("#others-list li").count() == 1, "compact link opens all 30 riders (29 tracked + 1 other tracker)")
    check(not errors, f"no console errors ({errors[:3]})")
    ctx.close()


def test_single_rider_still_works(browser, base):
    print("single-rider page (regression after moving helpers to common.js)")
    for scheme in ("light", "dark"):
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, color_scheme=scheme)
        stub_network(ctx)
        page = ctx.new_page()
        errors = []
        watch_console(page, errors)
        page.goto(f"{base}/?db=club-rides&id=anaShare01")
        page.wait_for_function("document.querySelector('#rider').textContent === 'Ana'", timeout=15000)
        page.wait_for_timeout(1200)
        check(page.inner_text("#status") .strip().upper() == "LIVE", f"[{scheme}] live status")
        tiles = page.eval_on_selector_all("#metrics-primary .label", "els => els.map(e => e.firstChild.textContent)")
        check(tiles == ["Speed", "Power", "Heart rate", "Cadence"], f"[{scheme}] primary tiles {tiles}")
        check(page.locator("#charts .chart").count() == 5, f"[{scheme}] five charts")
        check(page.is_visible("#legend-route"), f"[{scheme}] route legend")
        check(page.is_visible("#splits") and page.locator("#split-body tr").count() >= 2, f"[{scheme}] splits table")
        heads = page.eval_on_selector_all("#split-head th", "els => els.map(e => e.firstChild.nodeType === 3 ? e.firstChild.textContent : e.childNodes[1].textContent)")
        check(heads == ["km", "Time", "Speed", "Climb", "Power", "HR", "Cad"], f"[{scheme}] split columns {heads}")
        check(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"[{scheme}] no sideways scroll")
        page.screenshot(path=str(OUT / f"single-{scheme}.png"), full_page=True)
        check(not errors, f"[{scheme}] no console errors ({errors[:3]})")
        ctx.close()
    ctx = browser.new_context()
    stub_network(ctx)
    page = ctx.new_page()
    page.goto(f"{base}/?k2t=kimK2tId01")
    page.wait_for_function("document.querySelector('#rider').textContent.startsWith('Kim')", timeout=15000)
    check(True, "KarooTracker-only link still works")
    page.goto(f"{base}/")
    check(page.is_visible("#landing"), "landing page still shows")
    ctx.close()


def test_messages(browser, base):
    print("send a message")
    ctx = browser.new_context(viewport={"width": 375, "height": 812})
    stub_network(ctx)
    page = ctx.new_page()
    errors = []
    watch_console(page, errors)
    page.goto(f"{base}/?db=club-rides&id=anaShare01")
    page.wait_for_function("document.querySelector('#rider').textContent === 'Ana'", timeout=15000)
    page.wait_for_timeout(600)
    check(not page.is_visible("#msg-open"), "no message button when the rider hasn't switched messages on")
    page.goto(f"{base}/?db=ben-karoo&id=fayShare01")
    page.wait_for_function("document.querySelector('#rider').textContent === 'Fay'", timeout=15000)
    page.wait_for_timeout(600)
    check(not page.is_visible("#msg-open"), "no message button while the rider is paused")
    page.goto(f"{base}/?db=ben-karoo&id=benShare01")
    page.wait_for_function("document.querySelector('#rider').textContent === 'Ben'", timeout=15000)
    page.wait_for_selector("#msg-open", state="visible", timeout=5000)
    check(True, "message button shown while recording")
    page.click("#msg-open")
    check(page.is_visible("#msg-from") and not page.is_visible("#msg-open"), "form opens")
    page.fill("#msg-from", "Mom")
    page.fill("#msg-text", "Looking strong, see you at the café!")
    check(page.inner_text("#msg-count") == "36/100 · arrives in 2 parts", f"character counter ({page.inner_text('#msg-count')})")
    page.click("#msg-send")
    page.wait_for_function("document.querySelector('#msg-note').classList.contains('ok')", timeout=5000)
    sent = page.evaluate("window.__mockFirebase.sent")
    check(len(sent) == 1 and sent[0]["from"] == "Mom" and sent[0]["text"].startswith("Looking strong") and sent[0]["uid"] == "anon-viewer1",
          f"message written with sender and anonymous uid ({sent})")
    check(page.input_value("#msg-text") == "" and page.input_value("#msg-from") == "Mom", "text cleared, name kept")
    wide = page.evaluate("""[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 0.5)
        .slice(0, 6).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right))""")
    check(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"no sideways scroll with the form open {wide} " + page.evaluate("JSON.stringify([document.documentElement.scrollWidth, document.documentElement.clientWidth, innerWidth, document.body.scrollWidth, [...document.querySelectorAll('body *')].map(e => [e.id || e.className || e.tagName, e.scrollWidth, e.clientWidth]).filter(x => x[1] > 375).slice(0, 5)])"))
    page.screenshot(path=str(OUT / "message-sent.png"), full_page=False)
    page.fill("#msg-text", "And another")
    page.click("#msg-send")
    page.wait_for_function("document.querySelector('#msg-note').textContent.includes('Sending in')", timeout=5000)
    check(True, "second message within 20 s waits for its turn: " + page.inner_text("#msg-note"))
    page.wait_for_function("document.querySelector('#msg-note').classList.contains('ok')", timeout=30000)
    check(len(page.evaluate("window.__mockFirebase.sent")) == 2, "then sends")
    sent_list = page.eval_on_selector_all("#msg-sent-list li", "els => els.map(e => e.textContent)")
    check(len(sent_list) == 2 and sent_list[0].endswith("Looking strong, see you at the café!") and sent_list[1].endswith("And another"),
          f"sender sees their messages this ride, in order ({sent_list})")
    page.fill("#msg-text", "Faster!!! Think SPEED and keep the Cadence up.")
    parts = page.eval_on_selector_all("#msg-preview-parts .kbanner", "els => els.map(e => e.innerText.replace(/\\n/g, ' | '))")
    check(page.is_visible("#msg-preview") and parts == ["MOM 1/2 | Faster!!! Think SPEED and keep the", "MOM 2/2 | Cadence up."],
          f"long message previewed in Karoo-sized parts ({parts})")
    check("arrives in 2 parts" in page.inner_text("#msg-count") and "warn" in page.get_attribute("#msg-count", "class"), "counter warns about parts")
    page.screenshot(path=str(OUT / "message-parts.png"), full_page=False)
    page.fill("#msg-text", "Short one")
    check(not page.is_visible("#msg-preview"), "no preview for a short message")
    page.fill("#msg-text", "")
    page.reload()
    page.wait_for_selector("#msg-open", state="visible", timeout=8000)
    page.click("#msg-open")
    check(page.input_value("#msg-from") == "Mom", "name remembered after reload")
    check(page.locator("#msg-sent-list li").count() == 2, "sent list kept after reload")
    check(not errors, f"no console errors ({errors[:3]})")
    ctx.close()

    for label, script, expect in (
        ("old database rules", f"window.__MOCK_MSG_NORULES = ['{HOST_B}'];", "database rules"),
        ("Anonymous sign-in not enabled", "window.__MOCK_NO_ANON = true;", "Anonymous sign-in"),
    ):
        ctx = browser.new_context(viewport={"width": 375, "height": 812})
        stub_network(ctx)
        ctx.add_init_script(script)
        page = ctx.new_page()
        page.goto(f"{base}/?db=ben-karoo&id=benShare01")
        page.wait_for_selector("#msg-open", state="visible", timeout=15000)
        page.click("#msg-open")
        page.fill("#msg-from", "Sam")
        page.fill("#msg-text", "Hi")
        page.click("#msg-send")
        page.wait_for_function("document.querySelector('#msg-note').classList.contains('bad')", timeout=5000)
        note = page.inner_text("#msg-note")
        check(expect in note, f"{label}: clear message ({note})")
        ctx.close()


def main():
    httpd, base = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            test_single_rider_still_works(browser, base)
            test_group(browser, base)
            test_group_dark_desktop(browser, base)
            test_builder(browser, base)
            test_messages(browser, base)
        finally:
            browser.close()
            httpd.shutdown()
    print(f"\n{len(FAILS)} failure(s)" if FAILS else "\nall passed")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
