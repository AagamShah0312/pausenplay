# PausenPlay — store site + live seat booking & admin console

The PausenPlay marketing site (intro animation, hero, games, testimonials, contact) now has a
**live booking system** built on it: customers pick a gaming station off the store floor plan,
and the counter staff manage everything from an admin console at `/admin`.

Everything runs on one small **Node server with zero dependencies** — no npm install needed.

---

## Run it

```bash
node server.js          # or: npm start
# optional:  PORT=8080 node server.js
```
<!-- for docker: docker-compose --profile dev up app-dev (every single time)
To come out of it press ctrl+c to gracefully come back (Not delete containers)
 OR 
use docker compose --profile dev down to delete containers also -->

| Page | URL | Notes |
| --- | --- | --- |
| Customer site | `http://localhost:3000/` | new **Book a Seat** section + nav link |
| Admin console | `http://localhost:3000/admin` | login required |

### Admin credentials

| Field | Default |
| --- | --- |
| Username | `Admin` |
| Password | `Admin123` |

Both can be changed after signing in: **Settings → Save credentials** (you must type the
current password). Saving signs you out everywhere, so you log back in with the new details.
The password is stored as a salted scrypt hash in `data/auth.json` — never in plain text.

---

## Customer side (`/`)

* **Live floor plan** of the store — 12 stations across 4 zones
  (PS5 ×4, PC ×4, Racing ×2, Nostalgia ×2).
* **Green = free**, **Red = booked** with a live countdown of how much time is left
  ("⏱ 42:15"), plus the player's name on the station.
* Tap a station → fill **name, phone** → choose **Start now** or **Pick date & time**
  (date + start time, with *in 1 / 2 / 3 hours* and *tomorrow* shortcuts) → choose the duration.
* **Start now** begins the timer immediately. **Reserving** holds the station for the slot you
  picked; the station stays green for everyone else until then and shows a gold
  "⏰ 6:30 pm · reserved later" hint.
* The form tells you straight away whether the station is free in the slot you picked
  (or who has it, and until when) before you submit.
* Confirmation card + a floating bar: **"your session is running"** with the time left, or
  **"your booking is confirmed"** with a *starts in* countdown for a reservation.
* The bar follows the counter: if staff add time it updates, and if they end or cancel the
  session it disappears and says so — it never keeps counting a session that is already over.
* The map updates by itself: when someone books, when a session expires, when a reservation
  starts, or when the admin adds/removes time — no refresh needed (Server-Sent Events, with
  polling fallback).
* Reservation rules live in `data/state.json` → `booking`: `advanceDays` (default 30, how far
  ahead players may book), `minAdvanceMinutes` (optional lead time) and `slotStepMinutes`.
  Times are read in the store timezone (`TZ_NAME`, default `Asia/Kolkata`).

## Admin side (`/admin`)

* **Live floor** with the same green/red stations and countdowns.
* **Running sessions** table: station, player, end time, time left, and buttons to add or cut
  time (**−30 / −15 / +15 / +30 / +1h**) or end a session.
* **Upcoming bookings** table: every reservation waiting to start — who, phone, when it starts
  (with a live *in 2h 15m* countdown), how long, who made it — with **START NOW** (player turned
  up early), **±30m** and **CANCEL**.
* Click any station on the map to open its control pop-up — there you can add/remove time
  (quick buttons **or a custom number of minutes**) and end the session.
* **Walk-in booking** for players who come straight to the counter — leave the optional
  **date / starts at** fields empty to start immediately, or fill them in to hold a station
  for later.
* **Booking history**: every booking ever made — player name, phone, station, start/end time,
  minutes, status (running / scheduled / finished / ended early / cancelled), whether the
  customer or the admin made it, and every time adjustment. Search by name, phone or station
  and filter by status.
* **Excel export**: `⬇ EXPORT EXCEL` downloads a real `.xlsx` ("Bookings" sheet + a
  "Station summary" sheet with sessions/hours per station). A `CSV` button is there too.
* **Floor plan editor**: upload a photo of the store, then drag the stations onto it, resize them,
  rename them, add/remove them, or auto-arrange a grid — saved straight to the server.
* **Settings** to change the admin username and password.
* Quick stats: stations in play, free stations, bookings today, hours played today,
  all-time bookings, unique players.

---

## Using your own store photo / layout

**Fastest way — no file editing at all:**

1. Go to `/admin` → **Upload floor photo** and pick your picture (PNG / JPG / WEBP, up to 8 MB).
   It is saved to `assets/` and becomes the map immediately.
