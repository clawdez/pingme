/* pingme — v5 · all tasks */

const SUPABASE_URL = 'https://jjgamvhvdqqjcizvpowk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpqZ2Ftdmh2ZHFxamNpenZwb3drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMjU2NDEsImV4cCI6MjA4OTgwMTY0MX0.GF-j2amwiz4qVz2TojP1vRmfHbNXRKj4cu7VAqfeodM';

let sb = null;
try { sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON); }
catch (e) { console.error('Supabase failed to load:', e); }

const PLACE = 'the sub';
const AV_COLORS = ['#E8502A','#2544D6','#6FD27B','#E8B84A','#BFA8E0','#FFD3B6','#FF9AA2','#B5EAD7'];

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
      u.venue = PLACE;
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
  // T6: hide tooltip if already seen
  if (localStorage.getItem('pm_tooltip_seen')) hideTooltip();

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
          }
        }
        document.getElementById('setup-root').innerHTML = '';
        await loadRoster();
        await loadPings();
        subscribePings();
        renderHome();
        toast('welcome back, ' + profile.name);
      } else {
        // New user — continue onboarding at name screen
        const prefill = (
          session.user.user_metadata?.given_name ||
          session.user.user_metadata?.full_name?.split(' ')[0] ||
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
async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google', options: { redirectTo: window.location.origin }
  });
  if (error) toast('sign in failed: ' + error.message);
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

/* ── NAV — single screen, modals for notis + profile ── */
function setTab(t) {
  // Only home screen exists now — just re-render
  if (t === 'home') renderHome();
}

// Notis chip → open notis modal
document.getElementById('notis-chip').addEventListener('click', () => {
  renderNotis();
  document.getElementById('sheet-notis').classList.add('open');
});

// Avatar → open profile modal
document.getElementById('profile-av').addEventListener('click', () => {
  renderMe();
  document.getElementById('sheet-profile').classList.add('open');
});

/* ── SHEETS ── */
document.querySelectorAll('[data-dismiss]').forEach(el =>
  el.addEventListener('click', () => {
    const wrap = el.closest('.sheet-wrap');
    wrap.classList.remove('open');
    // If duration picker dismissed without choosing, snap back to previous state
    if (wrap.id === 'sheet-duration' && homeState === 'down' && profile && profile.status !== 'down') {
      homeState = profile.status || 'off';
      app.dataset.homeState = homeState;
      placeBall(SNAP[homeState], true);
      renderLiveZone();
      renderRoster();
    }
  })
);
document.querySelectorAll('#sheet-duration .opt').forEach(b =>
  b.addEventListener('click', async () => {
    downDur = parseInt(b.dataset.dur, 10);
    document.getElementById('sheet-duration').classList.remove('open');
    await setMyStatus('down');
    renderStrip();
    // Auto-ping squad when going down
    await pingEveryone();
    toast('pinged the squad');
  })
);

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

/* ── T6: TOOLTIP ── */
function hideTooltip() {
  const tip = document.querySelector('.court-eyebrow');
  if (tip) tip.style.display = 'none';
}
function dismissTooltip() {
  if (!localStorage.getItem('pm_tooltip_seen')) {
    localStorage.setItem('pm_tooltip_seen', '1');
    hideTooltip();
  }
}

/* ── STATE ── */
function setHomeState(st) {
  if (!profile && st !== 'off') { showSetup(); placeBall(SNAP.off, true); return; }
  homeState = st;
  app.dataset.homeState = st;
  if (st === 'down') {
    document.getElementById('sheet-duration').classList.add('open');
  } else {
    setMyStatus(st);
  }
  renderStrip();
  renderRoster();
}

