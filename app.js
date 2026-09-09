/* pingme — v5 · all tasks */

// Feature flags — overridden on dev/preview deployments via window.PINGME_FEATURES in index.html
const FEATURES = Object.assign({
  matchTracking: false,           // #6: ELO + IRL match tracking + voice scoring
  accessCodes:   true,            // invite-only access codes
  leaderboardLinkedOnly: false,   // #10: gate leaderboard to email-linked accounts only
  anonSignup: false,              // emergency fallback: anonymous "i'm in" (no email). Off — signup requires a verified email
}, (typeof window !== 'undefined' && window.PINGME_FEATURES) || {});

const POLL_INTERVAL_MS = 60000; // #7: 60s fallback (was 10s) — realtime is primary

const SUPABASE_URL = 'https://yuqahobbcwibekzvitec.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl1cWFob2JiY3dpYmVrenZpdGVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5MDUwNjMsImV4cCI6MjEwNDQ4MTA2M30.kbzhz7spTD9XEk6_QIwih32qbfP4kgU-5SEiuH3rEHs';

let sb = null;
try {
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
      persistSession: true,
      storageKey: 'pm_auth',
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
} catch (e) { console.error('Supabase failed to load:', e); }

// Venues are user-contributed and span any place with a ping pong table —
// public spots, businesses, private spaces. Source of truth is Supabase.
let VENUES = [];
let venueSearch = '';
let venueZip = localStorage.getItem('pm_zip') || '';
let selectedCity = localStorage.getItem('pm_city') || ''; // '' = all, or '__near__'
let userLoc = null; // { lat, lng } from geolocation, ephemeral per session
// Sketch-style SVG glyphs so venue type indicators match the rest of the app
// (no emoji). Each glyph fits in a 20px box and uses currentColor for stroke.
// Hand-drawn venue type glyphs (Ez-supplied, 2026-06-02). 40x40 viewBox,
// currentColor stroke so they inherit selection state.
const VENUE_TYPE_ICON = {
  public:   '<svg viewBox="0 0 40 40" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"><circle cx="20" cy="20" r="14.5"/><path d="M5.5 20 L34.5 20"/><path d="M20 5.5 C24 9.5 24 30.5 20 34.5 C16 30.5 16 9.5 20 5.5 Z"/><path d="M9 13.5 C13 16 27 16 31 13.5 M9 26.5 C13 24 27 24 31 26.5"/></svg>',
  business: '<svg viewBox="0 0 40 40" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"><path d="M5 34 L35 34"/><rect x="8" y="14" width="24" height="20" rx="2"/><path d="M14 14 L14 9.5 C14 8.5 14.7 8 15.5 8 L24.5 8 C25.3 8 26 8.5 26 9.5 L26 14"/><path d="M14 20 L14.01 20 M20 20 L20.01 20 M26 20 L26.01 20 M14 26 L14.01 26 M26 26 L26.01 26" stroke-width="3"/><path d="M18 34 L18 28 L22 28 L22 34"/></svg>',
  private:  '<svg viewBox="0 0 40 40" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"><rect x="9" y="18" width="22" height="15" rx="3"/><path d="M13.5 18 L13.5 13.5 C13.5 9 16.5 6.5 20 6.5 C23.5 6.5 26.5 9 26.5 13.5 L26.5 18"/><circle cx="20" cy="24.5" r="2.2" fill="currentColor" stroke="none"/><path d="M20 26.5 L20 29.5"/></svg>'
};
const VENUE_PIN_ICON = '<svg viewBox="0 0 40 40" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"><path d="M20 35 C20 35 31 24.5 31 16 C31 9.5 26 5 20 5 C14 5 9 9.5 9 16 C9 24.5 20 35 20 35 Z"/><circle cx="20" cy="16" r="4.5"/></svg>';
const VENUE_TYPE_LABEL = { public: 'public', business: 'business', private: 'private' };

function haversineKm(a, b) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function loadVenues() {
  if (!sb) return;
  try {
    const { data, error } = await sb.from('venues')
      .select('id, name, location, type, city, lat, lng, play_count, verified')
      .order('play_count', { ascending: false })
      .order('name');
    if (error) { console.warn('venues load failed', error); return; }
    VENUES = (data || []).map(v => ({
      id: v.id,
      name: v.name,
      desc: v.location || v.city || '',
      type: v.type || 'public',
      city: v.city || '',
      lat: v.lat, lng: v.lng,
      play_count: v.play_count || 0,
      verified: !!v.verified
    }));
    const stored = localStorage.getItem('pm_venue');
    if (stored && !VENUES.find(v => v.id === stored)) {
      selectedVenue = VENUES[0]?.id || null;
      if (selectedVenue) localStorage.setItem('pm_venue', selectedVenue);
      else localStorage.removeItem('pm_venue');
    }
    renderVenuePicker();
  } catch (e) { console.warn('venues load error', e); }
}
let selectedVenue = localStorage.getItem('pm_venue') || null;
function getVenue() { return VENUES.find(v => v.id === selectedVenue) || VENUES[0] || null; }
function getVenueName() { const v = getVenue(); return v ? v.name : null; }
function getVenueId()   { const v = getVenue(); return v ? v.id : null; }

const AV_COLORS = ['#E8502A','#2544D6','#6FD27B','#E8B84A','#BFA8E0','#FFD3B6','#FF9AA2','#B5EAD7'];

function filteredVenues() {
  const q = (venueSearch || '').trim().toLowerCase();
  const zip = (venueZip || '').trim();
  let list = VENUES.slice();
  // City tag filter — '__near__' uses location/distance, '' = all, else match city
  if (selectedCity && selectedCity !== '__near__') {
    list = list.filter(v => (v.city || '').toLowerCase() === selectedCity.toLowerCase());
  }
  if (zip) {
    list = list.filter(v =>
      (v.desc || '').includes(zip) ||
      (v.city || '').toLowerCase().includes(zip.toLowerCase())
    );
  }
  if (q) {
    list = list.filter(v =>
      v.name.toLowerCase().includes(q) ||
      (v.desc || '').toLowerCase().includes(q) ||
      (v.city || '').toLowerCase().includes(q)
    );
  }
  if (userLoc) {
    list = list.map(v => {
      const dist = (v.lat != null && v.lng != null)
        ? haversineKm(userLoc, { lat: v.lat, lng: v.lng })
        : Infinity;
      return Object.assign({}, v, { _dist: dist });
    }).sort((a, b) => a._dist - b._dist);
    // "near me" tag — cap to a sensible radius (~80km) and keep distance-sorted
    if (selectedCity === '__near__') {
      list = list.filter(v => isFinite(v._dist) && v._dist <= 80);
    }
  }
  return list;
}

// Distinct cities present in VENUES, ordered by total play_count (most-active first).
function cityTagOptions() {
  const counts = new Map();
  for (const v of VENUES) {
    const c = (v.city || '').trim();
    if (!c) continue;
    counts.set(c, (counts.get(c) || 0) + (v.play_count || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([city]) => city);
}

function renderVenueSections(list) {
  // If using location, show flat distance-sorted list (closest first).
  if (userLoc) return list.map(venuePillHtml).join('');
  // Otherwise group by city; verified spots float to the top within each city.
  const groups = new Map();
  for (const v of list) {
    const key = (v.city || 'other').trim() || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const cityOrder = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'other') return 1;
    if (b === 'other') return -1;
    return a.localeCompare(b);
  });
  let out = '';
  for (const city of cityOrder) {
    const rows = groups.get(city).sort((a, b) => {
      if (!!b.verified - !!a.verified) return !!b.verified - !!a.verified;
      return a.name.localeCompare(b.name);
    });
    out += '<div class="venue-section-label">' + esc(city) + '</div>';
    out += rows.map(venuePillHtml).join('');
  }
  return out;
}

function venuePillHtml(v) {
  const icon = VENUE_TYPE_ICON[v.type] || VENUE_PIN_ICON;
  const meta = [VENUE_TYPE_LABEL[v.type] || v.type, v.desc].filter(Boolean).join(' · ');
  const distLbl = (v._dist != null && isFinite(v._dist))
    ? ' · ' + (v._dist < 1.6 ? (v._dist * 0.621).toFixed(1) + 'mi' : Math.round(v._dist * 0.621) + 'mi')
    : '';
  const verifiedBadge = v.verified
    ? '<span class="vp-verified" title="table confirmed">✓</span>'
    : '';
  return '<button class="venue-pill' + (v.id === selectedVenue ? ' active' : '') + (v.verified ? ' verified' : '') + '" data-venue="' + v.id + '" type="button">'
    + '<span class="vp-icon">' + icon + '</span>'
    + '<span class="vp-text">'
    +   '<span class="vp-name">' + esc(v.name) + verifiedBadge + '</span>'
    +   '<span class="vp-desc">' + esc(meta) + distLbl + '</span>'
    + '</span>'
    + '</button>';
}

function renderVenuePicker() {
  const el = document.getElementById('venue-picker');
  if (!el) return;
  const list = filteredVenues();
  const searchVal = esc(venueSearch || '');
  const zipVal = esc(venueZip || '');
  let html = '';
  html += '<div class="vp-controls">';
  html += '<div class="venue-search-row">';
  html += '<input class="venue-search" id="venue-search" type="text" placeholder="search a place" value="' + searchVal + '" autocomplete="off"/>';
  html += '<button class="pm-add-venue-mini" id="pm-add-venue" type="button" title="add a venue" aria-label="add venue"><svg width="22" height="22" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"><path d="M20 8 L20 32 M8 20 L32 20"/></svg></button>';
  html += '</div>';
  // City tag row (Luma-style) — only render if there are 2+ cities or location is on
  const cities = cityTagOptions();
  if (cities.length >= 2 || userLoc) {
    let tags = '';
    if (userLoc) tags += '<button class="city-tag' + (selectedCity === '__near__' ? ' active' : '') + '" data-city="__near__" type="button">near me</button>';
    tags += '<button class="city-tag' + (selectedCity === '' ? ' active' : '') + '" data-city="" type="button">all</button>';
    for (const c of cities) {
      tags += '<button class="city-tag' + (selectedCity.toLowerCase() === c.toLowerCase() ? ' active' : '') + '" data-city="' + esc(c) + '" type="button">' + esc(c) + '</button>';
    }
    html += '<div class="city-tag-row">' + tags + '</div>';
  }
  html += '</div>';
  if (!list.length) {
    html += '<div class="venue-empty">no matches yet — keep typing to add it</div>';
  } else {
    html += '<div class="venue-pill-grid">';
    html += renderVenueSections(list);
    html += '</div>';
  }
  html += '<div class="vp-suggest" id="vp-suggest"></div>';
  el.innerHTML = html;

  const searchInput = el.querySelector('#venue-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      venueSearch = e.target.value;
      refreshVenueGrid(el);
      scheduleVenueSuggest(el);
    });
  }

  const addBtn = el.querySelector('#pm-add-venue');
  if (addBtn) {
    addBtn.addEventListener('click', () => openAddVenueModal());
  }

  // City tag chips
  el.querySelectorAll('.city-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCity = btn.dataset.city || '';
      if (selectedCity) localStorage.setItem('pm_city', selectedCity);
      else localStorage.removeItem('pm_city');
      // If user picks "near me" but no location yet, request it
      if (selectedCity === '__near__' && !userLoc && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          pos => { userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; renderVenuePicker(); },
          () => { selectedCity = ''; localStorage.removeItem('pm_city'); renderVenuePicker(); toast('location denied'); },
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
        );
        return;
      }
      renderVenuePicker();
    });
  });

  bindVenuePills(el);
  scheduleVenueSuggest(el);
}

let _vpSugTimer = null;
let _vpSugSeq = 0;
function scheduleVenueSuggest(el) {
  const sugEl = el.querySelector('#vp-suggest');
  if (!sugEl) return;
  const q = (venueSearch || '').trim();
  if (_vpSugTimer) clearTimeout(_vpSugTimer);
  if (q.length < 2) { sugEl.innerHTML = ''; return; }
  const seq = ++_vpSugSeq;
  sugEl.innerHTML = '<div class="vp-sug-loading">looking up "' + esc(q) + '"…</div>';
  _vpSugTimer = setTimeout(async () => {
    const items = (await findPingPongSpots(q, userLoc)).slice(0, 8);
    if (seq !== _vpSugSeq) return;
    if (!items.length) { sugEl.innerHTML = ''; return; }
    const nameSet = new Set(VENUES.map(v => v.name.toLowerCase().trim()));
    const fresh = items.filter(r => !nameSet.has(r.name.toLowerCase().trim()));
    if (!fresh.length) { sugEl.innerHTML = ''; return; }
    sugEl.innerHTML = '<div class="vp-sug-label">tap to add</div>' + fresh.map((r, i) =>
      '<button class="vp-sug-row" type="button" data-i="' + i + '">'
      + '<span class="vp-sug-plus">+</span>'
      + '<span class="vp-sug-text">'
      +   '<span class="vp-sug-name">' + esc(r.name) + '</span>'
      +   '<span class="vp-sug-meta">' + esc([r.city, r.location].filter(Boolean).join(' · ')) + '</span>'
      + '</span>'
      + '</button>'
    ).join('');
    sugEl.querySelectorAll('.vp-sug-row').forEach(btn => {
      btn.addEventListener('click', () => quickAddVenue(fresh[parseInt(btn.dataset.i, 10)]));
    });
  }, 220);
}

// City scoping: remember the city of the venue the user just picked, so the
// roster filter can keep Austin pings out of Lubbock (and vice-versa). Empty
// home_city = legacy "see everyone" behavior.
function adoptVenueCity(venueId) {
  if (!profile || !venueId) return;
  const v = VENUES.find(x => x.id === venueId);
  const city = (v && v.city) ? String(v.city).trim().toLowerCase() : '';
  if (!city) return;
  if ((profile.home_city || '').toLowerCase() === city) return;
  profile.home_city = city;
  try { sb.rpc('set_home_city', { p_city: city }); } catch {}
}

async function quickAddVenue(pick) {
  if (!profile) { toast('sign in first'); return; }
  if (!pick?.name) return;
  toast('adding ' + pick.name + '…');
  const { data, error } = await sb.rpc('add_venue', {
    p_name: pick.name, p_type: 'public',
    p_city: pick.city || null, p_location: pick.location || null,
    p_lat: pick.lat, p_lng: pick.lng
  });
  if (error) { toast(error.message || 'could not add'); return; }
  const v = Array.isArray(data) ? data[0] : data;
  if (v?.id) {
    VENUES.unshift({
      id: v.id, name: v.name, desc: v.location || v.city || '',
      type: v.type, city: v.city || '', lat: v.lat, lng: v.lng,
      play_count: 0, verified: false
    });
    selectedVenue = v.id;
    localStorage.setItem('pm_venue', selectedVenue);
    adoptVenueCity(selectedVenue);
    venueSearch = '';
    renderVenuePicker();
    toast('added: ' + v.name);
  }
}

function refreshVenueGrid(el) {
  const grid = el.querySelector('.venue-pill-grid, .venue-empty');
  if (!grid) return;
  const list2 = filteredVenues();
  if (!list2.length) {
    grid.outerHTML = '<div class="venue-empty">no matches — tap <b>+ add place</b> to put it on the map</div>';
  } else {
    grid.outerHTML = '<div class="venue-pill-grid">' + renderVenueSections(list2) + '</div>';
    bindVenuePills(el);
  }
}

function bindVenuePills(el) {
  el.querySelectorAll('.venue-pill').forEach(btn => {
    function handleVenue(e) {
      if (e.type === 'touchend') e.preventDefault();
      selectedVenue = btn.dataset.venue;
      localStorage.setItem('pm_venue', selectedVenue);
      adoptVenueCity(selectedVenue);
      el.querySelectorAll('.venue-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
    btn.addEventListener('click', handleVenue);
    btn.addEventListener('touchend', handleVenue);
  });
}

let _avSearchTimer = null;
let _avSearchSeq = 0;
let _avPicked = null; // { name, city, location, lat, lng }

async function nominatimSearch(query) {
  if (!query || query.length < 2) return [];
  const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&q=' + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

function formatNomResult(r) {
  const a = r.address || {};
  const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
  const name = r.namedetails?.name || (r.display_name || '').split(',')[0].trim();
  const parts = [a.road, a.house_number].filter(Boolean).join(' ');
  const tail = [parts, a.state, a.country].filter(Boolean).join(', ');
  return { name, city, location: tail || (r.display_name || ''), lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
}

// Distance helper (meters) for sorting nearby results.
function haversineM(a, b) {
  const R = 6371000;
  const toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const x = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Generic nearby places — bars, parks, cafes, community centers, anywhere
// people commonly play. Returns named POIs sorted by distance.
async function overpassNearbyPlaces(loc, radiusM = 2500) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return [];
  const area = '(around:' + radiusM + ',' + loc.lat + ',' + loc.lng + ')';
  const filters = [
    '["amenity"~"bar|pub|cafe|restaurant|community_centre|social_facility|biergarten|nightclub"]',
    '["leisure"~"park|sports_centre|playground|garden|fitness_centre|pitch"]',
    '["tourism"~"hotel|hostel|attraction"]',
    '["shop"="mall"]',
  ];
  const parts = filters.map(f => 'node' + f + '["name"]' + area + ';').join('');
  const body = '[out:json][timeout:15];(' + parts + ');out center 60;';
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(body),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.elements || []).map(e => {
      const lat = e.lat ?? e.center?.lat;
      const lng = e.lon ?? e.center?.lon;
      const tags = e.tags || {};
      const name = tags.name || tags['name:en'];
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const loc2 = [tags['addr:street'], tags['addr:city'], tags['addr:state']].filter(Boolean).join(', ');
      const city = tags['addr:city'] || '';
      return { name, city, location: loc2, lat, lng, _d: haversineM(loc, { lat, lng }) };
    }).filter(Boolean).sort((a, b) => a._d - b._d);
  } catch { return []; }
}

// Typed search → generic Nominatim (any place, anywhere).
// Empty query w/ location → nearby places from Overpass.
async function findPingPongSpots(query, loc) {
  const q = (query || '').trim();
  if (q.length >= 2) {
    const raw = await nominatimSearch(q);
    return raw.map(formatNomResult).filter(r => r.name);
  }
  return (await overpassNearbyPlaces(loc)).slice(0, 12);
}

function openAddVenueModal() {
  if (!profile) { toast('sign in first'); return; }
  let el = document.getElementById('sheet-add-venue');
  if (!el) {
    el = document.createElement('div');
    el.className = 'sheet-wrap';
    el.id = 'sheet-add-venue';
    el.innerHTML = `
      <div class="sheet-scrim" data-dismiss></div>
      <div class="modal-center">
        <button class="modal-close" data-dismiss>&times;</button>
        <h3>add a place</h3>
        <div class="av-sub">search for it — park, bar, gym, anywhere with a table</div>
        <div class="av-search-wrap">
          <input class="av-input av-search" id="av-search" autocomplete="off" placeholder="Search"/>
          <div class="av-results" id="av-results"></div>
        </div>
        <div class="av-picked" id="av-picked" style="display:none"></div>
        <div class="av-types">
          <button class="av-type active" data-type="public" type="button">public</button>
          <button class="av-type" data-type="business" type="button">business</button>
          <button class="av-type" data-type="private" type="button">private</button>
        </div>
        <button class="ping-confirm-btn" id="av-submit">add it</button>
        <div class="av-error" id="av-error"></div>
      </div>
    `;
    document.body.appendChild(el);
    el.querySelectorAll('[data-dismiss]').forEach(d => d.addEventListener('click', () => {
      el.classList.remove('open');
    }));
    el.querySelectorAll('.av-type').forEach(b => {
      b.addEventListener('click', () => {
        el.querySelectorAll('.av-type').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
    });
    const searchInput = el.querySelector('#av-search');
    const resultsEl = el.querySelector('#av-results');
    const pickedEl = el.querySelector('#av-picked');
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      _avPicked = null;
      pickedEl.style.display = 'none';
      if (_avSearchTimer) clearTimeout(_avSearchTimer);
      // Bump the seq immediately on every keystroke so any in-flight
      // location-prefill / older search results get discarded when they return.
      const seq = ++_avSearchSeq;
      if (q.length < 1) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; return; }
      resultsEl.innerHTML = '<div class="av-result-loading">searching…</div>';
      resultsEl.style.display = 'block';
      _avSearchTimer = setTimeout(async () => {
        const items = await nominatimSearch(q).then(raw => raw.map(formatNomResult).filter(r => r.name));
        if (seq !== _avSearchSeq) return;
        if (!items.length) { resultsEl.innerHTML = '<div class="av-result-loading">no matches — try a fuller name</div>'; return; }
        resultsEl.innerHTML = items.map((r, i) =>
          '<button class="av-result" type="button" data-i="' + i + '">'
          + '<span class="avr-name">' + esc(r.name) + '</span>'
          + '<span class="avr-meta">' + esc([r.city, r.location].filter(Boolean).join(' · ')) + '</span>'
          + '</button>'
        ).join('');
        resultsEl.querySelectorAll('.av-result').forEach(btn => {
          btn.addEventListener('click', () => {
            const pick = items[parseInt(btn.dataset.i, 10)];
            _avPicked = pick;
            searchInput.value = pick.name;
            resultsEl.style.display = 'none';
            resultsEl.innerHTML = '';
            pickedEl.style.display = 'block';
            pickedEl.innerHTML = '<span class="avp-pin"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7 7-13a7 7 0 1 0-14 0c0 6 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></svg></span>'
              + '<span class="avp-text"><b>' + esc(pick.name) + '</b><br/><span class="avp-meta">'
              + esc([pick.city, pick.location].filter(Boolean).join(' · ')) + '</span></span>';
          });
        });
      }, 200);
    });
    el.querySelector('#av-submit').addEventListener('click', async () => {
      const err = el.querySelector('#av-error');
      let payload = _avPicked;
      if (!payload) {
        const typed = searchInput.value.trim();
        if (typed.length < 2) { err.textContent = 'search for a place first'; return; }
        payload = { name: typed, city: '', location: '', lat: null, lng: null };
      }
      const type = el.querySelector('.av-type.active').dataset.type;
      err.textContent = '';
      const submitBtn = el.querySelector('#av-submit');
      submitBtn.disabled = true; submitBtn.textContent = 'adding…';
      const { data, error } = await sb.rpc('add_venue', {
        p_name: payload.name, p_type: type,
        p_city: payload.city || null, p_location: payload.location || null,
        p_lat: payload.lat, p_lng: payload.lng
      });
      submitBtn.disabled = false; submitBtn.textContent = 'add it';
      if (error) { err.textContent = error.message || 'could not add'; return; }
      const v = Array.isArray(data) ? data[0] : data;
      if (v?.id) {
        VENUES.unshift({
          id: v.id, name: v.name, desc: v.location || v.city || '',
          type: v.type, city: v.city || '', lat: v.lat, lng: v.lng,
          play_count: 0, verified: false
        });
        selectedVenue = v.id;
        localStorage.setItem('pm_venue', selectedVenue);
        renderVenuePicker();
        toast('added: ' + v.name);
      }
      // reset for next open
      _avPicked = null;
      searchInput.value = '';
      pickedEl.style.display = 'none';
      el.classList.remove('open');
    });
  } else {
    // reset on reopen
    const searchInput = el.querySelector('#av-search');
    const pickedEl = el.querySelector('#av-picked');
    const resultsEl = el.querySelector('#av-results');
    const errEl = el.querySelector('#av-error');
    if (searchInput) searchInput.value = '';
    if (pickedEl) pickedEl.style.display = 'none';
    if (resultsEl) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; }
    if (errEl) errEl.textContent = '';
    _avPicked = null;
  }
  el.classList.add('open');
  // If we have a location, pre-populate with nearby places from OSM.
  // 1-tap add: tapping a nearby result submits immediately (default type=public).
  if (userLoc) {
    const resultsEl = el.querySelector('#av-results');
    if (resultsEl) {
      const seq = ++_avSearchSeq;
      resultsEl.style.display = 'block';
      resultsEl.innerHTML = '<div class="av-result-loading">finding places near you…</div>';
      overpassNearbyPlaces(userLoc).then(items => {
        if (seq !== _avSearchSeq) return;
        if (!items.length) { resultsEl.innerHTML = '<div class="av-result-loading">nothing nearby — type a name</div>'; return; }
        const shown = items.slice(0, 12);
        resultsEl.innerHTML = '<div class="av-result-label">nearby — tap one to add</div>' + shown.map((r, i) =>
          '<button class="av-result" type="button" data-i="' + i + '">'
          + '<span class="avr-name">' + esc(r.name) + '</span>'
          + '<span class="avr-meta">' + esc([r.city, r.location].filter(Boolean).join(' · ')) + '</span>'
          + '</button>'
        ).join('');
        resultsEl.querySelectorAll('.av-result').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (btn._submitting) return;
            btn._submitting = true;
            btn.classList.add('av-result-loading');
            const pick = shown[parseInt(btn.dataset.i, 10)];
            await quickAddVenue(pick);
            el.classList.remove('open');
          });
        });
      });
    }
  }
}
const VAPID_PUBLIC = 'BL_BNqvydfkgV7pGo0T9gYToFkih9PEMirDsTGNjl8DFAUrK2eQP53NCQ1eH-BjpZRcLjXpDjmaQ56ZY2VCuqTQ';


