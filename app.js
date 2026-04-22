/* pingme — v5 · all tasks */

const SUPABASE_URL = 'https://jjgamvhvdqqjcizvpowk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpqZ2Ftdmh2ZHFxamNpenZwb3drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMjU2NDEsImV4cCI6MjA4OTgwMTY0MX0.GF-j2amwiz4qVz2TojP1vRmfHbNXRKj4cu7VAqfeodM';

let sb = null;
try { sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON); }
catch (e) { console.error('Supabase failed to load:', e); }

const VENUES = [
  { id: 'sub', name: 'the sub', desc: 'Student Union' },
  { id: 'rec', name: 'the rec', desc: 'Rec Center' },
  { id: 'maggie', name: 'Maggie Trejo', desc: 'Supercenter' }
];
let selectedVenue = localStorage.getItem('pm_venue') || 'sub';
function getVenue() { return VENUES.find(v => v.id === selectedVenue) || VENUES[0]; }
function getVenueName() { return getVenue().name; }

const AV_COLORS = ['#E8502A','#2544D6','#6FD27B','#E8B84A','#BFA8E0','#FFD3B6','#FF9AA2','#B5EAD7'];

function renderVenuePicker() {
  const el = document.getElementById('venue-picker');
  if (!el) return;
  el.innerHTML = VENUES.map(v =>
    '<button class="venue-pill' + (v.id === selectedVenue ? ' active' : '') + '" data-venue="' + v.id + '">' +
    '<span class="vp-name">' + esc(v.name) + '</span>' +
    '<span class="vp-desc">' + esc(v.desc) + '</span>' +
    '</button>'
  ).join('');
  el.querySelectorAll('.venue-pill').forEach(btn =>
    btn.addEventListener('click', () => {
      selectedVenue = btn.dataset.venue;
      localStorage.setItem('pm_venue', selectedVenue);
      el.querySelectorAll('.venue-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    })
  );
}
const VAPID_PUBLIC = 'BDbHU5XWUWFF1p1n6uAO_4pIWhf0fb6c8cilk0ExCOafQKDsGa1QpNkvyqrUHBzC6WTybuNjO7GwBCWRG3tjiFM';

/* ── TASK 2A: SEED USERS ── */
const SEED_DEFS = [
  { id:'seed-jake',   name:'jake',   ini:'JM', color:'#BFA8E0', status:'playing', playMins: 18 },
  { id:'seed-maya',   name:'maya',   ini:'MK', color:'#2544D6', status:'playing', playMins: 34 },
  { id:'seed-leo',    name:'leo',    ini:'LO', color:'#E8502A', status:'down',    dur:60,  elapsed:15 },
  { id:'seed-alex',   name:'alex',   ini:'AW', color:'#E8B84A', status:'down',    dur:60,  elapsed:30 },
  { id:'seed-tessa',  name:'tessa',  ini:'TR', color:'#6FD27B', status:'down',    dur:120, elapsed:70 },
  { id:'seed-devon',  name:'devon',  ini:'DC', color:'#FF9AA2', status:'off', hoursAgo:1.2, displayStatus:'away' },
  { id:'seed-priya',  name:'priya',  ini:'PS', color:'#B5EAD7', status:'off', hoursAgo:2.5, displayStatus:'away' },
  { id:'seed-marcus', name:'marcus', ini:'MB', color:'#BFA8E0', status:'off', hoursAgo:0.7, displayStatus:'away' },
  { id:'seed-sam',    name:'sam',    ini:'SL', color:'#2544D6', status:'off', hoursAgo:3.1, displayStatus:'away' },
  { id:'seed-noor',   name:'noor',   ini:'NA', color:'#E8B84A', status:'off', hoursAgo:1.8, displayStatus:'away' },
  { id:'seed-riley',  name:'riley',  ini:'RF', color:'#6FD27B', status:'off', hoursAgo:4.2, displayStatus:'away' },
  { id:'seed-caleb',  name:'caleb',  ini:'CH', color:'#E8502A', status:'off', hoursAgo:0.4, displayStatus:'away' },
];

function buildSeedUsers() {
  const now = Date.now();
  return SEED_DEFS.map(d => {
    const u = { id: d.id, name: d.name, ini: d.ini, color: d.color, status: d.status, _seed: true, ambient: '' };
    if (d.status === 'playing') {
      u.started_at = new Date(now - d.playMins * 60000).toISOString();
      u.venue = getVenueName();
      u.updated_at = u.started_at;
      u.duration = null;
    } else if (d.status === 'down') {
      u.duration = d.dur;
      u.started_at = new Date(now - d.elapsed * 60000).toISOString();
      u.updated_at = u.started_at;
      u.venue = null;
    } else {
      u.updated_at = new Date(now - d.hoursAgo * 3600000).toISOString();
      u.duration = null; u.started_at = null; u.venue = null;
    }
    return u;
  });
}

let seedUsers = buildSeedUsers();

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

/* ── BOOT ── */
window.addEventListener('load', boot);

async function boot() {
  // Request persistent storage to prevent iOS from wiping data after 7 days
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // T2A: admin reseed route
  if (location.pathname === '/admin/reseed') {
    seedUsers = buildSeedUsers();
    document.body.innerHTML =
      '<div style="font-family:monospace;padding:40px;background:#F4EDDC;min-height:100vh">' +
      '<h2 style="font-family:sans-serif">✓ seed regenerated</h2>' +
      '<p style="margin:12px 0">' + seedUsers.length + ' mock raiders rebuilt.</p>' +
      '<a href="/" style="color:#2544D6">← back to app</a></div>';
    return;
  }

  if (!sb) {
    setTab('home');
    renderHome();
    setTimeout(showSetup, 300);
    return;
  }

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await loadOrCreateProfile(session.user);
  } catch (e) { console.error('Auth check failed:', e); toast('connecting...'); }

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      // T8: detect new vs returning user
      const { data: existing } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
      if (existing && existing.name) {
        // Returning user — already onboarded
        profile = existing;
        homeState = existing.status || 'off';
        // Restore expiry timer if returning as "down"
        if (existing.status === 'down' && existing.started_at && existing.duration) {
          const msLeft = (existing.duration * 60000) - (Date.now() - new Date(existing.started_at).getTime());
          if (msLeft > 0) {
            downDur = existing.duration;
            downExpiryTimer = setTimeout(() => { toast('your down window expired'); snapTo('off'); }, msLeft);
            // Schedule 5-min reminder if enough time left
            const reminderMs = msLeft - 5 * 60000;
            if (reminderMs > 60000) {
              downReminderTimer = setTimeout(() => {
                toast('5 min left on your down window');
                maybeNotify('5 minutes left — find your game!');
              }, reminderMs);
            }
          } else {
            // Expired while offline — immediately set to off
            homeState = 'off';
            existing.status = 'off';
            profile = existing;
            await sb.from('profiles').update({ status: 'off', venue: null, duration: null, started_at: null }).eq('id', existing.id);
          }
        }
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
  if (!profile) setTimeout(showSetup, 300);

  setInterval(async () => {
    await expireStale();
    if (document.querySelector('[data-screen="home"].active')) renderHome();
  }, 45000);
}

/* ── AUTH ── */
async function signInWithMagicLink(email) {
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: 'https://pingme-iota.vercel.app' }
  });
  if (error) { toast('sign in failed: ' + error.message); return false; }
  return true;
}