async function setMyStatus(st) {
  if (!profile) return;
  // Clear any existing expiry timer
  if (downExpiryTimer) { clearTimeout(downExpiryTimer); downExpiryTimer = null; }

  const updates = { status: st, updated_at: new Date().toISOString() };
  if (st === 'playing') {
    updates.venue = PLACE; updates.started_at = new Date().toISOString(); updates.duration = null;
  } else if (st === 'down') {
    updates.duration = downDur; updates.started_at = new Date().toISOString(); updates.venue = null;
    // Set exact expiry timer
    downExpiryTimer = setTimeout(() => {
      toast('your down window expired');
      snapTo('off');
    }, downDur * 60000);
  } else {
    updates.venue = null; updates.duration = null; updates.started_at = null;
  }
  const { error } = await sb.from('profiles').update(updates).eq('id', profile.id);
  if (error) { toast('update failed'); console.error(error); return; }
  Object.assign(profile, updates);
  const me = roster.find(r => r.id === profile.id);
  if (me) Object.assign(me, updates);
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
  document.getElementById('notis-badge').textContent = u;
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

/* ── LIVE ZONE — avatar bubbles (down) / nothing (away) ── */
function renderLiveZone() {
  const zone = document.getElementById('live-zone');
  const timer = document.getElementById('court-timer');

  if (homeState === 'off') {
    zone.innerHTML = '';
    timer.innerHTML = '';

  } else if (homeState === 'playing') {
    zone.innerHTML = '';
    // Timer lives ON the court
    const me = profile ? allRaiders().find(r => r.id === profile.id) : null;
    const mins = me && me.started_at ? Math.floor((Date.now() - new Date(me.started_at).getTime()) / 60000) : 0;
    timer.innerHTML =
      '<div class="ct-pill">' +
      '<span class="ct-dot"></span>' +
      'live &middot; ' + mins + 'm &middot; @ ' + PLACE +
      '</div>';

  } else {
    // down — show who else is down as avatar bubbles
    timer.innerHTML = '';
    const all = allRaiders();
    const othersDown = all.filter(r => r.status === 'down' && (!profile || r.id !== profile.id));
    const othersPlaying = all.filter(r => r.status === 'playing');

    let bubblesHtml = '';
    // Show people who are down
    othersDown.forEach(r => {
      const ini = r.ini || r.name.slice(0, 2).toUpperCase();
      bubblesHtml += '<div class="lz-bub" style="background:' + (r.color || '#E8502A') + '" title="' + esc(r.name) + '">' + ini + '</div>';
    });
    // Show people who are playing
    othersPlaying.forEach(r => {
      const ini = r.ini || r.name.slice(0, 2).toUpperCase();
      bubblesHtml += '<div class="lz-bub" style="background:' + (r.color || '#E8502A') + '" title="' + esc(r.name) + ' (playing)">' + ini + '</div>';
    });

    // Empty slots if nobody responded yet
    if (othersDown.length === 0 && othersPlaying.length === 0) {
      bubblesHtml += '<div class="lz-bub empty">?</div>';
      bubblesHtml += '<div class="lz-bub empty">?</div>';
      bubblesHtml += '<div class="lz-bub empty">?</div>';
    }

    const m = downDur === 30 ? '30 min' : downDur === 60 ? '1 hr' : '2 hrs';
    const tl = profile ? timeLeft(profile) : '?';

    zone.innerHTML =
      '<div class="lz-waiting">' +
      '<div class="lz-status"><span class="lz-pulse"></span> waiting for players &middot; ' + tl + ' left</div>' +
      '<div class="lz-bubbles">' + bubblesHtml + '</div>' +
      '<div class="lz-hint">' + (othersDown.length + othersPlaying.length) + ' around &middot; squad pinged</div>' +
      '<button class="lz-change" id="change-dur">change time</button>' +
      '</div>';

    document.getElementById('change-dur').onclick = () =>
      document.getElementById('sheet-duration').classList.add('open');
  }
}

// Alias for backward compat
function renderStrip() { renderLiveZone(); }

async function pingEveryone() {
  if (!profile) return;
  // Don't ping seed users — they're not real
  const others = roster.filter(r => r.id !== profile.id && r.name && r.name !== 'anon');
  const rows = others.map(r => ({
    from_id: profile.id, to_id: r.id,
    verb: 'is down to play',
    msg: profile.name + ' is down for ' + downDur + ' min — you in?',
    unread: true
  }));
  if (rows.length) await sb.from('pings').insert(rows);
}

/* ── T2: MERGED RAIDERS (real + seed) ── */
function allRaiders() {
  // T2B: filter out unnamed / 'anon' real users
  const real = roster.filter(r => r.name && r.name !== 'anon');
  return [...real, ...seedUsers];
}

/* ── ROSTER — T2, T3, T5 ── */
function renderRoster() {
  const tableSub = document.getElementById('table-sub');
  const emptyEl = document.getElementById('empty-roster');
  const playingList = document.getElementById('list-playing');
  const downList = document.getElementById('list-down');
  const offList = document.getElementById('list-off');
  const playingSection = document.getElementById('section-playing');
  const downSection = document.getElementById('section-down');
  const offSection = document.getElementById('section-off');

  const all = allRaiders();
  const playing = all.filter(r => r.status === 'playing');
  const down = all.filter(r => r.status === 'down');
  const off = all.filter(r => r.status === 'off');

  tableSub.textContent = playing.length + ' playing \u00b7 ' + down.length + ' down';

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
      sub = m + 'm';
    } else if (r.status === 'down') {
      sub = timeLeft(r);
    } else {
      sub = '';
    }
    const displayName = (isMe && profile && profile.name && profile.name !== 'anon')
      ? profile.name : r.name;
    const stClass = r.status === 'off' ? 'bub-away' : 'bub-' + r.status;
    return '<button class="rbub ' + stClass + '" data-id="' + r.id + '">' +
      '<div class="rbub-av-wrap">' +
      '<div class="rbub-av" style="background:' + (r.color || '#E8502A') + '">' + ini + '</div>' +
      (isMe ? '<span class="rbub-you">you</span>' : '') +
      '</div>' +
      '<div class="rbub-name">' + esc(displayName) + '</div>' +
      (sub ? '<div class="rbub-sub">' + sub + '</div>' : '') +
      '</button>';
  }

  playingSection.style.display = playing.length ? 'block' : 'none';
  downSection.style.display = down.length ? 'block' : 'none';
  document.getElementById('count-playing').textContent = playing.length || '';
  document.getElementById('count-down').textContent = down.length || '';
  playingList.innerHTML = '<div class="bub-grid">' + playing.map(renderBubble).join('') + '</div>';
  downList.innerHTML = '<div class="bub-grid">' + down.map(renderBubble).join('') + '</div>';

  // T5: off section hidden by default, expand link at bottom
  if (off.length > 0) {
    if (showOffRaidersState) {
      offSection.style.display = 'block';
      document.getElementById('count-off').textContent = off.length || '';
      offList.innerHTML = '<div class="bub-grid">' + off.map(renderBubble).join('') + '</div>' +
        '<div class="off-expand"><button class="show-off-btn" id="hide-off-btn">hide away players</button></div>';
      clearOffExpand();
      const hideBtn = document.getElementById('hide-off-btn');
      if (hideBtn) hideBtn.onclick = () => { showOffRaidersState = false; renderRoster(); };
    } else {
      offSection.style.display = 'none';
      offList.innerHTML = '';
      const expandEl = getOrCreateOffExpand();
      expandEl.innerHTML =
        '<button class="show-off-btn" id="show-off-btn">show ' + off.length +
        ' away' + '</button>';
      document.getElementById('show-off-btn').onclick = () => {
        showOffRaidersState = true; renderRoster();
      };
    }
  } else {
    offSection.style.display = 'none';
    clearOffExpand();
  }

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
  const av = document.getElementById('rs-av');
  const ini = r.ini || r.name.slice(0, 2).toUpperCase();
  av.style.background = r.color || '#E8502A';
  av.style.color = '#F4EDDC';
  av.textContent = ini;
  document.getElementById('rs-name').textContent = r.name;

  const s = document.getElementById('rs-status');
  if (r.status === 'playing') {
    const m = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000) : 0;
    s.innerHTML = '&#128994; playing &middot; ' + (r.venue || PLACE) + ' &middot; ' + m + ' min in';
    s.style.background = 'var(--peach)';
  } else if (r.status === 'down') {
    s.innerHTML = '&#128993; down &middot; ' + timeLeft(r) + ' left';
    s.style.background = 'var(--straw)';
  } else {
    s.innerHTML = 'away';
    s.style.background = 'var(--cream)';
  }

  document.getElementById('rs-ambient').innerHTML = r.ambient || '';

  const pingBtn = document.getElementById('rs-ping-btn');
  if (profile && r.id !== profile.id && !r._seed) {
    pingBtn.style.display = 'block';
    pingBtn.onclick = async () => {
      await sb.from('pings').insert({
        from_id: profile.id, to_id: r.id,
        verb: 'wants to play',
        msg: profile.name + ' pinged you!',
        unread: true
      });
      pingBtn.textContent = 'sent!';
      pingBtn.style.background = 'var(--sage)';
      setTimeout(() => { pingBtn.textContent = '&#127955; ping'; pingBtn.style.background = ''; }, 1500);
    };
  } else {
    pingBtn.style.display = 'none';
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
      '<div class="nw-coming">coming soon: message players directly</div>' +
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
      '<div style="text-align:center;padding:40px 0">' +
      '<h2 style="font-family:Permanent Marker;font-size:28px;margin-bottom:12px">set up your profile</h2>' +
      '<p style="color:var(--muted);margin-bottom:20px">sign in to get started</p>' +
      '<button class="setup-btn" style="max-width:280px;margin:0 auto" onclick="showSetup()">let\'s go</button>' +
      '</div>';
    return;
  }

  const ini = profile.name.slice(0, 2).toUpperCase() || '??';
  const col = profile.color || AV_COLORS[Math.abs(hash(profile.name)) % AV_COLORS.length];
  const me = roster.find(r => r.id === profile.id) || profile;

  let nowIc = '&#9898;', nowHd = "you're away", nowSub = 'drag the ball to change your status';
  if (me.status === 'playing') {
    nowIc = '&#127955;';
    nowHd = 'playing at ' + (me.venue || PLACE);
    const m = me.started_at ? Math.floor((Date.now() - new Date(me.started_at).getTime()) / 60000) : 0;
    nowSub = 'since ' + timeStr() + ' &middot; ' + m + ' min in';
  } else if (me.status === 'down') {
    nowIc = '&#9203;';
    const dur = me.duration === 30 ? '30 min' : me.duration === 60 ? '1 hour' : '2 hours';
    nowHd = 'down for ' + dur;
    nowSub = timeLeft(me) + ' remaining';
  }

  const notifOn = typeof Notification !== 'undefined' && Notification.permission === 'granted';

  // T1: no week strip, no stats, no rally-grade badge
  // Layout: avatar (centered, tappable) → name → tag → divider → status → divider → settings → divider → footer
  w.innerHTML =
    '<div class="me-hero-min">' +
    '<button class="me-av-tap" id="me-av-btn" style="background:' + col + '" title="tap to change color">' + ini + '</button>' +
    '<div class="me-name-min">' + esc(profile.name) + '</div>' +
    '<div class="me-tag-min">here to play</div>' +
    '</div>' +

    '<div class="me-rule"></div>' +

    '<div class="section-title" style="padding:0 4px 8px">what\'s happening</div>' +
    '<div class="now-card">' +
    '<div class="now-ic">' + nowIc + '</div>' +
    '<div class="now-body">' +
    '<div class="now-hd">' + nowHd + '</div>' +
    '<div class="now-sub">' + nowSub + '</div>' +
    '</div></div>' +

    '<div class="me-rule"></div>' +

    '<div class="settings-group">' +
    '<div class="setting-row" id="sr-notif">' +
    '<div class="sr-label">notifications</div>' +
    '<div class="tog-switch ' + (notifOn ? 'on' : '') + '" id="notif-tog"><div class="knob"></div></div>' +
    '</div>' +
    '<div class="setting-row" id="sr-invite">' +
    '<div class="sr-label">invite someone</div>' +
    '<div class="sr-val">&#8250;</div>' +
    '</div>' +
    '<div class="setting-row" id="sr-signout">' +
    '<div class="sr-label">sign out</div>' +
    '<div class="sr-val danger">&#8250;</div>' +
    '</div>' +
    '</div>' +

    '<div class="me-rule"></div>' +

    '<div class="me-foot-min">pingme &middot; find your game &#127955;</div>';

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

  // Notifications inline toggle
  document.getElementById('notif-tog').addEventListener('click', async () => {
    if (!('Notification' in window)) { toast('not supported'); return; }
    const tog = document.getElementById('notif-tog');
    if (Notification.permission === 'granted') {
      tog.classList.toggle('on');
    } else {
      const p = await Notification.requestPermission();
      if (p === 'granted') { tog.classList.add('on'); toast('pings are on'); }
      else toast('check browser settings');
    }
  });

  // T1: "invite a raider" — native share with preset message
  document.getElementById('sr-invite').addEventListener('click', () => {
    const url = location.origin;
    const text = '\uD83C\uDFD3 come play ping pong. \u2192 ' + url;
    if (navigator.share) {
      navigator.share({ title: 'pingme', text, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text)
        .then(() => toast('invite copied'))
        .catch(() => toast('share not supported'));
    }
  });

  // Sign out
  document.getElementById('sr-signout').addEventListener('click', async () => {
    if (downExpiryTimer) { clearTimeout(downExpiryTimer); downExpiryTimer = null; }
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
    document.getElementById('sheet-profile').classList.remove('open');
    renderHome();
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
    '</div>' + // end s-page-1
    '</div>'; // end setup-fs

  document.getElementById('s1-in').addEventListener('click', () => {
    if (!sb) { toast('not connected'); return; }
    signInWithGoogle();
  });
}
window.showSetup = showSetup;

// Screen 2 — Name (called after Google OAuth or as fallback)
async function showSetupScreen2(user, existingProfile, prefill) {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-fs">' +
    '<div class="setup-page s-slide-in" id="s-page-2">' +
    '<div class="setup-wm-sm">ping<span class="swm-me">me!</span></div>' +
    '<h2 class="setup-h2">what do people call you?</h2>' +
    '<input class="setup-name-input" id="setup-name-2" placeholder="your name" value="' +
      esc(prefill || '') + '" autocomplete="off" autofocus/>' +
    '<button class="setup-primary" id="s2-rally">let\'s rally</button>' +
    '<div class="setup-disclaimer">you can change this anytime</div>' +
    '</div>' +
    '</div>';

  // Focus + select the prefilled name
  const inp = document.getElementById('setup-name-2');
  setTimeout(() => { inp.focus(); inp.select(); }, 80);

  document.getElementById('s2-rally').addEventListener('click', async () => {
    const n = inp.value.trim().toLowerCase();
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
        if (error) { toast('error saving name'); console.error(error); btn.textContent = 'let\'s rally'; btn.disabled = false; return; }
        newProfile = data;
      } else {
        // Create fresh profile
        const { data, error } = await sb.from('profiles').insert({
          id: user.id, name: n, color, status: 'off', ambient: 'just joined'
        }).select().single();
        if (error) { toast('error creating profile'); console.error(error); btn.textContent = 'let\'s rally'; btn.disabled = false; return; }
        newProfile = data;
      }
    } else {
      // Anon path — sign in first then create profile
      const { data: { user: anonUser }, error: authErr } = await sb.auth.signInAnonymously();
      if (authErr || !anonUser) { toast('error signing in'); btn.textContent = 'let\'s rally'; btn.disabled = false; return; }
      const { data, error } = await sb.from('profiles').insert({
        id: anonUser.id, name: n, color, status: 'off', ambient: 'just joined'
      }).select().single();
      if (error) { toast('error creating profile'); btn.textContent = 'let\'s rally'; btn.disabled = false; return; }
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
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('pingme', { body, tag: 'pm-update', renotify: true });
  }
}
