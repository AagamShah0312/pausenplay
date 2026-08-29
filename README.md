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
* Tap a green station → fill **name, phone, duration** → *Lock in my seat*.
* Confirmation card + a floating **"your session is running" bar** with a ticking countdown.
* The map updates by itself: when someone books, when a session expires, or when the admin
  adds/removes time — no refresh needed (Server-Sent Events, with polling fallback).

## Admin side (`/admin`)

* **Live floor** with the same green/red stations and countdowns.
* **Running sessions** table: station, player, end time, time left, and buttons to add or cut
  time (**−30 / −15 / +15 / +30 / +1h**) or end a session.
* Click any station on the map to open its control pop-up — there you can add/remove time
  (quick buttons **or a custom number of minutes**) and end the session.
* **Walk-in booking** for players who come straight to the counter.
* **Booking history**: every booking ever made — player name, phone, station, start/end time,
  minutes, status (running / finished), whether the customer or the admin made it, and every
  time adjustment. Search by name, phone or station and filter running/finished.
* **Excel export**: `⬇ EXPORT EXCEL` downloads a real `.xlsx` ("Bookings" sheet + a
  "Station summary" sheet with sessions/hours per station). A `CSV` button is there too.
* **Settings** to change the admin username and password.
* Quick stats: stations in play, free stations, bookings today, hours played today,
  all-time bookings, unique players.

---

## Using your own store photo / layout

The floor plan is just an image with stations positioned on top of it in **percentages**, so you
can drop in a photo of your actual store:

1. Put the picture in `assets/` (e.g. `assets/my-store.jpg`).
2. Stop the server, open `data/state.json` (it is created on first run) and edit:

```jsonc
{
  "layout": { "image": "assets/my-store.jpg", "width": 1600, "height": 900 },
  "seats": [
    { "id": "PS5-01", "label": "PS5-01", "zone": "PlayStation 5 Zone",
      "type": "ps5", "x": 7, "y": 17, "w": 17, "h": 15 },
    ...
  ]
}
```

* `x / y / w / h` are percentages of the image (0–100), measured from the top-left corner —
  so `x:7, y:17, w:17, h:15` = a box starting 7% from the left, 17% from the top,
  17% wide and 15% tall.
* Add or remove stations freely; give each a unique `id`.
* `durations` in the same file controls the time options offered to players
  (`[30, 60, 90, 120, 180]` minutes by default) and `defaultDuration` the pre-selected one.

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
| POST | `/api/book` | public | create a booking `{seatId, name, phone, minutes}` |
| GET | `/api/events` | public | SSE stream of live floor changes |
| POST | `/api/admin/login` | – | start session |
| POST | `/api/admin/logout` | admin | end session |
| GET | `/api/admin/me` | admin | current user |
| POST | `/api/admin/credentials` | admin | change username/password |
| GET | `/api/admin/state` | admin | floor + bookings + stats |
| GET | `/api/admin/history` | admin | full booking history |
| POST | `/api/admin/book` | admin | walk-in booking |
| POST | `/api/admin/adjust` | admin | add/remove minutes `{bookingId, deltaMinutes}` |
| POST | `/api/admin/end` | admin | end a session now |
| GET | `/api/export.xlsx` | admin | Excel export |
| GET | `/api/export.csv` | admin | CSV export |

---

## Deploying

Any host that can run Node 18+ (Render, Railway, Fly, a VPS, or a laptop at the counter).
Set `PORT` if the host requires it, and keep the `data/` folder on a persistent disk if you
want bookings to survive restarts/redeploys. Sessions and live updates are in-memory, which is
fine for a single store.
