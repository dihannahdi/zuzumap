//! Kafilah — a tiny location-sharing service for a circle of friends.
//!
//! One binary: a small JSON API over SQLite, plus (for local dev) static file
//! serving. In production Apache serves the static frontend and reverse-proxies
//! only `/api` here. Everyone in the circle shares one group key.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    key: String,
}

#[derive(Serialize)]
struct Pin {
    device_id: String,
    name: String,
    emoji: String,
    color: String,
    lat: f64,
    lng: f64,
    accuracy: Option<f64>,
    mode: String,
    note: Option<String>,
    updated_at: i64,
    avatar_hash: Option<String>,
    photo_hash: Option<String>,
}

#[derive(Deserialize)]
struct PinIn {
    device_id: String,
    name: String,
    emoji: Option<String>,
    color: Option<String>,
    lat: f64,
    lng: f64,
    accuracy: Option<f64>,
    mode: Option<String>,
    note: Option<String>,
    avatar: Option<String>,
    photo: Option<String>,
}

#[derive(Deserialize)]
struct StopIn {
    device_id: String,
}

#[derive(Deserialize)]
struct DeviceQ {
    device: Option<String>,
}

#[derive(Deserialize)]
struct PhotoQ {
    device: Option<String>,
    kind: Option<String>,
    // Cache-buster only, used by <img src> to force a refetch when the hash
    // changes; the value itself is never checked.
    #[allow(dead_code)]
    v: Option<String>,
    k: Option<String>,
}

#[derive(Deserialize)]
struct TargetQ {
    target: Option<String>,
}

#[derive(Deserialize)]
struct ReactIn {
    target: String,
    from_device: String,
    from_name: Option<String>,
    kind: String,
    content: String,
}

#[derive(Serialize)]
struct HistoryItem {
    photo: String,
    note: Option<String>,
    lat: f64,
    lng: f64,
    created_at: i64,
}

#[derive(Serialize)]
struct Reaction {
    from_name: Option<String>,
    kind: String,
    content: String,
    created_at: i64,
}

#[derive(Deserialize)]
struct DmIn {
    from_device: String,
    to_device: String,
    from_name: Option<String>,
    text: String,
    // Context when the DM is a reply to someone's status: a small thumbnail of
    // the photo being replied to (data URL) + whose status it was.
    reply_photo: Option<String>,
    reply_name: Option<String>,
    // Optional inline chat photo (data URL thumbnail) — a photo-only message
    // (empty text) is valid as long as a photo is attached.
    photo: Option<String>,
    // Optional quoted-reply context from a long-press on another message.
    quote_text: Option<String>,
    quote_name: Option<String>,
}

#[derive(Deserialize)]
struct DmThreadQ {
    me: Option<String>,
    peer: Option<String>,
    since: Option<i64>,
}

#[derive(Deserialize)]
struct ThreadsQ {
    me: Option<String>,
}

#[derive(Serialize)]
struct Msg {
    from_device: String,
    from_name: Option<String>,
    text: String,
    created_at: i64,
    reply_photo: Option<String>,
    reply_name: Option<String>,
    photo: Option<String>,
    quote_text: Option<String>,
    quote_name: Option<String>,
}

#[derive(Serialize)]
struct Thread {
    peer: String,
    name: String,
    text: String,
    mine: bool,
    created_at: i64,
}

#[derive(Serialize)]
struct Moment {
    device_id: String,
    name: String,
    photo: String,
    note: Option<String>,
    lat: f64,
    lng: f64,
    created_at: i64,
}

#[derive(Deserialize)]
struct PingIn {
    device_id: String,
    name: Option<String>,
}

