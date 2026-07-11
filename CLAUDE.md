# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ZuzuMap (https://map.nahdi.space) — a Find My–style location-sharing PWA for a circle of friends, with a Locket-style social layer (status photos, reactions, DM chat). The product name is **ZuzuMap**; the crate, binary, systemd service, DB, and API-key header keep the original codename **`kafilah`** (`X-Kafilah-Key`, `/opt/kafilah`). UI copy is Indonesian.

## Commands

```sh
# Local dev (binary serves ./static itself; needs .env — copy from .env.example)
cargo run                    # then open http://127.0.0.1:8795/?k=<APP_KEY>

cargo build --release        # release binary (target/release/kafilah)
cargo check                  # fast validation
```

There are no tests and no linter configured. `package.json` is vestigial — this is not a Node project; the frontend has no build step.

### Deploy (server = `ssh sonushub`)

- **Frontend only** (any change under `static/`): copy `static/` to `/www/wwwroot/map.nahdi.space/` (tar/rsync over ssh). No rebuild. **Always bump the SW cache version** (`kafilah-vN` in `sw.js`) so clients pick up the new shell on next load.
- **Backend** (any change to `src/`): rsync source to a build dir on the server, build there with `bash -lc 'cargo build --release'` (cargo is only on the login-shell PATH: `/root/.cargo/bin`), copy the binary to `/opt/kafilah/kafilah`, `systemctl restart kafilah`.
- Runtime config lives in `/opt/kafilah/.env` (systemd `EnvironmentFile`); SQLite DB at `/opt/kafilah/data/kafilah.db`. Apache serves the docroot and proxies `/api` → `127.0.0.1:8795` (vhost: `/www/server/panel/vhost/apache/map.nahdi.space.conf`, reload with `/etc/init.d/httpd graceful`).

## Architecture

Two halves, deployed independently:

- **`src/main.rs`** — the entire backend: one Axum binary, SQLite via `rusqlite` (a single `Arc<Mutex<Connection>>`, no pool), JSON API under `/api`. Every endpoint except `/api/health` requires the shared group secret in the `X-Kafilah-Key` header (`check_key`). Schema is created at startup with `CREATE TABLE IF NOT EXISTS` plus **idempotent `ALTER TABLE ... ADD COLUMN` migrations** (errors ignored) — follow that pattern when adding columns. Tables: `pins` (one row per device, upsert), `photo_history` (last 40 per device), `reactions` (last 200 per target), `messages` (DMs; `to_device='__group__'` is the shared group thread), `presence`.
- **`static/`** — the entire frontend: one IIFE in `app.js`, all markup in `index.html` (modals as `hidden` siblings), all styles in `app.css`, offline shell in `sw.js`. Vanilla JS, no framework, no build. MapLibre GL + GSAP self-hosted in `static/vendor/`.

Key frontend conventions:

- Identity is a per-device UUID in `localStorage` (`kafilah_device`); the group key is `kafilah_key` (grabbed from `?k=` and stripped from the URL). All server calls go through the `api()` helper, which attaches the key header and shows the key gate on 401.
- State polling: `/api/pins` every 10 s (`refresh()`), chat thread every 4 s while open, photo history/moments fetched on demand only — keep heavy data out of the 10 s poll.
- Images are client-side-resized to JPEG **data URLs** (no upload endpoint): avatar ≤ 512 px (server caps 900 KB), status photo ≤ 1024 px (server caps 1.6 MB). The server rejects anything not starting with `data:image/`.
- Any new modal/overlay **must** be added to the `ids` arrays in both `syncModalOpen()` and `watchModals()` (app.js) — that's what hides the bottom sheet/FAB behind it on iOS. Close via `animateClose()` for the shared slide-down animation.
- All user-provided strings rendered via `innerHTML` go through `escapeHtml()`.
- Theme: `data-theme` on `<html>` (`auto|light|dark`); dark CSS vars are declared twice in `app.css` (under the `prefers-color-scheme` media query with `:not([data-theme=light])`, and under `:root[data-theme=dark]`) — update both. Basemap swaps via `map.setStyle(baseStyle(dark))`; a `styledata` handler re-adds overlays.
- Gotcha already fixed once: author CSS `display:` rules beat the UA `[hidden]` rule — `app.css` has a global `[hidden]{display:none!important}`. Don't remove it.

## API surface

All JSON, all behind `X-Kafilah-Key` (except `/api/health`):

- `GET/POST /api/pins`, `POST /api/pins/stop` — location pins (upsert per device; `mode` = `once`|`live`; server stamps `updated_at`)
- `GET /api/history?device=`, `GET /api/moments` — status-photo history (per device / global feed)
- `POST /api/react`, `GET /api/reactions?target=` — emoji/text reactions on a status
- `POST /api/dm`, `GET /api/dm?me=&peer=`, `GET /api/threads?me=` — 1-on-1 chat (`peer=__group__` for the group thread). A DM may carry status-reply context: `reply_photo` (thumbnail data URL, ≤ 300 KB, else silently dropped) + `reply_name`, rendered IG-style above the bubble
- `POST /api/ping`, `GET /api/presence` — online presence (90 s window)

Unread state (inbox badge, chat dots) is purely client-side via `localStorage` timestamps (`kafilah_chat_seen`, `kafilah_inbox_seen`) — the server stores no read state.