async function loadOrCreateProfile(user) {
  const { data: existing } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (existing) {
    profile = existing; homeState = existing.status || 'off';
    // Restore expiry timer if returning as "down"
    if (existing.status === 'down' && existing.started_at && existing.duration) {
      const msLeft = (existing.duration * 60000) - (Date.now() - new Date(existing.started_at).getTime());
      if (msLeft > 0) {
        downDur = existing.duration;
        downExpiryTimer = setTimeout(() => { toast('your down window expired'); snapTo('off'); }, msLeft);
        const reminderMs = msLeft - 5 * 60000;
        if (reminderMs > 60000) {
          downReminderTimer = setTimeout(() => {
            toast('5 min left on your down window');
            maybeNotify('5 minutes left — find your game!');
          }, reminderMs);
        }
      } else {
        // Expired while offline — immediately set to off
        homeState = 'off';
        profile.status = 'off';
        await sb.from('profiles').update({ status: 'off', venue: null, duration: null, started_at: null }).eq('id', existing.id);
      }
    }
    // Restore expiry timer if returning as "playing"
    if (existing.status === 'playing' && existing.started_at) {
      const msLeft = (90 * 60000) - (Date.now() - new Date(existing.started_at).getTime());
      if (msLeft > 0) {
        playingExpiryTimer = setTimeout(() => { toast('playing session expired after 90 min'); snapTo('off'); }, msLeft);
      } else {
        homeState = 'off';
        profile.status = 'off';
        await sb.from('profiles').update({ status: 'off', venue: null, duration: null, started_at: null }).eq('id', existing.id);
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
  if (!profile || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
      });
    }
    // Store subscription in Supabase
    const subJson = sub.toJSON();
    await sb.from('push_subscriptions').upsert({
      user_id: profile.id,
      endpoint: subJson.endpoint,
      keys_p256dh: subJson.keys.p256dh,
      keys_auth: subJson.keys.auth,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
  } catch (e) { console.error('Push sub failed:', e); }
}

/* ── DATA ── */
async function loadRoster() {
  const { data, error } = await sb.from('profiles').select('*').order('updated_at', { ascending: false });
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

function subscribeRealtime() {
  sb.channel('profiles-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
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
    .subscribe();
  subscribePings();
}

function subscribePings() {
  if (!profile || pingsSubscribed) return;
  pingsSubscribed = true;
  sb.channel('pings-realtime')
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'pings',
      filter: 'to_id=eq.' + profile.id
    }, async () => {
      await loadPings();
      updateNotisBadge();
      maybeNotify('new ping!');
    })
    .subscribe();
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
function setTab(t) {
  if (t === 'home') renderHome();
}

// Avatar → open combined profile + notis modal
document.getElementById('profile-av').addEventListener('click', () => {
  renderMe();
  renderNotis();
  document.getElementById('sheet-me').classList.add('open');
});

/* ── SHEETS ── */
document.querySelectorAll('[data-dismiss]').forEach(el =>
  el.addEventListener('click', () => {
    const wrap = el.closest('.sheet-wrap');
    wrap.classList.remove('open');
    // If ping confirm dismissed, revert to previous state
    if (wrap.id === 'sheet-ping-confirm' && profile && profile.status !== homeState) {
      homeState = profile.status || 'off';
      app.dataset.homeState = homeState;
      placeBall(SNAP[homeState], true);
      renderRoster();
    }
  })
);

// Ping confirm buttons
document.getElementById('confirm-ping').addEventListener('click', async () => {
  document.getElementById('sheet-ping-confirm').classList.remove('open');
  const targetState = homeState; // 'down' or 'playing'
  if (targetState === 'down') downDur = 60;
  const ok = await setMyStatus(targetState);
  if (!ok) {
    homeState = profile?.status || 'off';
    app.dataset.homeState = homeState;
    placeBall(SNAP[homeState], true);
    renderRoster();
    return;
  }
  renderHome();
  if (targetState === 'down') {
    await pingEveryone();
    toast('pinged the squad');
  } else {
    toast('you\'re playing at ' + getVenueName());
  }
});

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
  dismissTooltip(); // T6
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

document.querySelectorAll('.c-lbl').forEach(b =>
  b.addEventListener('click', () => { dismissTooltip(); snapTo(b.dataset.state); })
);
lp.addEventListener('click', () => { if (!dragging) { dismissTooltip(); snapTo('down'); } });
rp.addEventListener('click', () => { if (!dragging) { dismissTooltip(); snapTo('playing'); } });

/* ── T6: TOOLTIP (always visible) ── */
function dismissTooltip() { /* no-op — eyebrow stays visible */ }

/* ── STATE ── */
function setHomeState(st) {
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
    setMyStatus(st);
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
  const { error } = await sb.from('profiles').update(updates).eq('id', profile.id);
  if (error) { toast('update failed'); console.error(error); return false; }
  Object.assign(profile, updates);
  const me = roster.find(r => r.id === profile.id);
  if (me) Object.assign(me, updates);
  return true;
}

/* ── RENDER HOME ── */
function renderHome() {
  updateNotisBadge();
  updateProfileAv();
  renderLiveZone();
  renderRoster();
  placeBall(SNAP[homeState], false);
  app.dataset.homeState = homeState;
  setTimeout(() => { if (!dragging) ball.classList.add('at-rest'); }, 100);
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
  if (profile) {
    av.textContent = profile.name.slice(0, 1).toUpperCase() + profile.name.slice(1, 2).toUpperCase();
    av.style.background = profile.color || AV_COLORS[Math.abs(hash(profile.name)) % AV_COLORS.length];
  } else {
    av.textContent = '?'; av.style.background = '';
  }
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

async function pingEveryone() {
  if (!profile) return;
  const now = Date.now();
  if (now - lastPingTime < PING_COOLDOWN) { toast('slow down — wait a sec'); return; }
  lastPingTime = now;
  const others = roster.filter(r => r.id !== profile.id && r.name && r.name !== 'anon');
  const rows = others.map(r => ({
    from_id: profile.id, to_id: r.id,
    verb: 'is down to play',
    msg: profile.name + ' is down — you in?',
    unread: true
  }));
  if (rows.length) {
    await sb.from('pings').insert(rows);
  }
}


/* ── T2: MERGED RAIDERS (real + seed) ── */
function allRaiders() {
  // Always include yourself even if name is 'anon'
  const real = roster.filter(r => {
    if (profile && r.id === profile.id) return true;
    return r.name && r.name !== 'anon';
  });
  // Hide seed users once there are 3+ real users
  if (real.length < 3) {
    const maxSeeds = profile ? seedUsers.length : 5;
    return [...real, ...seedUsers.slice(0, maxSeeds)];
  }
  return real;
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
    const showDemoBadge = r._seed && r.status === 'off';
    return '<button class="rbub ' + stClass + (r._seed ? ' rbub-seed' : '') + '" data-id="' + r.id + '">' +
      '<div class="rbub-av-wrap">' +
      '<div class="rbub-av" style="background:' + (r.color || '#E8502A') + '">' + ini + '</div>' +
      (isMe ? '<span class="rbub-you">you</span>' : (showDemoBadge ? '<span class="rbub-demo">demo</span>' : '')) +
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

  // Wire bubble clicks
  document.querySelectorAll('.section-list .rbub').forEach(bub =>
    bub.addEventListener('click', () => {
      const r = allRaiders().find(x => x.id === bub.dataset.id);
      if (r) openRaiderSheet(r);
    })
  );
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

function openRaiderSheet(r) {
  const modal = document.querySelector('#sheet-raider .modal-center');
  const ini = r.ini || r.name.slice(0, 2).toUpperCase();
  const isMe = profile && r.id === profile.id;
  const canAct = profile && !isMe && !r._seed;

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

  // Action buttons — ping is primary, message is secondary
  if (canAct) {
    html +=
      '<div class="rs-actions">' +
      '<button class="rs-ping-btn" id="rs-ping-btn">&#127955; ping ' + esc(r.name) + '</button>' +
      '<button class="rs-msg-btn" id="rs-msg-btn">&#128172;</button>' +
      '</div>';
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
      await sb.from('pings').insert({
        from_id: profile.id, to_id: r.id,
        verb: 'wants to play',
        msg: profile.name + ' pinged you!',
        unread: true
      });
      setTimeout(() => {
        document.getElementById('sheet-raider').classList.remove('open');
      }, 800);
    };

    // Message
    document.getElementById('rs-msg-btn').onclick = () => openChat(r);
  }

  document.getElementById('sheet-raider').classList.add('open');
}

/* ── NOTIS — T7 welcome card ── */
function renderNotis() {
  const notisSub = document.getElementById('notis-sub');
  const pingList = document.getElementById('ping-list');
  const u = pings.filter(p => p.unread).length;
  const rr = pings.filter(p => !p.unread).length;
  notisSub.textContent = u + ' new \u00b7 ' + rr + ' seen';

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
    const avText = (from.name || '??').slice(0, 2).toUpperCase();
    const color = from.color || '#E8502A';
    const who = from.name || 'someone';
    const ago = timeAgo(p.created_at);
    const acted = p.action_taken;

    let actions = '';
    if (!acted) {
      actions = '<div class="ping-actions">' +
        '<button class="pa-btn primary" data-ping="' + p.id + '" data-action="on my way">on my way</button>' +
        '<button class="pa-btn" data-ping="' + p.id + '" data-action="maybe">maybe</button>' +
        '<button class="pa-btn" data-ping="' + p.id + '" data-action="can\'t">can\'t</button>' +
        '</div>';
    } else {
      actions = '<div class="ping-actions"><button class="pa-btn taken">&#10003; ' + esc(acted) + '</button></div>';
    }

    return '<div class="ping-card ' + (p.unread ? 'unread' : '') + '" data-id="' + p.id + '">' +
      '<div class="pc-av" style="background:' + color + ';color:#F4EDDC">' + avText + '</div>' +
      '<div class="pc-body">' +
      '<div class="pc-who">' + esc(who) + ' <span class="pc-verb">' + esc(p.verb || '') + '</span></div>' +
      '<div class="pc-msg">' + esc(p.msg || '') + '</div>' +
      '<div class="pc-time">' + ago + '</div>' +
      actions + '</div></div>';
  }).join('') + '<div class="empty-hint">that\'s the lot. go play.</div>';

  pingList.querySelectorAll('.pa-btn[data-ping]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const pingId = btn.dataset.ping;
      const action = btn.dataset.action;
      if (!action) return;
      await sb.from('pings').update({ unread: false, action_taken: action }).eq('id', pingId);
      const p = pings.find(x => x.id === pingId);
      if (p) { p.unread = false; p.action_taken = action; }
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
}

/* ── ME — T1: truly minimal ── */
function renderMe() {
  const w = document.getElementById('me-wrap');

  if (!profile) {
    w.innerHTML =
      '<div class="me-hero-min">' +
      '<div class="me-av-tap" style="background:var(--muted-2);font-size:20px;width:52px;height:52px">?</div>' +
      '<div class="me-hero-text">' +
      '<div class="me-name-min" style="font-size:20px">not signed in</div>' +
      '</div>' +
      '</div>' +
      '<button class="setup-primary" style="font-size:20px;padding:14px;border-radius:16px" onclick="showSetup()">sign in to play</button>';
    return;
  }

  const ini = profile.name.slice(0, 2).toUpperCase() || '??';
  const col = profile.color || AV_COLORS[Math.abs(hash(profile.name)) % AV_COLORS.length];
  const me = roster.find(r => r.id === profile.id) || profile;

  let nowIc = '&#9898;', nowHd = "you're away", nowSub = 'drag the ball to change your status';
  if (me.status === 'playing') {
    nowIc = '&#127955;';
    nowHd = 'playing at ' + (me.venue || getVenueName());
    const m = me.started_at ? Math.floor((Date.now() - new Date(me.started_at).getTime()) / 60000) : 0;
    nowSub = 'since ' + timeStr() + ' &middot; ' + m + ' min in';
  } else if (me.status === 'down') {
    nowIc = '&#9203;';
    const dur = me.duration === 30 ? '30 min' : me.duration === 60 ? '1 hour' : '2 hours';
    nowHd = 'down for ' + dur;
    nowSub = timeLeft(me) + ' remaining';
  }

  const notifOn = typeof Notification !== 'undefined' && Notification.permission === 'granted' && !localStorage.getItem('pm_notif_off');

  // Layout: avatar + name + gear → notis feed
  w.innerHTML =
    '<div class="me-hero-min">' +
    '<button class="me-av-tap" id="me-av-btn" style="background:' + col + '" title="tap to change color">' + ini + '</button>' +
    '<div class="me-hero-text">' +
    '<div class="me-name-min" id="me-name-display">' + esc(profile.name) + ' <span class="me-name-edit">&#9998;</span></div>' +
    '</div>' +
    '<button class="me-gear" id="me-gear">&#9881;</button>' +
    '</div>' +

    '<div class="me-settings-dropdown" id="me-settings-dd">' +
    '<button class="me-dd-item" id="sr-notif-link">' +
      '<span class="tog-switch ' + (notifOn ? 'on' : '') + '" id="notif-tog"><span class="knob"></span></span>' +
      ' notifications' +
    '</button>' +
    '<button class="me-dd-item" id="sr-invite">share link</button>' +
    '<button class="me-dd-item" id="sr-name-change">change name</button>' +
    '<button class="me-dd-item" id="sr-link-email" style="display:none">link email (save account)</button>' +
    '<button class="me-dd-item me-dd-danger" id="sr-signout">sign out</button>' +
    '</div>';

  // Avatar: tap cycles color
  let colorIdx = AV_COLORS.indexOf(col);
  if (colorIdx === -1) colorIdx = 0;
  document.getElementById('me-av-btn').addEventListener('click', async () => {
    colorIdx = (colorIdx + 1) % AV_COLORS.length;
    const newColor = AV_COLORS[colorIdx];
    document.getElementById('me-av-btn').style.background = newColor;
    profile.color = newColor;
    updateProfileAv();
    if (sb) await sb.from('profiles').update({ color: newColor }).eq('id', profile.id);
  });

  // Gear toggle
  document.getElementById('me-gear').addEventListener('click', () => {
    document.getElementById('me-settings-dd').classList.toggle('open');
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
      toast(nowOn ? 'notifications off' : 'notifications on');
    } else if (Notification.permission === 'denied') {
      toast('blocked — check browser settings');
    } else {
      const p = await Notification.requestPermission();
      if (p === 'granted') {
        tog.classList.add('on');
        localStorage.removeItem('pm_notif_off');
        toast('pings are on');
      } else {
        tog.classList.remove('on');
        toast('permission denied — check browser settings');
      }
    }
  });

  // Link email — show only for anonymous users
  const linkEmailBtn = document.getElementById('sr-link-email');
  sb.auth.getSession().then(({ data: { session } }) => {
    if (session && !session.user.email) linkEmailBtn.style.display = '';
  });
  linkEmailBtn.addEventListener('click', () => {
    document.getElementById('me-settings-dd').classList.remove('open');
    showLinkEmail();
  });

  // Share link
  document.getElementById('sr-invite').addEventListener('click', showQrShare);

  // Sign out
  document.getElementById('sr-signout').addEventListener('click', async () => {
    if (downExpiryTimer) { clearTimeout(downExpiryTimer); downExpiryTimer = null; }
    if (downReminderTimer) { clearTimeout(downReminderTimer); downReminderTimer = null; }
    if (playingExpiryTimer) { clearTimeout(playingExpiryTimer); playingExpiryTimer = null; }
    if (profile) {
      await sb.from('profiles').update({
        status: 'off', venue: null, duration: null, started_at: null
      }).eq('id', profile.id);
    }
    await sb.auth.signOut();
    profile = null; homeState = 'off';
    placeBall(SNAP.off, true);
    app.dataset.homeState = 'off';
    toast('signed out');
    document.getElementById('sheet-me').classList.remove('open');
    renderHome();
  });
}

function showLinkEmail() {
  const modal = document.querySelector('#sheet-me .modal-center');
  const meWrap = document.getElementById('me-wrap');
  meWrap.innerHTML =
    '<div style="padding:20px 0">' +
    '<h2 class="setup-h2">link your email</h2>' +
    '<div class="setup-check-sub" style="margin-bottom:16px">save your account so you can log in on other devices</div>' +
    '<input class="setup-name-input" id="link-email-input" type="email" placeholder="you@school.edu" autocomplete="email" autofocus/>' +
    '<button class="setup-primary" id="link-email-go" style="margin-top:12px">send code</button>' +
    '<button class="setup-skip" id="link-email-cancel">cancel</button>' +
    '</div>';

  setTimeout(() => document.getElementById('link-email-input').focus(), 80);

  document.getElementById('link-email-cancel').addEventListener('click', () => renderMe());

  document.getElementById('link-email-go').addEventListener('click', async () => {
    const email = document.getElementById('link-email-input').value.trim();
    if (!email || !email.includes('@')) { toast('enter a valid email'); return; }
    const btn = document.getElementById('link-email-go');
    btn.textContent = 'sending...'; btn.disabled = true;

    const { error } = await sb.auth.updateUser({ email });
    if (error) { toast('failed: ' + error.message); btn.textContent = 'send code'; btn.disabled = false; return; }

    meWrap.innerHTML =
      '<div style="padding:20px 0">' +
      '<div class="setup-check-icon">&#9993;</div>' +
      '<h2 class="setup-h2">check your inbox</h2>' +
      '<div class="setup-check-sub">tap the confirmation link sent to <b>' + esc(email) + '</b></div>' +
      '<button class="setup-skip" id="link-email-done">done</button>' +
      '</div>';

    document.getElementById('link-email-done').addEventListener('click', () => renderMe());
  });
}

function renderFavoritesList() {
  const container = document.getElementById('me-favorites');
  if (!container) return;
  const favIds = getFavorites();
  const allR = roster.filter(r => r.name && r.name !== 'anon');
  const favUsers = favIds.map(id => allR.find(r => r.id === id)).filter(Boolean);

  if (favUsers.length === 0) {
    container.innerHTML =
      '<div class="fav-empty">no favorites yet — tap a player and hit <b>favorite</b></div>';
    return;
  }

  container.innerHTML = '<div class="bub-grid">' + favUsers.map(r => {
    const ini = r.ini || (r.name.slice(0, 1).toUpperCase() + r.name.slice(1, 2).toUpperCase());
    const stClass = r.status === 'off' ? 'bub-away' : 'bub-' + r.status;
    return '<button class="rbub ' + stClass + '" data-fav-id="' + r.id + '">' +
      '<div class="rbub-av-wrap">' +
      '<div class="rbub-av" style="background:' + (r.color || '#E8502A') + '">' + ini + '</div>' +
      '<span class="rbub-fav-star">\u2605</span>' +
      '</div>' +
      '<div class="rbub-name">' + esc(r.name) + '</div>' +
      '<div class="rbub-sub">' + r.status + '</div>' +
      '</button>';
  }).join('') + '</div>';

  container.querySelectorAll('[data-fav-id]').forEach(bub =>
    bub.addEventListener('click', () => {
      const r = allR.find(x => x.id === bub.dataset.favId);
      if (r) {
        document.getElementById('sheet-me').classList.remove('open');
        setTimeout(() => openRaiderSheet(r), 200);
      }
    })
  );
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
    '</div>' + // end s-page-1
    '</div>'; // end setup-fs

  document.getElementById('s1-in').addEventListener('click', () => {
    if (!sb) { toast('not connected'); return; }
    showSetupScreen2(null, null, '');
  });
}
window.showSetup = showSetup;

// Screen 1b — Email input for magic link
function showSetupEmail() {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-email">' +
    '<h2 class="setup-h2">enter your email</h2>' +
    '<input class="setup-name-input" id="setup-email" type="email" placeholder="you@school.edu" autocomplete="email" autofocus/>' +
    '<button class="setup-primary" id="s-email-go">send me a code</button>' +
    '<div class="setup-disclaimer">we\'ll send a 6-digit code — no password needed</div>' +
    '</div>' +
    '</div>';

  const inp = document.getElementById('setup-email');
  setTimeout(() => inp.focus(), 80);

  document.getElementById('s-email-go').addEventListener('click', async () => {
    const email = inp.value.trim();
    if (!email || !email.includes('@')) { toast('enter a valid email'); return; }
    const btn = document.getElementById('s-email-go');
    btn.textContent = 'sending...'; btn.disabled = true;

    const ok = await signInWithMagicLink(email);
    if (!ok) { btn.textContent = 'send me a link'; btn.disabled = false; return; }

    // Show "enter code" screen
    const root = document.getElementById('setup-root');
    root.innerHTML =
      '<div class="setup-fs">' +
      '<div class="setup-page s-slide-in">' +
      '<div class="setup-check-icon">&#9993;</div>' +
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
      const { data, error } = await sb.auth.verifyOtp({ email, token: code, type: 'email' });
      if (error) {
        toast('invalid code — try again');
        verifyBtn.textContent = 'verify'; verifyBtn.disabled = false;
        return;
      }
      // Auth succeeded — onAuthStateChange will handle the rest
    });

    // Auto-submit when 6 digits entered
    otpInp.addEventListener('input', () => {
      if (otpInp.value.trim().length === 6) {
        document.getElementById('s-otp-go').click();
      }
    });

    document.getElementById('s-email-retry').addEventListener('click', showSetupEmail);
  });
}