2. Click **Move / resize stations**, then **drag each station onto its spot** and drag its
   bottom-right corner to resize. Use **+ Add** / **Delete** for stations and the
   **Rows / Columns → Arrange as grid** helper for a quick starting layout.
3. Rename a station or its zone in the fields at the bottom, then **Save layout**.
   Players see the new map instantly.

Stations are stored as **percentages of the image**, so the map stays correct on any screen size.

If you prefer to edit the file by hand, stop the server and open `data/state.json`:

```jsonc
{
  "layout": { "image": "assets/my-store.jpg", "width": 1600, "height": 900 },
  "seats": [
    { "id": "PS5-01", "label": "PS5-01", "zone": "PlayStation 5 Zone",
      "type": "ps5", "x": 7, "y": 17, "w": 17, "h": 15 }
  ]
}
```

* `x / y / w / h` are percentages (0–100) measured from the top-left corner of the image —
  so `x:7, y:17, w:17, h:15` = a box starting 7% from the left, 17% from the top,
  17% wide and 15% tall.
* Add or remove stations freely; each needs a unique `id`.
* `type` is one of `ps5`, `pc`, `racing`, `retro`, `other`.
* `durations` controls the time options offered to players (`[30, 60, 90, 120, 180]` minutes by
  default) and `defaultDuration` the pre-selected one.

A station that is currently in use can not be deleted — end its session first.
The default plan is a vector floor map (`assets/store-layout.svg`) drawn to match the included
station coordinates, so it stays sharp on any screen.

---

## Where data is stored

| File | Contents |
| --- | --- |
| `data/state.json` | floor plan, station list, durations |
| `data/bookings.json` | every booking (live + history) |
| `data/auth.json` | admin username + salted password hash |

`data/` is git-ignored and recreated automatically on the first run (with the default
`Admin` / `Admin123` credentials). Delete the folder to reset everything.

## Project layout

```
server.js              HTTP server, API, SSE live updates, Excel export
lib/store.js           bookings, stations, expiry sweeper (JSON file storage)
lib/auth.js            admin login, scrypt password hashing, sessions
lib/xlsx.js            dependency-free .xlsx / CSV writer
public/index.html      the customer site (existing design + booking section)
public/admin.html      admin console markup
public/css/booking.css customer booking styles
public/css/admin.css   admin styles
public/js/booking.js   customer seat map + booking form
public/js/admin.js     admin dashboard
assets/store-layout.svg floor plan image
data/                  live data (auto-created, git-ignored)
```

## API

| Method | Route | Who | Purpose |
| --- | --- | --- | --- |
| GET | `/api/state` | public | stations + live bookings |
| POST | `/api/book` | public | create a booking `{seatId, name, phone, minutes}` — add `{date, time}` (or `startAt`) to reserve a slot instead of starting now |
| GET | `/api/events` | public | SSE stream of live floor changes |
| POST | `/api/admin/login` | – | start session |
| POST | `/api/admin/logout` | admin | end session |
| GET | `/api/admin/me` | admin | current user |
| POST | `/api/admin/credentials` | admin | change username/password |
| GET | `/api/admin/state` | admin | floor + bookings + `upcomingBookings` + stats |
| GET | `/api/admin/history` | admin | full booking history |
| POST | `/api/admin/book` | admin | walk-in booking (or a reservation with `{date, time}`) |
| POST | `/api/admin/adjust` | admin | add/remove minutes `{bookingId, deltaMinutes}` |
| POST | `/api/admin/start` | admin | start a reservation immediately |
| POST | `/api/admin/end` | admin | end a running session / cancel a reservation |
| GET | `/api/export.xlsx` | admin | Excel export |
| GET | `/api/export.csv` | admin | CSV export |

---

## Build & tests

```bash
npm run build   # verifies every file, parses all JS, checks the layout data and the xlsx writer
npm test        # 48 integration tests against a real server instance
npm run check   # build + tests
```

The tests boot `server.js` on a random port with a temporary data directory, so they never touch
your real bookings. They cover the public booking rules, admin auth (including the credential
change flow), time add/remove/end, history, the Excel/CSV export (byte-level zip validation),
live SSE updates, layout editing, image uploads, date-and-time reservations (overlap rules,
auto-start, cancel/start-early) and the exact element order Excel insists on inside the
worksheet XML.

## Deploying

Any host that can run Node 18+ (Render, Railway, Fly, a VPS, or a laptop at the counter).
Set `PORT` if the host requires it, and keep the `data/` folder on a persistent disk if you
want bookings to survive restarts/redeploys. Sessions and live updates are in-memory, which is
fine for a single store.
