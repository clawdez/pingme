/* pingme — v5 · all tasks */

// Feature flags — overridden on dev/preview deployments via window.PINGME_FEATURES in index.html
const FEATURES = Object.assign({
  matchTracking: false,           // #6: ELO + IRL match tracking + voice scoring
  accessCodes:   false,           // invite-only access codes
  leaderboardLinkedOnly: false,   // #10: gate leaderboard to email-linked accounts only
}, (typeof window !== 'undefined' && window.PINGME_FEATURES) || {});

const POLL_INTERVAL_MS = 60000; // #7: 60s fallback (was 10s) — realtime is primary

const SUPABASE_URL = 'https://jjgamvhvdqqjcizvpowk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpqZ2Ftdmh2ZHFxamNpenZwb3drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMjU2NDEsImV4cCI6MjA4OTgwMTY0MX0.GF-j2amwiz4qVz2TojP1vRmfHbNXRKj4cu7VAqfeodM';

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
let userLoc = null; // { lat, lng } from geolocation, ephemeral per session
const VENUE_TYPE_ICON = { public: '🌳', business: '🏪', private: '🏠' };
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
  }
  return list;
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
  const icon = VENUE_TYPE_ICON[v.type] || '📍';
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
  html += '<input class="venue-search" id="venue-search" type="text" placeholder="search or add a place…" value="' + searchVal + '" autocomplete="off"/>';
  html += '<button class="pm-loc-mini' + (userLoc ? ' active' : '') + '" id="pm-loc-near" type="button" title="use my location">📍</button>';
  html += '<input class="pm-loc-zip pm-loc-zip-mini" id="pm-loc-zip" type="text" inputmode="numeric" maxlength="6" placeholder="zip" value="' + zipVal + '"/>';
  html += '</div>';
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

  const zipInput = el.querySelector('#pm-loc-zip');
  if (zipInput) {
    zipInput.addEventListener('input', (e) => {
      venueZip = e.target.value;
      if (venueZip) localStorage.setItem('pm_zip', venueZip);
      else localStorage.removeItem('pm_zip');
      refreshVenueGrid(el);
    });
  }

  const nearBtn = el.querySelector('#pm-loc-near');
  if (nearBtn) {
    nearBtn.addEventListener('click', () => {
      if (userLoc) {
        userLoc = null;
        renderVenuePicker();
        return;
      }
      if (!navigator.geolocation) { toast('location not available'); return; }
      nearBtn.textContent = '📍 locating…';
      navigator.geolocation.getCurrentPosition(
        pos => {
          userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          // Persist on profile so push-notify radius filtering works
          if (sb && profile?.id) {
            sb.from('profiles').update({
              last_lat: userLoc.lat, last_lng: userLoc.lng,
              last_loc_at: new Date().toISOString()
            }).eq('id', profile.id).then(() => {}, () => {});
          }
          renderVenuePicker();
        },
        err => {
          nearBtn.textContent = '📍 use my location';
          toast('location denied');
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
      );
    });
  }

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
    const raw = await nominatimSearch(q);
    if (seq !== _vpSugSeq) return;
    const items = raw.map(formatNomResult).filter(r => r.name).slice(0, 4);
    if (!items.length) { sugEl.innerHTML = ''; return; }
    const nameSet = new Set(VENUES.map(v => v.name.toLowerCase().trim()));
    const fresh = items.filter(r => !nameSet.has(r.name.toLowerCase().trim()));
    if (!fresh.length) { sugEl.innerHTML = ''; return; }
    sugEl.innerHTML = '<div class="vp-sug-label">add a new spot</div>' + fresh.map((r, i) =>
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
          <input class="av-input av-search" id="av-search" autocomplete="off" placeholder="search a place…"/>
          <div class="av-results" id="av-results"></div>
        </div>
        <div class="av-picked" id="av-picked" style="display:none"></div>
        <div class="av-types">
          <button class="av-type active" data-type="public" type="button">🌳 public</button>
          <button class="av-type" data-type="business" type="button">🏪 business</button>
          <button class="av-type" data-type="private" type="button">🏠 private</button>
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
      if (q.length < 2) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; return; }
      const seq = ++_avSearchSeq;
      resultsEl.innerHTML = '<div class="av-result-loading">searching…</div>';
      resultsEl.style.display = 'block';
      _avSearchTimer = setTimeout(async () => {
        const raw = await nominatimSearch(q);
        if (seq !== _avSearchSeq) return;
        const items = raw.map(formatNomResult).filter(r => r.name);
        if (!items.length) { resultsEl.innerHTML = '<div class="av-result-loading">no matches</div>'; return; }
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
            pickedEl.innerHTML = '<span class="avp-pin">📍</span>'
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
  return profile ? location.origin + '?ref=' + profile.id : location.origin;
}

/* ── STATE ── */
let profile = null;
let roster = [];
let pings = [];
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
        await loadRoster();
        await loadPings();
        subscribePings();
        renderHome();
        registerPushSubscription();
        toast('welcome back, ' + profile.name);
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

  await loadRoster();
  await loadPings();
  subscribeRealtime();

  setTab('home');
  hideSplash();
  if (!profile) setTimeout(showSetup, 300);

  setInterval(async () => {
    await expireStale();
    // #7: polling is a true fallback now (60s). Realtime subscription is primary;
    // visibilitychange + heartbeat re-subscribe handle gaps.
    await loadRoster();
    if (profile) await loadPings();
    if (document.querySelector('[data-screen="home"].active')) renderHome();
  }, POLL_INTERVAL_MS);

  // #5: pull canonical venue list once we have a connection
  loadVenues();

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
    if (result.error) { toast(result.error); return false; }
    return true;
  } catch (e) { toast('sign in failed: ' + e.message); return false; }
}