// Screen 2 — Name (called after magic link auth or as fallback)
async function showSetupScreen2(user, existingProfile, prefill) {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-2">' +
    '<h2 class="setup-h2">what should we call you?</h2>' +
    '<input class="setup-name-input" id="setup-name-2" placeholder="your name" value="' +
      esc(prefill || '') + '" autocomplete="off" autofocus/>' +
    '<button class="setup-primary" id="s2-rally">continue</button>' +
    '<div class="setup-disclaimer">you can change this anytime</div>' +
    '</div>' +
    '</div>';

  // Focus + select the prefilled name
  const inp = document.getElementById('setup-name-2');
  setTimeout(() => { inp.focus(); inp.select(); }, 80);

  // Cap name length
  inp.maxLength = 30;

  document.getElementById('s2-rally').addEventListener('click', async () => {
    const n = inp.value.trim().toLowerCase().slice(0, 30);
    if (!n) { toast('enter your name first'); return; }
    const btn = document.getElementById('s2-rally');
    btn.textContent = '...'; btn.disabled = true;

    const color = AV_COLORS[Math.abs(hash(n)) % AV_COLORS.length];
    let newProfile;

    if (user) {
      if (existingProfile) {
        // Update existing nameless profile
        const { data, error } = await sb.from('profiles')
          .update({ name: n, color })
          .eq('id', user.id).select().single();
        if (error) { toast('error saving name'); console.error(error); btn.textContent = 'continue'; btn.disabled = false; return; }
        newProfile = data;
      } else {
        // Create fresh profile
        const { data, error } = await sb.from('profiles').insert({
          id: user.id, name: n, color, status: 'off', ambient: 'just joined'
        }).select().single();
        if (error) { toast('error creating profile'); console.error(error); btn.textContent = 'continue'; btn.disabled = false; return; }
        newProfile = data;
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
      const { data, error } = await sb.from('profiles').insert({
        id: anonUser.id, name: n, color, status: 'off', ambient: 'just joined'
      }).select().single();
      if (error) { toast('error creating profile'); btn.textContent = 'continue'; btn.disabled = false; return; }
      newProfile = data;
    }

    profile = newProfile;
    homeState = 'off';
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
        new Notification('pingme', { body: "you\'ll get pinged when raiders are down &#127955;" });
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
      new Notification('pingme', { body: "you'll get pinged when someone wants to play" });
    } else toast('check browser settings');
  });
};