/* ── REFERRAL ── */
function getRefParam() {
  try { return new URLSearchParams(location.search).get('ref'); } catch { return null; }
}
function clearRefParam() {
  try { const u = new URL(location.href); u.searchParams.delete('ref'); history.replaceState(null, '', u.pathname); } catch {}
}
function getShareUrl() {
  if (!profile) return location.origin;
  // Prefer an unused player-issued code so the recipient lands as an invited
  // guest without needing to type anything. Falls back to ref-only if codes
  // haven't been loaded yet.
  const codes = Array.isArray(myInviteCodes) ? myInviteCodes : [];
  const fresh = codes.find(c => (c.use_count || 0) < (c.max_uses || 1));
  if (fresh) return location.origin + '?code=' + fresh.code + '&ref=' + profile.id;
  return location.origin + '?ref=' + profile.id;
}

/* ── STATE ── */
let profile = null;
let roster = [];
let pings = [];
let myInviteCodes = []; // [{code, use_count, max_uses}]
let homeState = 'off';
let downDur = 60;
let dragging = false;
let currentPct = 50;
let pingsSubscribed = false;
let showOffRaidersState = false; // T5
let downExpiryTimer = null; // exact client-side expiry for "down" status
let playingExpiryTimer = null; // 90-min auto-expire for "playing" status
let downReminderTimer = null; // 5-min warning before expiry
let lastPingTime = 0; // rate limit pings (ms)
const PING_COOLDOWN = 10000; // 10 seconds between pings

/* ── FAVORITES ── */
function getFavorites() {
  try { return JSON.parse(localStorage.getItem('pm_favorites') || '[]'); } catch { return []; }
}
function setFavorites(ids) { localStorage.setItem('pm_favorites', JSON.stringify(ids)); }
function isFavorite(id) { return getFavorites().includes(id); }
function toggleFavorite(id) {
  const favs = getFavorites();
  const idx = favs.indexOf(id);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(id);
  setFavorites(favs);
  return idx < 0; // true = just added
}

const SNAP = { down: 10, off: 50, playing: 90 };
const TH_L = 32;
const TH_R = 68;

/* ── DOM ── */
const app = document.getElementById('app');
const ball = document.getElementById('ball');
const courtWrap = document.getElementById('court-wrap');
const lp = document.getElementById('left-paddle');
const rp = document.getElementById('right-paddle');

/* ── Splash ── */
function hideSplash() {
  const s = document.getElementById('splash');
  if (s) { s.style.opacity = '0'; s.style.transition = 'opacity .3s'; setTimeout(() => s.remove(), 350); }
}

/* ── BOOT ── */
window.addEventListener('load', boot);

// Boot never waits on Supabase forever. If the auth + first-data chain hasn't
// settled in BOOT_TIMEOUT_MS (backend 522, captive wifi, etc.) the user lands
// on an "offline, tap to retry" screen instead of an infinite splash spinner.
const BOOT_TIMEOUT_MS = (typeof window !== 'undefined' && window.PINGME_BOOT_TIMEOUT_MS) || 6000;
let authListenerBound = false;
let bootOnceDone = false;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('boot timed out'), { code: 'BOOT_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function showBootOffline() {
  hideSplash();
  let el = document.getElementById('boot-offline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'boot-offline';
    el.className = 'boot-offline';
    el.innerHTML =
      '<div class="boot-offline-mark">ping<span>me!</span></div>' +
      '<div class="boot-offline-title">looks like you\'re offline</div>' +
      '<div class="boot-offline-sub">can\'t reach pingme right now</div>' +
      '<button class="setup-primary" id="boot-retry">tap to retry</button>';
    document.body.appendChild(el);
    el.querySelector('#boot-retry').addEventListener('click', () => {
      const btn = el.querySelector('#boot-retry');
      btn.disabled = true; btn.textContent = 'connecting…';
      boot();
    });
  }
  const btn = el.querySelector('#boot-retry');
  btn.disabled = false; btn.textContent = 'tap to retry';
}
function hideBootOffline() {
  const el = document.getElementById('boot-offline');
  if (el) el.remove();
}

// Session restore + profile load. Errors here are non-fatal (signed-out boot).
async function bootSession() {
  try {
    // getSession() returns cached session without validating — if access token is expired,
    // we need to refresh it so the user doesn't get silently logged out
    let { data: { session } } = await sb.auth.getSession();
    if (session) {
      // Check if access token is expired or about to expire (within 60s)
      try {
        const exp = JSON.parse(atob(session.access_token.split('.')[1])).exp;
        if (exp * 1000 < Date.now() + 60000) {
          const { data: refreshed, error: refreshErr } = await sb.auth.refreshSession();
          if (refreshErr || !refreshed.session) {
            console.warn('Session expired and refresh failed:', refreshErr);
            session = null;
          } else {
            session = refreshed.session;
          }
        }
      } catch (tokenErr) {
        // Corrupted token — try refresh
        console.warn('Token parse failed, refreshing:', tokenErr);
        const { data: refreshed } = await sb.auth.refreshSession();
        session = refreshed?.session || null;
      }
      if (session) {
        await loadOrCreateProfile(session.user);
        registerPushSubscription(); // ensure push sub is registered on every boot
      }
    }
    // If no session but user had a linked email, show sign-in prompt
    if (!session && localStorage.getItem('pm_linked_email')) {
      toast('session expired — sign in again');
    }
  } catch (e) { console.error('Auth check failed:', e); toast('connecting...'); }
}

function bindAuthListener() {
  if (authListenerBound) return;
  authListenerBound = true;
  let profileLoaded = !!profile; // skip if boot already loaded profile
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      if (profileLoaded) return; // boot already handled this session
      profileLoaded = true;
      // T8: detect new vs returning user
      const { data: existing } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
      if (existing && existing.name) {
        // Returning user — already onboarded
        profile = await restoreTimers(existing);
        homeState = profile.status || 'off';
        document.getElementById('setup-root').innerHTML = '';
        await loadFriends();
        await loadRoster();
        await loadPings();
        subscribePings();
        renderHome();
        registerPushSubscription();
        toast('welcome back, ' + profile.name);
        loadScenes();
        setTimeout(maybeShowSceneNudge, 1200);
      } else {
        // New user — continue onboarding at name screen
        const prefill = (
          session.user.user_metadata?.given_name ||
          session.user.user_metadata?.full_name?.split(' ')[0] ||
          session.user.email?.split('@')[0] ||
          ''
        ).toLowerCase();
        showSetupScreen2(session.user, existing || null, prefill);
      }
    } else if (event === 'SIGNED_OUT') {
      profileLoaded = false;
      profile = null; homeState = 'off'; pingsSubscribed = false;
      placeBall(SNAP.off, true);
      app.dataset.homeState = 'off';
      renderHome();
    }
  });
}

async function boot() {
  // Request persistent storage to prevent iOS from wiping data after 7 days
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if (!sb) {
    setTab('home');
    renderHome();
    setTimeout(showSetup, 300);
    hideSplash();
    return;
  }

  try {
    await withTimeout((async () => {
      await bootSession();
      if (profile) await loadFriends();
      await loadRoster();
      await loadPings();
    })(), BOOT_TIMEOUT_MS);
  } catch (e) {
    if (e && e.code === 'BOOT_TIMEOUT') {
      console.warn('boot: supabase unreachable after ' + BOOT_TIMEOUT_MS + 'ms, showing offline screen');
      showBootOffline();
      return;
    }
    // Non-timeout failure (network error etc.): fall through to a signed-out
    // boot rather than leaving the splash up forever.
    console.warn('boot: data load failed:', e);
    toast('connecting...');
  }
  hideBootOffline();

  bindAuthListener();
  subscribeRealtime();

  setTab('home');
  hideSplash();
  if (!profile) setTimeout(showSetup, 300);
  else setTimeout(maybeShowSceneNudge, 1200);

  // #5: pull canonical venue list once we have a connection
  loadVenues();
  loadScenes().then(handleSceneRoute).catch(() => {});

  // Everything below is one-time wiring; a retry after the offline screen
  // must not double up timers or the pull-to-refresh handle.
  if (bootOnceDone) return;
  bootOnceDone = true;

  setInterval(async () => {
    await expireStale();
    // #7: polling is a true fallback now (60s). Realtime subscription is primary;
    // visibilitychange + heartbeat re-subscribe handle gaps.
    await loadRoster();
    if (profile) await loadPings();
    if (document.querySelector('[data-screen="home"].active')) renderHome();
  }, POLL_INTERVAL_MS);

  // Pull-to-refresh
  initPullToRefresh();
}

/* ── PULL TO REFRESH ── */
function initPullToRefresh() {
  const THRESHOLD = 70;
  const HOLD_POS = 56;
  let startY = 0;
  let isPulling = false;
  let refreshing = false;
  let screenEl = null; // the active .screen element — we transform this, NOT #app

  const ptr = document.createElement('div');
  ptr.className = 'ptr';
  ptr.innerHTML = '<div class="ptr-spinner"></div>';
  document.body.prepend(ptr);
  const spinner = ptr.querySelector('.ptr-spinner');

  // KEY FIX: transform the active .screen instead of #app.
  // CSS spec: position:fixed children of a transformed ancestor lose fixed positioning.
  // The sheet-wrap modals are position:fixed inside #app, so transforming #app
  // breaks them (they get pushed off-screen along with everything else).
  // Transforming only the active .screen avoids that — modals stay in place.
  function getScreenEl() {
    return document.querySelector('.screen.active') || document.getElementById('app');
  }

  function resetScreen() {
    if (screenEl) {
      screenEl.style.transform = '';
      screenEl.style.transition = '';
      screenEl = null;
    }
    ptr.style.opacity = '0';
    ptr.style.transform = 'translateX(-50%) translateY(0)';
  }

  // The move handler — only attached when a pull gesture starts
  function onTouchMove(e) {
    if (!isPulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 5 && window.scrollY <= 0) {
      e.preventDefault();
      const pull = dy < THRESHOLD ? dy * 0.5 : THRESHOLD * 0.5 + (dy - THRESHOLD) * 0.15;
      const progress = Math.min(dy / THRESHOLD, 1);
      if (screenEl) screenEl.style.transform = 'translateY(' + pull + 'px)';
      ptr.style.opacity = progress;
      ptr.style.transform = 'translateX(-50%) translateY(' + (pull * 0.4) + 'px)';
      spinner.style.transform = 'rotate(' + (dy * 2) + 'deg)';
      spinner.style.opacity = progress;
      ptr.classList.toggle('ptr-ready', progress >= 1);
    } else if (dy < 0 || window.scrollY > 0) {
      cleanup();
    }
  }

  function cleanup() {
    document.removeEventListener('touchmove', onTouchMove);
    isPulling = false;
    if (!refreshing) resetScreen();
  }

  // touchstart is passive
  document.addEventListener('touchstart', e => {
    if (refreshing) return;
    // Don't pull while a modal is open — would be jarring and useless
    if (document.querySelector('.sheet-wrap.open')) return;
    if (window.scrollY <= 0 && e.touches.length === 1) {
      startY = e.touches[0].clientY;
      isPulling = true;
      screenEl = getScreenEl();
      ptr.style.transition = 'none';
      if (screenEl) screenEl.style.transition = 'none';
      document.addEventListener('touchmove', onTouchMove, { passive: false });
    }
  }, { passive: true });

  document.addEventListener('touchend', async () => {
    if (!isPulling || refreshing) { cleanup(); return; }
    // Read pull distance before cleanup resets the transform
    const pulled = screenEl
      ? parseFloat(screenEl.style.transform?.match(/translateY\((.+?)px\)/)?.[1] || 0)
      : 0;
    cleanup(); // resets isPulling; keeps refreshing=false so resetScreen runs

    ptr.style.transition = 'transform .3s ease, opacity .3s ease';

    if (pulled >= THRESHOLD * 0.5) {
      // Re-acquire screenEl for the hold animation (cleanup cleared it)
      screenEl = getScreenEl();
      refreshing = true;
      ptr.classList.add('ptr-loading');
      if (screenEl) {
        screenEl.style.transition = 'transform .3s ease';
        screenEl.style.transform = 'translateY(' + HOLD_POS + 'px)';
      }
      ptr.style.transform = 'translateX(-50%) translateY(' + (HOLD_POS * 0.35) + 'px)';
      ptr.style.opacity = '1';

      try {
        await loadRoster();
        if (profile) await loadPings();
        if (document.querySelector('[data-screen="home"].active')) renderHome();
      } catch {}

      await new Promise(r => setTimeout(r, 400));

      ptr.classList.remove('ptr-loading');
      ptr.classList.remove('ptr-ready');
      if (screenEl) screenEl.style.transform = 'translateY(0)';
      ptr.style.transform = 'translateX(-50%) translateY(0)';
      ptr.style.opacity = '0';
      setTimeout(() => {
        refreshing = false;
        if (screenEl) { screenEl.style.transition = ''; screenEl.style.transform = ''; }
        screenEl = null;
      }, 300);
    }
  });

  // touchcancel — iOS fires on gesture conflicts (back swipe, control center, etc.)
  document.addEventListener('touchcancel', cleanup);

  // Safety net: force reset if transform gets stuck
  setInterval(() => {
    if (!isPulling && !refreshing && screenEl) {
      resetScreen();
    }
  }, 2000);
}

// #8: single source of truth for restoring per-status expiry timers + offline catch-up.
// Was duplicated between boot, loadOrCreateProfile, and onAuthStateChange.
async function restoreTimers(p) {
  if (!p) return p;
  if (p.status === 'down' && p.started_at && p.duration) {
    const msLeft = (p.duration * 60000) - (Date.now() - new Date(p.started_at).getTime());
    if (msLeft > 0) {
      downDur = p.duration;
      downExpiryTimer = setTimeout(() => { toast('your down window expired'); snapTo('off'); }, msLeft);
      const reminderMs = msLeft - 5 * 60000;
      if (reminderMs > 60000) {
        downReminderTimer = setTimeout(() => {
          toast('5 min left on your down window');
          maybeNotify('5 minutes left — find your game!');
        }, reminderMs);
      }
    } else {
      p.status = 'off';
      await sb.from('profiles').update({ status: 'off', venue: null, duration: null, started_at: null }).eq('id', p.id);
    }
  }
  if (p.status === 'playing' && p.started_at) {
    const msLeft = (90 * 60000) - (Date.now() - new Date(p.started_at).getTime());
    if (msLeft > 0) {
      playingExpiryTimer = setTimeout(() => { toast('playing session expired after 90 min'); snapTo('off'); }, msLeft);
    } else {
      p.status = 'off';
      await sb.from('profiles').update({ status: 'off', venue: null, duration: null, started_at: null }).eq('id', p.id);
    }
  }
  return p;
}

/* ── AUTH ── */
async function signInSendCode(email) {
  try {
    const r = await fetch(SUPABASE_URL + '/functions/v1/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify({ action: 'signin-send', email })
    });
    const result = await r.json();
    if (result.error) { toast(result.error); return { ok: false, error: result.error }; }
    return { ok: true };
  } catch (e) { toast('sign in failed: ' + e.message); return { ok: false, error: e.message }; }
}

// Email-required signup: same shape as the server-side check in send-email.
function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

async function signupSendCode(email) {
  try {
    const r = await fetch(SUPABASE_URL + '/functions/v1/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify({ action: 'signup-send', email })
    });
    const result = await r.json();
    if (result.error) return { ok: false, error: result.error, code: result.code };
    return { ok: true };
  } catch (e) { return { ok: false, error: 'could not send the code — check your connection and try again' }; }
}

// The send-email `send`/`verify` actions (link an email to the signed-in
// account) resolve the user from the bearer JWT, so it has to be the user's
// session token — the anon key gets a 401.
async function userAuthHeaders() {
  const { data: { session } } = await sb.auth.getSession();
  const token = session && session.access_token ? session.access_token : SUPABASE_ANON;
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
}

async function loadOrCreateProfile(user) {
  const { data: existing } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (existing) {
    profile = await restoreTimers(existing);
    homeState = profile.status || 'off';
    // Email-link nudge is surfaced via the email icon + dot on the profile,
    // not via the notifications list. Clean up any pre-existing system pings.
    sb.from('pings').delete()
      .eq('to_id', user.id).eq('verb', 'system')
      .then(() => updateNotisBadge(), () => {});
    localStorage.setItem('pm_link_nudge', '1');
    if (FEATURES.accessCodes && !existing.invited_via) {
      const params = new URLSearchParams(location.search);
      if (params.get('code') || params.get('ref') || localStorage.getItem('pm_invited_via')) {
        setTimeout(() => { try { window.pmMatch?.claimAccessCode?.(); } catch {} }, 200);
      }
    }
    loadMyInviteCodes();
    return;
  }
  // T2B: don't default to 'anon' — use empty string so nameless users are filtered
  const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || '';
  const color = AV_COLORS[Math.abs(hash(name || user.id)) % AV_COLORS.length];
  const { data: newProfile, error } = await sb.from('profiles').insert({
    id: user.id, name, color, status: 'off', ambient: 'just joined'
  }).select().single();
  if (error) { toast('profile error'); console.error(error); return; }
  profile = newProfile; homeState = 'off';
  if (FEATURES.accessCodes) {
    // New profile: kick off access code claim flow (referral param or PINGME or prompt)
    setTimeout(() => { try { window.pmMatch?.claimAccessCode?.(); } catch {} }, 200);
  }
  loadMyInviteCodes();
}

async function loadMyInviteCodes() {
  if (!profile || !sb || !FEATURES.accessCodes) return;
  try {
    const { data, error } = await sb.rpc('issue_my_invite_codes', { p_total: 3 });
    if (error) { console.warn('issue_my_invite_codes:', error.message); return; }
    if (Array.isArray(data)) {
      myInviteCodes = data;
      try { renderMyInviteCodes(); } catch {}
    }
  } catch (e) { console.warn('issue_my_invite_codes throw:', e); }
}
window.loadMyInviteCodes = loadMyInviteCodes;

/* ── WEB PUSH ── */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function registerPushSubscription() {
  if (!profile || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
      });
    }
    // Store subscription in Supabase
    const subJson = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({
      user_id: profile.id,
      endpoint: subJson.endpoint,
      keys_p256dh: subJson.keys.p256dh,
      keys_auth: subJson.keys.auth
    }, { onConflict: 'user_id' });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('Push sub failed:', e);
    return false;
  }
}

/* ── DATA ── */
async function loadRoster() {
  let { data, error } = await sb.from('profiles')
    .select('id, name, color, status, venue, duration, started_at, ambient, referred_by, referral_count, play_count, email_verified, elo, wins, losses, last_lat, last_lng, notify_radius_km, home_city, school, updated_at, created_at')
    .order('updated_at', { ascending: false })
    .limit(200);
  // Fallback if newer columns don't exist yet on this Supabase instance
  if (error && error.message && /play_count|email_verified|elo|wins|losses|home_city|school/.test(error.message)) {
    const fallback = await sb.from('profiles')
      .select('id, name, color, status, venue, duration, started_at, ambient, referred_by, referral_count, updated_at, created_at')
      .order('updated_at', { ascending: false })
      .limit(200);
    data = fallback.data;
    error = fallback.error;
  }
  if (!error && data) { rosterRaw = data; roster = scopeRoster(data); }
}

// Filter roster so a user only sees players in their own city. Self always
// passes. If the local user has no home_city yet, return everyone (legacy).
// A roster row counts as "in my city" if either:
//   - their home_city matches, OR
//   - they're currently at a venue whose city matches.
function scopeRosterToCity(rows) {
  const myCity = (profile && profile.home_city || '').toLowerCase();
  if (!myCity) return rows;
  return rows.filter(r => {
    if (profile && r.id === profile.id) return true;
    if ((r.home_city || '').toLowerCase() === myCity) return true;
    if (r.venue) {
      const v = VENUES.find(x => x.id === r.venue);
      if (v && (v.city || '').toLowerCase() === myCity) return true;
    }
    return false;
  });
}

async function loadPings() {
  if (!profile) { pings = []; return; }
  const { data, error } = await sb.from('pings')
    .select('*, from:profiles!pings_from_id_fkey(name, color)')
    .eq('to_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (!error && data) pings = data;
  // Don't surface "connect email" nudges to verified users — clear them locally and remotely
  const me = roster.find(r => r.id === profile.id);
  const linked = !!(me && me.email_verified) || !!localStorage.getItem('pm_linked_email');
  if (linked && pings.some(p => p.verb === 'system')) {
    const stale = pings.filter(p => p.verb === 'system').map(p => p.id);
    pings = pings.filter(p => p.verb !== 'system');
    if (stale.length) sb.from('pings').delete().in('id', stale).then(() => {}, () => {});
  }
}

let profilesChannel = null;
let realtimeRetryDelay = 3000;
let lastRealtimeEvent = Date.now();

// Heartbeat: if no realtime event in 90s and polling is fetching data, re-subscribe
setInterval(() => {
  if (sb && profilesChannel && Date.now() - lastRealtimeEvent > 90000) {
    console.log('realtime heartbeat: stale, re-subscribing');
    pingsSubscribed = false;
    subscribeRealtime();
  }
}, 30000);

function subscribeRealtime() {
  // Clean up existing channel before re-subscribing
  if (profilesChannel) {
    sb.removeChannel(profilesChannel);
    profilesChannel = null;
  }
  profilesChannel = sb.channel('profiles-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
      lastRealtimeEvent = Date.now();
      // City-scoped: drop realtime updates from players outside our city so
      // Lubbock users don't get Austin notifications (and vice-versa).
      const inScope = scopeRoster([payload.new || payload.old]).length > 0;
      if (payload.new && payload.new.id) {
        const raw = rosterRaw.find(r => r.id === payload.new.id);
        if (raw) Object.assign(raw, payload.new); else rosterRaw.push(payload.new);
      }
      if (payload.eventType === 'INSERT') {
        if (!inScope) return;
        const exists = roster.find(r => r.id === payload.new.id);
        if (!exists) roster.push(payload.new);
        else Object.assign(exists, payload.new);
      } else if (payload.eventType === 'UPDATE') {
        const r = roster.find(x => x.id === payload.new.id);
        if (!inScope) {
          if (r) roster = roster.filter(x => x.id !== payload.new.id);
          return;
        }
        if (r) Object.assign(r, payload.new);
        else roster.push(payload.new);
        if (profile && payload.new.id !== profile.id) {
          if (payload.new.status === 'playing' && payload.old?.status !== 'playing')
            maybeNotify(payload.new.name + ' just started playing');
          else if (payload.new.status === 'down' && payload.old?.status !== 'down')
            maybeNotify(payload.new.name + ' is down to play');
        }
      } else if (payload.eventType === 'DELETE') {
        roster = roster.filter(r => r.id !== payload.old.id);
        rosterRaw = rosterRaw.filter(r => r.id !== payload.old.id);
      }
      if (document.querySelector('[data-screen="home"].active')) renderHome();
    })
    .subscribe((status, err) => {
      console.log('profiles-realtime:', status, err || '');
      if (status === 'SUBSCRIBED') {
        realtimeRetryDelay = 3000; // reset on success
      } else if (status === 'CHANNEL_ERROR') {
        setTimeout(subscribeRealtime, realtimeRetryDelay);
        realtimeRetryDelay = Math.min(realtimeRetryDelay * 2, 60000); // exponential backoff, max 60s
      }
    });
  subscribePings();
}

// Refresh roster AND re-subscribe realtime when tab comes back into focus
let lastVisibilityRefresh = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && sb) {
    // Debounce — skip if we refreshed less than 5s ago
    if (Date.now() - lastVisibilityRefresh < 5000) return;
    lastVisibilityRefresh = Date.now();

    // Re-validate session on resume (catches iOS purging auth)
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session && profile) {
        // Session was lost — try to refresh
        const { data: refreshed } = await sb.auth.refreshSession();
        if (!refreshed?.session) {
          profile = null;
          homeState = 'off';
          toast('session expired — sign in again');
          renderHome();
          return;
        }
      }
    } catch (_) {}

    // Re-subscribe realtime — WebSocket dies when phone sleeps
    pingsSubscribed = false;
    subscribeRealtime();

    await loadRoster();
    if (profile) await loadPings();
    if (document.querySelector('[data-screen="home"].active')) renderHome();

    // Re-register push sub in case iOS killed the service worker
    if (profile) registerPushSubscription();
  }
});

