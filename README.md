# ZuzuMap — peta sahabat

A Find My–style, full-screen map where a circle of friends share their location —
one-time (with the moment it was shared) or live. Built for friends scattered across
the world on KKN. One shared key protects the whole circle; no accounts.

Live at **https://map.nahdi.space**.

> The product name is **ZuzuMap**. Internally the crate, binary, systemd service, and
> API key header keep the original codename `kafilah` (e.g. `X-Kafilah-Key`, `/opt/kafilah`).

## Stack

- **Backend:** Rust + Axum, one binary. SQLite (`rusqlite`, bundled). JSON API under `/api`.
- **Frontend:** vanilla HTML/CSS/JS + [MapLibre GL JS](https://maplibre.org) (self-hosted in `static/vendor/`) with CARTO Positron / Dark-Matter basemaps (no API key). PWA (installable).
- **Prod:** Apache reverse-proxy + Let's Encrypt on the `sonushub` VPS; the binary runs under systemd on `127.0.0.1:8795`. Apache serves the static frontend from the docroot and proxies `/api` to the binary.

## API

All endpoints require header `X-Kafilah-Key: <APP_KEY>` (except `/api/health`).

| Method | Path             | Body                                                           | Effect                          |
|--------|------------------|----------------------------------------------------------------|---------------------------------|
| GET    | `/api/health`    | —                                                              | `ok`                            |
| GET    | `/api/pins`      | —                                                              | list all visible pins (JSON)    |
| POST   | `/api/pins`      | `{device_id,name,emoji,color,lat,lng,accuracy,mode,note}`      | upsert my pin (server stamps time) |
| POST   | `/api/pins/stop` | `{device_id}`                                                  | hide my pin (stop sharing)      |

`mode` is `"once"` or `"live"`. `updated_at` is server epoch-ms — the authoritative "shared at" time.

## Configuration

Copy `.env.example` → `.env`. Keys: `APP_KEY`, `BIND_ADDR`, `DB_PATH`, `STATIC_DIR`.

## Local development

```sh
cp .env.example .env      # set APP_KEY, keep STATIC_DIR=./static, DB_PATH=./data/kafilah.db
cargo run
# open http://127.0.0.1:8795/?k=<APP_KEY>
```

The binary serves the static frontend itself in dev. Geolocation needs a secure
context; `localhost`/`127.0.0.1` count as secure, so live/once sharing work locally.

## Deploy to sonushub

DNS (once): add an A record `map.nahdi.space → 217.15.160.49` via the Hostinger API,
then:

1. `rsync` the source to a build dir on the server and `cargo build --release` (server has Rust + gcc).
2. Copy the binary + `.env` to `/opt/kafilah/`; copy `static/` to `/www/wwwroot/map.nahdi.space/`.
3. Install `deploy/kafilah.service` → `systemctl enable --now kafilah`.
4. Install the `:80` half of `deploy/map.nahdi.space.conf`, reload Apache, issue the cert
   (`certbot certonly --webroot -w /www/wwwroot/map.nahdi.space -d map.nahdi.space`), then add the `:443` half and reload.

Redeploying the **frontend** only = rsync `static/` to the docroot (no rebuild).
Redeploying the **backend** = rebuild, copy binary, `systemctl restart kafilah`.

## Sharing with friends

Send them: `https://map.nahdi.space/?k=<APP_KEY>` — the page saves the key and strips it from the URL.
