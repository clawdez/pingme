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
  { id:'seed-devon',  name:'devon',  ini:'DC', color:'#FF9AA2', status:'off', hoursAgo:1.2 },
  { id:'seed-priya',  name:'priya',  ini:'PS', color:'#B5EAD7', status:'off', hoursAgo:2.5 },
  { id:'seed-marcus', name:'marcus', ini:'MB', color:'#BFA8E0', status:'off', hoursAgo:0.7 },
  { id:'seed-sam',    name:'sam',    ini:'SL', color:'#2544D6', status:'off', hoursAgo:3.1 },
  { id:'seed-noor',   name:'noor',   ini:'NA', color:'#E8B84A', status:'off', hoursAgo:1.8 },
  { id:'seed-riley',  name:'riley',  ini:'RF', color:'#6FD27B', status:'off', hoursAgo:4.2 },
  { id:'seed-caleb',  name:'caleb',  ini:'CH', color:'#E8502A', status:'off', hoursAgo:0.4 },
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
      await loadOrCreateProfile(session.user);
      document.getElementById('setup-root').innerHTML = '';
      await loadRoster();
      await loadPings();
      subscribePings();
      renderHome();
      toast('welcome, ' + profile.name);
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
  if (existing) { profile = existing; homeState = existing.status || 'off'; return; }
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
            maybeNotify(payload.new.name + ' is now playing at ' + PLACE);
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

/* ── NAV ── */
function setTab(t) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.querySelector('[data-screen="' + t + '"]');
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.nav === t)
  );
  if (t === 'home') renderHome();
  else if (t === 'notis') renderNotis();
  else if (t === 'me') renderMe();
}

document.querySelectorAll('.nav-tab').forEach(btn =>
  btn.addEventListener('click', () => setTab(btn.dataset.nav))
);
document.getElementById('notis-chip').addEventListener('click', () => setTab('notis'));
document.getElementById('profile-av').addEventListener('click', () => setTab('me'));
document.querySelectorAll('[data-back]').forEach(b =>
  b.addEventListener('click', () => setTab('home'))
);