// Notify all other users via push notification (called by the person changing status)
// Fire-and-forget — don't block the UI. Sends in small batches to avoid hammering.
// Recipients farther than their notify_radius_km from the playing venue are skipped
// so Lubbock users don't get pinged about Austin pickup games (and vice versa).
// Silent on preview/dev hosts so testing never pings live users.
// Production = usepingme.com / www.usepingme.com. Anything else (Vercel preview
// URLs, localhost, custom dev hosts) suppresses outbound pushes.
// Override either way with localStorage.pm_push_force = '1' (force on) or
// localStorage.pm_push_off = '1' (force off, even on prod).
function isPushAllowedHere() {
  try {
    if (localStorage.getItem('pm_push_off') === '1') return false;
    if (localStorage.getItem('pm_push_force') === '1') return true;
    const h = location.hostname;
    return h === 'usepingme.com' || h === 'www.usepingme.com';
  } catch (_) { return false; }
}

function pushStatusChange(msg) {
  if (!profile) return;
  if (!isPushAllowedHere()) {
    console.log('[pingme] push suppressed (non-prod host):', location.hostname, msg);
    return;
  }
  const v = getVenue();
  const origin = (v && v.lat != null && v.lng != null)
    ? { lat: v.lat, lng: v.lng }
    : (userLoc || null);
  const others = roster.filter(r => {
    if (r.id === profile.id) return false;
    if (!r.name || r.name.trim() === '' || r.name === 'anon') return false;
    if (isFriend(r.id)) return true; // friends are mutual — never radius-filtered
    if (!origin) return true; // unknown origin → don't filter
    const radius = (r.notify_radius_km == null) ? 80 : r.notify_radius_km;
    if (radius <= 0) return true; // 0 means global
    if (r.last_lat == null || r.last_lng == null) return true; // unknown → include
    const d = haversineKm(origin, { lat: r.last_lat, lng: r.last_lng });
    return d <= radius;
  });
  // Send in batches of 5 with 200ms gaps
  const BATCH_SIZE = 5;
  others.forEach((r, i) => {
    setTimeout(() => sendPushNotification(r.id, profile.id, msg), Math.floor(i / BATCH_SIZE) * 200);
  });
}

function subscribePings() {
  if (!profile || pingsSubscribed) return;
  pingsSubscribed = true;
  sb.channel('pings-realtime')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'pings',
      filter: 'to_id=eq.' + profile.id
    }, async () => {
      lastRealtimeEvent = Date.now();
      await loadPings();
      updateNotisBadge();
      maybeNotify('new ping!');
    })
    .subscribe((status, err) => {
      console.log('pings-realtime:', status, err || '');
    });
}

/* ── TABLE SUBTITLE (dynamic counts) ── */
function updateTableSub() {
  const sub = document.getElementById('table-sub');
  if (!sub) return;
  const all = allRaiders();
  const playing = all.filter(r => r.status === 'playing').length;
  const down = all.filter(r => r.status === 'down').length;
  sub.textContent = `${playing} playing \u00b7 ${down} down`;
}


/* ── NAV — single screen, avatar opens combined panel ── */
function setTab() { renderHome(); }

// Share button → always show QR modal (with share link option)
function handleShareBtn(e) {
  if (e.type === 'touchend') e.preventDefault();
  showQrShare();
}
document.getElementById('top-share').addEventListener('click', handleShareBtn);
document.getElementById('top-share').addEventListener('touchend', handleShareBtn);

// Avatar → open combined profile + notis modal
// Open modal FIRST so tap feels instant, then populate content
// Handle both click and touchend for iOS
let profileAvFiring = false;
function handleProfileAv(e) {
  if (profileAvFiring) return;
  profileAvFiring = true;
  // Reset the firing flag no matter what — prevents lock-out if renderMe throws,
  // which would otherwise make the avatar permanently un-clickable.
  setTimeout(() => { profileAvFiring = false; }, 300);
  try {
    if (e.type === 'touchend') e.preventDefault();
    document.getElementById('sheet-me').classList.add('open');
    renderMe();
    renderNotis();
    // Mark pings as read when modal opens
    if (profile && pings.some(p => p.unread)) {
      sb.from('pings').update({ unread: false }).eq('to_id', profile.id).eq('unread', true)
        .then(() => { pings.forEach(p => p.unread = false); updateNotisBadge(); });
    }
  } catch (err) {
    console.error('profile open failed:', err);
  }
}
document.getElementById('profile-av').addEventListener('click', handleProfileAv);
document.getElementById('profile-av').addEventListener('touchend', handleProfileAv);

// Settings + email icons: rebuilt as a single delegated `click` handler
// (no touchend), on the BUBBLE phase so other capture-phase handlers don't
// swallow the tap. Mobile browsers synthesize click from touchend reliably;
// listening to both was causing the no-op double-fire users reported.
let lastIconTap = 0;
document.addEventListener('click', (e) => {
  const setBtn = e.target.closest('#row-settings');
  const emBtn  = e.target.closest('#row-email');
  if (!setBtn && !emBtn) return;
  // Guard: only open these overlays when the profile sheet is actually open.
  // Prevents them appearing over the homepage if the buttons are accessed
  // via a synthetic event while #sheet-me is closed.
  const meOpen = document.getElementById('sheet-me')?.classList.contains('open');
  if (!meOpen) return;
  const now = Date.now();
  if (now - lastIconTap < 250) return; // simple debounce
  lastIconTap = now;
  e.preventDefault();
  e.stopPropagation();
  if (setBtn) { openSettingsOverlay(); return; }
  if (emBtn) { openEmailOverlay(); return; }
});

// When the profile sheet closes, close any settings/email overlays riding
// above it so they can't end up floating over the homepage.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#sheet-me [data-dismiss], #sheet-me .me-back')) return;
  document.getElementById('sheet-settings')?.classList.remove('open');
  document.getElementById('sheet-email')?.classList.remove('open');
});

// Any settings item tap also dismisses the overlay
document.addEventListener('click', (e) => {
  const item = e.target.closest('#settings-list .me-dd-item');
  if (!item) return;
  // small delay so the item's own handler fires first
  setTimeout(() => document.getElementById('sheet-settings')?.classList.remove('open'), 0);
});

// Profile visibility: public / business / private — stored in localStorage
// (no schema change required for now). Cycles on tap; the row in the settings
// overlay shows the current state with the matching hand-drawn icon.
// business option deferred — see ideas box. Hidden from cycle for now; the
// SVG below is intentionally left in place so we can re-enable later.
const VIS_ORDER = ['public', 'private']; // ['public', 'business', 'private']
const VIS_ICONS = {
  public:   '<svg viewBox="0 0 40 40" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"><circle cx="20" cy="20" r="14.5"/><path d="M5.5 20 L34.5 20"/><path d="M20 5.5 C24 9.5 24 30.5 20 34.5 C16 30.5 16 9.5 20 5.5 Z"/><path d="M9 13.5 C13 16 27 16 31 13.5 M9 26.5 C13 24 27 24 31 26.5"/></svg>',
  business: '<svg viewBox="0 0 40 40" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"><path d="M5 34 L35 34"/><rect x="8" y="14" width="24" height="20" rx="2"/><path d="M14 14 L14 9.5 C14 8.5 14.7 8 15.5 8 L24.5 8 C25.3 8 26 8.5 26 9.5 L26 14"/><path d="M18 34 L18 28 L22 28 L22 34"/></svg>',
  private:  '<svg viewBox="0 0 40 40" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)"><rect x="9" y="18" width="22" height="15" rx="3"/><path d="M13.5 18 L13.5 13.5 C13.5 9 16.5 6.5 20 6.5 C23.5 6.5 26.5 9 26.5 13.5 L26.5 18"/><circle cx="20" cy="24.5" r="2.2" fill="currentColor" stroke="none"/></svg>'
};
function getVisibility() {
  const v = localStorage.getItem('pm_visibility') || 'public';
  // business option deferred — coerce any stale 'business' value to 'public'.
  return VIS_ORDER.includes(v) ? v : 'public';
}
function setVisibility(v) { localStorage.setItem('pm_visibility', v); }

function openSettingsOverlay() {
  const list = document.getElementById('settings-list');
  if (!list) return;

  if (!profile) {
    list.innerHTML =
      '<button class="me-dd-item" id="set-signin">sign in to play</button>';
    document.getElementById('set-signin').addEventListener('click', () => {
      document.getElementById('sheet-settings')?.classList.remove('open');
      showSetup();
    });
    document.getElementById('sheet-settings')?.classList.add('open');
    return;
  }

  const notifOn = typeof Notification !== 'undefined'
    && Notification.permission === 'granted'
    && !localStorage.getItem('pm_notif_off');
  const vis = getVisibility();

  list.innerHTML =
    '<button class="me-dd-item set-vis" id="set-visibility">' +
      '<span class="set-vis-ic">' + VIS_ICONS[vis] + '</span>' +
      '<span class="set-vis-text">profile · ' + vis + '</span>' +
      '<span class="set-vis-hint">tap to change</span>' +
    '</button>' +
    '<button class="me-dd-item" id="set-notif">' +
      '<span class="tog-switch ' + (notifOn ? 'on' : '') + '" id="set-notif-tog"><span class="knob"></span></span>' +
      ' notifications' +
    '</button>' +
    '<button class="me-dd-item" id="set-test-notif">test notification</button>' +
    '<button class="me-dd-item" id="set-friends">friends</button>' +
    '<button class="me-dd-item" id="set-scenes">scenes \u00b7 ' + sceneLabel() + '</button>' +
    '<button class="me-dd-item" id="set-invite">invite a friend</button>' +
    '<button class="me-dd-item me-dd-danger" id="set-signout">sign out</button>' +
    '<button class="me-dd-item me-dd-danger" id="set-delete">delete account</button>';

  // Visibility cycler
  document.getElementById('set-visibility').addEventListener('click', () => {
    const cur = getVisibility();
    const next = VIS_ORDER[(VIS_ORDER.indexOf(cur) + 1) % VIS_ORDER.length];
    setVisibility(next);
    openSettingsOverlay(); // re-render in place
    toast('profile · ' + next);
  });

  // Notifications toggle
  document.getElementById('set-notif').addEventListener('click', async () => {
    if (!('Notification' in window)) {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      toast(isIOS && !window.navigator.standalone
        ? 'tap Share → Add to Home Screen first'
        : 'notifications not supported');
      return;
    }
    const tog = document.getElementById('set-notif-tog');
    if (Notification.permission === 'granted') {
      const wasOn = tog.classList.contains('on');
      tog.classList.toggle('on');
      localStorage.setItem('pm_notif_off', wasOn ? '1' : '');
      if (!wasOn && typeof registerPushSubscription === 'function') {
        await registerPushSubscription();
      }
      toast(wasOn ? 'notifications off' : 'notifications on');
    } else if (Notification.permission === 'denied') {
      toast('blocked — check browser settings');
    } else {
      const p = await Notification.requestPermission();
      if (p === 'granted') {
        tog.classList.add('on');
        localStorage.removeItem('pm_notif_off');
        if (typeof registerPushSubscription === 'function') await registerPushSubscription();
        toast('notifications on');
      } else {
        toast('notifications blocked');
      }
    }
  });

  document.getElementById('set-test-notif').addEventListener('click', () => {
    document.getElementById('sheet-settings')?.classList.remove('open');
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      toast('enable notifications first');
      return;
    }
    new Notification('pingme', {
      body: (profile.name || 'someone') + ' wants to play!',
      icon: '/icon-192.png',
      tag: 'pm-test',
      renotify: true
    });
    toast('check your notification');
  });

  document.getElementById('set-friends').addEventListener('click', () => {
    document.getElementById('sheet-settings').classList.remove('open');
    openFriendsSheet('friends');
  });
  document.getElementById('set-scenes').addEventListener('click', () => {
    document.getElementById('sheet-settings').classList.remove('open');
    openSceneSheet();
  });
  document.getElementById('set-invite').addEventListener('click', () => {
    document.getElementById('sheet-settings')?.classList.remove('open');
    const url = getShareUrl();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => toast('invite code copied')).catch(() => toast('copy failed'));
    } else {
      toast('copy failed');
    }
  });

  document.getElementById('set-signout').addEventListener('click', async () => {
    if (!confirm('sign out?')) return;
    document.getElementById('sheet-settings')?.classList.remove('open');
    if (profile?.id && sb) {
      await sb.from('profiles').update({
        status: 'off', venue: null, duration: null, started_at: null
      }).eq('id', profile.id);
      await sb.auth.signOut();
    }
    localStorage.removeItem('pm_linked_email');
    const myId = profile?.id;
    profile = null; homeState = 'off';
    if (myId) roster = roster.filter(r => r.id !== myId);
    placeBall(SNAP.off, true);
    app.dataset.homeState = 'off';
    toast('signed out');
    document.getElementById('sheet-me').classList.remove('open');
    renderHome();
  });

  document.getElementById('set-delete').addEventListener('click', async () => {
    if (!confirm('delete your account? this cannot be undone.')) return;
    if (!confirm('are you sure? all your data will be permanently deleted.')) return;
    document.getElementById('sheet-settings')?.classList.remove('open');
    const myId = profile?.id;
    if (myId && sb) await sb.from('profiles').delete().eq('id', myId);
    if (sb) await sb.auth.signOut();
    ['pm_linked_email','pm_auth','pm_venue','pm_favorites','pm_link_nudge','pm_notif_off'].forEach(k => localStorage.removeItem(k));
    profile = null; homeState = 'off';
    if (myId) roster = roster.filter(r => r.id !== myId);
    placeBall(SNAP.off, true);
    app.dataset.homeState = 'off';
    toast('account deleted');
    document.getElementById('sheet-me').classList.remove('open');
    renderHome();
    setTimeout(showSetup, 300);
  });

  document.getElementById('sheet-settings')?.classList.add('open');
}

function openEmailOverlay() {
  if (!profile) { showSetup(); return; }
  const cachedEmail = (profile && profile._linkedEmail) || localStorage.getItem('pm_linked_email') || '';
  const verified = !!(profile && profile.email_verified) || !!cachedEmail;
  const title = document.getElementById('email-overlay-title');
  const sub = document.getElementById('email-overlay-sub');
  const cta = document.getElementById('email-overlay-cta');
  if (title) title.textContent = verified ? 'email connected' : 'link your email';
  if (sub) {
    sub.textContent = verified
      ? (cachedEmail || 'your email is verified')
      : 'save your account so you can log in on other devices';
  }
  if (cta) {
    cta.textContent = verified ? 'change email' : 'verify email';
    cta.onclick = () => {
      if (verified) {
        localStorage.removeItem('pm_linked_email');
        if (profile) { profile._linkedEmail = null; profile.email_verified = false; }
      }
      document.getElementById('sheet-email')?.classList.remove('open');
      showLinkEmail();
    };
  }
  document.getElementById('sheet-email')?.classList.add('open');
}

// Two-step email tap:
//   1st tap (per profile sheet open)   → small "your email has been connected" pill
//   2nd tap (or tap the pill itself)   → full inline manage card
let emailFirstTapShown = false;
function handleEmailTap() {
  if (!profile) { showSetup(); return; }
  const cachedEmail = (profile && profile._linkedEmail) || localStorage.getItem('pm_linked_email') || '';
  const verified = !!(profile && profile.email_verified) || !!cachedEmail;
  document.getElementById('sheet-me')?.classList.add('open');
  document.getElementById('me-settings-dd')?.classList.remove('open');

  // If not yet verified, skip the confirm pill — go straight to verify flow
  if (!verified) { emailFirstTapShown = false; openEmailActions(); return; }

  if (!emailFirstTapShown) {
    emailFirstTapShown = true;
    showEmailConnectedPill();
  } else {
    document.getElementById('me-email-confirm')?.remove();
    openEmailActions();
  }
}

function showEmailConnectedPill() {
  // Remove old card if any
  document.getElementById('me-email-inline')?.remove();
  let pill = document.getElementById('me-email-confirm');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'me-email-confirm';
    pill.className = 'me-email-confirm';
    const w = document.getElementById('me-wrap');
    if (w) w.insertAdjacentElement('afterend', pill);
  }
  pill.innerHTML =
    '<span class="mec-text">your email has been connected</span>' +
    '<button class="mec-x" type="button" aria-label="close">&times;</button>';
  pill.querySelector('.mec-x')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    pill.remove();
  });
  pill.addEventListener('click', () => {
    pill.remove();
    openEmailActions();
  });
  pill.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function openEmailActions() {
  if (!profile) { showSetup(); return; }
  // Stay on the profile page — render an inline card inside the profile
  // sheet instead of stacking another full-screen modal.
  const cachedEmail = (profile && profile._linkedEmail) || localStorage.getItem('pm_linked_email') || '';
  const verified = !!(profile && profile.email_verified) || !!cachedEmail;
  document.getElementById('sheet-me')?.classList.add('open');
  document.getElementById('me-settings-dd')?.classList.remove('open');

  let card = document.getElementById('me-email-inline');
  if (!card) {
    card = document.createElement('div');
    card.id = 'me-email-inline';
    card.className = 'me-email-inline';
    const w = document.getElementById('me-wrap');
    if (w) w.insertAdjacentElement('afterend', card);
  }
  card.innerHTML =
    '<button class="me-email-x" type="button" aria-label="close">&times;</button>' +
    '<div class="me-email-title">' + (verified ? 'email on file' : 'link your email') + '</div>' +
    '<div class="me-email-sub">' +
      (verified ? esc(cachedEmail || 'verified') : 'save your account so you can log in on other devices') +
    '</div>' +
    '<button class="me-email-cta" type="button">' +
      (verified ? 'change email' : 'verify email') +
    '</button>';
  card.classList.add('open');
  card.querySelector('.me-email-x')?.addEventListener('click', () => card.remove());
  card.querySelector('.me-email-cta')?.addEventListener('click', () => {
    if (verified) {
      localStorage.removeItem('pm_linked_email');
      if (profile) { profile._linkedEmail = null; profile.email_verified = false; }
    }
    card.remove();
    showLinkEmail();
  });
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ── SHEETS ── */
// Use event delegation so dynamically-added [data-dismiss] buttons also work
// Handle both click and touchend for iOS reliability
function handleDismiss(e) {
  const el = e.target.closest('[data-dismiss]');
  if (!el) return;
  const wrap = el.closest('.sheet-wrap');
  if (!wrap) return;
  if (e.type === 'touchend') e.preventDefault(); // prevent ghost click
  wrap.classList.remove('open');
  // Reset firing locks immediately so re-entry to profile is instant.
  // Bug (c): when closing the profile sheet, ALL debounce flags must reset —
  // previously a stale lock would block re-entry on a fast re-tap.
  if (wrap.id === 'sheet-me') {
    profileAvFiring = false;
    confirmPingFiring = false;
    emailFirstTapShown = false;
    document.getElementById('me-settings-dd')?.classList.remove('open');
    document.getElementById('me-email-confirm')?.remove();
  }
  // If ping confirm dismissed, revert to previous state
  if (wrap.id === 'sheet-ping-confirm' && profile && profile.status !== homeState) {
    homeState = profile.status || 'off';
    app.dataset.homeState = homeState;
    placeBall(SNAP[homeState], true);
    renderRoster();
  }
}
document.addEventListener('click', handleDismiss);
document.addEventListener('touchend', handleDismiss);

// Ping confirm buttons — handle both click and touchend for iOS
let confirmPingFiring = false; // debounce double-fire from touch+click
async function handleConfirmPing(e) {
  if (confirmPingFiring) return;
  if (e.type === 'touchend') e.preventDefault(); // prevent ghost click
  if (!getVenue()) {
    toast('pick a place first (or + add place)');
    return;
  }
  confirmPingFiring = true;
  document.getElementById('sheet-ping-confirm').classList.remove('open');
  const targetState = homeState; // 'down' or 'playing'
  if (targetState === 'down') downDur = 60;
  const ok = await setMyStatus(targetState);
  if (!ok) {
    homeState = profile?.status || 'off';
    app.dataset.homeState = homeState;
    placeBall(SNAP[homeState], true);
    renderRoster();
    confirmPingFiring = false;
    return;
  }
  renderHome();
  await fireStatusPings(targetState);
  confirmPingFiring = false;
}
document.getElementById('confirm-ping').addEventListener('click', handleConfirmPing);
document.getElementById('confirm-ping').addEventListener('touchend', handleConfirmPing);

/* ── BALL DRAG ── */
function placeBall(pct, smooth) {
  currentPct = pct;
  ball.classList.toggle('snapping', !!smooth);
  ball.style.left = pct + '%';
}

function pPct(e) {
  const r = courtWrap.getBoundingClientRect();
  return Math.max(4, Math.min(96, ((e.clientX - r.left) / r.width) * 100));
}

ball.addEventListener('pointerdown', e => {
  e.preventDefault(); dragging = true;
  try { ball.setPointerCapture(e.pointerId); } catch (_) {}
  ball.classList.add('dragging');
  ball.classList.remove('at-rest', 'snapping');
  // T6
});

window.addEventListener('pointermove', e => {
  if (!dragging) return;
  placeBall(pPct(e), false);
  lp.classList.toggle('ready', currentPct < 22);
  rp.classList.toggle('ready', currentPct > 78);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  ball.classList.remove('dragging');
  lp.classList.remove('ready'); rp.classList.remove('ready');
  let ns;
  if (currentPct < TH_L) ns = 'down';
  else if (currentPct > TH_R) ns = 'playing';
  else ns = 'off';
  snapTo(ns);
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

function snapTo(st) {
  placeBall(SNAP[st], true);
  if (st === 'down') flashP(lp);
  if (st === 'playing') flashP(rp);
  // T10: haptic bump on land
  if (navigator.vibrate) navigator.vibrate(10);
  // T10: squash-and-stretch on ball-core when it lands
  ball.classList.remove('landing');
  void ball.getBoundingClientRect();
  ball.classList.add('landing');
  setTimeout(() => ball.classList.remove('landing'), 500);
  setHomeState(st);
  setTimeout(() => { if (!dragging) ball.classList.add('at-rest'); }, 450);
}

function flashP(el) {
  el.classList.remove('bounce');
  void el.getBoundingClientRect();
  el.classList.add('bounce');
  setTimeout(() => el.classList.remove('bounce'), 520);
}

document.querySelectorAll('.c-lbl').forEach(b => {
  function handleLbl(e) { if (e.type === 'touchend') e.preventDefault(); snapTo(b.dataset.state); }
  b.addEventListener('click', handleLbl);
  b.addEventListener('touchend', handleLbl);
});
function handleLp(e) { if (e.type === 'touchend') e.preventDefault(); if (!dragging) { snapTo('down'); } }
function handleRp(e) { if (e.type === 'touchend') e.preventDefault(); if (!dragging) { snapTo('playing'); } }
lp.addEventListener('click', handleLp); lp.addEventListener('touchend', handleLp);
rp.addEventListener('click', handleRp); rp.addEventListener('touchend', handleRp);

/* ── T6: TOOLTIP ── */

/* ── STATE ── */
async function setHomeState(st) {
  if (!profile && st !== 'off') { showSetup(); placeBall(SNAP.off, true); return; }
  homeState = st;
  app.dataset.homeState = st;
  if (st === 'down') {
    renderVenuePicker();
    renderScenePicker();
    document.getElementById('sheet-ping-confirm').classList.add('open');
  } else if (st === 'playing') {
    renderVenuePicker();
    renderScenePicker();
    document.getElementById('sheet-ping-confirm').classList.add('open');
  } else {
    await setMyStatus(st);
  }
  renderStrip();
  renderRoster();
}

async function setMyStatus(st) {
  if (!profile) return false;
  // Clear any existing expiry / reminder timers
  if (downExpiryTimer) { clearTimeout(downExpiryTimer); downExpiryTimer = null; }
  if (downReminderTimer) { clearTimeout(downReminderTimer); downReminderTimer = null; }
  if (playingExpiryTimer) { clearTimeout(playingExpiryTimer); playingExpiryTimer = null; }

  const updates = { status: st, updated_at: new Date().toISOString() };
  if (st === 'playing') {
    updates.venue = getVenueName(); updates.started_at = new Date().toISOString(); updates.duration = 90;
    // Bump per-venue play_count so popular spots float to the top
    const vid = getVenueId();
    if (vid) sb.rpc('bump_venue_play', { p_venue: vid }).catch(() => {});
    // Increment play count for leaderboard
    sb.rpc('increment_play_count', { player_id: profile.id }).then(() => {
      profile.play_count = (profile.play_count || 0) + 1;
      const me = roster.find(r => r.id === profile.id);
      if (me) me.play_count = profile.play_count;
    }).catch(() => {});
    // 90-min auto-expire
    playingExpiryTimer = setTimeout(() => {
      toast('playing session expired after 90 min');
      snapTo('off');
    }, 90 * 60000);
  } else if (st === 'down') {
    updates.duration = downDur; updates.started_at = new Date().toISOString(); updates.venue = getVenueName();
    // Set exact expiry timer
    const expiryMs = downDur * 60000;
    downExpiryTimer = setTimeout(() => {
      toast('your down window expired');
      snapTo('off');
    }, expiryMs);
    // 5-minute warning (only if window > 10 min)
    const reminderMs = expiryMs - 5 * 60000;
    if (reminderMs > 60000) {
      downReminderTimer = setTimeout(() => {
        toast('5 min left on your down window');
        maybeNotify('5 minutes left — find your game!');
      }, reminderMs);
    }
  } else {
    updates.venue = null; updates.duration = null; updates.started_at = null;
  }
  const { data, error, count } = await sb.from('profiles').update(updates).eq('id', profile.id).select();
  if (error) { toast('update failed: ' + error.message); console.error(error); return false; }
  if (!data || data.length === 0) { toast('update missed — no rows matched'); console.error('No rows updated for id:', profile.id); return false; }
  Object.assign(profile, updates);
  const me = roster.find(r => r.id === profile.id);
  if (me) Object.assign(me, updates);
  if (st === 'playing') maybeBroadcastPlaying();
  return true;
}

/* ── RENDER HOME ── */
let renderHomeTimer = null;
function renderHome() {
  if (renderHomeTimer) return; // already scheduled
  renderHomeTimer = requestAnimationFrame(() => {
    renderHomeTimer = null;
    updateNotisBadge();
    updateProfileAv();
    updateLinkEmailDot();
    renderLiveZone();
    renderRoster();
    placeBall(SNAP[homeState], false);
    app.dataset.homeState = homeState;
    setTimeout(() => { if (!dragging) ball.classList.add('at-rest'); }, 100);
  });
}

function updateNotisBadge() {
  const u = pings.filter(p => p.unread).length;
  const badge = document.getElementById('notis-badge');
  if (badge) {
    badge.textContent = u;
    badge.style.display = u > 0 ? 'flex' : 'none';
  }
}

function updateProfileAv() {
  const av = document.getElementById('profile-av');
  // Preserve badge & dot spans
  const badge = document.getElementById('notis-badge');
  const dot = document.getElementById('link-email-dot');
  if (profile) {
    av.textContent = profile.name.slice(0, 1).toUpperCase() + profile.name.slice(1, 2).toUpperCase();
    av.style.background = profile.color || AV_COLORS[Math.abs(hash(profile.name)) % AV_COLORS.length];
  } else {
    av.textContent = '?'; av.style.background = '';
  }
  if (badge) av.appendChild(badge);
  if (dot) av.appendChild(dot);
}

function updateLinkEmailDot() {
  const dot = document.getElementById('link-email-dot');
  if (!dot) return;
  // Use cached state instead of async getSession call — prevents UI jank
  if (localStorage.getItem('pm_linked_email')) { dot.style.display = 'none'; return; }
  // If profile exists but no cached email, show the dot (anonymous user)
  dot.style.display = profile ? '' : 'none';
}

/* ── COURT TIMER — only for playing state ── */
function renderLiveZone() {
  const timer = document.getElementById('court-timer');
  if (homeState === 'playing') {
    const me = profile ? allRaiders().find(r => r.id === profile.id) : null;
    const mins = me && me.started_at ? Math.floor((Date.now() - new Date(me.started_at).getTime()) / 60000) : 0;
    timer.innerHTML =
      '<div class="ct-pill">' +
      '<span class="ct-dot"></span>' +
      'live &middot; ' + mins + 'm &middot; @ ' + esc(getVenueName()) +
      '</div>';
  } else {
    timer.innerHTML = '';
  }
}
function renderStrip() { renderLiveZone(); }

async function sendPushNotification(toId, fromId, msg) {
  if (!isPushAllowedHere()) {
    console.log('[pingme] push suppressed (non-prod host):', location.hostname, { toId, msg });
    return;
  }
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/send-push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUPABASE_ANON
      },
      body: JSON.stringify({ to_id: toId, from_id: fromId, msg }),
      keepalive: true
    });
    if (!res.ok) throw new Error(await res.text());
  } catch (e) { console.error('Push failed:', e); }
}

