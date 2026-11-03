"""Turns a Karoo ride file (.fit) into a Karoo Live ride, to show an earlier ride on your page again.

Each new ride replaces the previous one on your link. If a ride was replaced (by a quick test ride, say),
download its FIT file from the Hammerhead dashboard, convert it, and import the result in the Firebase
console at /live/<your share id> (Realtime Database, Data, select that entry, then the menu and "Import JSON").
Import at that entry only: importing at the top would replace your whole database.

    pip install fitdecode
    python fit-to-live.py Karoo-My_Ride-2026-11-03-1103.fit ride.json --name "Marc Roy" --units imperial

The output has the same shape the Karoo sends (see Tracker.kt), with a point every 10 s of recording
(the app sends one per update, every 15-30 s). Speed, power and cadence are 3-second averages, like the
Karoo's own fields. What a FIT file doesn't hold is left out: the planned route, the Karoo battery (unless
given with --battery) and the viewer-message switch, which the next real ride writes again.
"""
import argparse
import json
import math

import fitdecode

SEMICIRCLE = 180 / 2**31


def ms(dt):
    return int(dt.timestamp() * 1000)


def bearing(a, b):
    la1, la2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)
    return round((math.degrees(math.atan2(y, x)) + 360) % 360)


def read(path):
    records, session = [], None
    with fitdecode.FitReader(path) as fr:
        for frame in fr:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            if frame.name == "record":
                r = {f.name: f.value for f in frame.fields}
                if r.get("position_lat") is not None and r.get("position_long") is not None:
                    records.append(r)
            elif frame.name == "session":
                session = {f.name: f.value for f in frame.fields}
    if not records or not session:
        raise SystemExit("No GPS records or no session summary in this file.")
    return records, session


def first(r, *keys):
    for k in keys:
        if r.get(k) is not None:
            return r[k]
    return None


def convert(records, session, name, units, battery=None, step_s=10):
    def pos(r):
        return round(r["position_lat"] * SEMICIRCLE, 6), round(r["position_long"] * SEMICIRCLE, 6)

    def avg(win, *keys):
        vals = [v for v in (first(r, *keys) for r in win) if v is not None]
        return sum(vals) / len(vals) if vals else None

    track, win, last_t = {}, [], None
    for r in records:
        win = (win + [r])[-3:]  # 3-second averages, like the Karoo's 3s fields
        t = ms(r["timestamp"])
        if last_t is not None and t - last_t < step_s * 1000:
            continue
        lat, lng = pos(r)
        p = {"t": t, "lat": lat, "lng": lng, "alt": round(first(r, "enhanced_altitude", "altitude") or 0, 1),
             "spd": round(avg(win, "enhanced_speed", "speed") or 0, 2), "d": round(r.get("distance") or 0, 1)}
        for key, fit_keys in (("pwr", ("power",)), ("hr", ("heart_rate",)), ("cad", ("cadence",))):
            v = avg(win, *fit_keys)
            if v is not None:
                p[key] = round(v)
        if r.get("Pinion Gear") is not None:
            p["gear"] = int(r["Pinion Gear"])
        track[f"p{t}"] = p
        last_t = t

    last = records[-1]
    lat, lng = pos(last)
    cur = {"lat": lat, "lng": lng, "brg": bearing(pos(records[max(0, len(records) - 12)]), (lat, lng)),
           "alt": round(first(last, "enhanced_altitude", "altitude") or 0, 1), "spd": 0.0,
           "dist": round(session["total_distance"], 1),
           "el": int(session["total_elapsed_time"] * 1000), "rt": int(session["total_timer_time"] * 1000)}
    for key, fit_keys in (("gain", ("total_ascent",)), ("avgSpd", ("enhanced_avg_speed", "avg_speed")),
                          ("avgPwr", ("avg_power",)), ("np", ("normalized_power",))):
        v = first(session, *fit_keys)
        if v is not None:
            cur[key] = v
    for key, fit_key in (("temp", "temperature"), ("grade", "grade")):
        if last.get(fit_key) is not None:
            cur[key] = last[fit_key]
    if last.get("Pinion Gear") is not None:
        cur["gear"] = int(last["Pinion Gear"])
    if session.get("Pinion Shifts") is not None:
        cur["shifts"] = int(session["Pinion Shifts"])
    if battery is not None:
        cur["bat"] = battery

    ended = ms(session["timestamp"])
    return {"name": name, "units": units, "state": "idle", "startedAt": ms(session["start_time"]),
            "updatedAt": ended, "endedAt": ended, "cur": cur, "track": track}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("fit", help="the ride file from the Hammerhead dashboard")
    ap.add_argument("out", help="JSON file to write, for the Firebase console's Import JSON")
    ap.add_argument("--name", required=True, help="rider name shown on the page")
    ap.add_argument("--units", choices=["imperial", "metric"], default="metric")
    ap.add_argument("--battery", type=int, help="Karoo battery %% at the end, if you want it shown")
    a = ap.parse_args()
    records, session = read(a.fit)
    node = convert(records, session, a.name, a.units, a.battery)
    with open(a.out, "w") as f:
        json.dump(node, f, separators=(",", ":"))
    miles = node["cur"]["dist"] / (1609.344 if a.units == "imperial" else 1000)
    print(f"{len(node['track'])} points, {miles:.2f} {'mi' if a.units == 'imperial' else 'km'}, "
          f"{session['start_time']:%Y-%m-%d %H:%M} to {session['timestamp']:%H:%M} UTC -> {a.out}")


if __name__ == "__main__":
    main()