#[derive(Serialize)]
struct PresenceRow {
    device_id: String,
    last_seen: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Trim, then keep at most `max` characters (character-safe for emoji/UTF-8).
fn clamp_str(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

/// Cheap, non-cryptographic content hash used only as a cache-busting id for
/// avatar/photo blobs (so /api/pins can ship a hash instead of the blob).
fn fnv1a64(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}

fn check_key(headers: &HeaderMap, state: &AppState) -> Result<(), StatusCode> {
    let got = headers
        .get("x-kafilah-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !state.key.is_empty() && got == state.key {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// Same as `check_key`, but also accepts the key as a `k` query param — needed
/// for endpoints hit via `<img src>`, which can't send custom headers.
fn check_key_or_param(headers: &HeaderMap, state: &AppState, k: Option<&str>) -> Result<(), StatusCode> {
    if check_key(headers, state).is_ok() {
        return Ok(());
    }
    if !state.key.is_empty() && k.unwrap_or("") == state.key {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn health() -> &'static str {
    "ok"
}

async fn get_pins(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Pin>>, StatusCode> {
    check_key(&headers, &st)?;
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT device_id,name,emoji,color,lat,lng,accuracy,mode,note,updated_at,avatar_hash,photo_hash \
             FROM pins WHERE hidden=0 ORDER BY updated_at DESC LIMIT 500",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Pin {
                device_id: r.get(0)?,
                name: r.get(1)?,
                emoji: r.get(2)?,
                color: r.get(3)?,
                lat: r.get(4)?,
                lng: r.get(5)?,
                accuracy: r.get(6)?,
                mode: r.get(7)?,
                note: r.get(8)?,
                updated_at: r.get(9)?,
                avatar_hash: r.get(10)?,
                photo_hash: r.get(11)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let out: Vec<Pin> = rows.filter_map(|r| r.ok()).collect();
    Ok(Json(out))
}

async fn post_pin(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(inp): Json<PinIn>,
) -> Result<StatusCode, StatusCode> {
    check_key(&headers, &st)?;

    if !inp.lat.is_finite()
        || !inp.lng.is_finite()
        || !(-90.0..=90.0).contains(&inp.lat)
        || !(-180.0..=180.0).contains(&inp.lng)
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    let device_id = clamp_str(&inp.device_id, 64);
    if device_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let name = {
        let n = clamp_str(&inp.name, 40);
        if n.is_empty() {
            "Teman".to_string()
        } else {
            n
        }
    };
    let emoji = {
        let e = clamp_str(inp.emoji.as_deref().unwrap_or("📍"), 8);
        if e.is_empty() {
            "📍".to_string()
        } else {
            e
        }
    };
    let color = clamp_str(inp.color.as_deref().unwrap_or("#0A84FF"), 16);
    let mode = match inp.mode.as_deref() {
        Some("live") => "live",
        _ => "once",
    }
    .to_string();
    let note = inp
        .note
        .as_deref()
        .map(|s| clamp_str(s, 140))
        .filter(|s| !s.is_empty());
    let accuracy = inp.accuracy.filter(|a| a.is_finite() && *a >= 0.0);
    // Small square photo as a data URL, produced client-side. Reject anything
    // that isn't a data:image URL or is implausibly large (guards the payload).
    let avatar = inp
        .avatar
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with("data:image/") && s.len() <= 900_000);
    // Optional "status"/moment photo (Locket-style), shown large. Bigger cap for quality.
    let photo = inp
        .photo
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with("data:image/") && s.len() <= 1_600_000);
    let avatar_hash = avatar.as_deref().map(fnv1a64);
    let photo_hash = photo.as_deref().map(fnv1a64);

    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "INSERT INTO pins (device_id,name,emoji,color,lat,lng,accuracy,mode,note,updated_at,avatar,photo,avatar_hash,photo_hash,hidden) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0) \
         ON CONFLICT(device_id) DO UPDATE SET \
           name=excluded.name,emoji=excluded.emoji,color=excluded.color, \
           lat=excluded.lat,lng=excluded.lng,accuracy=excluded.accuracy, \
           mode=excluded.mode,note=excluded.note,updated_at=excluded.updated_at,avatar=excluded.avatar,photo=excluded.photo, \
           avatar_hash=excluded.avatar_hash,photo_hash=excluded.photo_hash,hidden=0",
        rusqlite::params![
            device_id, name, emoji, color, inp.lat, inp.lng, accuracy, mode, note, now_ms(), avatar, photo, avatar_hash, photo_hash
        ],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Append to photo history when a status photo is present and it differs from
    // the last one (so repeated live posts of the same photo don't pile up).
    if let Some(ph) = &photo {
        let last: Option<String> = db
            .query_row(
                "SELECT photo FROM photo_history WHERE device_id=?1 ORDER BY created_at DESC LIMIT 1",
                [&device_id],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);
        if last.as_deref() != Some(ph.as_str()) {
            let _ = db.execute(
                "INSERT INTO photo_history (device_id,photo,note,lat,lng,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                rusqlite::params![device_id, ph, note, inp.lat, inp.lng, now_ms()],
            );
            let _ = db.execute(
                "DELETE FROM photo_history WHERE device_id=?1 AND id NOT IN \
                 (SELECT id FROM photo_history WHERE device_id=?1 ORDER BY created_at DESC LIMIT 40)",
                [&device_id],
            );
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn get_history(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DeviceQ>,
) -> Result<Json<Vec<HistoryItem>>, StatusCode> {
    check_key(&headers, &st)?;
    let device = clamp_str(q.device.as_deref().unwrap_or(""), 64);
    if device.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT photo,note,lat,lng,created_at FROM photo_history \
             WHERE device_id=?1 ORDER BY created_at DESC LIMIT 40",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([device], |r| {
            Ok(HistoryItem {
                photo: r.get(0)?,
                note: r.get(1)?,
                lat: r.get(2)?,
                lng: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.filter_map(|r| r.ok()).collect()))
}

/// Serves a single avatar/photo blob out of `pins` as raw bytes (not JSON), so
/// it can be used directly as an `<img src>` and cached hard by the browser.
/// `/api/pins` only ships a content hash now — this is where the bytes live.
async fn get_photo(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PhotoQ>,
) -> Result<impl IntoResponse, StatusCode> {
    check_key_or_param(&headers, &st, q.k.as_deref())?;
    let device = clamp_str(q.device.as_deref().unwrap_or(""), 64);
    if device.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let sql = match q.kind.as_deref().unwrap_or("") {
        "avatar" => "SELECT avatar FROM pins WHERE device_id=?1",
        "photo" => "SELECT photo FROM pins WHERE device_id=?1",
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data_url: Option<String> = db
        .query_row(sql, [&device], |r| r.get(0))
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .flatten();
    let data_url = data_url.ok_or(StatusCode::NOT_FOUND)?;
    // Parse "data:<mime>;base64,<payload>".
    let rest = data_url.strip_prefix("data:").ok_or(StatusCode::NOT_FOUND)?;
    let (meta, payload) = rest.split_once(',').ok_or(StatusCode::NOT_FOUND)?;
    let mime = meta.strip_suffix(";base64").ok_or(StatusCode::NOT_FOUND)?.to_string();
    let bytes = B64.decode(payload).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable".to_string()),
        ],
        bytes,
    ))
}

async fn react(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(inp): Json<ReactIn>,
) -> Result<StatusCode, StatusCode> {
    check_key(&headers, &st)?;
    let target = clamp_str(&inp.target, 64);
    let from_device = clamp_str(&inp.from_device, 64);
    if target.is_empty() || from_device.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let kind = match inp.kind.as_str() {
        "emoji" => "emoji",
        "text" => "text",
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    let content = clamp_str(&inp.content, if kind == "emoji" { 24 } else { 300 });
    if content.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let from_name = inp
        .from_name
        .as_deref()
        .map(|s| clamp_str(s, 40))
        .filter(|s| !s.is_empty());
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "INSERT INTO reactions (target,from_device,from_name,kind,content,created_at) \
         VALUES (?1,?2,?3,?4,?5,?6)",
        rusqlite::params![target, from_device, from_name, kind, content, now_ms()],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = db.execute(
        "DELETE FROM reactions WHERE target=?1 AND id NOT IN \
         (SELECT id FROM reactions WHERE target=?1 ORDER BY created_at DESC LIMIT 200)",
        [target],
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn get_reactions(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TargetQ>,
) -> Result<Json<Vec<Reaction>>, StatusCode> {
    check_key(&headers, &st)?;
    let target = clamp_str(q.target.as_deref().unwrap_or(""), 64);
    if target.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT from_name,kind,content,created_at FROM reactions \
             WHERE target=?1 ORDER BY created_at DESC LIMIT 100",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([target], |r| {
            Ok(Reaction {
                from_name: r.get(0)?,
                kind: r.get(1)?,
                content: r.get(2)?,
                created_at: r.get(3)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.filter_map(|r| r.ok()).collect()))
}

async fn stop_pin(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(inp): Json<StopIn>,
) -> Result<StatusCode, StatusCode> {
    check_key(&headers, &st)?;
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "UPDATE pins SET hidden=1 WHERE device_id=?1",
        rusqlite::params![clamp_str(&inp.device_id, 64)],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn send_dm(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(inp): Json<DmIn>,
) -> Result<StatusCode, StatusCode> {
    check_key(&headers, &st)?;
    let from = clamp_str(&inp.from_device, 64);
    let to = clamp_str(&inp.to_device, 64);
    if from.is_empty() || to.is_empty() || from == to {
        return Err(StatusCode::BAD_REQUEST);
    }
    let text = clamp_str(&inp.text, 1000);
    // Invalid/oversized reply/photo/quote context is dropped silently; the
    // message still sends. A photo-only message (empty text) is valid as
    // long as a photo is attached.
    let photo = inp
        .photo
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with("data:image/") && s.len() <= 300_000);
    if text.is_empty() && photo.is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let name = inp
        .from_name
        .as_deref()
        .map(|s| clamp_str(s, 40))
        .filter(|s| !s.is_empty());
    let reply_photo = inp
        .reply_photo
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with("data:image/") && s.len() <= 300_000);
    let reply_name = inp
        .reply_name
        .as_deref()
        .map(|s| clamp_str(s, 40))
        .filter(|s| !s.is_empty());
    let quote_text = inp
        .quote_text
        .as_deref()
        .map(|s| clamp_str(s, 140))
        .filter(|s| !s.is_empty());
    let quote_name = inp
        .quote_name
        .as_deref()
        .map(|s| clamp_str(s, 40))
        .filter(|s| !s.is_empty());
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "INSERT INTO messages (from_device,to_device,from_name,text,created_at,reply_photo,reply_name,photo,quote_text,quote_name) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![from, to, name, text, now_ms(), reply_photo, reply_name, photo, quote_text, quote_name],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_dm(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DmThreadQ>,
) -> Result<Json<Vec<Msg>>, StatusCode> {
    check_key(&headers, &st)?;
    let me = clamp_str(q.me.as_deref().unwrap_or(""), 64);
    let peer = clamp_str(q.peer.as_deref().unwrap_or(""), 64);
    if me.is_empty() || peer.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let since = q.since.unwrap_or(0);
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    // Group chat: everyone shares the "__group__" thread.
    if peer == "__group__" {
        let mut stmt = db
            .prepare(
                "SELECT from_device,from_name,text,created_at,reply_photo,reply_name,photo,quote_text,quote_name FROM messages \
                 WHERE to_device='__group__' AND created_at > ?1 ORDER BY created_at ASC LIMIT 400",
            )
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let rows = stmt
            .query_map([since], |r| {
                Ok(Msg { from_device: r.get(0)?, from_name: r.get(1)?, text: r.get(2)?, created_at: r.get(3)?, reply_photo: r.get(4)?, reply_name: r.get(5)?, photo: r.get(6)?, quote_text: r.get(7)?, quote_name: r.get(8)? })
            })
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return Ok(Json(rows.filter_map(|r| r.ok()).collect()));
    }
    let mut stmt = db
        .prepare(
            "SELECT from_device,from_name,text,created_at,reply_photo,reply_name,photo,quote_text,quote_name FROM messages \
             WHERE ((from_device=?1 AND to_device=?2) OR (from_device=?2 AND to_device=?1)) AND created_at > ?3 \
             ORDER BY created_at ASC LIMIT 300",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map(rusqlite::params![me, peer, since], |r| {
            Ok(Msg { from_device: r.get(0)?, from_name: r.get(1)?, text: r.get(2)?, created_at: r.get(3)?, reply_photo: r.get(4)?, reply_name: r.get(5)?, photo: r.get(6)?, quote_text: r.get(7)?, quote_name: r.get(8)? })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.filter_map(|r| r.ok()).collect()))
}

async fn get_threads(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ThreadsQ>,
) -> Result<Json<Vec<Thread>>, StatusCode> {
    check_key(&headers, &st)?;
    let me = clamp_str(q.me.as_deref().unwrap_or(""), 64);
    if me.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT from_device,to_device,from_name,text,created_at FROM messages \
             WHERE (from_device=?1 OR to_device=?1) AND to_device != '__group__' \
             ORDER BY created_at DESC LIMIT 500",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map(rusqlite::params![me], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut order: Vec<String> = Vec::new();
    let mut threads: HashMap<String, Thread> = HashMap::new();
    let mut names: HashMap<String, String> = HashMap::new();
    for (fromd, tod, fname, text, ts) in rows.flatten() {
        let peer = if fromd == me { tod } else { fromd.clone() };
        if !threads.contains_key(&peer) {
            order.push(peer.clone());
            threads.insert(
                peer.clone(),
                Thread { peer: peer.clone(), name: String::new(), text, mine: fromd == me, created_at: ts },
            );
        }
        if fromd != me {
            names.entry(peer).or_insert_with(|| fname.unwrap_or_default());
        }
    }
    let mut out = Vec::new();
    for peer in order {
        if let Some(mut t) = threads.remove(&peer) {
            if let Some(n) = names.get(&peer) {
                if !n.is_empty() {
                    t.name = n.clone();
                }
            }
            out.push(t);
        }
    }
    Ok(Json(out))
}

async fn get_moments(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<Moment>>, StatusCode> {
    check_key(&headers, &st)?;
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT h.device_id, COALESCE(p.name,''), h.photo, h.note, h.lat, h.lng, h.created_at \
             FROM photo_history h LEFT JOIN pins p ON p.device_id = h.device_id \
             ORDER BY h.created_at DESC LIMIT 60",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Moment {
                device_id: r.get(0)?,
                name: r.get(1)?,
                photo: r.get(2)?,
                note: r.get(3)?,
                lat: r.get(4)?,
                lng: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.filter_map(|r| r.ok()).collect()))
}

async fn ping(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(inp): Json<PingIn>,
) -> Result<StatusCode, StatusCode> {
    check_key(&headers, &st)?;
    let d = clamp_str(&inp.device_id, 64);
    if d.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let name = inp
        .name
        .as_deref()
        .map(|s| clamp_str(s, 40))
        .filter(|s| !s.is_empty());
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "INSERT INTO presence (device_id,name,last_seen) VALUES (?1,?2,?3) \
         ON CONFLICT(device_id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen",
        rusqlite::params![d, name, now_ms()],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_presence(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PresenceRow>>, StatusCode> {
    check_key(&headers, &st)?;
    let db = st.db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare("SELECT device_id,last_seen FROM presence ORDER BY last_seen DESC LIMIT 500")
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rows = stmt
        .query_map([], |r| Ok(PresenceRow { device_id: r.get(0)?, last_seen: r.get(1)? }))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.filter_map(|r| r.ok()).collect()))
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();

    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8795".into());
    let key = std::env::var("APP_KEY").unwrap_or_default();
    if key.is_empty() {
        eprintln!("WARNING: APP_KEY is empty — the API is unprotected. Set APP_KEY.");
    }
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "./data/kafilah.db".into());
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "./static".into());

    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&db_path).expect("open sqlite db");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pins (\
            device_id  TEXT PRIMARY KEY,\
            name       TEXT NOT NULL,\
            emoji      TEXT NOT NULL,\
            color      TEXT NOT NULL,\
            lat        REAL NOT NULL,\
            lng        REAL NOT NULL,\
            accuracy   REAL,\
            mode       TEXT NOT NULL,\
            note       TEXT,\
            updated_at INTEGER NOT NULL,\
            avatar     TEXT,\
            photo      TEXT,\
            avatar_hash TEXT,\
            photo_hash  TEXT,\
            hidden     INTEGER NOT NULL DEFAULT 0\
        );",
    )
    .expect("init db schema");
    // Idempotent migrations for DBs created before these columns existed.
    let _ = conn.execute("ALTER TABLE pins ADD COLUMN avatar TEXT", []);
    let _ = conn.execute("ALTER TABLE pins ADD COLUMN photo TEXT", []);
    let _ = conn.execute("ALTER TABLE pins ADD COLUMN avatar_hash TEXT", []);
    let _ = conn.execute("ALTER TABLE pins ADD COLUMN photo_hash TEXT", []);

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS photo_history (\
            id INTEGER PRIMARY KEY,\
            device_id TEXT NOT NULL,\
            photo TEXT NOT NULL,\
            note TEXT,\
            lat REAL NOT NULL,\
            lng REAL NOT NULL,\
            created_at INTEGER NOT NULL\
        );\
        CREATE INDEX IF NOT EXISTS idx_history_device ON photo_history(device_id, created_at);\
        CREATE TABLE IF NOT EXISTS reactions (\
            id INTEGER PRIMARY KEY,\
            target TEXT NOT NULL,\
            from_device TEXT NOT NULL,\
            from_name TEXT,\
            kind TEXT NOT NULL,\
            content TEXT NOT NULL,\
            created_at INTEGER NOT NULL\
        );\
        CREATE INDEX IF NOT EXISTS idx_react_target ON reactions(target, created_at);\
        CREATE TABLE IF NOT EXISTS messages (\
            id INTEGER PRIMARY KEY,\
            from_device TEXT NOT NULL,\
            to_device TEXT NOT NULL,\
            from_name TEXT,\
            text TEXT NOT NULL,\
            created_at INTEGER NOT NULL,\
            reply_photo TEXT,\
            reply_name TEXT,\
            photo TEXT,\
            quote_text TEXT,\
            quote_name TEXT\
        );\
        CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_device, to_device, created_at);\
        CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_device, created_at);\
        CREATE TABLE IF NOT EXISTS presence (\
            device_id TEXT PRIMARY KEY,\
            name TEXT,\
            last_seen INTEGER NOT NULL\
        );",
    )
    .expect("init extra schema");
    // Idempotent migrations for DBs created before these columns existed.
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN reply_photo TEXT", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN reply_name TEXT", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN photo TEXT", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN quote_text TEXT", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN quote_name TEXT", []);