async function pingEveryone() {
  if (!profile) return false;
  if (!isPushAllowedHere()) {
    console.log('[pingme] pingEveryone suppressed (non-prod host):', location.hostname);
    toast('test mode — no pings sent');
    return false;
  }
  const now = Date.now();
  if (now - lastPingTime < PING_COOLDOWN) { toast('slow down — wait a sec'); return false; }
  lastPingTime = now;
  const others = roster.filter(r => r.id !== profile.id && r.name && r.name.trim() !== '' && r.name !== 'anon');
  const rows = others.map(r => ({
    from_id: profile.id, to_id: r.id,
    verb: 'is down to play',
    msg: profile.name + ' is down — you in?',
    unread: true
  }));
  if (rows.length) {
    await sb.from('pings').insert(rows);
  }
  return rows.length > 0;
}


/* ── T2: ALL RAIDERS ── */
function allRaiders() {
  return roster.filter(r => {
    if (profile && r.id === profile.id) return true;
    return r.name && r.name.trim() !== '' && r.name !== 'anon';
  });
}

/* ── ROSTER — T2, T3, T5 ── */
function renderRoster() {
  renderSceneScope();
  const emptyEl = document.getElementById('empty-roster');
  const playingList = document.getElementById('list-playing');
  const downList = document.getElementById('list-down');
  const offList = document.getElementById('list-off');
  const playingSection = document.getElementById('section-playing');
  const downSection = document.getElementById('section-down');
  const offSection = document.getElementById('section-off');

  const all = allRaiders();
  // Sort: you first in each group
  const meFirst = (a, b) => {
    const aMe = profile && a.id === profile.id ? -1 : 0;
    const bMe = profile && b.id === profile.id ? -1 : 0;
    return aMe - bMe;
  };
  const playing = all.filter(r => r.status === 'playing').sort(meFirst);
  const down = all.filter(r => r.status === 'down').sort(meFirst);
  const off = all.filter(r => r.status === 'off').sort(meFirst);


  if (all.length === 0) {
    playingList.innerHTML = ''; downList.innerHTML = ''; offList.innerHTML = '';
    playingSection.style.display = 'none';
    downSection.style.display = 'none';
    offSection.style.display = 'none';
    emptyEl.style.display = 'block';
    clearOffExpand();
    return;
  }
  emptyEl.style.display = 'none';

  function renderBubble(r) {
    const isMe = profile && r.id === profile.id;
    const ini = esc(r.ini || (r.name.slice(0, 1).toUpperCase() + r.name.slice(1, 2).toUpperCase()));
    let sub = '';
    if (r.status === 'playing') {
      const m = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000) : 0;
      sub = (r.venue ? esc(r.venue) + ' · ' : '') + m + 'm';
    } else if (r.status === 'down') {
      sub = (r.venue ? esc(r.venue) + ' · ' : '') + timeLeft(r) + ' left';
    } else {
      sub = '';
    }
    const displayName = (isMe && profile && profile.name && profile.name !== 'anon')
      ? profile.name : r.name;
    const stClass = r.status === 'off' ? 'bub-away' : 'bub-' + r.status;
    const refs = r.referral_count || 0;
    return '<button class="rbub ' + stClass + '" data-id="' + r.id + '">' +
      '<div class="rbub-av-wrap">' +
      '<div class="rbub-av" style="background:' + safeColor(r.color) + '">' + ini + '</div>' +
      (isMe ? '<span class="rbub-you">you</span>' : '') +
      (refs > 0 ? '<span class="rbub-refs">' + refs + '</span>' : '') +
      '</div>' +
      '<div class="rbub-name">' + esc(displayName) + '</div>' +
      (sub ? '<div class="rbub-sub">' + sub + '</div>' : '') +
      '</button>';
  }

  // Favorites pinned at top of roster
  const favIds = getFavorites();
  let favSection = document.getElementById('section-favorites');
  if (favIds.length > 0 && profile) {
    const favUsers = favIds.map(id => all.find(r => r.id === id)).filter(Boolean);
    if (favUsers.length > 0) {
      if (!favSection) {
        favSection = document.createElement('div');
        favSection.id = 'section-favorites';
        favSection.className = 'table-section';
        const sections = document.querySelector('.table-sections');
        sections.insertBefore(favSection, sections.firstChild);
      }
      favSection.innerHTML =
        '<div class="section-label fav-label"><span style="font-size:12px">&#9733;</span> favorites <span class="section-count">' + favUsers.length + '</span></div>' +
        '<div class="bub-grid">' + favUsers.map(renderBubble).join('') + '</div>';
      favSection.style.display = 'block';
    } else if (favSection) { favSection.style.display = 'none'; }
  } else if (favSection) { favSection.style.display = 'none'; }

  playingSection.style.display = playing.length ? 'block' : 'none';
  downSection.style.display = down.length ? 'block' : 'none';
  document.getElementById('count-playing').textContent = playing.length || '';
  document.getElementById('count-down').textContent = down.length || '';
  playingList.innerHTML = '<div class="bub-grid">' + playing.map(renderBubble).join('') + '</div>';
  downList.innerHTML = '<div class="bub-grid">' + down.map(renderBubble).join('') + '</div>';

  // Away players always visible but dimmed
  if (off.length > 0) {
    offSection.style.display = 'block';
    document.getElementById('count-off').textContent = off.length || '';
    offList.innerHTML = '<div class="bub-grid">' + off.map(renderBubble).join('') + '</div>';
  } else {
    offSection.style.display = 'none';
  }
  clearOffExpand();
  updateTableSub();
  renderLeaderboard();

}

let lbActiveTab = 'players';

function renderLeaderboard() {
  const list = document.getElementById('lb-list');
  if (!list) return;

  if (!FEATURES.matchTracking && lbActiveTab === 'elo') lbActiveTab = 'players';

  // Tab strip is optional — the rankings sheet has no #section-leaderboard,
  // it just renders whatever lbActiveTab says into #lb-list.
  const section = document.getElementById('section-leaderboard');
  if (section) {
    if (!FEATURES.matchTracking) {
      section.querySelectorAll('.lb-tab[data-tab="elo"]').forEach(t => t.style.display = 'none');
    }
    const tabs = section.querySelectorAll('.lb-tab');
    tabs.forEach(tab => {
      if (!tab._wired) {
        tab._wired = true;
        tab.addEventListener('click', () => {
          lbActiveTab = tab.dataset.tab;
          tabs.forEach(t => t.classList.toggle('lb-tab-active', t.dataset.tab === lbActiveTab));
          renderLeaderboardList();
        });
      }
    });
  }

  renderLeaderboardList();
}

function renderLeaderboardList() {
  const list = document.getElementById('lb-list');
  if (!list) return;

  const tab = lbActiveTab;
  // #3: dedupe by id (was name) — same name across accounts is fine, same id is the bug.
  const seen = new Map();
  let pool = allRaiders();
  // #10: gate to linked-email accounts when the flag is on. `email_verified` is set
  // server-side by the send-email edge function on OTP verify.
  if (FEATURES.leaderboardLinkedOnly) {
    pool = pool.filter(r => r.email_verified || (profile && r.id === profile.id && localStorage.getItem('pm_linked_email')));
  }
  pool
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    .forEach(r => { if (!seen.has(r.id)) seen.set(r.id, r); });
  const leaders = Array.from(seen.values())
    .sort((a, b) => {
      if (tab === 'players') return (b.play_count || 0) - (a.play_count || 0);
      if (tab === 'elo') return (b.elo || 1200) - (a.elo || 1200);
      return (b.referral_count || 0) - (a.referral_count || 0);
    })
    .slice(0, 10);

  if (leaders.length === 0) {
    list.innerHTML = '<div class="lb-empty">no one yet — be the first!</div>';
    return;
  }

  const medalSvg = (fill) => '<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="14" r="7" fill="' + fill + '" stroke="#141210" stroke-width="2"/><path d="M9 2h6l-1 7h-4L9 2z" fill="' + fill + '" stroke="#141210" stroke-width="1.5"/><circle cx="12" cy="14" r="3" fill="#F4EDDC" stroke="#141210" stroke-width="1.2"/></svg>';
  const medals = [medalSvg('#E8B84A'), medalSvg('#C0C0C0'), medalSvg('#CD7F32')];
  list.innerHTML = leaders.map((r, i) => {
    const ini = esc(r.name.slice(0, 1).toUpperCase() + r.name.slice(1, 2).toUpperCase());
    const isMe = profile && r.id === profile.id;
    const medal = i < 3 ? medals[i] : '<span class="lb-rank">' + (i + 1) + '</span>';
    let count, label;
    if (tab === 'players') { count = r.play_count || 0; label = count === 1 ? 'game' : 'games'; }
    else if (tab === 'elo') { count = r.elo || 1200; label = 'elo'; }
    else { count = r.referral_count || 0; label = 'invited'; }
    return '<div class="lb-row' + (isMe ? ' lb-me' : '') + '">' +
      '<span class="lb-medal">' + medal + '</span>' +
      '<div class="lb-av" style="background:' + safeColor(r.color) + '">' + ini + '</div>' +
      '<span class="lb-name">' + esc(r.name) + (isMe ? ' <span class="lb-you">(you)</span>' : '') + '</span>' +
      '<span class="lb-count">' + count + ' ' + label + '</span>' +
      '</div>';
  }).join('');
}
window.renderLeaderboard = renderLeaderboard;

function renderMyInviteCodes() {
  const wrap = document.getElementById('my-codes');
  if (!wrap) return;
  if (!profile) { wrap.innerHTML = '<div class="lb-empty">sign in to get your codes</div>'; return; }
  if (!myInviteCodes || myInviteCodes.length === 0) {
    wrap.innerHTML = '<div class="lb-empty">minting your codes…</div>';
    return;
  }
  const origin = location.origin;
  wrap.innerHTML = myInviteCodes.map(c => {
    const used = (c.use_count || 0) >= (c.max_uses || 1);
    const link = origin + '?code=' + c.code + '&ref=' + profile.id;
    return '<div class="my-code-row' + (used ? ' my-code-used' : '') + '">' +
      '<span class="my-code-val">' + esc(c.code) + '</span>' +
      (used
        ? '<span class="my-code-state">claimed</span>'
        : '<button class="my-code-copy" data-link="' + esc(link) + '" data-code="' + esc(c.code) + '">share</button>') +
      '</div>';
  }).join('');
  wrap.querySelectorAll('.my-code-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const link = btn.getAttribute('data-link');
      const code = btn.getAttribute('data-code');
      const text = "ping pong @ pingme — code " + code + " · " + link;
      if (navigator.share) {
        navigator.share({ title: 'pingme invite', text, url: link })
          .catch(() => { if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast('copied')); });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(() => toast('copied')).catch(() => toast('copy failed'));
      }
    });
  });
}
window.renderMyInviteCodes = renderMyInviteCodes;

// Descending elo ladder; everyone starts at 1200 ('rally regular').
const ELO_TIERS = [
  { min: 1450, name: 'table legend' },
  { min: 1300, name: 'spin doctor' },
  { min: 1150, name: 'rally regular' },
  { min: 1000, name: 'paddle prospect' },
  { min: -Infinity, name: 'garage tier' },
];

function renderEloSheet() {
  const big = document.getElementById('elo-big');
  if (!big) return;
  const me = profile ? (allRaiders().find(r => r.id === profile.id) || profile) : null;
  const elo = me && me.elo != null ? me.elo : 1200;
  const wins = (me && me.wins) || 0;
  const losses = (me && me.losses) || 0;
  const played = wins + losses;

  big.textContent = String(elo);

  const idx = ELO_TIERS.findIndex(t => elo >= t.min);
  const tier = ELO_TIERS[idx];
  const nextTier = idx > 0 ? ELO_TIERS[idx - 1] : null;
  const tierEl = document.getElementById('elo-tier');
  if (tierEl) tierEl.textContent = played === 0 ? 'unranked — log a match to place' : tier.name;

  const nextEl = document.getElementById('elo-next');
  const barWrap = document.getElementById('elo-bar-wrap');
  if (nextEl && barWrap) {
    if (played > 0 && nextTier) {
      const floor = isFinite(tier.min) ? tier.min : nextTier.min - 150;
      const pct = Math.max(0, Math.min(100, Math.round(((elo - floor) / (nextTier.min - floor)) * 100)));
      nextEl.textContent = (nextTier.min - elo) + ' to ' + nextTier.name;
      nextEl.style.display = '';
      barWrap.querySelector('span').style.width = pct + '%';
      barWrap.style.display = '';
    } else {
      nextEl.style.display = 'none';
      barWrap.style.display = 'none';
    }
  }

  const hist = document.getElementById('elo-hist');
  if (hist) {
    hist.innerHTML = played === 0
      ? '<div class="lb-empty">no matches yet — elo moves when you log games</div>'
      : '<div class="elo-hist-row">record: <b>' + wins + 'W &ndash; ' + losses + 'L</b> &middot; ' +
        Math.round((wins / played) * 100) + '% wins</div>';
  }
}

function getOrCreateOffExpand() {
  let el = document.getElementById('off-expand-link');
  if (!el) {
    el = document.createElement('div');
    el.id = 'off-expand-link';
    el.className = 'off-expand-wrap';
    document.getElementById('the-table').appendChild(el);
  }
  return el;
}
function clearOffExpand() {
  const el = document.getElementById('off-expand-link');
  if (el) el.innerHTML = '';
}

// Event delegation for roster bubble taps — wired once, not on every render
// Handle both click and touchend for iOS reliability
function handleBubbleTap(e) {
  const bub = e.target.closest('.rbub');
  if (!bub) return;
  if (e.type === 'touchend') e.preventDefault();
  const r = allRaiders().find(x => x.id === bub.dataset.id);
  if (r) openRaiderSheet(r);
}
document.querySelector('.table-sections').addEventListener('click', handleBubbleTap);
document.querySelector('.table-sections').addEventListener('touchend', handleBubbleTap);

function openRaiderSheet(r) {
  const modal = document.querySelector('#sheet-raider .modal-center');
  // Fetch phone on demand (not in roster for privacy)
  if (!r._phoneFetched && profile && r.id !== profile.id) {
    // #1: phone is no longer in the world-readable SELECT — fetch via RPC.
    sb.rpc('get_player_contact', { target_id: r.id }).then(({ data }) => {
      r.phone = data || null;
      r._phoneFetched = true;
      // Re-render msg button if sheet is still open
      const msgBtn = document.getElementById('rs-msg-btn');
      if (msgBtn && r.phone) {
        const a = document.createElement('a');
        a.className = 'rs-msg-btn';
        a.id = 'rs-msg-btn';
        a.href = 'sms:' + r.phone + '?body=' + encodeURIComponent((profile?.name || 'hey') + ' — down for ping pong?');
        a.innerHTML = '&#128172;';
        msgBtn.replaceWith(a);
      }
    });
  }
  const ini = esc(r.ini || r.name.slice(0, 2).toUpperCase());
  const isMe = profile && r.id === profile.id;
  const canAct = profile && !isMe;

  // Status info
  let statusText = '', statusClass = 'rs-away', contextLine = '';
  if (r.status === 'playing') {
    const m = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000) : 0;
    statusText = 'playing';
    statusClass = 'rs-playing';
    contextLine = 'at ' + esc(r.venue || getVenueName()) + ' \u00b7 ' + m + ' min in';
  } else if (r.status === 'down') {
    statusText = 'down to play';
    statusClass = 'rs-down';
    contextLine = timeLeft(r) + ' left on their window';
  } else {
    statusText = 'away';
    statusClass = 'rs-away';
    const ago = r.updated_at ? timeAgo(r.updated_at) : '';
    contextLine = ago ? 'last seen ' + ago : '';
  }

  // Build the modal content
  let html =
    // Top row: avatar + name + status
    '<div class="rs-top">' +
    '<div class="rs-av" style="background:' + safeColor(r.color) + '">' + ini + '</div>' +
    '<div class="rs-info">' +
    '<div class="rs-name">' + esc(r.name) + (isMe ? ' <span class="rs-you">you</span>' : '') + '</div>' +
    '<div class="rs-status ' + statusClass + '"><span class="rs-dot"></span>' + statusText + '</div>' +
    '</div>' +
    '</div>';

  // Context line
  if (contextLine) {
    html += '<div class="rs-context">' + contextLine + '</div>';
  }

  // Ambient / activity
  if (r.ambient) {
    html += '<div class="rs-ambient">' + esc(r.ambient) + '</div>';
  }

  // Action buttons — ping is primary, favorite (star) is the only secondary.
  // Challenge removed: ping covers "want to play". Star color flips boldly so
  // it's obvious whether you've favorited this player.
  if (canAct) {
    const showInvite = r.status === 'down';
    const favOn = isFavorite(r.id);
    // Star colors flip boldly: mustard fill when favorited, outline-only ink when not.
    const starFill = favOn ? '#E8B84A' : 'none';
    const starStroke = favOn ? '#141210' : '#141210';
    // Ping button uses the hand-drawn send icon. Single "Ping" word — challenge variant removed.
    html +=
      '<div class="rs-actions">' +
      '<button class="rs-ping-btn" id="rs-ping-btn">' +
        '<svg class="rs-ping-ic" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" filter="url(#wobble)" width="18" height="18">' +
          '<path d="M34 6 L4 17.5 L17 21.5 L21 33 Z"/><path d="M17 21.5 L34 6"/>' +
        '</svg> Ping' +
      '</button>' +
      '<button class="rs-msg-btn ' + (favOn ? 'rs-fav-on' : '') + '" id="rs-fav-icon" title="favorite" aria-pressed="' + favOn + '">' +
        '<svg viewBox="0 0 40 40" filter="url(#wobble)" width="24" height="24">' +
          '<path d="M20 6 L24 16 L34.5 16.5 L26.5 23.5 L29 33.5 L20 27.5 L11 33.5 L13.5 23.5 L5.5 16.5 L16 16 Z" ' +
          'fill="' + starFill + '" stroke="' + starStroke + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
      '</button>' +
      '</div>' +
      (showInvite ? '<button class="rs-challenge-btn" id="rs-invite-venue-btn" style="background:var(--cobalt);color:#F4EDDC">down to play at…</button>' : '');
  }

  modal.innerHTML = '<button class="modal-close" data-dismiss>&times;</button>' + html;

  // Wire actions
  if (canAct) {
    // Favorite toggle
    const favIcon = document.getElementById('rs-fav-icon');
    if (favIcon) {
      favIcon.onclick = () => {
        const added = toggleFavorite(r.id);
        favIcon.classList.toggle('rs-fav-on', added);
        const star = favIcon.querySelector('path');
        if (star) {
          star.setAttribute('fill', added ? '#E8B84A' : 'none');
          star.setAttribute('stroke', '#141210');
        }
        favIcon.setAttribute('aria-pressed', added ? 'true' : 'false');
        toast(added ? r.name + ' favorited' : r.name + ' unfavorited');
      };
    }

    // Ping
    document.getElementById('rs-ping-btn').onclick = async () => {
      const now = Date.now();
      if (now - lastPingTime < PING_COOLDOWN) { toast('slow down \u2014 wait a sec'); return; }
      lastPingTime = now;
      const btn = document.getElementById('rs-ping-btn');
      const prevHtml = btn.innerHTML; // our own static markup \u2014 safe to restore
      btn.disabled = true;
      btn.textContent = 'sending\u2026';
      const pingMsg = profile.name + ' pinged you!';
      let error = null;
      try {
        ({ error } = await sb.from('pings').insert({
          from_id: profile.id, to_id: r.id,
          verb: 'wants to play',
          msg: pingMsg,
          unread: true
        }) || {});
      } catch (e) { error = e; }
      if (error) {
        lastPingTime = 0; // a failed send shouldn't burn the cooldown
        btn.disabled = false;
        btn.innerHTML = prevHtml;
        toast('ping failed \u2014 try again');
        return;
      }
      btn.disabled = false;
      btn.textContent = 'sent!';
      btn.classList.add('rs-ping-sent');
      // Push notification handled server-side via DB webhook on ping insert
      setTimeout(() => {
        document.getElementById('sheet-raider').classList.remove('open');
      }, 800);
    };

    // (Challenge button removed — ping is the single primary action.)

    // Invite to a venue (handshake) — only when target is down
    const invBtn = document.getElementById('rs-invite-venue-btn');
    if (invBtn) {
      invBtn.onclick = () => {
        document.getElementById('sheet-raider').classList.remove('open');
        openInviteToVenue(r);
      };
    }
  }

  document.getElementById('sheet-raider').classList.add('open');
}

