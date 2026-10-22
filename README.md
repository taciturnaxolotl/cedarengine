# cedarengine

One database and one API over everything I have collected about Cedarville: the
student directory, the course catalog, the printed academic catalog, harvested
booklists, and the campus itself.

The canonical repo for this is hosted on tangled over at [`https://tangled.org/dunkirk.sh/cedarengine`](https://tangled.org/dunkirk.sh/cedarengine)

<p align="center">
    <img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/main/.github/images/line-break-thin.svg" />
</p>

## What's this?

Four projects had four data files and none of them could see each other.
`cedarstalk-raycast` swept the directory into `directory.db`.
`the-cedarville-app` crawled Colleague and the printed catalog into
`catalog.sqlite` and `book-2026-2027.json`. `cedar-major-pipeline` harvested
campus-store booklists and guessed majors off them, reaching across to the
other two by absolute path. `assassins` drew the campus off OpenStreetMap.

Every question worth asking crosses at least two of those. Which dorm has the
most engineers. Whether the person who moved into Lawlor over the summer
changed majors too. How far a freshman actually walks in a day. Kept in four
files those need application code; kept in one they need a `JOIN`.

So this is one SQLite database, one Bun server in front of it, and collectors
for each source. It also keeps history — every source upstream is a snapshot
API, and who arrived, who left, who moved and who dropped a course only exists
if you write it down each time you look.

## Running it

```bash
bun install
cp .env.example .env        # fill in BEARER_TOKEN: openssl rand -hex 32
bun run engine import       # seed from the older projects, if they are checked out beside this
bun run dev                 # http://127.0.0.1:3000
```

The dashboard is at `/`, the spec at `/openapi.json`, and every other route
wants `Authorization: Bearer <token>`. It binds loopback unless you tell it
otherwise, which you should think about before doing: this database holds ten
thousand real people's rooms, phone numbers and inferred majors.

## Collecting

```bash
bun run engine collect catalog 2027SP   # a term of sections and courses
bun run engine collect catalog --all    # every course that exists, offered or not
bun run engine collect book             # the printed catalog, ~340 pages
bun run engine collect campus           # OpenStreetMap plus the campus tour
bun run engine collect directory        # the whole directory (needs a session)
```

The book and the map need nobody's permission: the publisher's page HTML and
Overpass are both public. Colleague's course search used to be, but it now
redirects signed-out visitors to SSO, so `collect catalog` fails without a
session and the extension below is what keeps the catalog current. The
directory is behind SSO too, so `collect directory` needs a session cookie, from
`DIRECTORY_COOKIE`, from `--cookie <file>`, or from the signed macOS helper that
`cedarstalk-raycast` already installs.

Booklists need a real browser, because the campus store sits behind an AWS WAF
challenge. Two ways:

```bash
bun run engine harvester 2027SP         # a Tampermonkey script, ids baked in
bun run engine ingest ~/Downloads/2027SP.json
```

...or the extension, which is the better answer.

## The sync extension

`extension/` is an unpacked Chrome extension that keeps the database current
from the browser you are already signed into. Load it at
`chrome://extensions` → Developer mode → Load unpacked, then paste the engine
URL and the bearer token into its popup and press Save.

It does no thinking of its own. It asks `/v1/sync/manifest` what is missing,
runs those directory queries, course searches and booklist fetches with your
own cookies, and posts the results back. Each run crawls the current term and
every term after it that Self-Service lists, so seat counts stay fresh through
registration, plus the every-course listing once a week. Which name prefixes are still hiding rows, which
students have no booklist yet, when a sweep has seen everybody — all of that
stays on the server, so the extension never needs updating when the sweep logic
gets smarter. It runs itself every twelve hours by default.

## Guessing majors

The campus store's booklist leaks `Department / Course / Section` for every book
it wants to sell. Collected across the population and merged over terms, that is
a course fingerprint, scored against all 79 degree programs by TF-IDF cosine:
gen-eds everybody takes count for nothing, major-specific courses dominate.

```bash
bun run engine guess "First Last"
bun run engine guess --all --out guesses.csv
bun run engine labels data/labels/honors.csv   # known majors, for scoring
bun run engine evaluate                        # logs accuracy to the metrics table
```

From one term of mostly-shared coursework it is a reliable **cluster**
classifier (~75%) and a weak fine-grained one (~25% exact): it cannot split
MechE from CompE when they share the freshman core. More semesters is the fix,
and `evaluate` logs every run so the climb is visible.

## Schedules

The major model throws the section number away, because which lab slot somebody
drew says nothing about what they study. For one question it says everything:
`BIO-2500-01` is a row in the catalog, and that row carries the days, the hour
and the room. So a list of books nobody meant to publish as a timetable is a
timetable.

```
GET /v1/people/:id/schedule?term=2026FA
```

Sections with times and rooms, a Monday-to-Friday week with contact minutes per
day, credits summed off the catalog, online sections held apart from the ones
that meet, and the sections a booklist named that the catalog has never heard
of. It is only as current as the last harvest — a course dropped in week three
sits there until a sweep sees it gone, and `/v1/people/:id/history` is where
that movement is written down. A section nobody assigned a book to never shows
up at all.

## The map

`collect campus` pulls building outlines and every footpath, stair and service
drive off OpenStreetMap, then anchors each one to the graph node nearest its
edge — a door, near enough.

Three sources, in order of how much they know. OpenStreetMap draws most of it.
The halls OSM never traced come from Cedarville's own campus tour, whose
polygons are fitted to real coordinates through its sixty-odd GPS markers. What
neither has — the College View blocks, Cedar Park, the operations yard — is
pinned in `src/collect/assets/pins.tsv`, positioned by fitting the university's
printed campus map against the fifty buildings already placed, which lands
within about eight metres across thirty-one anchors. Every pin carries a note
saying where it came from.

Two things worth knowing about that. The bounding box is drawn generously on
purpose: the obvious box around the academic core cuts off the townhouses, the
residence-life centres and the operations yard, which is three hundred people.
And the directory's own name for a building is often nobody else's — Gromacki
Hall is the 2013 townhouse OSM still calls "Townhouse 2" — so
`src/collect/assets/buildings.tsv` maps the directory's shorthand onto the name
each source uses, with fuzzy matching as the fallback rather than the rule.

`/map` draws it: outlines in SVG, the walking graph underneath, buildings shaded
by how many people are listed there, or by hall gender, or by which class holds
the plurality. Pinned buildings are drawn as points rather than invented
footprints, and the ones sharing a position — the four College View blocks, the
three OPS shops — are one marker that breaks back down on hover.

Since everybody in the directory already carries a dorm or an office, that is
all it takes to put the whole population on the map:

```
GET /v1/campus/occupancy?by=class
GET /v1/campus/route?from=Printy%20Hall&to=Engineering%20and%20Science%20Ctr
GET /v1/people/:id/location
```

## History

Every collector writes down what changed rather than only what is:

```
GET /v1/history/events?kind=vanished
GET /v1/history/events?field=dorm_name
GET /v1/history/population
GET /v1/history/churn
GET /v1/people/:id/history
```

One rule worth knowing: only a sweep that asked the whole name space can retire
anybody. A resumed sweep skips the queries an earlier run finished, so most
people were never asked about — retiring on that would graduate the whole
school. `collect directory --refresh` is the one that counts.

## Hosting

Same as everything else I run: a systemd user service and a Caddy entry.

```bash
bun run build                       # -> dist/cedarengine
cp cedarengine.service ~/.config/systemd/user/
systemctl --user enable --now cedarengine
```

```caddy
http://cedarengine.dunkirk.sh {
        bind unix/.cedarengine.dunkirk.sh.webserver.sock|777
        reverse_proxy :38455
}
```

<p align="center">
    <img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/main/.github/images/line-break.svg" />
</p>

<p align="center">
    <i><code>&copy; 2026-present <a href="https://dunkirk.sh">Kieran Klukas</a></code></i>
</p>

<p align="center">
    <a href="https://tangled.org/dunkirk.sh/cedarengine/blob/main/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