/* ── QR SHARE ── */
function showQrShare() {
  const url = location.origin;
  const wrap = document.getElementById('qr-canvas-wrap');
  wrap.innerHTML = '';

  if (typeof qrcode !== 'undefined') {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    // Create styled QR with the retro theme
    const size = 200;
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
    canvas.style.width = '200px';
    canvas.style.height = '200px';
    canvas.style.borderRadius = '14px';
    canvas.style.border = '2.5px solid #141210';
    canvas.style.boxShadow = '4px 4px 0 #141210';
    wrap.appendChild(canvas);
  } else {
    wrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">QR failed to load</div>';
  }

  document.getElementById('qr-url-text').textContent = url;

  document.getElementById('qr-copy').onclick = () => {
    navigator.clipboard.writeText(url)
      .then(() => { toast('link copied'); })
      .catch(() => toast('copy failed'));
  };

  // Close profile modal, open QR
  document.getElementById('sheet-me').classList.remove('open');
  document.getElementById('sheet-qr').classList.add('open');
}

/* ── CHAT ── */
let chatWith = null; // profile object of the person we're chatting with
let chatMessages = [];
let chatChannel = null;

function chatRoomId(a, b) {
  return [a, b].sort().join('_');
}

async function openChat(raider) {
  if (!profile || !raider || raider._seed) return;
  chatWith = raider;
  const roomId = chatRoomId(profile.id, raider.id);

  // Close other modals
  document.getElementById('sheet-raider').classList.remove('open');

  // Render header
  const ini = raider.ini || raider.name.slice(0, 2).toUpperCase();
  document.getElementById('chat-header').innerHTML =
    '<div class="chat-av" style="background:' + (raider.color || '#E8502A') + '">' + ini + '</div>' +
    '<div class="chat-with">' + esc(raider.name) + '</div>';

  // Load messages
  const { data } = await sb.from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true })
    .limit(50);
  chatMessages = data || [];
  renderChatMessages();

  // Subscribe to new messages
  if (chatChannel) { sb.removeChannel(chatChannel); chatChannel = null; }
  chatChannel = sb.channel('chat-' + roomId)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: 'room_id=eq.' + roomId
    }, (payload) => {
      chatMessages.push(payload.new);
      renderChatMessages();
    })
    .subscribe();

  document.getElementById('sheet-chat').classList.add('open');
  setTimeout(() => document.getElementById('chat-input').focus(), 200);
}

