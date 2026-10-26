# Group rides

**[mybikeride.live/group.html](https://mybikeride.live/group.html)** follows several riders on one map. It's made for long recreational group rides: who's ahead, who's behind, who stopped for coffee, and who has lost signal.

## Making a group

1. Collect each rider's Karoo Live share link (the one they already send to family).
2. Open [group.html](https://mybikeride.live/group.html), paste the links one per line, and press **Add riders**.
3. Name the ride and press **Open the group**. Share that link.

What you can paste:

| Paste | Shown as |
|---|---|
| A Karoo Live link (`…/?db=…&id=…`) | Full rider: map, track, all the numbers |
| A KarooTracker id or link | Position and distance from Hammerhead's own tracking (no sensors) |
| Any other live-tracking link, with the rider's name on the same line (`Sam https://livetrack.garmin.com/…`) | Listed under **Other trackers** with a button to open it |
| An existing group link | Its riders are added |

The group lives entirely in the link. There's no account, nothing is stored, and each rider's data is read straight from their own Firebase database, read-only.

## What the page shows

- **Map:** each rider has a color *and* a number, so color is never the only cue. Colors come from a palette that stays distinguishable for common color-vision deficiencies, and riders 9 and up get dashed tracks. A heading arrow shows while a rider is live. A faded, dashed marker means "last seen here", as in Find My.
- **Planned route:** taken from the first rider in the group who is navigating one, drawn as a wide grey band under the tracks.
- **View:** *Everyone* keeps all riders on the road in view. *Route* shows the whole route. *Follow on map* (in a rider's details) keeps one rider centered.
- **Rider list:** sorted by distance to go when there's a route, or by distance ridden. Each row shows the gap to the leader on the road, in distance and in time. The time is when the leader passed the rider's current spot, worked out from the leader's track. Gap rows separate the bunches, like a race broadcast. Finished riders head the list.
- **States:** Live, Signal lost (no update for 2½ minutes while recording), Paused, Finished, Not started (nothing since a ride more than 12 hours ago), and Can't load (the rider's database isn't readable).
- **Details:** tap a rider for their current numbers. Power, heart rate and cadence only appear if that rider has those sensors.
- **Low battery** (20% or less) is flagged in the list.

### Distance to go for riders not navigating

A Karoo navigating the shared route reports its own distance to go, and the page uses that. For anyone else, the page snaps their position onto the route. When the route passes the same road twice (out-and-back or loops), it picks the stretch closest to where that rider was last time. A rider more than 250 m from the route is flagged **Off route** and keeps their last position along it.

## Link format

```
group.html?v=1&n=<ride name>&r=<rider>&r=<rider>…
```

| Rider token | Meaning |
|---|---|
| `<project>~<shareId>[~<name>]` | Karoo Live rider in `https://<project>-default-rtdb.firebaseio.com` |
| `<project>@<region>~<shareId>[~<name>]` | Regional database, e.g. `my-proj@europe-west1` |
| `<full host>~<shareId>[~<name>]` | Any other Firebase Realtime Database host |
| `k2t~<id>[~<name>]` | KarooTracker feed |
| `x~<name>~<url>` | Another tracker's page (listed, not mapped) |

Add `&units=imperial` or `&units=metric` to override the riders' own setting.

### Long links

A Karoo Live rider adds about 30 characters, so a 20-rider group is still well under 1,000. When a group passes 1,500 characters, the builder switches to a **compact link**: the same data, compressed, after `#z=`. In tests, 30 riders on three long project names went from about 1,650 characters to 430. Because it's after `#`, it's also never sent to the web server.

If a link is still too long for a messaging app, use any URL shortener. The shortener only stores the link, never anyone's ride data. A self-hosted option would be a `/groups/<id>` node in the organizer's own Firebase. That's a database schema change, so it's listed below as a future idea rather than built.

## Riders without a Karoo

Today a Garmin, Wahoo or phone rider can be in the group as an **Other tracker**: their name and a button to open their own live-tracking page. Their position isn't on the shared map. Garmin LiveTrack, Wahoo Live Track and Strava Beacon have no public API a web page is allowed to read from another site, so the map can't draw them without a server in between.

How other services handle this, and what we could borrow:

| Service | How it locates people | Idea for Karoo Live |
|---|---|---|
| **Find My** | The phone reports its own location in the background; when it can't, it shows the *last known* location with a time | Done: "last seen 6 min ago", with a faded marker |
| **Life360** | Native app with background location; shows battery; "arrived at" places | Battery done. **Places** could be "virtual checkpoints" (below) |
| **Strava Flybys** | After the activity, matches people who were near each other at the same time | Done: gap rows between bunches. Next: a post-ride "rode together" summary |
| **Big marathons (Boston, NYC)** | RFID chip in the bib, read by timing mats every ~5 km; the app shows splits and estimates position between mats | **Virtual checkpoints:** circles on the route (café stop, summit) that record a split when a rider's GPS enters them. No hardware needed |
| **Ultra/gravel events** | GPS tracker per rider (satellite or phone) | The phone-tracker options below |

For a phone (any brand of bike computer plus a phone in the pocket), the realistic options are:

1. **A "ride with my phone" page** that writes the existing Karoo Live schema to the rider's own Firebase. This needs no schema change. The catch: phones pause web pages when the screen locks, so it only tracks with the screen on. That's fine for a phone on the bars, but not in a pocket.
2. **OwnTracks** (free, open source, native iOS/Android, proper background location) posting to the rider's Firebase. This needs a small schema addition, because OwnTracks sends its own format, plus rules for it.
3. **A server**, which can accept OwnTracks, Traccar and similar apps. See below.

Options 2 and 3 change the database schema and need a decision first.

## Future: organizer-hosted events

Today everyone hosts their own data. A later tier could let a club or event organizer host it:

- **Events instead of links:** `group.html?event=<id>` loads the rider list from the organizer's server, so links stay short and riders can be added mid-ride.
- **Join codes:** riders join an event, and their device writes to `/events/<eventId>/live/<riderId>` with the same snapshot shape, so the viewer barely changes. Each rider can only write their own node, which is a rules change from today's single `owner`.
- **Phones as trackers:** the server accepts OwnTracks/Traccar, which brings in Garmin, Wahoo and phone-only riders properly.
- **Event features:** virtual checkpoints with split tables, "stopped too long" alerts for the sweep rider, and a post-ride "rode together" summary.
- **Privacy built in:** tracking only inside the event's time window, automatic deletion after N days, and explicit opt-in. A club handling other people's location has real obligations, GDPR included.

Ways to run it, cheapest first:

1. **The organizer's own free Firebase project.** Mostly new rules, plus an Android setting for "write to this event". The free Spark plan limits simultaneous connections (about 100 at the time of writing; check Firebase's current limits), which suits a club ride, not a big public event.
2. **A self-hostable server** (a Docker image, possibly built on the open-source Traccar server) for clubs that want control.
3. **A paid hosted tier.** Running servers costs money that grows with each event and each spectator, and someone has to own support, uptime and the privacy duties. A common open-source pattern, used by Plausible and Traccar, keeps the self-hosted version free and charges per event or season for hosting. Anything that changes the Android app or the database schema needs a decision first.

The group page is built for this: each rider is a "source" (`SOURCES` in `web/group.js`) that produces the same normalized model, so an event-server source is one more entry. The link format carries a version (`v=1`).

## Testing

```bash
cd tests
npm install                      # MapLibre, so tests don't need a CDN
pip install playwright && playwright install chromium
python viewer_test.py            # screenshots in tests/out/
```

The tests run both pages in headless Chromium against a mocked Firebase SDK (`tests/mock-firebase/`). They use 10 riders across four databases, one of them regional: live, bunched, sensor-less, signal lost, paused, finished, last week's ride, permission denied, KarooTracker and Garmin. They check ordering, gaps, states, sensor-aware details, follow mode, live re-sorting, theme switching, the builder, compact links, that markers sit on their coordinates, and that the viewer never writes. CI runs them on every change to `web/` or `tests/`.