    // Backfill avatar_hash/photo_hash for rows written before these columns
    // existed, so /api/photo has a hash to look up right away.
    {
        let mut stmt = conn
            .prepare(
                "SELECT device_id, avatar, photo FROM pins \
                 WHERE (avatar IS NOT NULL AND avatar_hash IS NULL) \
                    OR (photo IS NOT NULL AND photo_hash IS NULL)",
            )
            .expect("prepare backfill select");
        let rows: Vec<(String, Option<String>, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .expect("query backfill rows")
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        for (device_id, avatar, photo) in rows {
            let avatar_hash = avatar.as_deref().map(fnv1a64);
            let photo_hash = photo.as_deref().map(fnv1a64);
            let _ = conn.execute(
                "UPDATE pins SET avatar_hash=?2, photo_hash=?3 WHERE device_id=?1",
                rusqlite::params![device_id, avatar_hash, photo_hash],
            );
        }
    }

    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        key,
    };

    let index_path = format!("{}/index.html", static_dir.trim_end_matches('/'));
    let static_svc = ServeDir::new(&static_dir).not_found_service(ServeFile::new(index_path));

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/pins", get(get_pins).post(post_pin))
        .route("/api/pins/stop", post(stop_pin))
        .route("/api/history", get(get_history))
        .route("/api/photo", get(get_photo))
        .route("/api/react", post(react))
        .route("/api/reactions", get(get_reactions))
        .route("/api/dm", get(get_dm).post(send_dm))
        .route("/api/threads", get(get_threads))
        .route("/api/moments", get(get_moments))
        .route("/api/ping", post(ping))
        .route("/api/presence", get(get_presence))
        .fallback_service(static_svc)
        .with_state(state);

    let addr: SocketAddr = bind.parse().expect("BIND_ADDR must be host:port");
    println!("kafilah listening on http://{addr}  (static: {static_dir})");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind listener");
    axum::serve(listener, app).await.expect("serve");
}