function renderChatMessages() {
  const el = document.getElementById('chat-messages');
  if (chatMessages.length === 0) {
    el.innerHTML = '<div class="chat-empty">no messages yet — say hi!</div>';
    return;
  }
  el.innerHTML = chatMessages.map(m => {
    const isMe = profile && m.sender_id === profile.id;
    return '<div class="chat-msg ' + (isMe ? 'chat-me' : 'chat-them') + '">' +
      '<div class="chat-bubble">' + esc(m.body) + '</div>' +
      '<div class="chat-time">' + timeAgo(m.created_at) + '</div>' +
      '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function sendChatMessage() {
  if (!profile || !chatWith) return;
  const inp = document.getElementById('chat-input');
  const body = inp.value.trim();
  if (!body) return;
  inp.value = '';

  const roomId = chatRoomId(profile.id, chatWith.id);
  await sb.from('messages').insert({
    room_id: roomId,
    sender_id: profile.id,
    receiver_id: chatWith.id,
    body: body.slice(0, 200)
  });
}

// Wire chat send
document.getElementById('chat-send').addEventListener('click', sendChatMessage);
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
});

// Clean up chat channel when closing
document.querySelector('#sheet-chat [data-dismiss]').addEventListener('click', () => {
  if (chatChannel) { sb.removeChannel(chatChannel); chatChannel = null; }
  chatWith = null;
});

/* ── EXPIRY ── */
async function expireStale() {
  try { await sb.rpc('expire_stale_profiles'); } catch (_) {
    let changed = false;
    const expireList = [...roster, ...seedUsers];
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
    new Notification('pingme', { body, tag: 'pm-update', renotify: true });
  }
}