/* ── INVITE TO VENUE (handshake) ──
   target is a roster row in 'down' state. We pick a venue + optional note,
   then drop a ping with verb='down to play at' so the receiver sees
   accept/decline in their notis. */
function openInviteToVenue(target) {
  if (!profile) { toast('sign in first'); return; }
  let el = document.getElementById('sheet-invite-venue');
  if (!el) {
    el = document.createElement('div');
    el.className = 'sheet-wrap';
    el.id = 'sheet-invite-venue';
    el.innerHTML =
      '<div class="sheet-scrim" data-dismiss></div>' +
      '<div class="modal-center">' +
        '<button class="modal-close" data-dismiss>&times;</button>' +
        '<h3 id="iv-title">down to play?</h3>' +
        '<div class="ping-confirm-sub" id="iv-sub">pick a spot — they get to accept or pass</div>' +
        '<div class="venue-picker" id="venue-picker"></div>' +
        '<input class="av-input" id="iv-note" maxlength="120" placeholder="add a note (optional) — e.g. anytime after 6pm"/>' +
        '<button class="ping-confirm-btn" id="iv-send">send invite</button>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelectorAll('[data-dismiss]').forEach(d =>
      d.addEventListener('click', () => el.classList.remove('open'))
    );
  }
  el.querySelector('#iv-title').textContent = 'invite ' + target.name + ' to play';
  el.querySelector('#iv-note').value = '';
  renderVenuePicker();
  el.classList.add('open');

  el.querySelector('#iv-send').onclick = async () => {
    const venue = getVenue();
    if (!venue) { toast('pick a place first'); return; }
    const note = el.querySelector('#iv-note').value.trim();
    const btn = el.querySelector('#iv-send');
    btn.disabled = true; btn.textContent = 'sending…';
    const msg = (profile.name || 'someone') + ' is down to play at ' + venue.name +
                (note ? ' — ' + note : '');
    const { error } = await sb.from('pings').insert({
      from_id: profile.id,
      to_id: target.id,
      verb: 'down to play at',
      msg: msg + '␟' + venue.id, // separator-encoded venue id for accept handler
      unread: true
    });
    btn.disabled = false; btn.textContent = 'send invite';
    if (error) { toast('send failed: ' + error.message); return; }
    el.classList.remove('open');
    toast('invite sent to ' + target.name);
  };
}

/* ── FRIENDS ──
   Persistent mutual friend graph (friendships table, list_friendships RPC).
   The sheet has three tabs: friends (multi-select → group "ping to play"),
   requests (accept / pass), add (search by name, scoped to my scene). */
let friends = [];            // [{ other_id, name, color, school (scene slug mirror), status, incoming, created_at }]
let frTab = 'friends';
let frSelected = new Set();  // other_ids picked for a group ping
let frSearchAll = false;     // add tab: search across all scenes
let frResults = [];
let frResultState = {};      // other_id → 'pending' | 'accepted' after tapping add
const FRIEND_PING_DEFAULT = 'hey i want to play';
const FRIEND_BROADCAST_WINDOW_MS = 60 * 60000; // mirrors broadcast_playing() server throttle

function friendIds() {
  const s = new Set();
  friends.forEach(f => { if (f.status === 'accepted') s.add(f.other_id); });
  return s;
}
function isFriend(id) { return friendIds().has(id); }

async function loadFriends() {
  if (!profile || !sb) { friends = []; return; }
  try {
    const { data, error } = await sb.rpc('list_friendships') || {};
    if (error) { console.warn('list_friendships:', error.message); return; }
    if (Array.isArray(data)) friends = data;
  } catch (e) { console.warn('list_friendships throw:', e); }
}

function ensureFriendsSheet() {
  let el = document.getElementById('sheet-friends');
  if (el) return el;
  el = document.createElement('div');
  el.className = 'sheet-wrap';
  el.id = 'sheet-friends';
  el.innerHTML =
    '<div class="sheet-scrim" data-dismiss></div>' +
    '<div class="modal-center modal-tall">' +
      '<button class="modal-close" data-dismiss>&times;</button>' +
      '<h3>friends</h3>' +
      '<div class="fr-tabs">' +
        '<button class="fr-tab" id="fr-tab-friends" data-tab="friends" type="button">friends</button>' +
        '<button class="fr-tab" id="fr-tab-requests" data-tab="requests" type="button">requests<span class="fr-tab-badge" id="fr-req-badge" style="display:none"></span></button>' +
        '<button class="fr-tab" id="fr-tab-add" data-tab="add" type="button">add</button>' +
      '</div>' +
      '<div class="fr-pane" id="fr-pane-friends">' +
        '<div class="ping-confirm-sub">tap friends, then ping them all at once</div>' +
        '<div class="fr-list" id="fr-list"></div>' +
        '<input class="av-input" id="fr-line" maxlength="120" placeholder="' + FRIEND_PING_DEFAULT + '"/>' +
        '<button class="ping-confirm-btn" id="fr-ping" type="button">pick friends to ping</button>' +
        '<button class="me-dd-item fr-bcast" id="fr-bcast" type="button">' +
          '<span class="tog-switch"><span class="knob"></span></span> tell friends when i start playing' +
        '</button>' +
      '</div>' +
      '<div class="fr-pane" id="fr-pane-requests"><div class="fr-list" id="fr-requests"></div></div>' +
      '<div class="fr-pane" id="fr-pane-add">' +
        '<input class="av-input" id="fr-search" placeholder="search by name" autocomplete="off"/>' +
        '<button class="fr-scope" id="fr-scope" type="button"></button>' +
        '<div class="fr-list" id="fr-results"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  el.querySelectorAll('[data-dismiss]').forEach(d =>
    d.addEventListener('click', () => el.classList.remove('open'))
  );
  el.querySelectorAll('.fr-tab').forEach(b =>
    b.addEventListener('click', () => { frTab = b.dataset.tab; renderFriendsSheet(); })
  );
  el.querySelector('#fr-ping').addEventListener('click', sendFriendPing);
  el.querySelector('#fr-bcast').addEventListener('click', () => {
    const on = localStorage.getItem('pm_bcast_friends') === '1';
    localStorage.setItem('pm_bcast_friends', on ? '' : '1');
    renderFriendsSheet();
    toast(on ? 'friends won\'t be told when you play' : 'friends get a ping when you start playing');
  });
  let searchTimer = null;
  el.querySelector('#fr-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runFriendSearch, 250);
  });
  el.querySelector('#fr-scope').addEventListener('click', () => {
    frSearchAll = !frSearchAll;
    renderFriendsSheet();
    runFriendSearch();
  });
  // friends tab: avatar → profile, row → toggle selection
  el.querySelector('#fr-list').addEventListener('click', e => {
    const row = e.target.closest('.fr-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.fr-av')) {
      const f = friends.find(x => x.other_id === id);
      el.classList.remove('open');
      openRaiderSheet(roster.find(r => r.id === id) ||
        { id, name: (f && f.name) || '?', color: f && f.color, status: 'off' });
      return;
    }
    if (frSelected.has(id)) frSelected.delete(id); else frSelected.add(id);
    renderFriendsSheet();
  });
  el.querySelector('#fr-requests').addEventListener('click', e => {
    const btn = e.target.closest('.fr-accept, .fr-decline');
    if (!btn) return;
    respondFriendRequest(btn.dataset.id, btn.classList.contains('fr-accept'), btn);
  });
  el.querySelector('#fr-results').addEventListener('click', e => {
    const btn = e.target.closest('.fr-add');
    if (btn) sendFriendRequest(btn.dataset.id, btn);
  });
  return el;
}

function frRow(f, o) {
  o = o || {};
  const id = f.other_id || f.id;
  const ini = esc((f.name || '??').slice(0, 2).toUpperCase());
  const scene = f.school ? '<span class="fr-scene">' + esc(sceneName(f.school)) + '</span>' : '';
  return '<div class="fr-row lb-row' + (o.selected ? ' fr-selected' : '') + '" data-id="' + esc(id) + '">' +
    (o.check ? '<span class="fr-check">' + (o.selected ? '&#10003;' : '') + '</span>' : '') +
    '<button class="lb-av fr-av" type="button" style="background:' + safeColor(f.color) + '" title="view profile">' + ini + '</button>' +
    '<span class="lb-name fr-name">' + esc(f.name || '?') + scene + '</span>' +
    (o.meta ? '<span class="fr-meta">' + esc(o.meta) + '</span>' : '') +
    (o.actions || '') +
    '</div>';
}

function renderFriendsSheet() {
  const el = document.getElementById('sheet-friends');
  if (!el) return;
  el.querySelectorAll('.fr-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === frTab));
  el.querySelectorAll('.fr-pane').forEach(p => { p.style.display = p.id === 'fr-pane-' + frTab ? '' : 'none'; });

  const accepted = friends.filter(f => f.status === 'accepted');
  const incoming = friends.filter(f => f.status === 'pending' && f.incoming);
  const outgoing = friends.filter(f => f.status === 'pending' && !f.incoming);

  const badge = el.querySelector('#fr-req-badge');
  badge.textContent = incoming.length;
  badge.style.display = incoming.length ? '' : 'none';

  // drop selections that are no longer friends
  [...frSelected].forEach(id => { if (!accepted.some(f => f.other_id === id)) frSelected.delete(id); });

  el.querySelector('#fr-list').innerHTML = accepted.length
    ? accepted.map(f => frRow(f, { check: true, selected: frSelected.has(f.other_id) })).join('')
    : '<div class="fr-empty">no friends yet — find people in the add tab</div>';
  const n = frSelected.size;
  const pingBtn = el.querySelector('#fr-ping');
  if (!pingBtn.classList.contains('rs-ping-sent')) {
    pingBtn.textContent = n ? 'ping ' + n + ' friend' + (n === 1 ? '' : 's') : 'pick friends to ping';
  }
  pingBtn.classList.toggle('fr-ping-idle', !n);
  el.querySelector('#fr-bcast .tog-switch').classList.toggle('on', localStorage.getItem('pm_bcast_friends') === '1');

  const reqHtml =
    incoming.map(f => frRow(f, { actions:
      '<span class="ping-actions fr-req-actions">' +
      '<button class="pa-btn primary fr-accept" type="button" data-id="' + esc(f.other_id) + '">accept</button>' +
      '<button class="pa-btn fr-decline" type="button" data-id="' + esc(f.other_id) + '">pass</button>' +
      '</span>' })).join('') +
    outgoing.map(f => frRow(f, { meta: 'sent' })).join('');
  el.querySelector('#fr-requests').innerHTML = reqHtml || '<div class="fr-empty">no requests right now</div>';

  const scope = el.querySelector('#fr-scope');
  if (profile && profile.school) {
    scope.style.display = '';
    scope.textContent = frSearchAll
      ? 'searching all scenes · tap for ' + sceneName(profile.school)
      : 'searching ' + sceneName(profile.school) + ' · tap for all scenes';
  } else {
    scope.style.display = 'none';
  }
  renderFriendResults();
}

function renderFriendResults() {
  const box = document.getElementById('fr-results');
  if (!box) return;
  const q = (document.getElementById('fr-search') || {}).value || '';
  if (!q.trim()) { box.innerHTML = ''; return; }
  box.innerHTML = frResults.length
    ? frResults.map(r => {
        const f = friends.find(x => x.other_id === r.id);
        const st = frResultState[r.id] || (f && f.status) || null;
        let action;
        if (st === 'accepted') action = '<span class="fr-meta">friends</span>';
        else if (st === 'pending' || st === 'blocked') action = '<span class="fr-meta">sent</span>';
        else action = '<button class="pa-btn primary fr-add" type="button" data-id="' + esc(r.id) + '">add</button>';
        return frRow({ other_id: r.id, name: r.name, color: r.color, school: r.school }, { actions: action });
      }).join('')
    : '<div class="fr-empty">no one found</div>';
}

async function openFriendsSheet(tab) {
  if (!profile) { toast('sign in first'); return; }
  const el = ensureFriendsSheet();
  frTab = tab || 'friends';
  el.querySelector('#fr-ping').classList.remove('rs-ping-sent');
  renderFriendsSheet();
  el.classList.add('open');
  await loadFriends();
  renderFriendsSheet();
}

async function runFriendSearch() {
  const el = document.getElementById('sheet-friends');
  if (!el || !profile) return;
  const q = el.querySelector('#fr-search').value.trim();
  if (!q) { frResults = []; renderFriendResults(); return; }
  const p_school = (!frSearchAll && profile.school) ? profile.school : null;
  let data = null, error = null;
  try { ({ data, error } = await sb.rpc('search_players', { p_q: q, p_school, p_limit: 20 }) || {}); }
  catch (e) { error = e; }
  if (error) { toast('search failed — try again'); return; }
  frResults = (Array.isArray(data) ? data : []).filter(r => r.id !== profile.id);
  renderFriendResults();
}

async function sendFriendRequest(id, btn) {
  if (!profile || !id) return;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  let data = null, error = null;
  try { ({ data, error } = await sb.rpc('send_friend_request', { p_target: id }) || {}); }
  catch (e) { error = e; }
  if (error) {
    if (btn) { btn.disabled = false; btn.textContent = 'add'; }
    toast('request failed — ' + (error.message || 'try again'));
    return;
  }
  frResultState[id] = data === 'accepted' ? 'accepted' : 'pending';
  toast(data === 'accepted' ? 'you\'re friends now!' : 'friend request sent');
  renderFriendResults();
  await loadFriends();
  renderFriendsSheet();
}

async function respondFriendRequest(id, accept, btn) {
  if (!profile || !id) return;
  if (btn) btn.disabled = true;
  let error = null;
  try { ({ error } = await sb.rpc('respond_friend_request', { p_from: id, p_accept: !!accept }) || {}); }
  catch (e) { error = e; }
  if (error) {
    if (btn) btn.disabled = false;
    toast('failed — ' + (error.message || 'try again'));
    return;
  }
  const f = friends.find(x => x.other_id === id);
  toast(accept ? ('you and ' + ((f && f.name) || 'them') + ' are friends now') : 'request passed');
  await loadFriends();
  renderFriendsSheet();
  if (accept) { roster = scopeRoster(rosterRaw.length ? rosterRaw : roster); renderHome(); }
}

// Group ping: one RPC → one batch insert on the server (friends only).
async function sendFriendPing() {
  if (!profile) { toast('sign in first'); return; }
  const el = document.getElementById('sheet-friends');
  if (!el) return;
  const btn = el.querySelector('#fr-ping');
  const ids = [...frSelected];
  if (!ids.length) { toast('pick a friend first'); return; }
  const now = Date.now();
  if (now - lastPingTime < PING_COOLDOWN) { toast('slow down — wait a sec'); return; }
  lastPingTime = now;
  const line = (el.querySelector('#fr-line').value || '').trim().slice(0, 120) || FRIEND_PING_DEFAULT;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'sending…';
  let data = null, error = null;
  try { ({ data, error } = await sb.rpc('ping_friends', { p_to: ids, p_msg: line }) || {}); }
  catch (e) { error = e; }
  btn.disabled = false;
  if (error) {
    lastPingTime = 0; // a failed send shouldn't burn the cooldown
    btn.textContent = prev;
    toast('ping failed — ' + (error.message || 'try again'));
    return;
  }
  const sent = typeof data === 'number' ? data : ids.length;
  btn.textContent = 'sent to ' + sent + '!';
  btn.classList.add('rs-ping-sent');
  frSelected.clear();
  setTimeout(() => {
    btn.classList.remove('rs-ping-sent');
    renderFriendsSheet();
  }, 1500);
}

// "I'm playing" fan-out to every accepted friend. Opt-in toggle in the friends
// sheet; throttled client-side (and again server-side) to once per hour.
async function maybeBroadcastPlaying() {
  if (!profile || !sb) return;
  if (localStorage.getItem('pm_bcast_friends') !== '1') return;
  const last = parseInt(localStorage.getItem('pm_bcast_last') || '0', 10) || 0;
  if (Date.now() - last < FRIEND_BROADCAST_WINDOW_MS) return;
  localStorage.setItem('pm_bcast_last', String(Date.now()));
  try {
    const { data, error } = await sb.rpc('broadcast_playing') || {};
    if (error) {
      console.warn('broadcast_playing:', error.message);
      localStorage.setItem('pm_bcast_last', String(last)); // let the next attempt retry
      return;
    }
    if (typeof data === 'number' && data > 0) {
      toast('told ' + data + ' friend' + (data === 1 ? '' : 's') + ' you\'re playing');
    }
  } catch (e) { console.warn('broadcast_playing throw:', e); }
}

/* ── SCENES (place-anchored notification groups) ──
   A scene is a place people play at ("Zilker Park Pickleball", "TTU Rec
   Center"). Users join any number of scenes; pinging from a scene notifies its
   members. Rows come from list_scenes (visibility + my membership flags baked
   in); SCENES_BUILTIN keeps onboarding usable if that read fails.
   profiles.school is the DB's mirror of my most recently joined scene — a
   one-release alias column, read here only as a fallback before scenes load. */
const SCENES_BUILTIN = [
  { id: null, slug: 'ttu', display_name: 'Texas Tech University', activity: null, city: 'lubbock', color: '#CC0000', pending: false, member_count: 0, joined: false, notifications_enabled: true, pings_24h: 0, near_rank: null }
];
let SCENES = [];
let sceneMemberIds = new Set();   // user ids across the scenes I'm in (scene_members under RLS)
let rosterRaw = [];
let browseAllScenes = localStorage.getItem('pm_browse_all') === '1';
let selectedScene = null;         // slug picked in the ping confirm modal (null = everyone / legacy open ping)

function sceneRows() { return SCENES.length ? SCENES : SCENES_BUILTIN; }
function sortScenes(list) {
  return list.slice().sort((a, b) =>
    ((a.near_rank == null ? 9 : a.near_rank) - (b.near_rank == null ? 9 : b.near_rank)) ||
    ((b.member_count || 0) - (a.member_count || 0)) ||
    String(a.display_name || '').localeCompare(String(b.display_name || '')));
}
// Picker: approved scenes only, nearest first (when a zip is known), then biggest.
function sceneList() {
  const approved = sceneRows().filter(s => !s.pending);
  return sortScenes(approved.length ? approved : SCENES_BUILTIN);
}
function sceneBySlug(slug) { return sceneRows().find(x => x.slug === slug) || null; }
function sceneName(slug) { const s = sceneBySlug(slug); return s ? s.display_name : (slug || ''); }
function sceneNameById(id) { const s = id ? SCENES.find(x => x.id === id) : null; return s ? s.display_name : ''; }
function scenePending(slug) { const s = SCENES.find(x => x.slug === slug); return !!(s && s.pending); }
function sceneStamp(s) { return Date.parse(s.last_ping_at || s.joined_at || 0) || 0; }
// Scenes I'm in, most recent activity first.
function myScenes() { return SCENES.filter(s => s.joined).sort((a, b) => sceneStamp(b) - sceneStamp(a)); }
// Slugs I belong to. Before list_scenes resolves, the profiles.school mirror
// stands in so the roster is scoped from the first render.
function mySceneSlugs() {
  const joined = myScenes().map(s => s.slug);
  if (joined.length) return joined;
  return (profile && profile.school) ? [profile.school] : [];
}
// Settings-menu label (HTML): name + dim "pending" badge, or a count.
function sceneLabel() {
  const mine = mySceneSlugs();
  if (!mine.length) return 'none — find your scene';
  if (mine.length > 1) return mine.length + ' scenes';
  return esc(sceneName(mine[0])) + (scenePending(mine[0]) ? ' <span class="scene-pending-badge">pending</span>' : '');
}
function sceneZip() { try { return localStorage.getItem('pm_zip') || null; } catch { return null; } }

async function loadScenes(zip) {
  if (!sb) return;
  const p_zip = zip || sceneZip();
  try {
    const { data, error } = await sb.rpc('list_scenes', { p_zip }) || {};
    if (!error && Array.isArray(data) && data.length) SCENES = data;
  } catch (e) { console.warn('scenes load failed:', e); }
  if (profile) {
    try {
      const { data, error } = await sb.from('scene_members').select('user_id') || {};
      if (!error && Array.isArray(data)) sceneMemberIds = new Set(data.map(r => r.user_id));
    } catch (e) { console.warn('scene members load failed:', e); }
  }
  if (rosterRaw.length) { roster = scopeRoster(rosterRaw); renderHome(); }
}

// ?scene=zilker-park-pickleball on a landing/share link (legacy ?school= links
// still land). Stashed in localStorage so it survives the email sign-in round
// trip and lands as the onboarding default.
function getSceneParam() {
  let s = null;
  try { const q = new URLSearchParams(location.search); s = q.get('scene') || q.get('school'); } catch {}
  s = (s || '').trim().toLowerCase();
  if (s) {
    try { localStorage.setItem('pm_scene_hint', s); } catch {}
    return s;
  }
  try { return localStorage.getItem('pm_scene_hint') || null; } catch { return null; }
}
function clearSceneParam() {
  try { localStorage.removeItem('pm_scene_hint'); } catch {}
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('scene') || u.searchParams.has('school')) {
      u.searchParams.delete('scene');
      u.searchParams.delete('school');
      history.replaceState(null, '', u.pathname + (u.search || ''));
    }
  } catch {}
}

// Roster scope: members of my scenes (by membership id, or by their mirrored
// slug), city as fallback for scene-less rows. Self and accepted friends
// always pass (the friend graph ignores scenes). The "everyone" toggle shows all.
function scopeRoster(rows) {
  if (browseAllScenes) return rows;
  const mine = new Set(mySceneSlugs().map(s => String(s).toLowerCase()));
  if (!mine.size) return scopeRosterToCity(rows);
  const fids = friendIds();
  return rows.filter(r => {
    if (profile && r.id === profile.id) return true;
    if (fids.has(r.id)) return true;
    if (sceneMemberIds.has(r.id)) return true;
    const s = (r.school || '').toLowerCase();
    if (s) return mine.has(s);
    return scopeRosterToCity([r]).length > 0;
  });
}

function sceneScopeName() {
  const mine = mySceneSlugs();
  return mine.length === 1 ? sceneName(mine[0]) : 'my scenes';
}
function renderSceneScope() {
  const btn = document.getElementById('scene-scope');
  if (!btn) return;
  if (!profile || !mySceneSlugs().length) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.textContent = browseAllScenes ? 'everyone' : sceneScopeName();
  btn.classList.toggle('active', !browseAllScenes);
  btn.title = browseAllScenes ? 'tap to see only ' + sceneScopeName() : 'tap to see everyone';
}
function toggleSceneScope() {
  if (!profile || !mySceneSlugs().length) return;
  browseAllScenes = !browseAllScenes;
  localStorage.setItem('pm_browse_all', browseAllScenes ? '1' : '');
  roster = scopeRoster(rosterRaw.length ? rosterRaw : roster);
  renderSceneScope();
  renderHome();
  toast(browseAllScenes ? 'showing everyone' : 'back to ' + sceneScopeName());
}
(function () {
  const btn = document.getElementById('scene-scope');
  if (btn) btn.addEventListener('click', toggleSceneScope);
})();

// Membership changed on the server → mirror it locally, including the
// profiles.school mirror the way _pm_sync_primary_scene does (latest join wins).
function markSceneJoined(slug, joined) {
  const s = SCENES.find(x => x.slug === slug);
  if (s) {
    if (joined && !s.joined) s.member_count = (s.member_count || 0) + 1;
    if (!joined && s.joined) s.member_count = Math.max(0, (s.member_count || 0) - 1);
    s.joined = joined;
    s.joined_at = joined ? new Date().toISOString() : null;
    if (!joined) s.notifications_enabled = true;
  }
  if (!profile) return;
  let mirror = null;
  if (joined) mirror = slug;
  else {
    const byJoin = SCENES.filter(x => x.joined).sort((a, b) => (Date.parse(b.joined_at || 0) || 0) - (Date.parse(a.joined_at || 0) || 0));
    mirror = byJoin.length ? byJoin[0].slug : null;
  }
  profile.school = mirror;
  const me = roster.find(r => r.id === profile.id);
  if (me) me.school = mirror;
  if (joined) sceneMemberIds.add(profile.id);
  localStorage.setItem('pm_scene_prompted', '1');
}

