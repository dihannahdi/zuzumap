/* Kafilah — peta sahabat. Vanilla JS + MapLibre GL. */
(function () {
  'use strict';

  // ---------- constants ----------
  const EMOJIS = ['📍', '😀', '🧕', '🧑', '🌙', '⭐', '🌴', '🕌', '🚀', '🐫', '☕', '📚'];
  const COLORS = ['#0A84FF', '#30D158', '#FF9F0A', '#FF375F', '#BF5AF2', '#5E5CE6', '#64D2FF', '#FFD60A'];
  const POLL_MS = 10000;       // refresh everyone every 10s
  const LIVE_POST_MS = 10000;  // when live, post my location at most this often
  const STALE_MS = 5 * 60 * 1000; // a "live" pin older than this counts as stale

  const LS = { key: 'kafilah_key', device: 'kafilah_device', name: 'kafilah_name', emoji: 'kafilah_emoji', color: 'kafilah_color', avatar: 'kafilah_avatar', theme: 'kafilah_theme', inboxSeen: 'kafilah_inbox_seen' };
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------
  let map, mapReady = false;
  let markers = {};       // device_id -> { marker, el, pin }
  let meMarker = null;
  let myLoc = null;       // {lat,lng} viewer's own last-known location
  let pins = [];
  let pollTimer = null;
  let watchId = null;
  let liveMode = false;
  let lastPost = 0;
  let selectedMode = 'once';
  let firstFit = true;
  let toastT = null;
  let currentDetailPin = null;
  let detailList = [];
  let detailIndex = 0;
  let selectedDeviceId = null;
  let swiped = false;
  let sheetState = 'peek';
  let sheetDraggable = null;
  let reactTarget = null;
  let myReactions = [];
  let myThreads = [];
  let chatPeer = null;
  let chatTimer = null;
  let chatMsgs = [];
  let chatQuote = null;
  let groupLast = null;
  let curApprox = false;
  let liveStopTimer = null;
  const presenceMap = {};
  const placeCache = {};
  const historyCache = {};
  const deviceId = getDevice();
  let curEmoji = localStorage.getItem(LS.emoji) || '📍';
  let curColor = localStorage.getItem(LS.color) || '#0A84FF';
  let curAvatar = localStorage.getItem(LS.avatar) || '';
  let curStatus = '';

  // ---------- storage / key ----------
  function getDevice() {
    let d = localStorage.getItem(LS.device);
    if (!d) {
      d = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      localStorage.setItem(LS.device, d);
    }
    return d;
  }
  function getKey() { return localStorage.getItem(LS.key) || ''; }
  function setKey(k) { localStorage.setItem(LS.key, k); }

  (function grabKeyFromUrl() {
    const u = new URL(location.href);
    const k = u.searchParams.get('k');
    if (k) {
      setKey(k.trim());
      u.searchParams.delete('k');
      history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    }
  })();

  // ---------- API ----------
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'X-Kafilah-Key': getKey() }, opts.headers || {});
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch('/api' + path, Object.assign({}, opts, { headers }));
    if (res.status === 401) { showGate(true); throw new Error('unauthorized'); }
    return res;
  }

  // ---------- map ----------
  function tilesFor(dark) {
    const path = dark ? 'dark_all/{z}/{x}/{y}.png' : 'rastertiles/voyager/{z}/{x}/{y}.png';
    return ['a', 'b', 'c', 'd'].map((h) => `https://${h}.basemaps.cartocdn.com/${path}`);
  }
  function rasterStyle(dark) {
    return {
      version: 8,
      sources: { base: { type: 'raster', tiles: tilesFor(dark), tileSize: 256, attribution: '© OpenStreetMap contributors © CARTO' } },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    };
  }
  // Colourful vector basemap — sea blue, land/islands green (OpenFreeMap, no key).
  function vectorStyle() {
    const roadW = ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.5, 16, 4];
    return {
      version: 8,
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© OpenMapTiles © OpenStreetMap contributors' } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#c2e6a4' } },
        { id: 'wood', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover',
          filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest', 'grass', 'scrub', 'tree']]],
          paint: { 'fill-color': '#9ed586', 'fill-opacity': 0.65 } },
        { id: 'residential', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse',
          filter: ['==', ['get', 'class'], 'residential'], paint: { 'fill-color': '#d8edc4' } },
        { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
          paint: { 'fill-color': '#78c3ec' } },
        { id: 'waterway', type: 'line', source: 'openmaptiles', 'source-layer': 'waterway',
          paint: { 'line-color': '#78c3ec', 'line-width': 1 } },
        { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
          filter: ['!=', ['get', 'class'], 'ferry'],
          paint: { 'line-color': '#ffffff', 'line-width': roadW } },
        { id: 'road-major', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
          filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
          paint: { 'line-color': '#ffd684', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 12, 3, 16, 6] } },
        { id: 'place', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place',
          filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb', 'island']]],
          layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 13] },
          paint: { 'text-color': '#37502a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 } },
      ],
    };
  }
  function baseStyle(dark) { return dark ? rasterStyle(true) : vectorStyle(); }

  function ensureOverlays() {
    if (!map.getSource('accuracy')) {
      map.addSource('accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getLayer('accuracy-fill')) {
      map.addLayer({ id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
    }
    if (!map.getLayer('accuracy-line')) {
      map.addLayer({ id: 'accuracy-line', type: 'line', source: 'accuracy', paint: { 'line-color': ['get', 'color'], 'line-opacity': 0.4, 'line-width': 1 } });
    }
    renderMarkers();
  }
  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: baseStyle(effectiveDark()),
      center: [110, 0],
      zoom: 1.6,
      attributionControl: { compact: true },
      fadeDuration: 250,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.on('load', () => {
      mapReady = true;
      ensureOverlays();
      updateMe();
      if (firstFit && pins.length) { firstFit = false; fitToPins(); }
    });
    // Re-add overlays whenever a new style finishes loading (theme swap).
    map.on('styledata', () => { if (mapReady && map.isStyleLoaded() && !map.getLayer('accuracy-fill')) ensureOverlays(); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (currentTheme() === 'auto') applyTheme(); });
  }

  // /api/pins ships only content hashes now (no inline data URLs) — build the
  // cacheable image URL for a pin's avatar/status photo from its hash.
  function photoUrl(pin, kind) {
    const h = kind === 'avatar' ? pin.avatar_hash : pin.photo_hash;
    if (!h) return '';
    return '/api/photo?device=' + encodeURIComponent(pin.device_id) + '&kind=' + kind + '&v=' + h + '&k=' + encodeURIComponent(getKey());
  }

  // Set a bubble/avatar element to show a photo (if any) or the emoji.
  function applyBubble(el, pin) {
    if (!el) return;
    const av = photoUrl(pin, 'avatar');
    if (av) { el.style.backgroundImage = `url('${av}')`; el.textContent = ''; }
    else { el.style.backgroundImage = ''; el.textContent = pin.emoji || '📍'; }
  }

  function makeMarkerEl(pin, isStale) {
    const el = document.createElement('div');
    el.className = 'k-pin' + (pin.mode === 'live' && !isStale ? ' live' : '');
    el.style.setProperty('--pin', pin.color || '#0A84FF');
    el.innerHTML =
      '<div class="k-pin-halo"></div>' +
      '<div class="k-pin-bubble"></div>' +
      '<div class="k-pin-tip"></div>' +
      '<div class="k-pin-label">' + escapeHtml(shortName(pin.name)) + '</div>';
    applyBubble(el.querySelector('.k-pin-bubble'), pin);
    el.addEventListener('click', (ev) => { ev.stopPropagation(); openDetail(pin); });
    return el;
  }

  function renderMarkers() {
    if (!mapReady) return;
    const now = Date.now();
    const seen = {};
    const accFeatures = [];
    pins.forEach((pin) => {
      seen[pin.device_id] = true;
      const isStale = pin.mode === 'live' && now - pin.updated_at > STALE_MS;
      let entry = markers[pin.device_id];
      if (!entry) {
        const el = makeMarkerEl(pin, isStale);
        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([pin.lng, pin.lat]).addTo(map);
        markers[pin.device_id] = { marker, el, pin };
      } else {
        const prev = entry.pin;
        if (prev.lng !== pin.lng || prev.lat !== pin.lat) tweenMarker(entry.marker, [prev.lng, prev.lat], [pin.lng, pin.lat]);
        entry.el.style.setProperty('--pin', pin.color || '#0A84FF');
        entry.el.classList.toggle('live', pin.mode === 'live' && !isStale);
        applyBubble(entry.el.querySelector('.k-pin-bubble'), pin);
        const l = entry.el.querySelector('.k-pin-label'); if (l) l.textContent = shortName(pin.name);
        entry.pin = pin;
      }
      if (pin.accuracy && pin.accuracy > 0 && pin.accuracy < 5000) {
        accFeatures.push(circleFeature(pin.lng, pin.lat, pin.accuracy, pin.color || '#0A84FF'));
      }
    });
    Object.keys(markers).forEach((id) => { if (!seen[id]) { markers[id].marker.remove(); delete markers[id]; } });
    Object.keys(markers).forEach((id) => { markers[id].el.classList.toggle('selected', id === selectedDeviceId || id === deviceId); });
    const src = map.getSource('accuracy');
    if (src) src.setData({ type: 'FeatureCollection', features: accFeatures });
  }

  function tweenMarker(marker, from, to) {
    const dur = 650, start = performance.now();
    function step(t) {
      const p = Math.min(1, (t - start) / dur);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      marker.setLngLat([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function circleFeature(lng, lat, rMeters, color) {
    const pts = 48, R = 6378137, latR = lat * Math.PI / 180, coords = [];
    for (let i = 0; i <= pts; i++) {
      const a = 2 * Math.PI * i / pts;
      const dLng = (rMeters * Math.cos(a) / (R * Math.cos(latR))) * 180 / Math.PI;
      const dLat = (rMeters * Math.sin(a) / R) * 180 / Math.PI;
      coords.push([lng + dLng, lat + dLat]);
    }
    return { type: 'Feature', properties: { color }, geometry: { type: 'Polygon', coordinates: [coords] } };
  }

  function sheetPeekY() { return Math.max(0, $('sheet').offsetHeight - 148); }
  function setSheet(state) {
    sheetState = state;
    const s = $('sheet');
    if (window.gsap) {
      gsap.to(s, { y: state === 'open' ? 0 : sheetPeekY(), duration: 0.5, ease: 'power3.out', onUpdate: () => { if (sheetDraggable) sheetDraggable.update(); } });
    } else {
      s.dataset.state = state;
    }
  }
  function focusPin(pin) {
    setSheet('peek');
    const center = [pin.lng, pin.lat], zoom = Math.max(map.getZoom(), 15);
    if (reduce()) map.jumpTo({ center, zoom });
    else map.flyTo({ center, zoom, speed: 0.9, curve: 1.5, essential: true });
  }
  function fitToPins() {
    if (!pins.length) return;
    const anim = !reduce();
    if (pins.length === 1) { map.flyTo({ center: [pins[0].lng, pins[0].lat], zoom: 13, speed: 1.0, essential: true, animate: anim }); return; }
    const b = new maplibregl.LngLatBounds();
    pins.forEach((p) => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: { top: 120, left: 60, right: 60, bottom: 260 }, maxZoom: 15, duration: anim ? 900 : 0 });
  }

  // ---------- friend detail card (Locket-style) ----------
  function openDetail(pin) {
    detailList = pins.slice();
    detailIndex = detailList.findIndex((p) => p.device_id === pin.device_id);
    if (detailIndex < 0) { detailList = [pin]; detailIndex = 0; }
    $('detailModal').hidden = false;
    renderDetail();
  }
  function detailGo(dir) {
    if (detailList.length < 2) return;
    detailIndex = (detailIndex + dir + detailList.length) % detailList.length;
    renderDetail();
    updateViewer();
  }
  function renderDetail() {
    const pin = detailList[detailIndex];
    if (!pin) return;
    currentDetailPin = pin;
    const now = Date.now();
    const isLive = pin.mode === 'live' && now - pin.updated_at <= STALE_MS;

    // Big image: status/moment photo first, else profile photo, else emoji block.
    const big = photoUrl(pin, 'photo') || photoUrl(pin, 'avatar');
    const photo = $('detailPhoto');
    const bigImg = $('detailPhotoImg');
    if (big) {
      photo.classList.remove('is-emoji');
      photo.classList.add('tappable');
      bigImg.src = big;
    } else {
      photo.classList.add('is-emoji');
      photo.classList.remove('tappable');
      bigImg.removeAttribute('src');
      photo.style.setProperty('--pin', pin.color || '#0A84FF');
      $('detailPhotoEmoji').textContent = pin.emoji || '📍';
    }

    const chip = $('detailChip');
    chip.style.setProperty('--pin', pin.color || '#0A84FF');
    const chipAv = photoUrl(pin, 'avatar');
    if (chipAv) { chip.style.backgroundImage = `url('${chipAv}')`; chip.textContent = ''; }
    else { chip.style.backgroundImage = ''; chip.textContent = pin.emoji || '📍'; }

    $('detailName').textContent = pin.name + (pin.device_id === deviceId ? ' (kamu)' : '');
    $('detailBadge').innerHTML = isLive ? '<span class="badge-live">LIVE</span>' : '';

    const note = pin.note || (isLive ? 'Sedang berbagi lokasi live' : '');
    const noteEl = $('detailNote');
    noteEl.textContent = note;
    noteEl.style.display = note ? '' : 'none';

    $('detailTime').textContent = isLive
      ? ('diperbarui ' + relTime(pin.updated_at, now))
      : (absTime(pin.updated_at) + ' · ' + relTime(pin.updated_at, now));

    const distRow = $('detailDistRow');
    if (myLoc) { $('detailDist').textContent = formatDist(haversine(myLoc.lat, myLoc.lng, pin.lat, pin.lng)) + ' dari kamu'; distRow.hidden = false; }
    else distRow.hidden = true;

    const key = pin.lat.toFixed(4) + ',' + pin.lng.toFixed(4);
    const placeEl = $('detailPlace');
    if (placeCache[key]) placeEl.textContent = placeCache[key];
    else {
      placeEl.textContent = 'Mencari lokasi…';
      reverseGeocode(pin.lat, pin.lng)
        .then((label) => { placeCache[key] = label; if (currentDetailPin === pin) placeEl.textContent = label; })
        .catch(() => { if (currentDetailPin === pin) placeEl.textContent = pin.lat.toFixed(4) + ', ' + pin.lng.toFixed(4); });
    }

    $('btnDetailDelete').hidden = pin.device_id !== deviceId;
    $('detailModal').classList.remove('closing');
    setSelected(pin.device_id);
    reactTarget = pin.device_id;
    document.querySelector('.reply-wrap').hidden = (pin.device_id === deviceId);
    $('btnChat').hidden = (pin.device_id === deviceId);
    loadReactions(pin.device_id);
  }
  // Smooth ease-out dismiss for any modal (scrim fades, card slides down).
  function animateClose(el) {
    if (!el || el.hidden) return;
    const card = el.querySelector('.modal-card, .detail-card, .chat-card');
    let closed = false;
    const done = () => { if (closed) return; closed = true; el.hidden = true; el.classList.remove('closing'); };
    el.classList.add('closing');
    if (card) card.addEventListener('animationend', done, { once: true }); else done();
    setTimeout(done, 440); // fallback if animationend doesn't fire
  }
  // Hide the bottom sheet + FAB whenever any modal/overlay is open (bulletproof).
  function syncModalOpen() {
    const ids = ['shareModal', 'detailModal', 'inboxModal', 'historyModal', 'cameraModal', 'chatModal', 'momentsModal', 'gate'];
    const anyOpen = ids.some((id) => { const e = document.getElementById(id); return e && !e.hidden; });
    document.body.classList.toggle('modal-open', anyOpen);
  }
  function closeDetail() {
    const m = $('detailModal');
    if (m.hidden) return;
    currentDetailPin = null;
    setSelected(null);
    animateClose(m);
  }
  function setSelected(id) {
    selectedDeviceId = id;
    Object.keys(markers).forEach((k) => { markers[k].el.classList.toggle('selected', k === id || k === deviceId); });
  }

  // Fullscreen photo viewer
  function currentBig() { const p = currentDetailPin; return p && (photoUrl(p, 'photo') || photoUrl(p, 'avatar')); }
  function openViewer() { const img = currentBig(); if (!img) return; $('photoViewerImg').src = img; $('photoViewer').hidden = false; }
  function updateViewer() { if ($('photoViewer').hidden) return; const img = currentBig(); if (img) $('photoViewerImg').src = img; else closeViewer(); }
  function closeViewer() { $('photoViewer').hidden = true; $('photoViewerImg').removeAttribute('src'); }

  function deleteMine() {
    const p = currentDetailPin;
    if (!p || p.device_id !== deviceId) return;
    closeViewer();
    closeDetail();
    if (liveMode) { stopLive(); }
    else {
      api('/pins/stop', { method: 'POST', body: JSON.stringify({ device_id: deviceId }) }).then(() => refresh()).catch(() => {});
      toast('Lokasimu dihapus');
    }
  }

  function invite() {
    const link = location.origin + '/?k=' + encodeURIComponent(getKey());
    const data = { title: 'ZuzuMap', text: 'Gabung ke peta ZuzuMap kita 🗺️', url: link };
    if (navigator.share) { navigator.share(data).catch(() => {}); }
    else if (navigator.clipboard) { navigator.clipboard.writeText(link).then(() => toast('Link undangan disalin')).catch(() => toast(link)); }
    else { toast(link); }
  }

  // theme: auto | light | dark
  function currentTheme() { return localStorage.getItem(LS.theme) || 'auto'; }
  function effectiveDark() { const t = currentTheme(); return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches); }
  function updateThemeIcon() { const b = $('btnTheme'); if (!b) return; const t = currentTheme(); b.textContent = t === 'light' ? '☀️' : (t === 'dark' ? '🌙' : '🌗'); b.title = 'Tema: ' + ({ auto: 'ikuti sistem', light: 'terang', dark: 'gelap' }[t]); }
  function initTheme() {
    document.documentElement.setAttribute('data-theme', currentTheme());
    updateThemeIcon();
  }
  function applyTheme() {
    initTheme();
    if (map && map.setStyle) map.setStyle(baseStyle(effectiveDark()));
  }
  function cycleTheme() { const order = ['auto', 'light', 'dark']; const next = order[(order.indexOf(currentTheme()) + 1) % 3]; localStorage.setItem(LS.theme, next); applyTheme(); }

  function reduce() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }

  // Turn coordinates into a friendly place name via OpenStreetMap Nominatim (no key).
  async function reverseGeocode(lat, lng) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    try {
      const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=id&lat=' + lat + '&lon=' + lng;
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('geo');
      const d = await r.json();
      const a = d.address || {};
      const local = a.village || a.town || a.city || a.suburb || a.city_district || a.municipality || a.county || '';
      const region = a.state || a.region || '';
      const parts = [local, region].filter(Boolean);
      if (!parts.length && a.country) parts.push(a.country);
      return parts.join(', ') || (d.display_name || '').split(',').slice(0, 2).join(',').trim() || (lat.toFixed(4) + ', ' + lng.toFixed(4));
    } finally { clearTimeout(to); }
  }

  // ---------- reply / reactions ----------
  const REPLY_EMOJIS = ['❤️', '😂', '🔥', '👍', '😮', '🙏', '😍', '🤙'];
  function buildReplyEmojis() {
    const box = $('replyEmojis'); if (!box) return; box.innerHTML = '';
    REPLY_EMOJIS.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = e;
      b.onclick = () => sendReaction('emoji', e);
      box.appendChild(b);
    });
  }
  async function sendReaction(kind, content) {
    if (!reactTarget || !content) return;
    if (kind === 'emoji') floatEmoji(content, 14);
    try {
      await api('/react', { method: 'POST', body: JSON.stringify({ target: reactTarget, from_device: deviceId, from_name: localStorage.getItem(LS.name) || 'Teman', kind, content }) });
      if (kind === 'text') { $('replyText').value = ''; toast('Balasan terkirim'); }
      loadReactions(reactTarget);
    } catch (e) { toast('Gagal mengirim'); }
  }
  // Re-encode an existing data-URL image down to a small thumbnail (for reply context).
  function shrinkDataUrl(dataUrl, maxDim, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', quality));
        } catch (e) { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    });
  }
  // A text reply on someone's status is a real DM (shows up in Chat + Inbox for both).
  // It carries a thumbnail of the status photo being replied to, IG-style.
  async function sendStatusDM(text) {
    if (!reactTarget) return;
    $('replyText').value = '';
    const body = { from_device: deviceId, to_device: reactTarget, from_name: localStorage.getItem(LS.name) || 'Teman', text };
    const pin = currentDetailPin;
    const src = pin && pin.device_id === reactTarget ? (photoUrl(pin, 'photo') || photoUrl(pin, 'avatar')) : '';
    if (src) {
      const thumb = await shrinkDataUrl(src, 480, 0.72);
      if (thumb && thumb.length <= 300000) { body.reply_photo = thumb; body.reply_name = pin.name || 'Teman'; }
    }
    try {
      await api('/dm', { method: 'POST', body: JSON.stringify(body) });
      toast('Pesan terkirim ke chat');
      loadInbox();
    } catch (e) { toast('Gagal mengirim'); $('replyText').value = text; }
  }
  async function loadReactions(target) {
    try {
      const res = await api('/reactions?target=' + encodeURIComponent(target));
      if (!res.ok) return;
      const list = await res.json();
      if (reactTarget !== target) return;
      const el = $('replyList'); el.innerHTML = '';
      const now = Date.now();
      list.slice(0, 30).forEach((r) => {
        const row = document.createElement('div');
        row.className = 'reply-item' + (r.kind === 'emoji' ? ' emoji' : '');
        row.innerHTML = '<span class="who">' + escapeHtml(r.from_name || 'Teman') + '</span>' +
          '<span class="content"> ' + escapeHtml(r.content) + '</span>' +
          '<span class="when">' + relTime(r.created_at, now) + '</span>';
        el.appendChild(row);
      });
    } catch (e) { /* ignore */ }
  }

  // floating emoji burst (rises from the bottom, GSAP)
  function floatEmoji(emoji, count) {
    const layer = $('emojiFloat'); if (!layer) return;
    const n = count || 8, W = window.innerWidth, H = window.innerHeight;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.textContent = emoji;
      s.style.left = (W * 0.5 + (Math.random() * 140 - 70)) + 'px';
      s.style.fontSize = (26 + Math.random() * 22) + 'px';
      layer.appendChild(s);
      if (window.gsap) {
        gsap.fromTo(s, { y: 0, opacity: 0, scale: 0.6 },
          { y: -(H * (0.5 + Math.random() * 0.4)), opacity: 1, scale: 1, duration: 1.6 + Math.random() * 0.8, ease: 'power1.out', delay: i * 0.05, onComplete: () => s.remove() });
        gsap.to(s, { x: '+=' + (Math.random() * 80 - 40), duration: 2.2, ease: 'sine.inOut' });
        gsap.to(s, { opacity: 0, duration: 0.6, delay: 1.4 + Math.random() * 0.5 });
      } else {
        s.style.transition = 'transform 1.8s ease-out, opacity 1.8s'; s.style.transform = 'translateY(-60vh)';
        setTimeout(() => { s.style.opacity = '0'; }, 1200); setTimeout(() => s.remove(), 1900);
      }
    }
  }

  // ---------- inbox (replies to me) ----------
  async function loadInbox() {
    try {
      const [tr, rc, gm] = await Promise.all([
        api('/threads?me=' + encodeURIComponent(deviceId)).then((r) => (r.ok ? r.json() : [])).catch(() => []),
        api('/reactions?target=' + encodeURIComponent(deviceId)).then((r) => (r.ok ? r.json() : [])).catch(() => []),
        api('/dm?me=' + encodeURIComponent(deviceId) + '&peer=__group__').then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]);
      myThreads = tr; myReactions = rc; groupLast = gm.length ? gm[gm.length - 1] : null;
      updateInboxBadge();
    } catch (e) { /* ignore */ }
  }
  function updateInboxBadge() {
    const dmUnread = myThreads.filter((t) => !t.mine && t.created_at > getChatSeen(t.peer)).length;
    const rcSeen = Number(localStorage.getItem(LS.inboxSeen) || 0);
    const rcUnread = myReactions.filter((r) => r.created_at > rcSeen).length;
    const gUnread = (groupLast && groupLast.from_device !== deviceId && groupLast.created_at > getChatSeen('__group__')) ? 1 : 0;
    const n = dmUnread + rcUnread + gUnread;
    const b = $('inboxBadge');
    if (n > 0) { b.textContent = n > 9 ? '9+' : String(n); b.hidden = false; } else b.hidden = true;
  }
  function openInbox() {
    const el = $('inboxList'); el.innerHTML = '';
    const now = Date.now();
    {
      const grow = document.createElement('div'); grow.className = 'inbox-item';
      const gunread = groupLast && groupLast.from_device !== deviceId && groupLast.created_at > getChatSeen('__group__');
      const prev = groupLast ? escapeHtml((groupLast.from_name || 'Teman') + ': ' + (groupLast.text || '📷 Foto')) + ' · ' + relTime(groupLast.created_at, now) : 'Obrolan bareng semua anggota';
      grow.innerHTML = '<div class="ic">👥</div><div class="tx"><b>Grup Posdim' + (gunread ? '<span class="dot"></span>' : '') + '</b><div>' + prev + '</div></div>';
      grow.onclick = () => { animateClose($('inboxModal')); openChat('__group__', 'Grup Posdim'); };
      el.appendChild(grow);
    }
    if (myThreads.length) {
      const h = document.createElement('div'); h.className = 'inbox-section'; h.textContent = 'Pesan'; el.appendChild(h);
      myThreads.forEach((t) => {
        const row = document.createElement('div'); row.className = 'inbox-item';
        const unread = !t.mine && t.created_at > getChatSeen(t.peer);
        const pname = t.name || (pins.find((p) => p.device_id === t.peer) || {}).name || 'Teman';
        row.innerHTML = '<div class="ic">💬</div><div class="tx"><b>' + escapeHtml(pname) + (unread ? '<span class="dot"></span>' : '') +
          '</b><div>' + (t.mine ? 'Kamu: ' : '') + escapeHtml(t.text || '📷 Foto') + ' · ' + relTime(t.created_at, now) + '</div></div>';
        row.onclick = () => { animateClose($('inboxModal')); openChat(t.peer, pname); };
        el.appendChild(row);
      });
    }
    if (myReactions.length) {
      const h = document.createElement('div'); h.className = 'inbox-section'; h.textContent = 'Reaksi status'; el.appendChild(h);
      myReactions.slice(0, 50).forEach((r) => {
        const row = document.createElement('div'); row.className = 'inbox-item';
        const ic = r.kind === 'emoji' ? r.content : '💬';
        row.innerHTML = '<div class="ic">' + escapeHtml(ic) + '</div><div class="tx"><b>' + escapeHtml(r.from_name || 'Teman') + '</b><div>' +
          (r.kind === 'text' ? escapeHtml(r.content) + ' · ' : 'bereaksi · ') + relTime(r.created_at, now) + '</div></div>';
        el.appendChild(row);
      });
    }
    $('inboxModal').classList.remove('closing');
    $('inboxModal').hidden = false;
    localStorage.setItem(LS.inboxSeen, String(Date.now()));
    updateInboxBadge();
  }

  // ---------- chat / DM ----------
  function chatSeenMap() { try { return JSON.parse(localStorage.getItem('kafilah_chat_seen') || '{}'); } catch (e) { return {}; } }
  function getChatSeen(peer) { return chatSeenMap()[peer] || 0; }
  function setChatSeen(peer, ts) { const m = chatSeenMap(); if (!(m[peer] >= ts)) { m[peer] = ts; localStorage.setItem('kafilah_chat_seen', JSON.stringify(m)); } }
  function scrollChatBottom() { const b = $('chatBody'); b.scrollTop = b.scrollHeight; }

  // Long-press (450ms, cancelled by release or >10px movement) — used to pick
  // a message to quote-reply to. Also swallows the native context menu.
  function attachLongPress(el, cb) {
    let timer = null, sx = 0, sy = 0;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('pointerdown', (e) => {
      sx = e.clientX; sy = e.clientY;
      clear();
      timer = setTimeout(() => { timer = null; cb(); }, 450);
    });
    el.addEventListener('pointermove', (e) => {
      if (!timer) return;
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear();
    });
    el.addEventListener('pointerup', clear);
    el.addEventListener('pointercancel', clear);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  function showQuoteBar() {
    if (!chatQuote) { hideQuoteBar(); return; }
    $('cqName').textContent = chatQuote.name;
    $('cqSnippet').textContent = chatQuote.text.slice(0, 80);
    $('chatQuoteBar').hidden = false;
    $('chatText').focus();
  }
  function hideQuoteBar() { $('chatQuoteBar').hidden = true; }
  function updateChatDot() {
    const dot = $('chatDot'); if (!dot) return;
    dot.hidden = !chatPeer || chatPeer === '__group__' || !isOnline(chatPeer);
  }
  function renderChat(msgs) {
    const body = $('chatBody');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    body.innerHTML = '';
    if (!msgs.length) { body.innerHTML = '<div class="chat-empty">Belum ada pesan. Sapa duluan 👋</div>'; return; }
    const now = Date.now();
    const isGroup = chatPeer === '__group__';
    msgs.forEach((m) => {
      const mine = m.from_device === deviceId;
      const side = mine ? 'me' : 'them';
      const sender = (isGroup && !mine) ? '<span class="chat-sender">' + escapeHtml(m.from_name || 'Teman') + '</span>' : '';
      const quoteHtml = m.quote_text
        ? '<div class="chat-quote"><b>' + escapeHtml(m.quote_name || 'Teman') + '</b><span>' + escapeHtml(m.quote_text) + '</span></div>'
        : '';
      const hasPhoto = m.photo && String(m.photo).indexOf('data:image/') === 0;
      const photoHtml = hasPhoto ? '<img class="chat-photo" alt="">' : '';
      const textHtml = m.text ? escapeHtml(m.text) : '';
      const bubble = sender + quoteHtml + photoHtml + textHtml + '<span class="chat-time">' + relTime(m.created_at, now) + '</span>';
      const hasReply = m.reply_photo && String(m.reply_photo).indexOf('data:image/') === 0;
      let bubbleEl;
      if (hasReply) {
        // IG-style: the replied-to status photo sits above the reply bubble.
        const wrap = document.createElement('div');
        wrap.className = 'chat-group ' + side;
        const label = mine
          ? 'Kamu membalas status ' + (m.reply_name || 'teman')
          : (isGroup ? 'Membalas status ' + (m.reply_name || 'teman') : 'Membalas statusmu');
        wrap.innerHTML = '<div class="chat-reply"><span class="chat-reply-label">' + escapeHtml(label) + '</span><img alt="" /></div>' +
          '<div class="chat-msg ' + side + '">' + bubble + '</div>';
        const img = wrap.querySelector('.chat-reply img');
        img.src = m.reply_photo;
        img.onclick = () => { $('photoViewerImg').src = m.reply_photo; $('photoViewer').hidden = false; };
        bubbleEl = wrap.querySelector('.chat-msg');
        body.appendChild(wrap);
      } else {
        const el = document.createElement('div');
        el.className = 'chat-msg ' + side;
        el.innerHTML = bubble;
        bubbleEl = el;
        body.appendChild(el);
      }
      if (hasPhoto) {
        const img = bubbleEl.querySelector('.chat-photo');
        if (img) { img.src = m.photo; img.onclick = () => { $('photoViewerImg').src = m.photo; $('photoViewer').hidden = false; }; }
      }
      attachLongPress(bubbleEl, () => {
        chatQuote = { text: m.text || '📷 Foto', name: m.from_device === deviceId ? (localStorage.getItem(LS.name) || 'Kamu') : (m.from_name || 'Teman') };
        showQuoteBar();
      });
    });
    if (atBottom) scrollChatBottom();
  }
  async function loadChat(scroll) {
    if (!chatPeer) return;
    const peer = chatPeer;
    const since = chatMsgs.length ? chatMsgs[chatMsgs.length - 1].created_at : 0;
    try {
      const res = await api('/dm?me=' + encodeURIComponent(deviceId) + '&peer=' + encodeURIComponent(peer) + '&since=' + since);
      if (!res.ok || chatPeer !== peer) return;
      const msgs = await res.json();
      if (chatPeer !== peer) return;
      if (msgs.length) chatMsgs = chatMsgs.concat(msgs);
      renderChat(chatMsgs);
      if (scroll) scrollChatBottom();
      updateChatDot();
      const lastIn = chatMsgs.filter((m) => m.from_device === peer).slice(-1)[0];
      if (lastIn) { setChatSeen(peer, lastIn.created_at); updateInboxBadge(); }
    } catch (e) { /* ignore */ }
  }
  function openChat(peer, name) {
    if (!peer || peer === deviceId) return;
    chatPeer = peer;
    chatMsgs = [];
    chatQuote = null;
    hideQuoteBar();
    $('chatPeerName').textContent = name || 'Teman';
    $('chatBody').innerHTML = '<div class="chat-empty">Memuat…</div>';
    updateChatDot();
    $('chatModal').classList.remove('closing');
    $('chatModal').hidden = false;
    loadChat(true);
    clearInterval(chatTimer);
    chatTimer = setInterval(() => { if (!$('chatModal').hidden) loadChat(false); else { clearInterval(chatTimer); chatTimer = null; } }, 4000);
  }
  function closeChat() { clearInterval(chatTimer); chatTimer = null; chatPeer = null; chatQuote = null; hideQuoteBar(); animateClose($('chatModal')); }
  async function sendChat() {
    const t = $('chatText').value.trim();
    if (!t || !chatPeer) return;
    $('chatText').value = '';
    const body = { from_device: deviceId, to_device: chatPeer, from_name: localStorage.getItem(LS.name) || 'Teman', text: t };
    if (chatQuote) { body.quote_text = chatQuote.text; body.quote_name = chatQuote.name; }
    try {
      await api('/dm', { method: 'POST', body: JSON.stringify(body) });
      chatQuote = null; hideQuoteBar();
      loadChat(true);
    } catch (e) { toast('Gagal mengirim'); $('chatText').value = t; }
  }
  async function sendChatPhoto(file) {
    if (!file || !chatPeer) return;
    try {
      let thumb = await resizeImage(file, 900, 0.78);
      if (thumb.length > 300000) thumb = await shrinkDataUrl(thumb, 700, 0.6);
      if (!thumb || thumb.length > 300000) { toast('Foto terlalu besar'); return; }
      await api('/dm', { method: 'POST', body: JSON.stringify({ from_device: deviceId, to_device: chatPeer, from_name: localStorage.getItem(LS.name) || 'Teman', text: '', photo: thumb }) });
      loadChat(true);
    } catch (e) { toast('Gagal mengirim foto'); }
  }

  // ---------- presence ----------
  async function pingPresence() {
    try { await api('/ping', { method: 'POST', body: JSON.stringify({ device_id: deviceId, name: localStorage.getItem(LS.name) || '' }) }); } catch (e) { /* ignore */ }
  }
  async function loadPresence() {
    try {
      const res = await api('/presence');
      if (!res.ok) return;
      (await res.json()).forEach((p) => { presenceMap[p.device_id] = p.last_seen; });
    } catch (e) { /* ignore */ }
  }
  function isOnline(id) { const ls = presenceMap[id]; return !!ls && (Date.now() - ls < 90000); }

  // ---------- momen feed ----------
  async function openMoments() {
    $('momentsModal').classList.remove('closing');
    $('momentsModal').hidden = false;
    const feed = $('momentsFeed');
    feed.innerHTML = '<div class="history-empty">Memuat…</div>';
    try {
      const res = await api('/moments');
      const items = res.ok ? await res.json() : [];
      if ($('momentsModal').hidden) return;
      if (!items.length) { feed.innerHTML = '<div class="history-empty">Belum ada momen. Bagikan foto status dulu!</div>'; return; }
      feed.innerHTML = '';
      const now = Date.now();
      items.forEach((it) => {
        const card = document.createElement('div'); card.className = 'moment';
        const img = document.createElement('img'); img.src = it.photo; img.alt = '';
        img.onclick = () => { $('photoViewerImg').src = it.photo; $('photoViewer').hidden = false; };
        const info = document.createElement('div'); info.className = 'moment-info';
        info.innerHTML = '<div class="m-name">' + escapeHtml(it.name || 'Teman') + '</div>' +
          '<div class="m-sub">' + relTime(it.created_at, now) + '</div>' +
          (it.note ? '<div class="m-note">' + escapeHtml(it.note) + '</div>' : '');
        card.appendChild(img); card.appendChild(info);
        feed.appendChild(card);
      });
    } catch (e) { feed.innerHTML = '<div class="history-empty">Gagal memuat.</div>'; }
  }

  // ---------- photo history ----------
  async function openHistory(device, name) {
    $('historyTitle').textContent = 'Riwayat foto' + (name ? ' · ' + name : '');
    $('historyModal').classList.remove('closing');
    $('historyModal').hidden = false;
    const grid = $('historyGrid');
    grid.innerHTML = '<div class="history-empty">Memuat…</div>';
    let items = historyCache[device];
    if (!items) {
      try { const res = await api('/history?device=' + encodeURIComponent(device)); items = res.ok ? await res.json() : []; historyCache[device] = items; }
      catch (e) { items = []; }
    }
    if ($('historyModal').hidden) return;
    if (!items.length) { grid.innerHTML = '<div class="history-empty">Belum ada riwayat foto.</div>'; return; }
    grid.innerHTML = '';
    const now = Date.now();
    items.forEach((it) => {
      const cell = document.createElement('div');
      cell.className = 'history-cell';
      const img = document.createElement('img'); img.src = it.photo; img.alt = '';
      const date = document.createElement('div'); date.className = 'hc-date'; date.textContent = relTime(it.created_at, now);
      cell.appendChild(img); cell.appendChild(date);
      cell.onclick = () => { $('photoViewerImg').src = it.photo; $('photoViewer').hidden = false; };
      grid.appendChild(cell);
    });
  }

  // ---------- BeReal-style camera (sequential back + front, with review) ----------
  let camStream = null;
  let camResult = null;
  let camBack = null;
  let camStep = 1;
  let camFacing = 'environment';
  async function startCam(facing) {
    camFacing = facing;
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
    const v = $('camVideo'); v.srcObject = camStream;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
  }
  function stopCam() { if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; } }
  // Capture a centre-cropped SQUARE frame (matches the square Locket-style preview).
  function grabFrame() {
    const v = $('camVideo');
    const w = v.videoWidth || 720, h = v.videoHeight || 720;
    const s = Math.min(w, h), sx = (w - s) / 2, sy = (h - s) / 2;
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(v, sx, sy, s, s, 0, 0, s, s);
    return c;
  }
  async function flipCam() {
    const next = camFacing === 'environment' ? 'user' : 'environment';
    try { await startCam(next); } catch (e) { /* ignore */ }
  }
  function camHintForStep() {
    $('camHint').textContent = camStep === 1 ? 'Jepret 1 dari 2 — kamera belakang' : 'Jepret 2 dari 2 — kamera depan (selfie)';
  }
  function camShowLive(step) {
    camResult = null; camStep = step || 1;
    $('camVideo').hidden = false; $('camPreview').hidden = true; $('camPreview').removeAttribute('src');
    $('camShootRow').hidden = false; $('camPreviewRow').hidden = true;
    $('btnCamShoot').disabled = false;
    if (camStep === 1) $('camThumb').style.backgroundImage = '';
    $('camHint').hidden = false; camHintForStep();
  }
  async function openCamera() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { toast('Kamera tidak tersedia'); return; }
    $('cameraModal').hidden = false;
    camBack = null; camShowLive(1);
    try { await startCam('environment'); } catch (e) {
      try { await startCam('user'); } catch (e2) { toast('Tidak bisa akses kamera'); closeCamera(); }
    }
  }
  function closeCamera() { stopCam(); $('camVideo').srcObject = null; $('cameraModal').hidden = true; camBack = null; camShowLive(1); }
  async function shootBeReal() {
    $('btnCamShoot').disabled = true;
    try {
      // Step 1: you tap to shoot the back camera, then it flips to the front.
      if (camStep === 1) {
        camBack = grabFrame();
        $('camThumb').style.backgroundImage = "url('" + camBack.toDataURL('image/jpeg', 0.6) + "')";
        $('camHint').textContent = 'Balik ke kamera depan…';
        try { await startCam('user'); } catch (e) { /* keep back cam if there's no front */ }
        camStep = 2; camHintForStep();
        $('btnCamShoot').disabled = false;
        return;
      }
      // Step 2: you tap again to shoot the front (selfie), then compose (square).
      const front = grabFrame();
      const back = camBack || front;
      const size = Math.min(1024, back.width || 1024);
      const out = document.createElement('canvas'); out.width = size; out.height = size;
      const ctx = out.getContext('2d');
      ctx.drawImage(back, 0, 0, size, size);
      const iw = Math.round(size * 0.33), ih = iw;
      const ix = Math.round(size * 0.045), iy = Math.round(size * 0.045), rad = Math.round(iw * 0.2);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ix + rad, iy);
      ctx.arcTo(ix + iw, iy, ix + iw, iy + ih, rad);
      ctx.arcTo(ix + iw, iy + ih, ix, iy + ih, rad);
      ctx.arcTo(ix, iy + ih, ix, iy, rad);
      ctx.arcTo(ix, iy, ix + iw, iy, rad);
      ctx.closePath();
      ctx.fillStyle = '#000'; ctx.fill(); ctx.clip();
      ctx.drawImage(front, ix, iy, iw, ih);
      ctx.restore();
      ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke();
      camResult = out.toDataURL('image/jpeg', 0.85);
      stopCam(); $('camVideo').srcObject = null;
      $('camPreview').src = camResult; $('camPreview').hidden = false; $('camVideo').hidden = true;
      $('camShootRow').hidden = true; $('camPreviewRow').hidden = false;
      $('camHint').textContent = 'Pakai foto ini, atau ulangi?';
    } catch (e) { toast('Gagal mengambil foto'); closeCamera(); }
  }
  function useCamResult() {
    if (!camResult) return;
    curStatus = camResult; updateStatusPreview(); toast('Foto status siap'); closeCamera();
  }
  async function retakeCam() {
    camBack = null; camShowLive(1);
    try { await startCam('environment'); } catch (e) { try { await startCam('user'); } catch (e2) { closeCamera(); } }
  }

  // ---------- friend list (bottom sheet) ----------
  function renderList() {
    const list = $('friendList'), now = Date.now();
    $('friendCount').textContent = pins.length;
    if (!pins.length) {
      list.innerHTML = '<div class="empty">Belum ada yang berbagi lokasi.<br>Jadilah yang pertama — ketuk “Bagikan lokasiku”.</div>';
      return;
    }
    list.innerHTML = '';
    pins.forEach((pin) => {
      const isLive = pin.mode === 'live' && now - pin.updated_at <= STALE_MS;
      const row = document.createElement('div');
      row.className = 'friend';
      const dist = myLoc ? formatDist(haversine(myLoc.lat, myLoc.lng, pin.lat, pin.lng)) : '';
      const mine = pin.device_id === deviceId ? ' (kamu)' : '';
      const sub = isLive ? ('diperbarui ' + relTime(pin.updated_at, now)) : ('dibagikan ' + absTime(pin.updated_at));
      const note = pin.note ? ' · ' + escapeHtml(pin.note) : '';
      const badge = isLive ? '<span class="badge-live">LIVE</span>' : '';
      const ring = pin.color || '#0A84FF';
      const avUrl = photoUrl(pin, 'avatar');
      const avatarHtml = avUrl
        ? '<div class="avatar" style="--ring:' + ring + ";background-image:url('" + avUrl + "')\"></div>"
        : '<div class="avatar" style="--ring:' + ring + '">' + escapeHtml(pin.emoji || '📍') + '</div>';
      row.innerHTML =
        avatarHtml +
        '<div class="friend-info"><div class="friend-name">' + (isOnline(pin.device_id) ? '<span class="online-dot"></span>' : '') + escapeHtml(pin.name) + mine + ' ' + badge + '</div>' +
        '<div class="friend-sub">' + sub + note + '</div></div>' +
        '<div class="friend-dist">' + dist + '</div>';
      row.addEventListener('click', () => openDetail(pin));
      list.appendChild(row);
    });
  }

  // ---------- data cycle ----------
  async function refresh() {
    try {
      const res = await api('/pins');
      if (!res.ok) return;
      pins = await res.json();
      renderList();
      renderMarkers();
      loadInbox();
      pingPresence();
      loadPresence();
      if (firstFit && mapReady && pins.length) { firstFit = false; fitToPins(); }
    } catch (e) { /* gate shown on 401; ignore transient errors */ }
  }
  function startPolling() {
    refresh();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
  }

  // ---------- sharing ----------
  function openShare() {
    if (!('geolocation' in navigator)) { toast('Perangkat tidak mendukung lokasi'); return; }
    $('inpName').value = localStorage.getItem(LS.name) || '';
    $('inpNote').value = '';
    curEmoji = localStorage.getItem(LS.emoji) || '📍';
    curColor = localStorage.getItem(LS.color) || '#0A84FF';
    curAvatar = localStorage.getItem(LS.avatar) || '';
    curStatus = '';
    buildPickers();
    updateAvatarPreview();
    updateStatusPreview();
    curApprox = localStorage.getItem('kafilah_approx') === '1';
    $('optApprox').checked = curApprox;
    $('liveDurRow').hidden = (selectedMode !== 'live');
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('is-active', x.dataset.mode === selectedMode));
    setModeHint();
    $('shareModal').classList.remove('closing');
    $('shareModal').hidden = false;
  }
  function closeShare() { animateClose($('shareModal')); }

  function confirmShare() {
    const name = $('inpName').value.trim() || 'Teman';
    const note = $('inpNote').value.trim();
    localStorage.setItem(LS.name, name);
    localStorage.setItem(LS.emoji, curEmoji);
    localStorage.setItem(LS.color, curColor);
    if (curAvatar) localStorage.setItem(LS.avatar, curAvatar); else localStorage.removeItem(LS.avatar);
    curApprox = $('optApprox').checked;
    localStorage.setItem('kafilah_approx', curApprox ? '1' : '');
    const liveDur = parseInt($('optLiveDur').value, 10) || 0;
    closeShare();
    if (selectedMode === 'live') startLive(name, curEmoji, curColor, note, curAvatar, curStatus, liveDur);
    else shareOnce(name, curEmoji, curColor, note, curAvatar, curStatus);
  }

  function shareOnce(name, emoji, color, note, avatar, photo) {
    toast('Mengambil lokasi…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateMe();
      try {
        await postPin(pos, 'once', name, emoji, color, note, avatar, photo);
        toast('Lokasimu dibagikan');
        await refresh();
        const mine = pins.find((p) => p.device_id === deviceId);
        if (mine) focusPin(mine);
      } catch (e) { toast('Gagal membagikan'); }
    }, geoErr, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function startLive(name, emoji, color, note, avatar, photo, liveDur) {
    liveMode = true; lastPost = 0; showLiveBar(true);
    clearTimeout(liveStopTimer);
    if (liveDur > 0) liveStopTimer = setTimeout(() => { if (liveMode) { stopLive(); toast('Live berhenti otomatis'); } }, liveDur * 3600000);
    watchId = navigator.geolocation.watchPosition(async (pos) => {
      myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateMe();
      const t = Date.now();
      if (lastPost && t - lastPost < LIVE_POST_MS) return;
      lastPost = t;
      try { await postPin(pos, 'live', name, emoji, color, note, avatar, photo); refresh(); } catch (e) { /* keep trying */ }
    }, geoErr, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
  }

  function stopLive() {
    clearTimeout(liveStopTimer); liveStopTimer = null;
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    liveMode = false; showLiveBar(false);
    api('/pins/stop', { method: 'POST', body: JSON.stringify({ device_id: deviceId }) }).then(() => refresh()).catch(() => {});
    toast('Berhenti berbagi');
  }

  async function postPin(pos, mode, name, emoji, color, note, avatar, photo) {
    let lat = pos.coords.latitude, lng = pos.coords.longitude, accuracy = pos.coords.accuracy || null;
    if (curApprox) {
      lat = Math.round(lat * 100) / 100 + (Math.random() - 0.5) * 0.01;
      lng = Math.round(lng * 100) / 100 + (Math.random() - 0.5) * 0.01;
      accuracy = 1000;
    }
    const body = {
      device_id: deviceId, name, emoji, color, mode, note,
      avatar: avatar || null, photo: photo || null,
      lat, lng, accuracy,
    };
    await api('/pins', { method: 'POST', body: JSON.stringify(body) });
  }

  function geoErr(err) {
    toast(err && err.code === 1 ? 'Izin lokasi ditolak' : 'Tidak bisa mengambil lokasi');
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    liveMode = false; showLiveBar(false);
  }

  function locateMe() {
    if (!('geolocation' in navigator)) { toast('Perangkat tidak mendukung lokasi'); return; }
    toast('Mencari lokasimu…');
    navigator.geolocation.getCurrentPosition((pos) => {
      myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateMe();
      if (reduce()) map.jumpTo({ center: [myLoc.lng, myLoc.lat], zoom: 15 });
      else map.flyTo({ center: [myLoc.lng, myLoc.lat], zoom: 15, speed: 0.9, curve: 1.5, essential: true });
      renderList();
    }, geoErr, { enableHighAccuracy: true, timeout: 15000 });
  }

  function updateMe() {
    if (!myLoc || !mapReady) return;
    if (!meMarker) {
      const el = document.createElement('div');
      el.className = 'me-dot';
      el.style.position = 'relative';
      meMarker = new maplibregl.Marker({ element: el }).setLngLat([myLoc.lng, myLoc.lat]).addTo(map);
    } else {
      meMarker.setLngLat([myLoc.lng, myLoc.lat]);
    }
  }

  function showLiveBar(on) {
    $('liveBar').hidden = !on;
    $('fab').style.display = on ? 'none' : '';
  }

  // ---------- pickers / mode ----------
  function buildPickers() {
    const ep = $('emojiPicker'); ep.innerHTML = '';
    EMOJIS.forEach((e) => {
      const b = document.createElement('button');
      b.className = 'chip' + (e === curEmoji ? ' is-active' : '');
      b.textContent = e;
      b.onclick = () => { curEmoji = e; [...ep.children].forEach((c) => c.classList.remove('is-active')); b.classList.add('is-active'); updateAvatarPreview(); };
      ep.appendChild(b);
    });
    const cp = $('colorPicker'); cp.innerHTML = '';
    COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chip' + (c === curColor ? ' is-active' : '');
      const d = document.createElement('span'); d.className = 'color-dot'; d.style.background = c;
      b.appendChild(d);
      b.onclick = () => { curColor = c; [...cp.children].forEach((x) => x.classList.remove('is-active')); b.classList.add('is-active'); updateAvatarPreview(); };
      cp.appendChild(b);
    });
  }
  // Read an image file, center-crop to a square, downscale, return a JPEG data URL.
  // Downscale to fit within maxDim (longest side), preserving aspect ratio.
  // No cropping, no upscaling.
  function resizeImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
      img.src = url;
    });
  }
  function updateAvatarPreview() {
    const p = $('avatarPreview');
    if (!p) return;
    if (curAvatar) { p.style.backgroundImage = `url('${curAvatar}')`; p.textContent = ''; $('btnClearPhoto').hidden = false; }
    else { p.style.backgroundImage = ''; p.textContent = curEmoji || '📍'; $('btnClearPhoto').hidden = true; }
    p.style.boxShadow = '0 0 0 3px ' + (curColor || '#0A84FF');
  }
  function updateStatusPreview() {
    const p = $('statusPreview');
    if (!p) return;
    if (curStatus) { p.style.backgroundImage = `url('${curStatus}')`; p.classList.add('has-photo'); $('btnClearStatus').hidden = false; }
    else { p.style.backgroundImage = ''; p.classList.remove('has-photo'); $('btnClearStatus').hidden = true; }
  }

  function setModeHint() {
    $('modeHint').textContent = selectedMode === 'live'
      ? 'Lokasimu diperbarui terus selama halaman ini terbuka. Ketuk “Berhenti” kapan saja.'
      : 'Kirim lokasimu sekarang, satu kali, lengkap dengan waktunya.';
  }

  // ---------- gate ----------
  function showGate(err) { $('gate').hidden = false; $('gateErr').hidden = !err; $('inpKey').value = getKey(); }
  function hideGate() { $('gate').hidden = true; }

  // ---------- utils ----------
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function shortName(n) { n = String(n || ''); return n.length > 12 ? n.slice(0, 11) + '…' : n; }
  function relTime(ts, now) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 45) return 'baru saja';
    const m = Math.round(s / 60); if (m < 60) return m + ' menit lalu';
    const h = Math.round(m / 60); if (h < 24) return h + ' jam lalu';
    const d = Math.round(h / 24); if (d < 7) return d + ' hari lalu';
    return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  }
  function absTime(ts) {
    return new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function haversine(la1, lo1, la2, lo2) {
    const R = 6371000, t = Math.PI / 180;
    const dla = (la2 - la1) * t, dlo = (lo2 - lo1) * t;
    const a = Math.sin(dla / 2) ** 2 + Math.cos(la1 * t) * Math.cos(la2 * t) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function formatDist(m) {
    if (m < 1000) return Math.round(m) + ' m';
    if (m < 10000) return (m / 1000).toFixed(1) + ' km';
    return Math.round(m / 1000) + ' km';
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
  }
  // Horizontal swipe detection (ignores mostly-vertical drags).
  function onSwipe(el, cb) {
    let x0 = null, y0 = null;
    el.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; });
    el.addEventListener('pointerup', (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0, dy = e.clientY - y0; x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) cb(dx < 0 ? 1 : -1);
    });
  }

  // ---------- bottom sheet (GSAP Draggable) ----------
  (function initSheet() {
    const s = $('sheet');
    if (!window.gsap || !window.Draggable) {
      // fallback: tap header toggles via CSS data-state
      document.querySelector('.sheet-head').addEventListener('click', (e) => {
        if (e.target.closest('.sheet-head-actions')) return;
        s.dataset.state = s.dataset.state === 'peek' ? 'open' : 'peek';
      });
      return;
    }
    s.style.transition = 'none';
    gsap.set(s, { y: sheetPeekY() });
    sheetDraggable = Draggable.create(s, {
      type: 'y',
      trigger: '.sheet-grabber, .sheet-head',
      dragClickables: false,
      bounds: { minY: 0, maxY: sheetPeekY() },
      onDragEnd() {
        const mid = sheetPeekY() / 2;
        setSheet(this.y < mid ? 'open' : 'peek');
      },
    })[0];
    document.querySelector('.sheet-head').addEventListener('click', (e) => {
      if (e.target.closest('.sheet-head-actions')) return;
      setSheet(sheetState === 'peek' ? 'open' : 'peek');
    });
    window.addEventListener('resize', () => {
      if (sheetDraggable) sheetDraggable.applyBounds({ minY: 0, maxY: sheetPeekY() });
      setSheet(sheetState);
    });
  })();

  // ---------- wire up ----------
  $('fab').onclick = openShare;
  $('btnCancelShare').onclick = closeShare;
  $('btnConfirmShare').onclick = confirmShare;
  $('btnPickPhoto').onclick = () => $('filePhoto').click();
  $('btnClearPhoto').onclick = () => { curAvatar = ''; localStorage.removeItem(LS.avatar); updateAvatarPreview(); };
  $('filePhoto').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { curAvatar = await resizeImage(f, 512, 0.9); updateAvatarPreview(); }
    catch (err) { toast('Gagal memuat foto'); }
  });
  $('btnPickStatus').onclick = () => $('fileStatus').click();
  $('btnClearStatus').onclick = () => { curStatus = ''; updateStatusPreview(); };
  $('fileStatus').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { curStatus = await resizeImage(f, 1024, 0.85); updateStatusPreview(); }
    catch (err) { toast('Gagal memuat foto'); }
  });
  $('btnLocate').onclick = locateMe;
  $('btnStopLive').onclick = stopLive;
  $('btnRefresh').onclick = () => {
    const b = $('btnRefresh'); b.classList.add('spin'); setTimeout(() => b.classList.remove('spin'), 700);
    refresh();
  };
  $('shareModal').addEventListener('click', (e) => { if (e.target.id === 'shareModal') closeShare(); });
  $('btnDetailClose').onclick = closeDetail;
  $('btnDetailFly').onclick = () => { const p = currentDetailPin; closeDetail(); if (p) focusPin(p); };
  $('detailModal').addEventListener('click', (e) => { if (e.target.id === 'detailModal') closeDetail(); });
  $('btnDetailDelete').onclick = deleteMine;
  $('detailPhoto').addEventListener('click', () => { if (swiped) return; openViewer(); });
  $('photoViewer').addEventListener('click', closeViewer);
  onSwipe($('detailPhoto'), (dir) => { swiped = true; detailGo(dir); setTimeout(() => { swiped = false; }, 60); });
  onSwipe($('photoViewer'), (dir) => detailGo(dir));
  $('btnInvite').onclick = (e) => { e.stopPropagation(); invite(); };
  $('btnTheme').onclick = (e) => { e.stopPropagation(); cycleTheme(); };
  $('btnInbox').onclick = (e) => { e.stopPropagation(); openInbox(); };
  $('btnMoments').onclick = (e) => { e.stopPropagation(); openMoments(); };
  $('btnMomentsClose').onclick = () => animateClose($('momentsModal'));
  $('momentsModal').addEventListener('click', (e) => { if (e.target.id === 'momentsModal') animateClose($('momentsModal')); });
  $('btnInboxClose').onclick = () => animateClose($('inboxModal'));
  $('inboxModal').addEventListener('click', (e) => { if (e.target.id === 'inboxModal') animateClose($('inboxModal')); });
  $('btnHistory').onclick = () => { if (currentDetailPin) openHistory(currentDetailPin.device_id, currentDetailPin.name); };
  $('btnChat').onclick = () => { const p = currentDetailPin; if (!p) return; closeDetail(); openChat(p.device_id, p.name); };
  $('btnChatBack').onclick = closeChat;
  $('btnChatSend').onclick = sendChat;
  $('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  $('chatModal').addEventListener('click', (e) => { if (e.target.id === 'chatModal') closeChat(); });
  $('btnChatPhoto').onclick = () => $('fileChatPhoto').click();
  $('fileChatPhoto').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) sendChatPhoto(f);
  });
  $('btnQuoteCancel').onclick = () => { chatQuote = null; hideQuoteBar(); };
  $('btnHistoryClose').onclick = () => animateClose($('historyModal'));
  $('historyModal').addEventListener('click', (e) => { if (e.target.id === 'historyModal') animateClose($('historyModal')); });
  $('btnReplySend').onclick = () => { const t = $('replyText').value.trim(); if (t) sendStatusDM(t); };
  $('replyText').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnReplySend').click(); });
  $('btnCamStatus').onclick = openCamera;
  $('btnCamShoot').onclick = shootBeReal;
  $('btnCamClose').onclick = closeCamera;
  $('btnCamUse').onclick = useCamResult;
  $('btnCamRetake').onclick = retakeCam;
  $('btnCamFlip').onclick = flipCam;
  document.querySelectorAll('.seg-btn').forEach((b) => b.onclick = () => {
    selectedMode = b.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
    setModeHint();
    $('liveDurRow').hidden = (selectedMode !== 'live');
  });
  $('btnEnter').onclick = () => {
    const k = $('inpKey').value.trim(); if (!k) return;
    setKey(k); hideGate(); firstFit = true; startPolling();
  };
  $('inpKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnEnter').click(); });

  // ---------- boot ----------
  buildPickers();
  buildReplyEmojis();
  initTheme();
  initMap();
  if (!getKey()) showGate(false);
  else startPolling();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  (function watchModals() {
    const ids = ['shareModal', 'detailModal', 'inboxModal', 'historyModal', 'cameraModal', 'chatModal', 'momentsModal', 'gate'];
    const obs = new MutationObserver(syncModalOpen);
    ids.forEach((id) => { const e = $(id); if (e) obs.observe(e, { attributes: true, attributeFilter: ['hidden'] }); });
  })();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