async function loadOrCreateProfile(user) {
  const { data: existing } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (existing) {
    profile = await restoreTimers(existing);
    homeState = profile.status || 'off';
    // Nudge anonymous users to link email (once)
    if (!user.email && !localStorage.getItem('pm_link_nudge')) {
      localStorage.setItem('pm_link_nudge', '1');
      sb.from('pings').insert({
        from_id: user.id, to_id: user.id,
        verb: 'system',
        msg: 'your account will disappear if you log out or switch devices. connect your email now to save it.',
        unread: true
      }).then(() => updateNotisBadge());
    }
    if (FEATURES.accessCodes && !existing.invited_via) {
      const params = new URLSearchParams(location.search);
      if (params.get('code') || params.get('ref') || localStorage.getItem('pm_invited_via')) {
        setTimeout(() => { try { window.pmMatch?.claimAccessCode?.(); } catch {} }, 200);
      }
    }
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
}

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
    .select('id, name, color, status, venue, duration, started_at, ambient, referred_by, referral_count, play_count, email_verified, elo, wins, losses, last_lat, last_lng, notify_radius_km, updated_at, created_at')
    .order('updated_at', { ascending: false })
    .limit(200);
  // Fallback if newer columns don't exist yet on this Supabase instance
  if (error && error.message && /play_count|email_verified|elo|wins|losses/.test(error.message)) {
    const fallback = await sb.from('profiles')
      .select('id, name, color, status, venue, duration, started_at, ambient, referred_by, referral_count, updated_at, created_at')
      .order('updated_at', { ascending: false })
      .limit(200);
    data = fallback.data;
    error = fallback.error;
  }
  if (!error && data) roster = data;
}