async function joinScene(slug) {
  if (!profile) { toast('sign in first'); return false; }
  let error = null;
  try { ({ error } = await sb.rpc('join_scene', { p_slug: slug }) || {}); }
  catch (e) { error = e; }
  if (error) { toast('couldn’t join — ' + (error.message || 'try again')); return false; }
  markSceneJoined(slug, true);
  clearSceneParam();
  return true;
}
async function leaveScene(slug) {
  if (!profile) return false;
  let error = null;
  try { ({ error } = await sb.rpc('leave_scene', { p_slug: slug }) || {}); }
  catch (e) { error = e; }
  if (error) { toast('couldn’t leave — ' + (error.message || 'try again')); return false; }
  markSceneJoined(slug, false);
  return true;
}
async function setSceneMute(slug, enabled) {
  const s = SCENES.find(x => x.slug === slug);
  const prev = s ? s.notifications_enabled : true;
  if (s) s.notifications_enabled = enabled;
  let error = null;
  try { ({ error } = await sb.rpc('set_scene_notifications', { p_slug: slug, p_enabled: enabled }) || {}); }
  catch (e) { error = e; }
  if (error) {
    if (s) s.notifications_enabled = prev;
    toast('couldn’t update — ' + (error.message || 'try again'));
    return false;
  }
  return true;
}

function matchesScene(s, q) {
  return [s.display_name, s.slug, s.city, s.activity, s.place_hint].some(v => v && String(v).toLowerCase().includes(q));
}
function sceneMeta(s, extra) {
  return [s.activity, s.city, (s.near_rank != null && s.near_rank <= 1) ? 'near you' : null].concat(extra || []).filter(Boolean).join(' · ');
}
function sceneOptHtml(s, primary) {
  const meta = sceneMeta(s);
  return '<button class="scene-opt' + (primary ? ' primary' : '') + '" type="button" data-slug="' + esc(s.slug) +
    '" style="--scene:' + safeColor(s.color) + '"><span class="scene-dot"></span>' +
    '<span class="scene-opt-text"><span class="scene-opt-name">' + esc(s.display_name) + '</span>' +
    (meta ? '<span class="scene-meta">' + esc(meta) + '</span>' : '') + '</span>' +
    '<span class="scene-count" title="members">' + (s.member_count || 0) + '</span></button>';
}

// "don't see it? + create a scene": create_scene creates a pending row (or
// joins the existing slug) and joins the caller server-side, so people
// creating the same place are grouped before it goes live at 3 members.
// Errors stay inline next to the form; nothing throws.
function sceneCreateHtml() {
  return '<div class="scene-create-row">' +
    '<button class="scene-opt scene-other" id="s-scene-create" type="button">don’t see it? + create a scene</button>' +
    '<div id="s-scene-create-wrap" hidden>' +
      '<input class="av-input" id="s-scene-name" type="text" maxlength="80" placeholder="scene name — e.g. Zilker Park Pickleball" autocomplete="off"/>' +
      '<input class="av-input" id="s-scene-activity" type="text" maxlength="32" placeholder="activity (optional) — pickleball, basketball, ping-pong" autocomplete="off" list="scene-activities"/>' +
      '<datalist id="scene-activities"><option value="pickleball"></option><option value="basketball"></option><option value="ping-pong"></option><option value="tennis"></option><option value="general"></option></datalist>' +
      '<input class="av-input" id="s-scene-place" type="text" maxlength="120" placeholder="where (optional) — Zilker Park, Austin TX" autocomplete="off"/>' +
      '<input class="av-input" id="s-scene-zip" type="text" inputmode="numeric" maxlength="5" placeholder="zip (optional)" autocomplete="postal-code"/>' +
      '<div class="scene-create-error" id="s-scene-error"></div>' +
      '<button class="scene-opt primary" id="s-scene-submit" type="button">create scene</button>' +
      '<div class="scene-create-hint">you’re in right away — it shows to everyone once 3 people join</div>' +
    '</div>' +
  '</div>';
}
function wireSceneCreate(box, opts) {
  const btn = box.querySelector('#s-scene-create');
  const wrap = box.querySelector('#s-scene-create-wrap');
  if (!btn || !wrap) return;
  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    wrap.hidden = false;
    try { box.querySelector('#s-scene-name').focus(); } catch {}
  });
  const submit = () => submitSceneCreate(box, opts);
  box.querySelector('#s-scene-submit').addEventListener('click', submit);
  wrap.querySelectorAll('input').forEach(i =>
    i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } })
  );
}
async function submitSceneCreate(box, opts) {
  opts = opts || {};
  const err = box.querySelector('#s-scene-error');
  const btn = box.querySelector('#s-scene-submit');
  const val = id => { const el = box.querySelector(id); return el ? el.value.trim().replace(/\s+/g, ' ') : ''; };
  const showErr = m => { if (err) err.textContent = m || ''; };
  showErr('');
  const name = val('#s-scene-name');
  const activity = val('#s-scene-activity').toLowerCase() || null;
  const place = val('#s-scene-place') || null;
  const zip = val('#s-scene-zip') || null;
  if (!name || name.length < 2) { showErr('at least 2 characters'); return false; }
  if (name.length > 80) { showErr('80 characters max'); return false; }
  if (zip && !/^\d{5}$/.test(zip)) { showErr('zip should be 5 digits'); return false; }
  if (!profile) { showErr('sign in first'); return false; }
  if (btn) btn.disabled = true;
  let data = null, error = null;
  try { ({ data, error } = await sb.rpc('create_scene', { p_name: name, p_activity: activity, p_place_hint: place, p_zip: zip }) || {}); }
  catch (e) { error = e; }
  if (btn) btn.disabled = false;
  if (error || !data) { showErr((error && error.message) || 'couldn’t create — try again'); return false; }
  const slug = String(data);
  if (!SCENES.some(s => s.slug === slug)) {
    SCENES.push({ id: null, slug, display_name: name, activity, place_hint: place, zip, city: null, region: null, color: '#E8502A',
      pending: true, member_count: 0, joined: false, notifications_enabled: true, joined_at: null, pings_24h: 0, last_ping_at: null, near_rank: null });
  }
  markSceneJoined(slug, true);
  if (zip) { try { localStorage.setItem('pm_zip', zip); } catch {} }
  clearSceneParam();
  toast(scenePending(slug)
    ? 'you’re in ' + sceneName(slug) + ' — goes live at 3 members (pending)'
    : 'joined ' + sceneName(slug));
  if (opts.onCreated) { try { await opts.onCreated(slug); } catch (e) { console.error(e); } }
  return true;
}

// Onboarding chooser: search (name / city) or zip, popular-near-you list with
// member counts, "+ create a scene", skip.
let sceneSearchTimer = null;
function renderSceneChooser(box, opts) {
  opts = opts || {};
  const hint = opts.highlight || null;
  box.innerHTML =
    '<input class="av-input scene-search" id="s-scene-search" type="text" placeholder="search a name, city or zip" autocomplete="off"/>' +
    '<div class="scene-opts-label" id="s-scene-label"></div>' +
    '<div class="scene-opts" id="s-scene-list"></div>' +
    sceneCreateHtml() +
    '<button class="setup-skip" id="s-scene-skip" type="button">' + esc(opts.skipLabel || 'skip for now') + '</button>';
  const list = box.querySelector('#s-scene-list');
  const label = box.querySelector('#s-scene-label');
  const input = box.querySelector('#s-scene-search');
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    let rows = sceneList().filter(s => !s.joined);
    if (q && !/^\d{5}$/.test(q)) rows = rows.filter(s => matchesScene(s, q));
    if (hint) { const i = rows.findIndex(s => s.slug === hint); if (i > 0) rows.unshift(rows.splice(i, 1)[0]); }
    label.textContent = rows.length ? (sceneZip() ? 'near you:' : 'popular:') : '';
    list.innerHTML = rows.length
      ? rows.map((s, i) => sceneOptHtml(s, i === 0 && (hint ? s.slug === hint : !q))).join('')
      : '<div class="fr-empty scene-empty">nothing here yet — be the first: create it below</div>';
    list.querySelectorAll('.scene-opt[data-slug]').forEach(b =>
      b.addEventListener('click', () => opts.onPick && opts.onPick(b.dataset.slug, b))
    );
  };
  draw();
  input.addEventListener('input', () => {
    const v = input.value.trim();
    clearTimeout(sceneSearchTimer);
    if (/^\d{5}$/.test(v)) {
      sceneSearchTimer = setTimeout(async () => {
        try { localStorage.setItem('pm_zip', v); } catch {}
        await loadScenes(v);
        draw();
      }, 250);
    } else {
      draw();
    }
  });
  wireSceneCreate(box, opts);
  box.querySelector('#s-scene-skip').addEventListener('click', () => opts.onSkip && opts.onSkip());
}

// Onboarding step (after the name screen): "where do you play?"
function showSetupScene(next) {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-scene-page">' +
    '<h2 class="setup-h2">where do you play?</h2>' +
    '<div class="setup-sub">join a scene to get pinged when people play there</div>' +
    '<div id="s-scene-chooser"></div>' +
    '</div>' +
    '</div>';
  const done = () => { try { if (typeof next === 'function') next(); } catch (e) { console.error(e); } };
  renderSceneChooser(document.getElementById('s-scene-chooser'), {
    highlight: getSceneParam(),
    onPick: async (slug, btn) => {
      btn.disabled = true;
      const ok = await joinScene(slug);
      btn.disabled = false;
      if (ok) { toast('joined ' + sceneName(slug)); done(); }
    },
    onCreated: () => done(),
    onSkip: () => { localStorage.setItem('pm_scene_prompted', '1'); clearSceneParam(); done(); }
  });
}

// Signup: a valid ?scene= hint auto-joins that scene and skips the ask.
async function setupSceneStep(next) {
  const hint = getSceneParam();
  if (hint && sceneRows().some(s => s.slug === hint) && await joinScene(hint)) {
    toast('joined ' + sceneName(hint));
    next();
    return;
  }
  showSetupScene(next);
}

// Existing users who are in no scene yet: ask once, non-blocking.
function maybeShowSceneNudge() {
  if (!profile || mySceneSlugs().length) return;
  if (localStorage.getItem('pm_scene_prompted') === '1') return;
  openSceneSheet();
}

// /scenes "route": #scenes opens the browse sheet (the app has no router).
function handleSceneRoute() {
  let h = '';
  try { h = location.hash; } catch {}
  if (h === '#scenes' || h === '#/scenes') openSceneSheet();
}

/* ── browse sheet: your scenes · trending · near you ── */
// mode: 'mine' (mute + leave) · 'join' · 'info' (joined, controls live under "your scenes")
function sceneRowHtml(s, mode) {
  const n = s.member_count || 0;
  const meta = [n + ' member' + (n === 1 ? '' : 's')].concat(
    sceneMeta(s, [s.pings_24h ? s.pings_24h + ' ping' + (s.pings_24h === 1 ? '' : 's') + ' today' : null]) || []).filter(Boolean).join(' · ');
  const controls = mode === 'mine'
    ? '<button class="tog-switch scene-mute' + (s.notifications_enabled !== false ? ' on' : '') + '" type="button" title="notifications from this scene"><span class="knob"></span></button>' +
      '<button class="pa-btn scene-leave" type="button">leave</button>'
    : mode === 'join'
      ? '<button class="pa-btn primary scene-join" type="button">join</button>'
      : '<span class="scene-joined-chip">joined ✓</span>';
  return '<div class="scene-row" data-slug="' + esc(s.slug) + '" style="--scene:' + safeColor(s.color) + '">' +
    '<span class="scene-dot"></span>' +
    '<span class="scene-row-text"><span class="scene-row-name">' + esc(s.display_name) +
      (s.pending ? ' <span class="scene-pending-badge">pending</span>' : '') + '</span>' +
    '<span class="scene-meta">' + esc(meta) + '</span></span>' +
    controls +
    '</div>';
}
function renderSceneBrowse(el) {
  const q = ((el.querySelector('#sc-search') || {}).value || '').trim().toLowerCase();
  const filt = rows => (q && !/^\d{5}$/.test(q)) ? rows.filter(s => matchesScene(s, q)) : rows;
  const mine = filt(myScenes());
  const near = filt(sceneList().filter(s => !s.joined));
  const trending = filt(sceneRows().filter(s => !s.pending && (s.pings_24h || 0) > 0))
    .sort((a, b) => (b.pings_24h || 0) - (a.pings_24h || 0) || (b.member_count || 0) - (a.member_count || 0));
  el.querySelector('#sc-mine').innerHTML = mine.length
    ? mine.map(s => sceneRowHtml(s, 'mine')).join('')
    : '<div class="fr-empty">none yet — join one below or create your own</div>';
  const tr = el.querySelector('#sc-trending');
  tr.innerHTML = trending.map(s => sceneRowHtml(s, s.joined ? 'info' : 'join')).join('');
  tr.parentElement.style.display = trending.length ? '' : 'none';
  el.querySelector('#sc-near-label').textContent = sceneZip() ? 'near you' : 'popular';
  el.querySelector('#sc-near').innerHTML = near.length
    ? near.map(s => sceneRowHtml(s, 'join')).join('')
    : '<div class="fr-empty">nothing here yet — create it below</div>';
}
function ensureSceneSheet() {
  let el = document.getElementById('sheet-scenes');
  if (el) return el;
  el = document.createElement('div');
  el.className = 'sheet-wrap';
  el.id = 'sheet-scenes';
  el.innerHTML =
    '<div class="sheet-scrim" data-dismiss></div>' +
    '<div class="modal-center modal-tall">' +
      '<button class="modal-close" data-dismiss>&times;</button>' +
      '<h3>scenes</h3>' +
      '<div class="ping-confirm-sub">join a scene, get pinged when people play there</div>' +
      '<input class="av-input scene-search" id="sc-search" type="text" placeholder="search a name, city or zip" autocomplete="off"/>' +
      '<div class="scene-section"><div class="scene-section-label">your scenes</div><div class="scene-list" id="sc-mine"></div></div>' +
      '<div class="scene-section"><div class="scene-section-label">trending</div><div class="scene-list" id="sc-trending"></div></div>' +
      '<div class="scene-section"><div class="scene-section-label" id="sc-near-label">near you</div><div class="scene-list" id="sc-near"></div></div>' +
      '<div id="sc-create"></div>' +
    '</div>';
  document.body.appendChild(el);
  el.querySelectorAll('[data-dismiss]').forEach(d =>
    d.addEventListener('click', () => {
      el.classList.remove('open');
      localStorage.setItem('pm_scene_prompted', '1');
    })
  );
  el.querySelector('#sc-search').addEventListener('input', () => {
    const v = el.querySelector('#sc-search').value.trim();
    clearTimeout(sceneSearchTimer);
    if (/^\d{5}$/.test(v)) {
      sceneSearchTimer = setTimeout(async () => {
        try { localStorage.setItem('pm_zip', v); } catch {}
        await loadScenes(v);
        renderSceneBrowse(el);
      }, 250);
    } else {
      renderSceneBrowse(el);
    }
  });
  const box = el.querySelector('#sc-create');
  box.innerHTML = sceneCreateHtml();
  wireSceneCreate(box, {
    onCreated: async () => {
      box.innerHTML = sceneCreateHtml();
      wireSceneCreate(box, { onCreated: () => renderSceneBrowse(el) });
      renderSceneBrowse(el);
      await loadRoster();
      renderHome();
    }
  });
  el.addEventListener('click', async e => {
    const row = e.target.closest('.scene-row');
    if (!row) return;
    const slug = row.dataset.slug;
    if (e.target.closest('.scene-mute')) {
      const s = SCENES.find(x => x.slug === slug);
      await setSceneMute(slug, !(s && s.notifications_enabled !== false));
      renderSceneBrowse(el);
    } else if (e.target.closest('.scene-leave')) {
      const b = e.target.closest('.scene-leave'); b.disabled = true;
      const ok = await leaveScene(slug);
      renderSceneBrowse(el);
      if (ok) { toast('left ' + sceneName(slug)); await loadRoster(); renderHome(); }
    } else if (e.target.closest('.scene-join')) {
      const b = e.target.closest('.scene-join'); b.disabled = true;
      const ok = await joinScene(slug);
      renderSceneBrowse(el);
      if (ok) { toast('joined ' + sceneName(slug)); await loadRoster(); renderHome(); }
    }
  });
  return el;
}
function openSceneSheet() {
  if (!profile) { toast('sign in first'); return; }
  const el = ensureSceneSheet();
  renderSceneBrowse(el);
  el.classList.add('open');
  if (sb) loadScenes().then(() => { if (el.classList.contains('open')) renderSceneBrowse(el); }).catch(() => {});
}

/* ── ping "at [scene]" ── */
// Default = my most recently active joined scene; the last explicit choice
// ('' = everyone) is remembered in pm_last_scene.
function primaryScene() {
  const mine = myScenes();
  if (!mine.length) return null;
  let last = null;
  try { last = localStorage.getItem('pm_last_scene'); } catch {}
  if (last && mine.some(s => s.slug === last)) return last;
  return mine[0].slug;
}
function renderScenePicker() {
  const el = document.getElementById('scene-picker');
  if (!el) return;
  const mine = myScenes();
  if (!mine.length) { el.innerHTML = ''; el.style.display = 'none'; selectedScene = null; return; }
  let stored = null;
  try { stored = localStorage.getItem('pm_last_scene'); } catch {}
  selectedScene = stored === '' ? null : primaryScene();
  el.style.display = '';
  el.innerHTML =
    '<div class="scene-picker-label">ping who?</div>' +
    '<div class="scene-chips">' +
      mine.map(s => '<button class="scene-chip' + (selectedScene === s.slug ? ' active' : '') + '" type="button" data-slug="' + esc(s.slug) + '">' + esc(s.display_name) + '</button>').join('') +
      '<button class="scene-chip' + (selectedScene === null ? ' active' : '') + '" type="button" data-slug="">everyone</button>' +
    '</div>';
  el.querySelectorAll('.scene-chip').forEach(b => b.addEventListener('click', () => {
    selectedScene = b.dataset.slug || null;
    try { localStorage.setItem('pm_last_scene', b.dataset.slug || ''); } catch {}
    el.querySelectorAll('.scene-chip').forEach(c => c.classList.toggle('active', (c.dataset.slug || null) === selectedScene));
  }));
}

// After the status is saved: tell people. With a scene selected the server
// fans out to its members (ping_scene → one pings row each → push); with no
// scene it's the legacy open ping / radius push.
async function fireStatusPings(targetState) {
  const slug = (selectedScene && myScenes().some(s => s.slug === selectedScene)) ? selectedScene : null;
  if (slug) {
    if (!isPushAllowedHere()) {
      console.log('[pingme] scene ping suppressed (non-prod host):', location.hostname, slug);
      toast('test mode — no pings sent');
      return;
    }
    const verb = targetState === 'down' ? 'is down to play' : 'is playing';
    const venue = getVenueName();
    const msg = profile.name + ' ' + verb + ' at ' + sceneName(slug) + (venue ? ' (' + venue + ')' : '') + (targetState === 'down' ? ' — you in?' : '');
    let data = null, error = null;
    try { ({ data, error } = await sb.rpc('ping_scene', { p_slug: slug, p_msg: msg, p_verb: verb }) || {}); }
    catch (e) { error = e; }
    if (error) { toast('ping failed — ' + (error.message || 'try again')); return; }
    const n = typeof data === 'number' ? data : 0;
    if (n > 0) toast('pinged ' + n + ' at ' + sceneName(slug));
    else toast(targetState === 'down' ? 'you’re down to play' : 'you’re playing at ' + (venue || sceneName(slug)));
    return;
  }
  if (targetState === 'down') {
    const pinged = await pingEveryone();
    toast(pinged ? 'pinged the squad' : 'you’re down to play');
  } else if (targetState === 'playing') {
    pushStatusChange(profile.name + ' is playing at ' + getVenueName());
    toast('you’re playing at ' + getVenueName());
  }
}

/* ── NOTIS — T7 welcome card ── */
function renderNotis() {
  const notisSub = document.getElementById('notis-sub');
  const pingList = document.getElementById('me-ping-list') || document.getElementById('ping-list');
  if (!pingList) return;
  // Hide system "connect email" pings from the list — surfaced via the envelope icon instead
  const visible = pings.filter(p => p.verb !== 'system');
  const u = visible.filter(p => p.unread).length;
  const rr = visible.filter(p => !p.unread).length;
  if (notisSub) notisSub.textContent = u + ' new \u00b7 ' + rr + ' seen';

  // Update bell badge in the new pings header
  const pBadge = document.getElementById('me-pings-badge');
  if (pBadge) {
    pBadge.textContent = u;
    pBadge.style.display = u > 0 ? 'grid' : 'none';
  }
  // Toggle clear-all visibility
  const clearBtn = document.getElementById('clear-pings');
  if (clearBtn) clearBtn.style.display = visible.length ? 'inline-flex' : 'none';

  // T7: welcome card when no pings yet
  if (visible.length === 0) {
    pingList.innerHTML =
      '<div class="notis-welcome">' +
      '<div class="nw-icon"><svg width="36" height="36" viewBox="0 0 40 40" filter="url(#wobble)"><ellipse cx="22" cy="18" rx="14" ry="14" fill="none" stroke="#141210" stroke-width="2.4"/><rect x="6" y="26" width="14" height="6" rx="2" fill="none" stroke="#141210" stroke-width="2.4" transform="rotate(-22 13 29)"/><circle cx="32" cy="10" r="2.4" fill="none" stroke="#141210" stroke-width="1.8"/></svg></div>' +
      '<div class="nw-title">your notis will live here</div>' +
      '<div class="nw-body">' +
      '<div class="nw-item">&middot; when someone\'s looking for a game</div>' +
      '<div class="nw-item">&middot; when someone starts playing</div>' +
      '<div class="nw-item">&middot; before your time runs out</div>' +
      '</div>' +
      '<div class="nw-coming">tap a player to ping or message them</div>' +
      '</div>';
    return;
  }

  pingList.innerHTML = visible.map(p => {
    const from = p.from || {};
    const isSystem = p.verb === 'system';
    const avText = esc(isSystem ? 'pm' : (from.name || '??').slice(0, 2).toUpperCase());
    const color = isSystem ? '#2563eb' : safeColor(from.color);
    const who = isSystem ? 'pingme' : (from.name || 'someone');
    const ago = timeAgo(p.created_at);
    const acted = p.action_taken;

    let actions = '';
    const isInvite = p.verb === 'down to play at';
    if (isSystem) {
      actions = '<div class="ping-actions">' +
        '<button class="pa-btn primary system-link-email" data-ping="' + p.id + '">connect email</button>' +
        '</div>';
    } else if (!acted && isInvite) {
      actions = '<div class="ping-actions">' +
        '<button class="pa-btn primary" data-ping="' + p.id + '" data-action="accepted">i\'m in</button>' +
        '<button class="pa-btn" data-ping="' + p.id + '" data-action="declined">pass</button>' +
        '</div>';
    } else if (!acted) {
      actions = '<div class="ping-actions">' +
        '<button class="pa-btn primary" data-ping="' + p.id + '" data-action="on my way">on my way</button>' +
        '<button class="pa-btn" data-ping="' + p.id + '" data-action="maybe">maybe</button>' +
        '<button class="pa-btn" data-ping="' + p.id + '" data-action="can\'t">can\'t</button>' +
        '</div>';
    } else if (isInvite && acted === 'accepted' && FEATURES.matchTracking) {
      actions = '<div class="ping-actions">' +
        '<button class="pa-btn primary pa-start-match" data-from="' + p.from_id + '">tap to start match</button>' +
        '</div>';
    } else {
      actions = '<div class="ping-actions"><button class="pa-btn taken">&#10003; ' + esc(acted) + '</button></div>';
    }

    const displayMsg = (p.msg || '').split('␟')[0]; // strip encoded venue id on invites
    return '<div class="ping-card ' + (p.unread ? 'unread' : '') + '" data-id="' + p.id + '">' +
      '<div class="pc-av" style="background:' + color + ';color:#F4EDDC">' + avText + '</div>' +
      '<div class="pc-body">' +
      '<div class="pc-who">' + esc(who) + (isSystem ? '' : ' <span class="pc-verb">' + esc(p.verb || '') + '</span>') + '</div>' +
      (p.scene_id && sceneNameById(p.scene_id) ? '<div class="pc-scene">at ' + esc(sceneNameById(p.scene_id)) + '</div>' : '') +
      '<div class="pc-msg">' + esc(displayMsg) + '</div>' +
      '<div class="pc-time">' + ago + '</div>' +
      actions + '</div></div>';
  }).join('') + '<div class="empty-hint">that\'s the lot. go play.</div>';

  // System "connect email" button → opens link email flow
  pingList.querySelectorAll('.system-link-email').forEach(btn =>
    btn.addEventListener('click', async () => {
      const pingId = btn.dataset.ping;
      await sb.from('pings').update({ unread: false, action_taken: 'linked' }).eq('id', pingId);
      const p = pings.find(x => x.id === pingId);
      if (p) { p.unread = false; p.action_taken = 'linked'; }
      updateNotisBadge();
      showLinkEmail();
    })
  );

  pingList.querySelectorAll('.pa-btn[data-ping]:not(.system-link-email)').forEach(btn =>
    btn.addEventListener('click', async () => {
      const pingId = btn.dataset.ping;
      const action = btn.dataset.action;
      if (!action) return;
      btn.disabled = true;
      let error = null;
      try {
        ({ error } = await sb.from('pings').update({ unread: false, action_taken: action }).eq('id', pingId) || {});
      } catch (e) { error = e; }
      if (error) {
        btn.disabled = false;
        toast('could not save — try again');
        return;
      }
      const p = pings.find(x => x.id === pingId);
      if (p) { p.unread = false; p.action_taken = action; }
      // "accepted" invite → switch to that venue + go down
      if (action === 'accepted' && profile && p?.verb === 'down to play at') {
        const venueId = (p.msg || '').split('␟')[1];
        if (venueId && VENUES.find(v => v.id === venueId)) {
          selectedVenue = venueId;
          localStorage.setItem('pm_venue', venueId);
        }
        if (homeState !== 'down' && homeState !== 'playing') {
          downDur = 60;
          const ok = await setMyStatus('down');
          if (!ok) { toast('failed to update status'); renderNotis(); return; }
          homeState = 'down';
          app.dataset.homeState = 'down';
        }
        document.getElementById('sheet-me').classList.remove('open');
        renderHome();
        toast('locked in — see you at ' + (getVenueName() || 'the table'));
        return;
      }
      // "on my way" sets your status to down automatically
      if (action === 'on my way' && profile && homeState !== 'down' && homeState !== 'playing') {
        downDur = 60;
        const ok = await setMyStatus('down');
        if (!ok) { toast('failed to update status'); renderNotis(); return; }
        homeState = 'down';
        app.dataset.homeState = 'down';
        document.getElementById('sheet-me').classList.remove('open');
        renderHome();
        toast('you\'re down — heading to ' + getVenueName());
        return;
      }
      renderNotis();
      updateNotisBadge();
    })
  );

  // "tap to start match" on an accepted invite → open scoreholio score card
  pingList.querySelectorAll('.pa-start-match').forEach(btn =>
    btn.addEventListener('click', () => {
      const fromId = btn.dataset.from;
      if (!fromId) return;
      document.getElementById('sheet-me').classList.remove('open');
      if (window.pmMatch?.open) window.pmMatch.open(fromId);
      else toast('match tracking not enabled');
    })
  );

  // Swipe-left to delete a single ping
  pingList.querySelectorAll('.ping-card').forEach(card => wireSwipeDelete(card));
}