/* ── SHEETS ── */
document.querySelectorAll('[data-dismiss]').forEach(el =>
  el.addEventListener('click', () => el.closest('.sheet-wrap').classList.remove('open'))
);
document.querySelectorAll('#sheet-duration .opt').forEach(b =>
  b.addEventListener('click', () => {
    downDur = parseInt(b.dataset.dur, 10);
    document.getElementById('sheet-duration').classList.remove('open');
    setMyStatus('down');
    renderStrip();
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
  const updates = { status: st, updated_at: new Date().toISOString() };
  if (st === 'playing') {
    updates.venue = PLACE; updates.started_at = new Date().toISOString(); updates.duration = null;
  } else if (st === 'down') {
    updates.duration = downDur; updates.started_at = new Date().toISOString(); updates.venue = null;
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
  renderStrip();
  renderRoster();
  placeBall(SNAP[homeState], false);
  app.dataset.homeState = homeState;
  setTimeout(() => { if (!dragging) ball.classList.add('at-rest'); }, 100);
}

function updateNotisBadge() {
  const u = pings.filter(p => p.unread).length;
  const navBadge = document.getElementById('nav-badge');
  if (u > 0) { navBadge.textContent = u; navBadge.style.display = 'flex'; }
  else { navBadge.style.display = 'none'; }
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

/* ── STRIP — T3 terminology, T4 counter ── */
function renderStrip() {
  const strip = document.getElementById('strip');
  const all = allRaiders();
  const nP = all.filter(r => r.status === 'playing').length;
  const nD = all.filter(r => r.status === 'down').length;
  const total = nP + nD;

  if (homeState === 'off') {
    // T4: dot separator, dead quiet only when both === 0 and subtler
    let heatPill = '';
    if (nP === 0 && nD === 0) {
      heatPill = '<span class="heat-tag cold subtle">dead quiet</span>';
    } else if (nP >= 3) {
      heatPill = '<span class="heat-tag fire">court\'s on fire</span>';
    } else if (total >= 2) {
      heatPill = '<span class="heat-tag warm">warming up</span>';
    } else if (total === 1) {
      heatPill = '<span class="heat-tag mild">getting started</span>';
    }

    strip.innerHTML =
      '<div class="strip-scoreboard">' +
      '<span class="sb-count"><b>' + nP + '</b> playing</span>' +
      '<span class="sb-dot">&middot;</span>' +
      '<span class="sb-count"><b>' + nD + '</b> down</span>' +
      '</div>' +
      '<div class="strip-bottom">' + heatPill + '<span class="strip-place">@ ' + PLACE + '</span></div>';

  } else if (homeState === 'playing') {
    const me = profile ? allRaiders().find(r => r.id === profile.id) : null;
    const mins = me && me.started_at ? Math.floor((Date.now() - new Date(me.started_at).getTime()) / 60000) : 0;
    strip.innerHTML =
      '<div class="strip-live">' +
      '<span class="live-dot"></span>' +
      '<span class="live-tag">LIVE</span>' +
      '<span class="live-loc">@ ' + PLACE + '</span>' +
      '<span class="live-time">' + timeStr() + ' &middot; ' + mins + 'm in</span>' +
      '</div>' +
      // T3: "you're in the game" → "you're playing"
      '<div class="strip-bottom"><span class="heat-tag fire">you\'re playing</span></div>';

  } else {
    // down
    const m = downDur === 30 ? '30 min' : downDur === 60 ? '1 hr' : '2 hrs';
    strip.innerHTML =
      '<div class="strip-ondeck">' +
      '<span class="ondeck-icon">&#9203;</span>' +
      '<div class="ondeck-info">' +
      '<span class="ondeck-title">down for <b>' + m + '</b></span>' +
      '<span class="ondeck-sub">hit me up, i\'m around</span>' +
      '</div></div>' +
      '<div class="strip-actions">' +
      '<button class="mini-btn" id="ping-every">&#127955; rally the squad</button>' +
      '<button class="tiny-link" id="change-dur">change time</button>' +
      '</div>';
    document.getElementById('ping-every').onclick = async function () {
      await pingEveryone();
      this.textContent = '✓ sent!';
      this.style.background = 'var(--sage)';
      this.style.color = 'var(--ink)';
      setTimeout(renderStrip, 1800);
    };
    document.getElementById('change-dur').onclick = () =>
      document.getElementById('sheet-duration').classList.add('open');
  }
}

async function pingEveryone() {
  if (!profile) return;
  // Don't ping seed users — they're not real
  const others = roster.filter(r => r.id !== profile.id && r.name && r.name !== 'anon');
  const rows = others.map(r => ({
    from_id: profile.id, to_id: r.id,
    verb: 'is down to play',
    msg: profile.name + ' is looking for a game',
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

  // T3: "playing · down" (not "playing · on deck")
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

  function renderPlayerRow(r) {
    const isMe = profile && r.id === profile.id;
    const ini = r.ini || (r.name.slice(0, 1).toUpperCase() + r.name.slice(1, 2).toUpperCase());
    let sub = '', badge = '';
    if (r.status === 'playing') {
      const m = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000) : 0;
      sub = m + 'm in';
      badge = '<span class="row-badge">&#127955;</span>';
    } else if (r.status === 'down') {
      sub = timeLeft(r) + ' left';
      badge = '<span class="row-badge">&#9203;</span>';
    } else {
      sub = 'off'; // T3: was "off court"
    }
    // T2C: never show "anon · you" — use real name from profile
    const displayName = (isMe && profile && profile.name && profile.name !== 'anon')
      ? profile.name : r.name;
    return '<button class="rrow ' + (r.status === 'off' ? 'off-row' : r.status) + '" data-id="' + r.id + '">' +
      '<span class="rav" style="background:' + (r.color || '#E8502A') + ';color:#F4EDDC">' + ini + '</span>' +
      '<span class="rbody">' +
      '<div class="rname">' + esc(displayName) + (isMe ? ' <span class="you-tag">you</span>' : '') + '</div>' +
      '<div class="rsub">' + sub + '</div>' +
      '</span>' + badge + '</button>';
  }

  playingSection.style.display = playing.length ? 'block' : 'none';
  downSection.style.display = down.length ? 'block' : 'none';
  document.getElementById('count-playing').textContent = playing.length || '';
  document.getElementById('count-down').textContent = down.length || '';
  playingList.innerHTML = playing.map(renderPlayerRow).join('');
  downList.innerHTML = down.map(renderPlayerRow).join('');

  // T5: off section hidden by default, expand link at bottom
  if (off.length > 0) {
    if (showOffRaidersState) {
      offSection.style.display = 'block';
      document.getElementById('count-off').textContent = off.length || '';
      offList.innerHTML = off.map(renderPlayerRow).join('') +
        '<div class="off-expand"><button class="show-off-btn" id="hide-off-btn">hide off raiders</button></div>';
      clearOffExpand();
      const hideBtn = document.getElementById('hide-off-btn');
      if (hideBtn) hideBtn.onclick = () => { showOffRaidersState = false; renderRoster(); };
    } else {
      offSection.style.display = 'none';
      offList.innerHTML = '';
      const expandEl = getOrCreateOffExpand();
      expandEl.innerHTML =
        '<button class="show-off-btn" id="show-off-btn">show ' + off.length +
        ' off raider' + (off.length !== 1 ? 's' : '') + '</button>';
      document.getElementById('show-off-btn').onclick = () => {
        showOffRaidersState = true; renderRoster();
      };
    }
  } else {
    offSection.style.display = 'none';
    clearOffExpand();
  }

  // Wire row clicks
  document.querySelectorAll('.section-list .rrow').forEach(row =>
    row.addEventListener('click', () => {
      const r = allRaiders().find(x => x.id === row.dataset.id);
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
    s.innerHTML = 'off'; // T3: was "offline"
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
      '<div class="nw-item">&middot; when raiders go down to play</div>' +
      '<div class="nw-item">&middot; when someone heads to the table</div>' +
      '<div class="nw-item">&middot; when your status is about to expire</div>' +
      '</div>' +
      '<div class="nw-coming">coming soon: direct pings</div>' +
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

  let nowIc = '&#9898;', nowHd = "you're off", nowSub = 'drag the ball to change your status';
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
    '<div class="me-tag-min">ttu ping pong raider</div>' +
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
    '<div class="sr-label">invite a raider</div>' +
    '<div class="sr-val">&#8250;</div>' +
    '</div>' +
    '<div class="setting-row" id="sr-signout">' +
    '<div class="sr-label">sign out</div>' +
    '<div class="sr-val danger">&#8250;</div>' +
    '</div>' +
    '</div>' +

    '<div class="me-rule"></div>' +

    '<div class="me-foot-min">pingme &middot; made for the sub &#127955;</div>';

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
    const text = '\uD83C\uDFD3 ping pong at the sub. join us \u2192 ' + url;
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
    setTab('home');
  });
}

/* ── SETUP ── */
function showSetup() {
  const root = document.getElementById('setup-root');
  root.innerHTML =
    '<div class="setup-overlay"><div class="setup-sheet">' +
    '<h2>welcome to pingme!</h2>' +
    '<div class="setup-sub">sign in to play</div>' +
    '<button class="setup-btn google-btn" id="google-signin">' +
    '<svg width="18" height="18" viewBox="0 0 48 48" style="vertical-align:middle;margin-right:10px"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>' +
    'sign in with Google</button>' +
    '<div class="setup-divider"><span>or</span></div>' +
    '<div class="field"><label>just enter your name</label><input id="setup-name" placeholder="what do people call you?" autofocus/></div>' +
    '<button class="setup-btn" id="anon-go">let\'s go</button>' +
    '<div class="notif-card"><p>want to know when someone heads to the tables?</p><button onclick="reqNotif()">turn on pings</button></div>' +
    '</div></div>';
  document.getElementById('google-signin').addEventListener('click', signInWithGoogle);
  document.getElementById('anon-go').addEventListener('click', finishAnonSetup);
}
window.showSetup = showSetup;

async function finishAnonSetup() {
  const n = document.getElementById('setup-name').value.trim();
  if (!n) { toast('enter your name first'); return; }
  const { data: { user }, error: authErr } = await sb.auth.signInAnonymously();
  if (authErr || !user) { toast('error signing in'); console.error(authErr); return; }
  const color = AV_COLORS[Math.abs(hash(n)) % AV_COLORS.length];
  const { data: newProfile, error } = await sb.from('profiles').insert({
    id: user.id, name: n, color, status: 'off', ambient: 'just joined'
  }).select().single();
  if (error) { toast('error creating profile'); console.error(error); return; }
  profile = newProfile; homeState = 'off';
  roster.push(newProfile);
  document.getElementById('setup-root').innerHTML = '';
  toast('welcome, ' + n);
  subscribePings();
  renderHome();
}

window.reqNotif = function () {
  if (!('Notification' in window)) { toast('not supported in this browser'); return; }
  Notification.requestPermission().then(p => {
    if (p === 'granted') {
      toast('pings are on');
      new Notification('pingme', { body: "you'll get pinged when someone wants to play" });
    } else toast('notifications blocked');
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