async function loadPings() {
  if (!profile) { pings = []; return; }
  const { data, error } = await sb.from('pings')
    .select('*, from:profiles!pings_from_id_fkey(name, color)')
    .eq('to_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (!error && data) pings = data;
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
      if (payload.eventType === 'INSERT') {
        const exists = roster.find(r => r.id === payload.new.id);
        if (!exists) roster.push(payload.new);
        else Object.assign(exists, payload.new);
      } else if (payload.eventType === 'UPDATE') {
        const r = roster.find(x => x.id === payload.new.id);
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
function pushStatusChange(msg) {
  if (!profile) return;
  const v = getVenue();
  const origin = (v && v.lat != null && v.lng != null)
    ? { lat: v.lat, lng: v.lng }
    : (userLoc || null);
  const others = roster.filter(r => {
    if (r.id === profile.id) return false;
    if (!r.name || r.name.trim() === '' || r.name === 'anon') return false;
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
  if (e.type === 'touchend') e.preventDefault();
  document.getElementById('sheet-me').classList.add('open');
  renderMe();
  renderNotis();
  // Mark pings as read when modal opens
  if (profile && pings.some(p => p.unread)) {
    sb.from('pings').update({ unread: false }).eq('to_id', profile.id).eq('unread', true)
      .then(() => { pings.forEach(p => p.unread = false); updateNotisBadge(); });
  }
  setTimeout(() => { profileAvFiring = false; }, 300);
}
document.getElementById('profile-av').addEventListener('click', handleProfileAv);
document.getElementById('profile-av').addEventListener('touchend', handleProfileAv);

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
  if (targetState === 'down') {
    const pinged = await pingEveryone();
    toast(pinged ? 'pinged the squad' : 'you\'re down to play');
  } else if (targetState === 'playing') {
    pushStatusChange(profile.name + ' is playing at ' + getVenueName());
    toast('you\'re playing at ' + getVenueName());
  }
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
    document.getElementById('sheet-ping-confirm').classList.add('open');
  } else if (st === 'playing') {
    renderVenuePicker();
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
      'live &middot; ' + mins + 'm &middot; @ ' + getVenueName() +
      '</div>';
  } else {
    timer.innerHTML = '';
  }
}
function renderStrip() { renderLiveZone(); }

async function sendPushNotification(toId, fromId, msg) {
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
    const ini = r.ini || (r.name.slice(0, 1).toUpperCase() + r.name.slice(1, 2).toUpperCase());
    let sub = '';
    if (r.status === 'playing') {
      const m = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000) : 0;
      sub = (r.venue ? r.venue + ' · ' : '') + m + 'm';
    } else if (r.status === 'down') {
      sub = (r.venue ? r.venue + ' · ' : '') + timeLeft(r) + ' left';
    } else {
      sub = '';
    }
    const displayName = (isMe && profile && profile.name && profile.name !== 'anon')
      ? profile.name : r.name;
    const stClass = r.status === 'off' ? 'bub-away' : 'bub-' + r.status;
    const refs = r.referral_count || 0;
    return '<button class="rbub ' + stClass + '" data-id="' + r.id + '">' +
      '<div class="rbub-av-wrap">' +
      '<div class="rbub-av" style="background:' + (r.color || '#E8502A') + '">' + ini + '</div>' +
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
  const section = document.getElementById('section-leaderboard');
  const list = document.getElementById('lb-list');
  if (!section || !list) return;

  // Hide the elo tab when match tracking isn't enabled on this build
  if (!FEATURES.matchTracking) {
    section.querySelectorAll('.lb-tab[data-tab="elo"]').forEach(t => t.style.display = 'none');
    if (lbActiveTab === 'elo') lbActiveTab = 'players';
  }

  // Wire tabs
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
    const ini = r.name.slice(0, 1).toUpperCase() + r.name.slice(1, 2).toUpperCase();
    const isMe = profile && r.id === profile.id;
    const medal = i < 3 ? medals[i] : '<span class="lb-rank">' + (i + 1) + '</span>';
    let count, label;
    if (tab === 'players') { count = r.play_count || 0; label = count === 1 ? 'game' : 'games'; }
    else if (tab === 'elo') { count = r.elo || 1200; label = 'elo'; }
    else { count = r.referral_count || 0; label = 'invited'; }
    return '<div class="lb-row' + (isMe ? ' lb-me' : '') + '">' +
      '<span class="lb-medal">' + medal + '</span>' +
      '<div class="lb-av" style="background:' + (r.color || '#E8502A') + '">' + ini + '</div>' +
      '<span class="lb-name">' + esc(r.name) + (isMe ? ' <span class="lb-you">(you)</span>' : '') + '</span>' +
      '<span class="lb-count">' + count + ' ' + label + '</span>' +
      '</div>';
  }).join('');
}
window.renderLeaderboard = renderLeaderboard;

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
  const ini = r.ini || r.name.slice(0, 2).toUpperCase();
  const isMe = profile && r.id === profile.id;
  const canAct = profile && !isMe;

  // Status info
  let statusText = '', statusClass = 'rs-away', contextLine = '';
  if (r.status === 'playing') {
    const m = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000) : 0;
    statusText = 'playing';
    statusClass = 'rs-playing';
    contextLine = 'at ' + (r.venue || getVenueName()) + ' \u00b7 ' + m + ' min in';
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
    '<div class="rs-av" style="background:' + (r.color || '#E8502A') + '">' + ini + '</div>' +
    '<div class="rs-info">' +
    '<div class="rs-name">' + esc(r.name) + (isMe ? ' <span class="rs-you">you</span>' : '') + '</div>' +
    '<div class="rs-status ' + statusClass + '"><span class="rs-dot"></span>' + statusText + '</div>' +
    '</div>' +
    (canAct ? '<button class="rs-fav-icon" id="rs-fav-icon">' + (isFavorite(r.id) ? '\u2605' : '\u2606') + '</button>' : '') +
    '</div>';

  // Context line
  if (contextLine) {
    html += '<div class="rs-context">' + contextLine + '</div>';
  }

  // Ambient / activity
  if (r.ambient) {
    html += '<div class="rs-ambient">' + esc(r.ambient) + '</div>';
  }

  // Action buttons — ping is primary, text is secondary (SMS deep link)
  if (canAct) {
    const hasPhone = r.phone && r.phone.length >= 10;
    const showInvite = r.status === 'down';
    html +=
      '<div class="rs-actions">' +
      '<button class="rs-ping-btn" id="rs-ping-btn">&#127955; ping ' + esc(r.name) + '</button>' +
      (hasPhone
        ? '<a class="rs-msg-btn" href="sms:' + esc(r.phone) + '?body=' + encodeURIComponent((profile?.name || 'hey') + ' — down for ping pong?') + '" id="rs-msg-btn">&#128172;</a>'
        : '<button class="rs-msg-btn rs-msg-disabled" id="rs-msg-btn" disabled title="no phone number">&#128172;</button>') +
      '</div>' +
      (showInvite ? '<button class="rs-challenge-btn" id="rs-invite-venue-btn" style="background:var(--cobalt);color:#F4EDDC">&#128205; down to play at...</button>' : '') +
      (FEATURES.matchTracking ? '<button class="rs-challenge-btn" id="rs-challenge-btn">&#127935; challenge to a match</button>' : '');
  }

  modal.innerHTML = '<button class="modal-close" data-dismiss>&times;</button>' + html;

  // Wire actions
  if (canAct) {
    // Favorite toggle
    const favIcon = document.getElementById('rs-fav-icon');
    if (favIcon) {
      favIcon.onclick = () => {
        const added = toggleFavorite(r.id);
        favIcon.textContent = added ? '\u2605' : '\u2606';
        favIcon.classList.toggle('rs-fav-active', added);
        toast(added ? esc(r.name) + ' favorited' : esc(r.name) + ' unfavorited');
      };
      favIcon.classList.toggle('rs-fav-active', isFavorite(r.id));
    }

    // Ping
    document.getElementById('rs-ping-btn').onclick = async () => {
      const now = Date.now();
      if (now - lastPingTime < PING_COOLDOWN) { toast('slow down \u2014 wait a sec'); return; }
      lastPingTime = now;
      const btn = document.getElementById('rs-ping-btn');
      btn.textContent = 'sent!';
      btn.classList.add('rs-ping-sent');
      const pingMsg = profile.name + ' pinged you!';
      await sb.from('pings').insert({
        from_id: profile.id, to_id: r.id,
        verb: 'wants to play',
        msg: pingMsg,
        unread: true
      });
      // Push notification handled server-side via DB webhook on ping insert
      setTimeout(() => {
        document.getElementById('sheet-raider').classList.remove('open');
      }, 800);
    };

    // Challenge to a match
    const chBtn = document.getElementById('rs-challenge-btn');
    if (chBtn) {
      chBtn.onclick = () => {
        document.getElementById('sheet-raider').classList.remove('open');
        if (window.pmMatch?.open) window.pmMatch.open(r.id);
      };
    }

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

/* ── NOTIS — T7 welcome card ── */
function renderNotis() {
  const notisSub = document.getElementById('notis-sub');
  const pingList = document.getElementById('me-ping-list') || document.getElementById('ping-list');
  if (!pingList) return;
  const u = pings.filter(p => p.unread).length;
  const rr = pings.filter(p => !p.unread).length;
  if (notisSub) notisSub.textContent = u + ' new \u00b7 ' + rr + ' seen';

  // Update bell badge in the new pings header
  const pBadge = document.getElementById('me-pings-badge');
  if (pBadge) {
    pBadge.textContent = u;
    pBadge.style.display = u > 0 ? 'grid' : 'none';
  }
  // Toggle clear-all visibility
  const clearBtn = document.getElementById('clear-pings');
  if (clearBtn) clearBtn.style.display = pings.length ? 'inline-flex' : 'none';

  // T7: welcome card when no pings yet
  if (pings.length === 0) {
    pingList.innerHTML =
      '<div class="notis-welcome">' +
      '<div class="nw-icon">&#127955;</div>' +
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

  pingList.innerHTML = pings.map(p => {
    const from = p.from || {};
    const isSystem = p.verb === 'system';
    const avText = isSystem ? '&#9993;' : (from.name || '??').slice(0, 2).toUpperCase();
    const color = isSystem ? '#2563eb' : (from.color || '#E8502A');
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
        '<button class="pa-btn primary pa-start-match" data-from="' + p.from_id + '">&#127955; tap to start match</button>' +
        '</div>';
    } else {
      actions = '<div class="ping-actions"><button class="pa-btn taken">&#10003; ' + esc(acted) + '</button></div>';
    }

    const displayMsg = (p.msg || '').split('␟')[0]; // strip encoded venue id on invites
    return '<div class="ping-card ' + (p.unread ? 'unread' : '') + '" data-id="' + p.id + '">' +
      '<div class="pc-av" style="background:' + color + ';color:#F4EDDC">' + avText + '</div>' +
      '<div class="pc-body">' +
      '<div class="pc-who">' + esc(who) + (isSystem ? '' : ' <span class="pc-verb">' + esc(p.verb || '') + '</span>') + '</div>' +
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
      await sb.from('pings').update({ unread: false, action_taken: action }).eq('id', pingId);
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
    statusHtml = 'playing at ' + (me.venue || getVenueName()) + ' &middot; ' + m + ' min in';
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
  if (rankEl) rankEl.textContent = computeMyRankText();

  // Email / phone row state
  const cachedEmail = (profile && profile._linkedEmail) || localStorage.getItem('pm_linked_email');
  const rowEmail = document.getElementById('row-email');
  if (rowEmail) {
    rowEmail.classList.toggle('ok', !!cachedEmail || !!me.email_verified);
    rowEmail.title = cachedEmail ? ('email: ' + cachedEmail) : (me.email_verified ? 'email verified' : 'link email');
  }

  // ── settings panel + link-email banner live in #me-wrap (legacy) ──
  w.innerHTML =
    '<div class="me-settings-dropdown" id="me-settings-dd">' +
    '<button class="me-dd-item" id="sr-notif-link">' +
      '<span class="tog-switch ' + (notifOn ? 'on' : '') + '" id="notif-tog"><span class="knob"></span></span>' +
      ' notifications' +
    '</button>' +
    '<button class="me-dd-item" id="sr-test-notif">test notification</button>' +
    '<button class="me-dd-item" id="sr-invite">share link</button>' +
    '<button class="me-dd-item" id="sr-name-change">change name</button>' +
    '<button class="me-dd-item me-dd-danger" id="sr-signout">sign out</button>' +
    '<button class="me-dd-item me-dd-danger" id="sr-delete-acct">delete account</button>' +
    '</div>' +

    '<button class="me-link-acct-banner" id="me-link-acct" style="display:none">' +
    '&#9993; link email (save account)</button>' +
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

  // Gear toggle (top-right gear icon on the redesigned profile page)
  const gearBtn = document.getElementById('me-gear-top');
  if (gearBtn && !gearBtn._wired) {
    gearBtn._wired = true;
    gearBtn.addEventListener('click', () => {
      document.getElementById('me-settings-dd')?.classList.toggle('open');
    });
  }

  // Stat-row clicks → open rank / elo sheets
  const statRank = document.getElementById('stat-rank');
  if (statRank && !statRank._wired) {
    statRank._wired = true;
    statRank.addEventListener('click', () => {
      renderLeaderboard();
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

  // Email/Phone row icons
  const rowEmailEl = document.getElementById('row-email');
  if (rowEmailEl && !rowEmailEl._wired) {
    rowEmailEl._wired = true;
    rowEmailEl.addEventListener('click', () => {
      if (rowEmailEl.classList.contains('ok')) {
        toast(rowEmailEl.title || 'email linked');
      } else {
        showLinkEmail();
      }
    });
  }

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

  // Name change from dropdown
  document.getElementById('sr-name-change').addEventListener('click', () => {
    document.getElementById('me-settings-dd').classList.remove('open');
    startNameChange();
  });

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

  // Link email — show blue banner for anonymous users, or show linked email
  const linkAcctBanner = document.getElementById('me-link-acct');
  const linkedEmailEl = document.getElementById('me-linked-email');
  if (cachedEmail) {
    linkedEmailEl.style.display = '';
    linkedEmailEl.textContent = '✓ linked to ' + cachedEmail;
    linkAcctBanner.style.display = 'none';
  } else {
    // Show link banner immediately for anonymous users — don't block on async getSession
    linkAcctBanner.style.display = profile ? '' : 'none';
  }
  linkAcctBanner.addEventListener('click', () => showLinkEmail());

  // Share link
  document.getElementById('sr-invite').addEventListener('click', showQrShare);

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
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
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
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
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
    showSetupScreen2(null, null, '');
  });
  document.getElementById('s1-signin').addEventListener('click', () => {
    if (!sb) { toast('not connected'); return; }
    showSetupEmail();
  });
}
window.showSetup = showSetup;

// Screen 1b — Email sign-in via custom OTP
function showSetupEmail() {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-email">' +
    '<h2 class="setup-h2">enter your email</h2>' +
    '<input class="setup-name-input" id="setup-email" type="email" placeholder="your email" autocomplete="email" autofocus/>' +
    '<button class="setup-primary" id="s-email-go">send me a code</button>' +
    '<div class="setup-disclaimer">we\'ll send a 6-digit code — no password needed</div>' +
    '<button class="setup-skip" id="s-email-back">go back</button>' +
    '<button class="setup-skip" id="s-email-new">new here? create an account</button>' +
    '</div>' +
    '</div>';

  const inp = document.getElementById('setup-email');
  setTimeout(() => inp.focus(), 80);
  document.getElementById('s-email-back').addEventListener('click', showSetup);
  document.getElementById('s-email-new').addEventListener('click', () => showSetupScreen2(null, null, ''));

  document.getElementById('s-email-go').addEventListener('click', async () => {
    const email = inp.value.trim();
    if (!email || !email.includes('@')) { toast('enter a valid email'); return; }
    const btn = document.getElementById('s-email-go');
    btn.textContent = 'sending...'; btn.disabled = true;

    const ok = await signInSendCode(email);
    if (!ok) { btn.textContent = 'send me a code'; btn.disabled = false; return; }

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
      // Anon path — sign in first then create profile
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
    showSetupScreen3();
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