function wireSwipeDelete(card) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, locked = false;
  const THRESH = 80; // px past which we delete
  const onStart = (e) => {
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX; startY = t.clientY; dx = 0; dy = 0;
    dragging = true; locked = false;
    card.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    dx = t.clientX - startX; dy = t.clientY - startY;
    if (!locked) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { dragging = false; return; }
      if (Math.abs(dx) > 8) locked = true;
    }
    if (locked) {
      if (e.cancelable) e.preventDefault();
      const x = Math.min(0, dx); // only swipe-left
      card.style.transform = 'translateX(' + x + 'px)';
      card.style.opacity = String(Math.max(0.3, 1 + x / 240));
    }
  };
  const onEnd = async () => {
    if (!dragging) return;
    dragging = false;
    card.style.transition = 'transform .18s ease, opacity .18s ease';
    if (locked && dx < -THRESH) {
      card.style.transform = 'translateX(-120%)';
      card.style.opacity = '0';
      const pingId = card.dataset.id;
      setTimeout(async () => {
        try { await sb.from('pings').delete().eq('id', pingId); } catch {}
        const idx = pings.findIndex(p => p.id === pingId);
        if (idx >= 0) pings.splice(idx, 1);
        renderNotis();
        updateNotisBadge();
      }, 160);
    } else {
      card.style.transform = '';
      card.style.opacity = '';
    }
  };
  card.addEventListener('touchstart', onStart, { passive: true });
  card.addEventListener('touchmove', onMove, { passive: false });
  card.addEventListener('touchend', onEnd);
  card.addEventListener('touchcancel', onEnd);
}

/* ── ME — T1: truly minimal ── */
function renderMe() {
  const w = document.getElementById('me-wrap');

  if (!profile) {
    // Populate fixed elements with empty/signed-out state
    const avEl = document.getElementById('me-av-tap');
    if (avEl) { avEl.textContent = '?'; avEl.style.background = 'var(--muted-2)'; }
    const nameEl = document.getElementById('me-name-text');
    if (nameEl) nameEl.textContent = 'not signed in';
    const statusEl = document.getElementById('me-status-line');
    if (statusEl) statusEl.textContent = 'sign in to play';
    const eloEl = document.querySelector('#stat-elo .ms-num');
    if (eloEl) eloEl.textContent = '—';
    const gamesEl = document.getElementById('stat-games');
    if (gamesEl) gamesEl.textContent = '—';
    const rankEl = document.querySelector('#stat-rank .ms-num');
    if (rankEl) rankEl.textContent = '—';
    if (w) w.innerHTML =
      '<button class="setup-primary" style="font-size:20px;padding:14px;border-radius:16px;width:100%" onclick="showSetup()">sign in to play</button>';
    return;
  }

  const ini = profile.name.slice(0, 2).toUpperCase() || '??';
  const col = profile.color || AV_COLORS[Math.abs(hash(profile.name)) % AV_COLORS.length];
  const me = roster.find(r => r.id === profile.id) || profile;

  // Status line for the fixed status element
  let statusHtml = "you're off right now";
  if (me.status === 'playing') {
    const m = me.started_at ? Math.floor((Date.now() - new Date(me.started_at).getTime()) / 60000) : 0;
    statusHtml = 'playing at ' + esc(me.venue || getVenueName()) + ' &middot; ' + m + ' min in';
  } else if (me.status === 'down') {
    const dur = me.duration === 30 ? '30 min' : me.duration === 60 ? '1 hour' : '2 hours';
    statusHtml = 'down for ' + dur + ' &middot; ' + timeLeft(me) + ' remaining';
  }

  const notifOn = typeof Notification !== 'undefined' && Notification.permission === 'granted' && !localStorage.getItem('pm_notif_off');

  // Stats: ELO, games (plays), rank
  const elo = (me.elo != null ? me.elo : 1200);
  const wins = me.wins || 0;
  const losses = me.losses || 0;
  const plays = me.play_count || 0;
  const totalMatches = wins + losses;
  const winPct = totalMatches > 0 ? Math.round((wins / totalMatches) * 100) : null;

  // ── Populate FIXED elements (new redesigned profile DOM) ──
  const avEl = document.getElementById('me-av-tap');
  if (avEl) { avEl.textContent = ini; avEl.style.background = col; }
  const nameEl = document.getElementById('me-name-text');
  if (nameEl) {
    nameEl.innerHTML = esc(profile.name) + (me.email_verified ? ' <span class="me-verified" title="verified">&#10004;</span>' : '');
  }
  const statusEl = document.getElementById('me-status-line');
  if (statusEl) statusEl.innerHTML = statusHtml;
  const eloEl = document.querySelector('#stat-elo .ms-num');
  if (eloEl) eloEl.textContent = elo;
  const gamesEl = document.getElementById('stat-games');
  if (gamesEl) gamesEl.textContent = plays;
  const rankEl = document.querySelector('#stat-rank .ms-num');
  if (rankEl) rankEl.textContent = (me.referral_count || 0);

  // Settings + email icons: email icon flips sage (verified) / flame (unverified).
  const cachedEmail = (profile && profile._linkedEmail) || localStorage.getItem('pm_linked_email');
  const isEmailLinked = !!cachedEmail || !!me.email_verified;
  const settingsBtn = document.getElementById('row-settings');
  if (settingsBtn) {
    // Settings icon stays in default ink/cream styling — don't tie it to email.
    settingsBtn.classList.remove('ok');
    settingsBtn.title = 'settings';
  }
  const emailBtn = document.getElementById('row-email');
  if (emailBtn) {
    emailBtn.classList.toggle('ok', isEmailLinked);
    emailBtn.title = isEmailLinked ? ('email verified' + (cachedEmail ? ' · ' + cachedEmail : '')) : 'verify email';
  }

  // ── settings panel + link-email banner live in #me-wrap (legacy) ──
  const emailLabel = isEmailLinked
    ? ('email verified' + (cachedEmail ? ' · ' + esc(cachedEmail) : ''))
    : 'link email';
  w.innerHTML =
    '<div class="me-settings-dropdown" id="me-settings-dd">' +
    '<button class="me-dd-item" id="sr-notif-link">' +
      '<span class="tog-switch ' + (notifOn ? 'on' : '') + '" id="notif-tog"><span class="knob"></span></span>' +
      ' notifications' +
    '</button>' +
    '<button class="me-dd-item" id="sr-test-notif">test notification</button>' +
    '<button class="me-dd-item" id="sr-friends">friends</button>' +
    '<button class="me-dd-item" id="sr-scenes">scenes \u00b7 ' + sceneLabel() + '</button>' +
    '<button class="me-dd-item" id="sr-invite">invite a friend</button>' +
    '<button class="me-dd-item me-dd-danger" id="sr-signout">sign out</button>' +
    '<button class="me-dd-item me-dd-danger" id="sr-delete-acct">delete account</button>' +
    '</div>' +

    // Blue "link email" banner removed — envelope icon in the id-icons row
    // is the single entry point for linking/verifying email.
    '<button class="me-link-acct-banner" id="me-link-acct" style="display:none" hidden></button>' +
    '<div class="me-linked-email" id="me-linked-email" style="display:none"></div>';

  // Stub elements so older code that reads them doesn't crash
  // (me-name-display + me-av-btn are now the fixed elements above)
  const meNameDisplayStub = document.createElement('div');
  meNameDisplayStub.id = 'me-name-display'; meNameDisplayStub.style.display = 'none';
  w.appendChild(meNameDisplayStub);

  // Avatar: tap cycles color (new fixed element: #me-av-tap)
  let colorIdx = AV_COLORS.indexOf(col);
  if (colorIdx === -1) colorIdx = 0;
  const meAvBtn = document.getElementById('me-av-tap');
  if (meAvBtn && !meAvBtn._wired) {
    meAvBtn._wired = true;
    meAvBtn.addEventListener('click', async () => {
      colorIdx = (colorIdx + 1) % AV_COLORS.length;
      const newColor = AV_COLORS[colorIdx];
      meAvBtn.style.background = newColor;
      profile.color = newColor;
      updateProfileAv();
      if (sb) await sb.from('profiles').update({ color: newColor }).eq('id', profile.id);
    });
  }

  // Settings icon click is handled by the global delegated capture-phase
  // listener (handleSettingsIconTap). Binding directly here caused a
  // double-toggle on mobile (touchend AND click both firing), which
  // immediately re-closed the dropdown after opening.

  // Email-link entry inside the settings dropdown
  const linkEmailItem = document.getElementById('sr-link-email');
  if (linkEmailItem) {
    linkEmailItem.addEventListener('click', () => {
      document.getElementById('me-settings-dd')?.classList.remove('open');
      showLinkEmail();
    });
  }

  // Stat-row clicks → open rank / elo sheets
  const statRank = document.getElementById('stat-rank');
  if (statRank && !statRank._wired) {
    statRank._wired = true;
    statRank.addEventListener('click', () => {
      lbActiveTab = 'referrals';
      renderLeaderboard();
      renderMyInviteCodes();
      document.getElementById('sheet-rank')?.classList.add('open');
    });
  }
  const statElo = document.getElementById('stat-elo');
  if (statElo && !statElo._wired) {
    statElo._wired = true;
    statElo.addEventListener('click', () => {
      renderEloSheet();
      document.getElementById('sheet-elo')?.classList.add('open');
    });
  }

  // Email row icon click handler is wired globally at script startup
  // (see handleEmailIconTap). Don't wire here.

  // Name edit (pencil icon)
  const nameEditBtn = document.getElementById('me-name-edit');
  if (nameEditBtn && !nameEditBtn._wired) {
    nameEditBtn._wired = true;
    nameEditBtn.addEventListener('click', () => startNameChange());
  }
  // Clear pings button
  const clrBtn = document.getElementById('clear-pings');
  if (clrBtn && !clrBtn._wired) {
    clrBtn._wired = true;
    clrBtn.addEventListener('click', async () => {
      if (!profile) return;
      if (!confirm('clear all pings?')) return;
      await sb.from('pings').delete().eq('to_id', profile.id);
      pings.length = 0;
      renderNotis();
      updateNotisBadge();
      toast('pings cleared');
    });
  }

  // Test notification
  document.getElementById('sr-test-notif').addEventListener('click', () => {
    document.getElementById('me-settings-dd').classList.remove('open');
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      toast('enable notifications first');
      return;
    }
    new Notification('pingme', {
      body: (profile.name || 'someone') + ' wants to play!',
      icon: '/icon-192.png',
      tag: 'pm-test',
      renotify: true
    });
    toast('check your notification');
  });

  // (name change is handled by the pencil icon next to the name)

  // Name change — tap name
  function startNameChange() {
    const nameEl = document.getElementById('me-name-display');
    nameEl.innerHTML = '<input class="me-name-input" id="me-name-inp" value="' + esc(profile.name) + '" maxlength="30" autofocus/>';
    const inp = document.getElementById('me-name-inp');
    inp.focus(); inp.select();
    inp.addEventListener('blur', saveName);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  }
  async function saveName() {
    const inp = document.getElementById('me-name-inp');
    if (!inp) return;
    const n = inp.value.trim().toLowerCase().slice(0, 30);
    if (!n || n === profile.name) { renderMe(); renderNotis(); return; }
    profile.name = n;
    const me = roster.find(r => r.id === profile.id);
    if (me) me.name = n;
    if (sb) await sb.from('profiles').update({ name: n }).eq('id', profile.id);
    updateProfileAv();
    renderMe();
    renderNotis();
    toast('name updated');
  }
  document.getElementById('me-name-display').addEventListener('click', startNameChange);

  // Notifications toggle
  document.getElementById('sr-notif-link').addEventListener('click', async () => {
    if (!('Notification' in window)) {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS && !window.navigator.standalone) {
        toast('tap Share → Add to Home Screen first, then enable notifications');
      } else {
        toast('notifications not supported in this browser');
      }
      return;
    }
    const tog = document.getElementById('notif-tog');
    if (Notification.permission === 'granted') {
      const nowOn = tog.classList.contains('on');
      tog.classList.toggle('on');
      localStorage.setItem('pm_notif_off', nowOn ? '1' : '');
      if (!nowOn) await registerPushSubscription();
      toast(nowOn ? 'notifications off' : 'notifications on');
    } else if (Notification.permission === 'denied') {
      toast('blocked — check browser settings');
    } else {
      const p = await Notification.requestPermission();
      if (p === 'granted') {
        tog.classList.add('on');
        localStorage.removeItem('pm_notif_off');
        await registerPushSubscription();
        toast('pings are on');
      } else {
        tog.classList.remove('on');
        toast('permission denied — check browser settings');
      }
    }
  });

  // Link-email banner + linked-email confirmation text are intentionally
  // not rendered in the profile body. The envelope icon in the id-icons
  // row is the single source of truth for email status / linking.
  const linkAcctBanner = document.getElementById('me-link-acct');
  const linkedEmailEl = document.getElementById('me-linked-email');
  if (linkAcctBanner) linkAcctBanner.style.display = 'none';
  if (linkedEmailEl) linkedEmailEl.style.display = 'none';

  document.getElementById('sr-friends').addEventListener('click', () => {
    document.getElementById('me-settings-dd')?.classList.remove('open');
    openFriendsSheet('friends');
  });
  document.getElementById('sr-scenes').addEventListener('click', () => {
    document.getElementById('me-settings-dd')?.classList.remove('open');
    openSceneSheet();
  });

  // Invite a friend → copy the user's invite link/code to clipboard, no share sheet.
  document.getElementById('sr-invite').addEventListener('click', () => {
    document.getElementById('me-settings-dd')?.classList.remove('open');
    const url = getShareUrl();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url)
        .then(() => toast('invite code copied'))
        .catch(() => toast('copy failed'));
    } else {
      toast('copy failed');
    }
  });

  // Sign out
  document.getElementById('sr-signout').addEventListener('click', async () => {
    if (downExpiryTimer) { clearTimeout(downExpiryTimer); downExpiryTimer = null; }
    if (downReminderTimer) { clearTimeout(downReminderTimer); downReminderTimer = null; }
    if (playingExpiryTimer) { clearTimeout(playingExpiryTimer); playingExpiryTimer = null; }
    const myId = profile?.id;
    if (profile) {
      await sb.from('profiles').update({
        status: 'off', venue: null, duration: null, started_at: null
      }).eq('id', profile.id);
    }
    await sb.auth.signOut();
    localStorage.removeItem('pm_linked_email');
    profile = null; homeState = 'off';
    if (myId) roster = roster.filter(r => r.id !== myId);
    placeBall(SNAP.off, true);
    app.dataset.homeState = 'off';
    toast('signed out');
    document.getElementById('sheet-me').classList.remove('open');
    renderHome();
  });

  // Delete account
  document.getElementById('sr-delete-acct').addEventListener('click', async () => {
    if (!confirm('delete your account? this cannot be undone.')) return;
    if (!confirm('are you sure? all your data will be permanently deleted.')) return;
    const myId = profile?.id;
    if (myId) {
      await sb.from('profiles').delete().eq('id', myId);
    }
    await sb.auth.signOut();
    localStorage.removeItem('pm_linked_email');
    localStorage.removeItem('pm_auth');
    localStorage.removeItem('pm_venue');
    localStorage.removeItem('pm_favorites');
    localStorage.removeItem('pm_link_nudge');
    localStorage.removeItem('pm_notif_off');
    profile = null; homeState = 'off';
    if (myId) roster = roster.filter(r => r.id !== myId);
    placeBall(SNAP.off, true);
    app.dataset.homeState = 'off';
    toast('account deleted');
    document.getElementById('sheet-me').classList.remove('open');
    renderHome();
    setTimeout(showSetup, 300);
  });
}

function showLinkEmail() {
  const modal = document.querySelector('#sheet-me .modal-center');
  const meWrap = document.getElementById('me-wrap');
  const notisSection = document.getElementById('me-notis-section');
  if (notisSection) notisSection.style.display = 'none';

  const cachedEmail = localStorage.getItem('pm_linked_email') || '';
  const verified = !!(profile && profile.email_verified) || !!cachedEmail;
  if (verified) {
    meWrap.innerHTML =
      '<div style="padding:16px 0;text-align:center">' +
      '<div style="font-size:32px;margin-bottom:4px">&#10004;</div>' +
      '<h3 class="link-email-h">email linked</h3>' +
      '<div class="link-email-sub">' + (cachedEmail ? esc(cachedEmail) : 'your account is saved') + '</div>' +
      '<button class="link-email-go-back" id="link-email-done">done</button>' +
      '</div>';
    document.getElementById('link-email-done').addEventListener('click', () => {
      if (notisSection) notisSection.style.display = '';
      renderMe();
    });
    // Surface the panel visibly: scroll it into view and toast so the user knows
    // their tap registered (previously the inline swap was easy to miss).
    requestAnimationFrame(() => meWrap.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    toast(cachedEmail ? ('email: ' + cachedEmail) : 'email linked');
    return;
  }

  meWrap.innerHTML =
    '<div style="padding:16px 0">' +
    '<h3 class="link-email-h">link your email</h3>' +
    '<div class="link-email-sub">save your account so you can log in on other devices</div>' +
    '<input class="link-email-input" id="link-email-input" type="email" placeholder="your email" autocomplete="email" autofocus/>' +
    '<button class="link-email-btn" id="link-email-go">send code</button>' +
    '<button class="link-email-go-back" id="link-email-cancel">go back</button>' +
    '</div>';

  setTimeout(() => document.getElementById('link-email-input').focus(), 80);

  document.getElementById('link-email-cancel').addEventListener('click', () => {
    if (notisSection) notisSection.style.display = '';
    renderMe();
  });

  document.getElementById('link-email-go').addEventListener('click', async () => {
    const email = document.getElementById('link-email-input').value.trim();
    if (!email || !email.includes('@')) { toast('enter a valid email'); return; }
    const btn = document.getElementById('link-email-go');
    btn.textContent = 'sending...'; btn.disabled = true;

    // Send OTP via our edge function (bypasses Supabase SMTP entirely)
    try {
      const r = await fetch(SUPABASE_URL + '/functions/v1/send-email', {
        method: 'POST',
        headers: await userAuthHeaders(),
        body: JSON.stringify({ action: 'send', email, user_id: profile.id })
      });
      if (!r.ok) { toast('failed to send code'); btn.textContent = 'send code'; btn.disabled = false; return; }
    } catch (e) { toast('failed: ' + e.message); btn.textContent = 'send code'; btn.disabled = false; return; }

    meWrap.innerHTML =
      '<div style="padding:16px 0">' +
      '<div style="font-size:32px;text-align:center;margin-bottom:4px">&#9993;</div>' +
      '<h3 class="link-email-h">enter your code</h3>' +
      '<div class="link-email-sub">we sent a code to <b>' + esc(email) + '</b></div>' +
      '<input class="link-email-input" id="link-email-otp" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="enter code" autocomplete="one-time-code" style="letter-spacing:4px" autofocus/>' +
      '<button class="link-email-btn" id="link-email-verify">verify</button>' +
      '<button class="link-email-go-back" id="link-email-done">go back</button>' +
      '</div>';

    setTimeout(() => document.getElementById('link-email-otp').focus(), 80);

    document.getElementById('link-email-verify').addEventListener('click', async () => {
      const verifyBtn = document.getElementById('link-email-verify');
      if (verifyBtn.disabled) return; // prevent double-click
      const code = document.getElementById('link-email-otp').value.trim();
      if (!code || code.length < 6) { toast('enter the 6-digit code'); return; }
      verifyBtn.textContent = 'verifying...'; verifyBtn.disabled = true;
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(SUPABASE_URL + '/functions/v1/send-email', {
          method: 'POST',
          headers: await userAuthHeaders(),
          body: JSON.stringify({ action: 'verify', email, code, user_id: profile.id }),
          signal: ctrl.signal
        });
        const result = await r.json();
        if (result.error) {
          toast(result.error);
          verifyBtn.textContent = 'verify'; verifyBtn.disabled = false;
          return;
        }
      } catch (e) {
        toast(e.name === 'AbortError' ? 'timed out — try again' : 'failed — try again');
        verifyBtn.textContent = 'verify'; verifyBtn.disabled = false;
        return;
      }
      // Edge function already deleted system pings from DB — remove from local array
      pings = pings.filter(p => p.verb !== 'system');
      // Refresh session (don't block on it)
      sb.auth.refreshSession().catch(() => {});
      // Persist linked email in localStorage so it survives refresh
      localStorage.setItem('pm_linked_email', email);
      profile._linkedEmail = email;
      toast('email linked!');
      if (notisSection) notisSection.style.display = '';
      updateNotisBadge();
      renderNotis();
      renderMe();
      updateLinkEmailDot();
    });

    // Auto-submit when full code entered
    document.getElementById('link-email-otp').addEventListener('input', (e) => {
      if (e.target.value.trim().length >= 6) document.getElementById('link-email-verify').click();
    });

    document.getElementById('link-email-done').addEventListener('click', () => {
      if (notisSection) notisSection.style.display = '';
      renderMe();
    });
  });
}

