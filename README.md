# AIRDATE

Self-hosted TV Time-style tracker. Search shows and movies (TMDB), track what
you're watching, and see what's coming up next and what you're behind on.
Supports multiple separate accounts, one per household member.

## Setup

1. Get a free TMDB API key: https://www.themoviedb.org/settings/api
   (You want the **v3 API Key**, not the v4 read access token.)

2. Copy the env template and fill it in:

   ```
   cp .env.example .env
   nano .env
   ```

3. Build and start:

   ```
   docker compose up -d --build
   ```

4. Open `http://<host>:3000`, log in with the username/password you set in
   `.env` (`ACCOUNT_NAME` / `APP_PASSWORD`), hit **+ Add title**.

## Accounts

The first time the app starts, it creates one account from `ACCOUNT_NAME` and
`APP_PASSWORD` in your `.env`. After that, those env vars no longer matter —
everything is managed from inside the app under the **Accounts** button in
the top bar, where you can add more accounts for other people. Each account
has its own completely separate library, watchlist, and watched history.

If you're upgrading from an older version that only had a single shared
password, your existing library is automatically migrated into an account
using those same `ACCOUNT_NAME` / `APP_PASSWORD` values — nothing is lost,
and you can keep logging in with the same password as before.

## Features

- **Upcoming** — a TV Time-style feed of what's airing/releasing next across
  everything you track, with accurate air times (cross-checked against
  TVmaze, with a manual override if a show has neither)
- **Watchlist** — everything aired that you haven't marked watched yet,
  oldest first, with one-tap or mark-all-at-once catch-up
- **Library** — your full collection, with per-show detail (season/episode
  breakdown, synopsis, stills), pause/resume tracking, and removal
- **Import** — bring in your watched history from a TV Time data export
- **Push notifications** — an optional daily digest ("3 shows air today")
  sent to your phone/browser at a time you choose, per account. Enable it
  from the Accounts menu. Requires HTTPS (already true if you're using a
  Cloudflare tunnel or similar) — won't work over plain `http://` LAN
  access, since browsers require a secure context for push. On iPhone, add
  the site to your Home Screen first (Share → Add to Home Screen), then
  enable notifications from there — this is an Apple requirement, not
  something this app can work around.

## Notes

- Each account's data lives in `./data/library-<id>.json` (bind-mounted), so
  it survives container rebuilds. Account credentials live in
  `./data/accounts.json`, with passwords stored as bcrypt hashes.
- TMDB/TVmaze responses are cached in memory for 6 hours to stay well under
  rate limits.
- To change the port, edit the left side of `ports:` in docker-compose.yml
  (e.g. `"3210:3000"`).

## PLEASE CONSIDER DONATING
Times are tough right now so any help would be appreciated.   Thank you!
https://donate.tonystegall.net