/* ── T9: PUSH / PWA DETECTION ── */
function isPushSupported() {
  return 'Notification' in window && 'PushManager' in window;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function isStandalonePWA() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

/* ── T8: SETUP — 3-screen onboarding ── */

// Screen 1 — Hero
function showSetup() {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page" id="s-page-1">' +

    // Inline court SVG (same style as the toggle)
    '<div class="setup-art">' +
    '<svg viewBox="0 0 320 150" preserveAspectRatio="xMidYMid meet" style="width:100%;max-width:300px">' +
    '<defs>' +
    '<pattern id="nm2" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse">' +
    '<line x1="0" y1="0" x2="0" y2="4" stroke="#F4EDDC" stroke-width=".6" opacity=".7"/>' +
    '<line x1="0" y1="0" x2="4" y2="0" stroke="#F4EDDC" stroke-width=".6" opacity=".7"/>' +
    '</pattern></defs>' +
    '<ellipse cx="160" cy="148" rx="130" ry="5" fill="rgba(20,18,16,.12)"/>' +
    '<path d="M 50 46 L 270 46 L 282 122 L 38 122 Z" fill="#1E5EA8" stroke="#141210" stroke-width="2.5"/>' +
    '<path d="M 56 51 L 264 51 L 274 117 L 46 117 Z" fill="none" stroke="#F4EDDC" stroke-width="1.4" opacity=".55"/>' +
    '<line x1="44" y1="84" x2="276" y2="84" stroke="#F4EDDC" stroke-width="1" stroke-dasharray="5 3" opacity=".5"/>' +
    '<rect x="157" y="40" width="6" height="88" fill="url(#nm2)" stroke="#141210" stroke-width="1.5"/>' +
    '<rect x="155" y="37" width="10" height="6" fill="#F4EDDC" stroke="#141210" stroke-width="1"/>' +
    // left paddle
    '<g transform="translate(26,84)">' +
    '<rect x="-20" y="-4" width="24" height="9" rx="3" fill="#C99060" stroke="#141210" stroke-width="2.2" transform="rotate(-22 -9 1)"/>' +
    '<ellipse cx="14" cy="0" rx="18" ry="21" fill="#2544D6" stroke="#141210" stroke-width="2.5"/>' +
    '<ellipse cx="14" cy="0" rx="12" ry="15" fill="none" stroke="#F4EDDC" stroke-width="1" stroke-dasharray="2 3" opacity=".5"/>' +
    '</g>' +
    // right paddle
    '<g transform="translate(294,84)">' +
    '<rect x="-4" y="-4" width="24" height="9" rx="3" fill="#C99060" stroke="#141210" stroke-width="2.2" transform="rotate(22 9 1)"/>' +
    '<ellipse cx="-14" cy="0" rx="18" ry="21" fill="#E8502A" stroke="#141210" stroke-width="2.5"/>' +
    '<ellipse cx="-14" cy="0" rx="12" ry="15" fill="none" stroke="#F4EDDC" stroke-width="1" stroke-dasharray="2 3" opacity=".5"/>' +
    '</g>' +
    // ball mid-bounce
    '<ellipse cx="160" cy="72" rx="9" ry="3" fill="rgba(20,18,16,.18)"/>' +
    '<circle cx="160" cy="56" r="11" fill="white" stroke="#141210" stroke-width="2.5" style="filter:drop-shadow(0 2px 0 rgba(20,18,16,.18))"/>' +
    '<circle cx="157" cy="53" r="3.5" fill="rgba(255,255,255,.85)"/>' +
    '</svg></div>' +

    '<div class="setup-wm">ping<span class="swm-me">me!</span></div>' +
    '<div class="setup-tagline">find your game. right now.</div>' +

    '<button class="setup-primary" id="s1-in">i\'m in</button>' +
    '<div class="setup-disclaimer">you\'ll hear when someone\'s looking for a game. free, no spam.</div>' +
    '<button class="setup-skip" id="s1-signin">already have an account? sign in</button>' +
    '</div>' + // end s-page-1
    '</div>'; // end setup-fs

  document.getElementById('s1-in').addEventListener('click', () => {
    if (!sb) { toast('not connected'); return; }
    if (FEATURES.anonSignup) { showSetupScreen2(null, null, ''); return; }
    showSetupSignupEmail('');
  });
  document.getElementById('s1-signin').addEventListener('click', () => {
    if (!sb) { toast('not connected'); return; }
    showSetupEmail();
  });
}
window.showSetup = showSetup;

// Screen 1b — Email sign-in via custom OTP
function showSetupEmail(prefillEmail) {
  const pre = typeof prefillEmail === 'string' ? prefillEmail : '';
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-email">' +
    '<h2 class="setup-h2">enter your email</h2>' +
    '<input class="setup-name-input" id="setup-email" type="email" placeholder="your email" autocomplete="email" value="' + esc(pre) + '" autofocus/>' +
    '<button class="setup-primary" id="s-email-go">send me a code</button>' +
    '<div class="setup-disclaimer">we\'ll send a 6-digit code — no password needed</div>' +
    '<div class="setup-nudge" id="s-email-nudge" hidden>no account with that email yet? ' +
      '<button class="setup-nudge-go" id="s-email-nudge-go">create an account &rarr;</button></div>' +
    '<button class="setup-skip" id="s-email-back">go back</button>' +
    '<button class="setup-skip" id="s-email-new">new here? create an account</button>' +
    '</div>' +
    '</div>';

  const inp = document.getElementById('setup-email');
  const nudge = document.getElementById('s-email-nudge');
  const toSignup = () => {
    if (FEATURES.anonSignup) { showSetupScreen2(null, null, ''); return; }
    showSetupSignupEmail(inp.value.trim().toLowerCase());
  };
  setTimeout(() => inp.focus(), 80);
  document.getElementById('s-email-back').addEventListener('click', showSetup);
  document.getElementById('s-email-new').addEventListener('click', toSignup);
  document.getElementById('s-email-nudge-go').addEventListener('click', toSignup);

  document.getElementById('s-email-go').addEventListener('click', async () => {
    const email = inp.value.trim().toLowerCase();
    if (!email || !email.includes('@')) { toast('enter a valid email'); return; }
    const btn = document.getElementById('s-email-go');
    btn.textContent = 'sending...'; btn.disabled = true;

    const res = await signInSendCode(email);
    if (!res.ok) {
      btn.textContent = 'send me a code'; btn.disabled = false;
      // The server answers "if that email exists…" for unknown accounts (no
      // enumeration), so point new people at signup unless they're rate-limited.
      if (!/wait/i.test(res.error || '')) nudge.hidden = false;
      return;
    }
    nudge.hidden = true;

    // Show "enter code" screen
    const root = document.getElementById('setup-root');
    root.innerHTML =
      '<div class="setup-fs">' +
      '<div class="setup-page s-slide-in">' +
      '<div class="setup-check-icon">&#9993;</div>' +
      '<button class="setup-back" id="s-otp-back">&larr;</button>' +
      '<h2 class="setup-h2">check your inbox</h2>' +
      '<div class="setup-check-sub">we sent a 6-digit code to <b>' + esc(email) + '</b></div>' +
      '<input class="setup-name-input" id="setup-otp" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" autocomplete="one-time-code" style="text-align:center;letter-spacing:8px;font-size:28px" autofocus/>' +
      '<button class="setup-primary" id="s-otp-go">verify</button>' +
      '<button class="setup-skip" id="s-email-retry">use a different email</button>' +
      '</div>' +
      '</div>';

    const otpInp = document.getElementById('setup-otp');
    setTimeout(() => otpInp.focus(), 80);

    document.getElementById('s-otp-go').addEventListener('click', async () => {
      const code = otpInp.value.trim();
      if (code.length !== 6) { toast('enter the 6-digit code'); return; }
      const verifyBtn = document.getElementById('s-otp-go');
      verifyBtn.textContent = 'verifying...'; verifyBtn.disabled = true;

      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(SUPABASE_URL + '/functions/v1/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
          body: JSON.stringify({ action: 'signin-verify', email, code }),
          signal: ctrl.signal
        });
        const result = await r.json();
        if (result.error) {
          toast(result.error);
          verifyBtn.textContent = 'verify'; verifyBtn.disabled = false;
          return;
        }
        if (result.token_hash) {
          // Use the token to sign in via Supabase client
          const { data, error } = await sb.auth.verifyOtp({ token_hash: result.token_hash, type: 'magiclink' });
          if (error) {
            toast('sign in failed — try again');
            verifyBtn.textContent = 'verify'; verifyBtn.disabled = false;
            return;
          }
          // Auth succeeded — onAuthStateChange will handle the rest
        }
      } catch (e) {
        toast(e.name === 'AbortError' ? 'timed out — try again' : 'failed — try again');
        verifyBtn.textContent = 'verify'; verifyBtn.disabled = false;
      }
    });

    // Auto-submit when 6 digits entered
    otpInp.addEventListener('input', () => {
      if (otpInp.value.trim().length === 6) {
        document.getElementById('s-otp-go').click();
      }
    });

    document.getElementById('s-email-retry').addEventListener('click', showSetupEmail);
    document.getElementById('s-otp-back').addEventListener('click', showSetupEmail);
  });
}

// Screen 1c — Email-required signup: email → code → session → name step.
// A new account is always a real, email-confirmed auth user, so it can sign
// back in from any device (the old anonymous signup lived only in this
// browser's localStorage).
function showSetupSignupEmail(prefillEmail) {
  const pre = typeof prefillEmail === 'string' ? prefillEmail : '';
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-signup">' +
    '<button class="setup-back" id="s-signup-back">&larr;</button>' +
    '<h2 class="setup-h2">what\'s your email?</h2>' +
    '<input class="setup-name-input" id="setup-signup-email" type="email" placeholder="your email" autocomplete="email" value="' + esc(pre) + '" autofocus/>' +
    '<div class="setup-inline-err" id="s-signup-err"></div>' +
    '<button class="setup-primary" id="s-signup-go">send me a code</button>' +
    '<div class="setup-disclaimer">we\'ll email you a 6-digit code — no password. it\'s how you get back in on any device.</div>' +
    '<button class="setup-skip" id="s-signup-signin">already have an account? sign in</button>' +
    '</div>' +
    '</div>';

  const inp = document.getElementById('setup-signup-email');
  const err = document.getElementById('s-signup-err');
  const btn = document.getElementById('s-signup-go');
  setTimeout(() => inp.focus(), 80);
  const toSignin = () => showSetupEmail(inp.value.trim().toLowerCase());
  document.getElementById('s-signup-back').addEventListener('click', showSetup);
  document.getElementById('s-signup-signin').addEventListener('click', toSignin);

  const showErr = (msg, offerSignin) => {
    err.textContent = msg || '';
    if (offerSignin) {
      const b = document.createElement('button');
      b.className = 'setup-nudge-go'; b.id = 's-signup-signin-now'; b.textContent = 'sign in \u2192';
      b.addEventListener('click', toSignin);
      err.appendChild(document.createTextNode(' '));
      err.appendChild(b);
    }
  };

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    const email = inp.value.trim().toLowerCase();
    if (!isValidEmail(email)) { showErr('enter a valid email'); return; }
    showErr('');
    btn.textContent = 'sending...'; btn.disabled = true;
    const res = await signupSendCode(email);
    if (!res.ok) {
      btn.textContent = 'send me a code'; btn.disabled = false;
      showErr(res.error, res.code === 'already_registered');
      return;
    }
    showSetupSignupOtp(email);
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
}

function showSetupSignupOtp(email) {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-signup-otp">' +
    '<div class="setup-check-icon">&#9993;</div>' +
    '<button class="setup-back" id="s-otp-back">&larr;</button>' +
    '<h2 class="setup-h2">check your inbox</h2>' +
    '<div class="setup-check-sub">we sent a 6-digit code to <b>' + esc(email) + '</b></div>' +
    '<input class="setup-name-input" id="setup-otp" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" autocomplete="one-time-code" style="text-align:center;letter-spacing:8px;font-size:28px" autofocus/>' +
    '<div class="setup-inline-err" id="s-otp-err"></div>' +
    '<button class="setup-primary" id="s-otp-go">verify</button>' +
    '<button class="setup-skip" id="s-otp-resend">didn\'t get it? send a new code</button>' +
    '<button class="setup-skip" id="s-otp-retry">use a different email</button>' +
    '</div>' +
    '</div>';

  const otpInp = document.getElementById('setup-otp');
  const err = document.getElementById('s-otp-err');
  const verifyBtn = document.getElementById('s-otp-go');
  setTimeout(() => otpInp.focus(), 80);
  const reset = (msg) => { err.textContent = msg || ''; verifyBtn.textContent = 'verify'; verifyBtn.disabled = false; };

  verifyBtn.addEventListener('click', async () => {
    if (verifyBtn.disabled) return;
    const code = otpInp.value.trim();
    if (!/^\d{6}$/.test(code)) { err.textContent = 'enter the 6-digit code'; return; }
    err.textContent = '';
    verifyBtn.textContent = 'verifying...'; verifyBtn.disabled = true;
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(SUPABASE_URL + '/functions/v1/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
        body: JSON.stringify({ action: 'signup-verify', email, code }),
        signal: ctrl.signal
      });
      const result = await r.json();
      if (result.error || !result.token_hash) { reset(result.error || 'failed — try again'); return; }
      // Exchange the server-minted token for a session; onAuthStateChange
      // (SIGNED_IN, no profile yet) continues at the name step.
      const { error } = await sb.auth.verifyOtp({ token_hash: result.token_hash, type: 'magiclink' });
      if (error) { reset('couldn\'t sign you in — try again or request a new code'); return; }
      localStorage.setItem('pm_linked_email', email);
    } catch (e) {
      reset(e.name === 'AbortError' ? 'timed out — try again' : 'failed — try again');
    }
  });
  // Auto-submit when 6 digits entered
  otpInp.addEventListener('input', () => {
    if (otpInp.value.trim().length === 6) verifyBtn.click();
  });

  document.getElementById('s-otp-resend').addEventListener('click', async () => {
    const b = document.getElementById('s-otp-resend');
    if (b.disabled) return;
    b.disabled = true;
    const res = await signupSendCode(email);
    b.disabled = false;
    err.textContent = res.ok ? '' : res.error;
    if (res.ok) toast('new code sent to ' + email);
  });
  document.getElementById('s-otp-retry').addEventListener('click', () => showSetupSignupEmail(email));
  document.getElementById('s-otp-back').addEventListener('click', () => showSetupSignupEmail(email));
}

// Screen 2 — Name (called after magic link auth or as fallback)
async function showSetupScreen2(user, existingProfile, prefill) {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-2">' +
    '<button class="setup-back" id="s2-back">&larr;</button>' +
    '<h2 class="setup-h2">what should we call you?</h2>' +
    '<input class="setup-name-input" id="setup-name-2" placeholder="your name" value="' +
      esc(prefill || '') + '" autocomplete="off" autofocus/>' +
    '<button class="setup-primary" id="s2-rally">continue</button>' +
    '</div>' +
    '</div>';

  document.getElementById('s2-back').addEventListener('click', showSetup);

  // Focus + select the prefilled name
  const inp = document.getElementById('setup-name-2');
  setTimeout(() => { inp.focus(); inp.select(); }, 80);

  // Cap name length
  inp.maxLength = 30;

  document.getElementById('s2-rally').addEventListener('click', async () => {
    const n = inp.value.trim().toLowerCase().slice(0, 30);
    if (!n) { toast('enter your name first'); return; }
    const phone = null;
    const btn = document.getElementById('s2-rally');
    btn.textContent = '...'; btn.disabled = true;

    const color = AV_COLORS[Math.abs(hash(n)) % AV_COLORS.length];
    let newProfile;

    if (user) {
      if (existingProfile) {
        // Update existing nameless profile
        const upd = { name: n, color };
        if (phone) upd.phone = phone;
        const { data, error } = await sb.from('profiles')
          .update(upd)
          .eq('id', user.id).select().single();
        if (error) { toast('error saving name'); console.error(error); btn.textContent = 'continue'; btn.disabled = false; return; }
        newProfile = data;
      } else {
        // Create fresh profile
        const refId = getRefParam();
        const insert = { id: user.id, name: n, color, status: 'off', ambient: 'just joined' };
        if (phone) insert.phone = phone;
        if (refId && refId !== user.id) insert.referred_by = refId;
        const { data, error } = await sb.from('profiles').insert(insert).select().single();
        if (error) { toast('error creating profile'); console.error(error); btn.textContent = 'continue'; btn.disabled = false; return; }
        newProfile = data;
        if (refId && refId !== user.id) {
          sb.rpc('increment_referral', { referrer_id: refId }).then(() => {}).catch(() => {});
        }
      }
    } else {
      if (!FEATURES.anonSignup) {
        // Email-required signup: no auth user yet → collect + verify an email first.
        btn.textContent = 'continue'; btn.disabled = false;
        showSetupSignupEmail('');
        return;
      }
      // Anon path (emergency fallback behind FEATURES.anonSignup) — sign in first then create profile
      const { data: { user: anonUser }, error: authErr } = await sb.auth.signInAnonymously();
      if (authErr || !anonUser) {
        toast('trying email sign-in instead');
        btn.textContent = 'continue'; btn.disabled = false;
        showSetupEmail();
        return;
      }
      const refId = getRefParam();
      const insert = { id: anonUser.id, name: n, color, status: 'off', ambient: 'just joined' };
      if (phone) insert.phone = phone;
      if (refId && refId !== anonUser.id) insert.referred_by = refId;
      const { data, error } = await sb.from('profiles').insert(insert).select().single();
      if (error) { toast('error creating profile'); btn.textContent = 'continue'; btn.disabled = false; return; }
      newProfile = data;
      if (refId && refId !== anonUser.id) {
        sb.rpc('increment_referral', { referrer_id: refId }).then(() => {}).catch(() => {});
      }
    }

    profile = newProfile;
    homeState = 'off';
    clearRefParam();
    if (!roster.find(r => r.id === newProfile.id)) roster.push(newProfile);
    await loadRoster();
    subscribePings();
    setupSceneStep(showSetupScreen3);
  });
}

// Screen 3 — Push opt-in (T8 + T9)
function showSetupScreen3() {
  const root = document.getElementById('setup-root');

  // T9: detect platform
  const ios = isIOS();
  const standalone = isStandalonePWA();
  const pushOk = isPushSupported();

  let content = '';

  if (ios && !standalone) {
    // T9: iOS Safari without PWA install → show add-to-home-screen instructions
    content =
      '<div class="setup-pwa-icon">&#8679;</div>' +
      '<h2 class="setup-h2">add pingme to your home screen first</h2>' +
      '<div class="setup-pwa-steps">' +
      '<div class="setup-pwa-step">1. tap the <b>share</b> icon &#11014; at the bottom of Safari</div>' +
      '<div class="setup-pwa-step">2. scroll down and tap <b>add to home screen</b></div>' +
      '<div class="setup-pwa-step">3. tap <b>add</b> — then open pingme from your home screen</div>' +
      '</div>' +
      '<button class="setup-primary" id="s3-done">got it</button>' +
      '<div class="setup-disclaimer">so we can let you know when someone starts playing</div>';
  } else if (!pushOk) {
    // Android Chrome or other non-push browser → add-to-home instructions
    content =
      '<div class="setup-pwa-icon">&#8942;</div>' +
      '<h2 class="setup-h2">add pingme to your home screen</h2>' +
      '<div class="setup-pwa-steps">' +
      '<div class="setup-pwa-step">1. tap the menu <b>&#8942;</b> in your browser</div>' +
      '<div class="setup-pwa-step">2. tap <b>install app</b> or <b>add to home screen</b></div>' +
      '<div class="setup-pwa-step">3. open pingme from your home screen to get pings</div>' +
      '</div>' +
      '<button class="setup-primary" id="s3-done">got it</button>';
  } else {
    // Push is supported — ask for permission
    content =
      '<div class="setup-notif-art">' +
      '<div class="sna-phone">&#128241;</div>' +
      '<div class="sna-bubble">jake is looking for a game &#127955;</div>' +
      '</div>' +
      '<h2 class="setup-h2">want a heads up when someone starts playing?</h2>' +
      '<button class="setup-primary" id="s3-yes">yes, ping me</button>' +
      '<button class="setup-skip" id="s3-no">not now</button>';
  }

  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-3">' +
    content +
    '</div>' +
    '</div>';

  const done = () => {
    root.innerHTML = '';
    renderHome();
    registerPushSubscription();
    toast('welcome, ' + (profile?.name || 'raider'));
  };

  const doneBtn = document.getElementById('s3-done');
  if (doneBtn) doneBtn.addEventListener('click', done);

  const yesBtn = document.getElementById('s3-yes');
  if (yesBtn) {
    yesBtn.addEventListener('click', async () => {
      const p = await Notification.requestPermission();
      if (p === 'granted') {
        new Notification('pingme', { body: "you'll get pinged when raiders are down", icon: '/icon-192.png' });
      }
      done();
    });
  }

  const noBtn = document.getElementById('s3-no');
  if (noBtn) noBtn.addEventListener('click', done);
}

window.reqNotif = function () {
  if (!isPushSupported()) {
    if (isIOS() && !isStandalonePWA()) {
      toast('add pingme to your home screen first');
    } else {
      toast('not supported in this browser');
    }
    return;
  }
  Notification.requestPermission().then(p => {
    if (p === 'granted') {
      toast('pings are on');
      new Notification('pingme', { body: "you'll get pinged when someone wants to play", icon: '/icon-192.png' });
    } else toast('check browser settings');
  });
};

/* ── QR SHARE ── */
function showQrShare() {
  const url = getShareUrl();
  const wrap = document.getElementById('qr-box');
  if (wrap) {
    wrap.innerHTML = '';

    if (typeof qrcode !== 'undefined') {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      // Create styled QR with the retro theme
      const size = 160;
      const modules = qr.getModuleCount();
      const cellSize = Math.floor(size / modules);
      const canvas = document.createElement('canvas');
      canvas.width = cellSize * modules;
      canvas.height = cellSize * modules;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#F4EDDC';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#141210';
      for (let r = 0; r < modules; r++) {
        for (let c = 0; c < modules; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
          }
        }
      }
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.maxWidth = '160px';
      canvas.style.maxHeight = '160px';
      wrap.appendChild(canvas);
    } else {
      wrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">QR failed to load</div>';
    }
  }

  // Update visible share link text
  const linkText = document.getElementById('share-link');
  if (linkText) linkText.textContent = url.replace(/^https?:\/\//, '');

  // Copy / native-share button (one button, branches on capability)
  const copyBtn = document.getElementById('copy-link');
  if (copyBtn) {
    copyBtn.textContent = navigator.share ? 'share invite link' : 'copy invite link';
    copyBtn.onclick = () => {
      if (navigator.share) {
        navigator.share({ title: 'pingme', text: "see who's playing ping pong rn", url })
          .catch(() => {
            if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('link copied')).catch(() => toast('copy failed'));
          });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => toast('link copied')).catch(() => toast('copy failed'));
      } else {
        toast('copy failed');
      }
    };
  }

  // Close profile modal, open share
  document.getElementById('sheet-me').classList.remove('open');
  document.getElementById('sheet-share').classList.add('open');
}

/* ── CHAT (removed — using SMS deep links instead) ── */

/* ── EXPIRY ── */
async function expireStale() {
  try { await sb.rpc('expire_stale_profiles'); } catch (_) {
    let changed = false;
    const expireList = roster;
    expireList.forEach(r => {
      if (r.status === 'down' && r.started_at && r.duration) {
        if ((Date.now() - new Date(r.started_at).getTime()) / 60000 >= r.duration) {
          r.status = 'off'; r.venue = null; r.duration = null; r.started_at = null; changed = true;
        }
      }
      if (r.status === 'playing' && r.started_at) {
        if ((Date.now() - new Date(r.started_at).getTime()) / 60000 >= 90) {
          r.status = 'off'; r.venue = null; r.duration = null; r.started_at = null; changed = true;
        }
      }
    });
    if (!changed) return;
  }
  await loadRoster();
  const me = profile ? roster.find(r => r.id === profile.id) : null;
  if (me) homeState = me.status || 'off';
}

/* ── HELPERS ── */
function timeLeft(r) {
  if (!r.started_at || !r.duration) return '?';
  const rem = Math.max(0, Math.ceil(r.duration - (Date.now() - new Date(r.started_at).getTime()) / 60000));
  if (rem >= 60) return Math.floor(rem / 60) + 'h ' + rem % 60 + 'm';
  return rem + 'm';
}
function timeStr() {
  const d = new Date();
  let h = d.getHours(), m = d.getMinutes(), ap = 'am';
  if (h >= 12) { ap = 'pm'; if (h > 12) h -= 12; }
  if (h === 0) h = 12;
  return h + ':' + String(m).padStart(2, '0') + ap;
}
function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// profiles.color is client-writable — never trust it inside a style attribute.
function safeColor(c) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : '#E8502A';
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return h;
}
function toast(msg, dur) {
  dur = dur || 2500;
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), dur);
}
function maybeNotify(body) {
  if ('Notification' in window && Notification.permission === 'granted' && !localStorage.getItem('pm_notif_off')) {
    new Notification('pingme', { body, icon: '/icon-192.png', tag: 'pm-update', renotify: true });
  }
}
