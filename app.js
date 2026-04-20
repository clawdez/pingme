/* pingme — prototype-exact design · Supabase-powered · v3 */

const SUPABASE_URL = 'https://jjgamvhvdqqjcizvpowk.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpqZ2Ftdmh2ZHFxamNpenZwb3drIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMjU2NDEsImV4cCI6MjA4OTgwMTY0MX0.GF-j2amwiz4qVz2TojP1vRmfHbNXRKj4cu7VAqfeodM';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

const PLACE = 'the sub';
const AV_COLORS = ['#E8502A','#2544D6','#6FD27B','#E8B84A','#BFA8E0','#FFD3B6','#FF9AA2','#B5EAD7'];

/* ── STATE ── */
let profile = null;
let roster = [];
let pings = [];
let homeState = 'off';
let downDur = 60;
let rosterExpanded = false;
let dragging = false;
let currentPct = 50;
let pingsSubscribed = false;

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
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) await loadOrCreateProfile(session.user);
  } catch (e) {
    console.error('Auth check failed:', e);
    toast('connecting...');
  }

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
      profile = null;
      homeState = 'off';
      pingsSubscribed = false;
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
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) toast('sign in failed: ' + error.message);
}

async function loadOrCreateProfile(user) {
  const { data: existing } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (existing) {
    profile = existing;
    homeState = existing.status || 'off';
    return;
  }
  const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'anon';
  const color = AV_COLORS[Math.abs(hash(name)) % AV_COLORS.length];
  const { data: newProfile, error } = await sb.from('profiles').insert({
    id: user.id, name: name, color: color, status: 'off', ambient: 'just joined'
  }).select().single();
  if (error) { toast('profile error'); console.error(error); return; }
  profile = newProfile;
  homeState = 'off';
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
      updatePingsBadge();
      maybeNotify('new ping!');
    })
    .subscribe();
}

/* ── NAV ── */

function setTab(t) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.querySelector('[data-screen="' + t + '"]');
  if (el) el.classList.add('active');
  if (t === 'home') renderHome();
  else if (t === 'pings') renderPings();
  else if (t === 'me') renderMe();
}

// Top bar nav: pings chip → pings, avatar → me
document.getElementById('pings-chip').addEventListener('click', () => setTab('pings'));
document.getElementById('profile-av').addEventListener('click', () => setTab('me'));
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => setTab('home')));

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
  e.preventDefault();
  dragging = true;
  try { ball.setPointerCapture(e.pointerId); } catch (_) {}
  ball.classList.add('dragging');
  ball.classList.remove('at-rest', 'snapping');
});

window.addEventListener('pointermove', e => {
  if (!dragging) return;
  const p = pPct(e);
  placeBall(p, false);
  lp.classList.toggle('ready', p < 22);
  rp.classList.toggle('ready', p > 78);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  ball.classList.remove('dragging');
  lp.classList.remove('ready');
  rp.classList.remove('ready');
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

/* tap labels + paddles */
document.querySelectorAll('.c-lbl').forEach(b =>
  b.addEventListener('click', () => snapTo(b.dataset.state))
);
lp.addEventListener('click', () => { if (!dragging) snapTo('down'); });
rp.addEventListener('click', () => { if (!dragging) snapTo('playing'); });

/* ── STATE ── */

function setHomeState(st) {
  if (!profile && st !== 'off') {
    showSetup();
    placeBall(SNAP.off, true);
    return;
  }
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
    updates.venue = PLACE;
    updates.started_at = new Date().toISOString();
    updates.duration = null;
  } else if (st === 'down') {
    updates.duration = downDur;
    updates.started_at = new Date().toISOString();
    updates.venue = null;
  } else {
    updates.venue = null;
    updates.duration = null;
    updates.started_at = null;
  }
  const { error } = await sb.from('profiles').update(updates).eq('id', profile.id);
  if (error) { toast('update failed'); console.error(error); return; }
  Object.assign(profile, updates);
  const me = roster.find(r => r.id === profile.id);
  if (me) Object.assign(me, updates);
}

/* ── RENDER HOME ── */

function renderHome() {
  updatePingsBadge();
  updateProfileAv();
  renderStrip();
  renderRoster();
  placeBall(SNAP[homeState], false);
  app.dataset.homeState = homeState;
  setTimeout(() => { if (!dragging) ball.classList.add('at-rest'); }, 100);
}

function updatePingsBadge() {
  const u = pings.filter(p => p.unread).length;
  const badge = document.getElementById('pings-badge');
  badge.textContent = u;
}

function updateProfileAv() {
  const av = document.getElementById('profile-av');
  if (profile) {
    av.textContent = profile.name.slice(0, 1).toUpperCase() + profile.name.slice(1, 2).toUpperCase();
    av.style.background = profile.color || AV_COLORS[Math.abs(hash(profile.name)) % AV_COLORS.length];
  } else {
    av.textContent = '?';
    av.style.background = '';
  }
}

/* ── STRIP (prototype-exact) ── */

function renderStrip() {
  const strip = document.getElementById('strip');
  const nP = roster.filter(r => r.status === 'playing').length;
  const nD = roster.filter(r => r.status === 'down').length;

  if (homeState === 'off') {
    strip.innerHTML =
      '<span class="tick o"></span>' +
      '<span><b>' + nP + '</b> playing</span>' +
      '<span class="divider"></span>' +
      '<span><b>' + nD + '</b> down</span>' +
      '<span class="c-sub">right now at ' + PLACE + '</span>';
  } else if (homeState === 'playing') {
    const me = profile ? roster.find(r => r.id === profile.id) : null;
    const mins = me && me.started_at ? Math.floor((Date.now() - new Date(me.started_at).getTime()) / 60000) : 0;
    strip.innerHTML =
      '<span class="tick"></span>' +
      '<span>you\'re at <b>' + PLACE + '</b></span>' +
      '<span class="divider"></span>' +
      '<span class="c-sub">since ' + timeStr() + ' \u00b7 ' + mins + 'm in</span>';
  } else {
    const m = downDur === 30 ? '30 min' : downDur === 60 ? '1 hour' : '2 hours';
    strip.innerHTML =
      '<span class="tick y"></span>' +
      '<span>down for <b>' + m + '</b></span>' +
      '<button class="mini-btn" id="ping-every">\ud83d\udce2 ping friends</button>' +
      '<button class="tiny-link" id="change-dur" style="margin-left:auto;">tap to change</button>';
    document.getElementById('ping-every').onclick = async function () {
      await pingEveryone();
      this.textContent = '\u2713 sent to ' + (roster.length - 1) + ' friends';
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
  const others = roster.filter(r => r.id !== profile.id);
  const rows = others.map(r => ({
    from_id: profile.id, to_id: r.id,
    verb: 'is down to play',
    msg: profile.name + ' is looking for a game',
    unread: true
  }));
  if (rows.length) await sb.from('pings').insert(rows);
}

/* ── ROSTER (prototype flat friends list) ── */

function renderRoster() {
  const rdrSub = document.getElementById('rdr-sub');
  const rdrList = document.getElementById('rdr-list');

  const nP = roster.filter(r => r.status === 'playing').length;
  const nD = roster.filter(r => r.status === 'down').length;

  if (homeState === 'off') rdrSub.textContent = 'at ' + PLACE + ' \u00b7 ' + (nP + nD) + ' active';
  else rdrSub.textContent = nP + ' playing \u00b7 ' + nD + ' down';

  // Sort: playing first, then down, then off
  let list = [...roster].sort((a, b) => {
    const order = { playing: 0, down: 1, off: 2 };
    return (order[a.status] || 2) - (order[b.status] || 2);
  });

  const LIMIT = 3;
  const visible = rosterExpanded ? list : list.slice(0, LIMIT);
  const hidden = list.length - visible.length;

  rdrList.innerHTML = visible.map(r => {
    const isMe = profile && r.id === profile.id;
    const ini = r.name.slice(0, 1).toUpperCase() + r.name.slice(1, 2).toUpperCase();
    let sub = '';
    if (r.status === 'playing') {
      const m = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000) : 0;
      sub = PLACE + ' \u00b7 ' + m + ' min in';
    } else if (r.status === 'down') {
      sub = 'down \u00b7 ' + timeLeft(r) + ' left';
    } else {
      sub = 'off court';
    }
    return '<button class="rrow ' + r.status + '" data-id="' + r.id + '">' +
      '<span class="rav" style="background:' + (r.color || '#E8502A') + ';color:#F4EDDC">' + ini + '</span>' +
      '<span class="rbody"><div class="rname">' + esc(r.name) + (isMe ? ' <span class="you-tag">you</span>' : '') + '</div>' +
      '<div class="rsub">' + sub + '</div></span></button>';
  }).join('') + (
    (hidden > 0 || rosterExpanded)
      ? '<button class="show-more" id="show-more">' + (rosterExpanded ? 'show less \u2191' : 'show ' + hidden + ' more \u2193') + '</button>'
      : ''
  );

  rdrList.querySelectorAll('.rrow').forEach(row =>
    row.addEventListener('click', () => {
      const r = roster.find(x => x.id === row.dataset.id);
      if (r) openRaiderSheet(r);
    })
  );
  const sm = document.getElementById('show-more');
  if (sm) sm.addEventListener('click', () => {
    rosterExpanded = !rosterExpanded;
    renderRoster();
  });
}

function openRaiderSheet(r) {
  const av = document.getElementById('rs-av');
  av.style.background = r.color || '#E8502A';
  av.style.color = '#F4EDDC';
  av.textContent = r.name.slice(0, 2).toUpperCase();
  document.getElementById('rs-name').textContent = r.name;

  const s = document.getElementById('rs-status');
  if (r.status === 'playing') {
    const m = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000) : 0;
    s.innerHTML = '\ud83d\udfe2 playing \u00b7 ' + (r.venue || PLACE) + ' \u00b7 ' + m + ' min in';
    s.style.background = 'var(--peach)';
  } else if (r.status === 'down') {
    s.innerHTML = '\ud83d\udfe1 down \u00b7 ' + timeLeft(r) + ' left';
    s.style.background = 'var(--straw)';
  } else {
    s.innerHTML = 'offline';
    s.style.background = 'var(--cream)';
  }

  document.getElementById('rs-ambient').innerHTML = r.ambient || '';

  const pingBtn = document.getElementById('rs-ping-btn');
  if (profile && r.id !== profile.id) {
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
      setTimeout(() => {
        pingBtn.textContent = '\ud83c\udfd3 ping';
        pingBtn.style.background = '';
      }, 1500);
    };
  } else {
    pingBtn.style.display = 'none';
  }

  document.getElementById('sheet-raider').classList.add('open');
}

/* ── PINGS ── */

function renderPings() {
  const pingsSub = document.getElementById('pings-sub');
  const pingList = document.getElementById('ping-list');
  const u = pings.filter(p => p.unread).length;
  const rr = pings.filter(p => !p.unread).length;
  pingsSub.textContent = u + ' unread \u00b7 ' + rr + ' replied';

  if (pings.length === 0) {
    pingList.innerHTML = '<div class="empty-hint">no pings yet. go play and they\'ll come.</div>';
    return;
  }

  pingList.innerHTML = pings.map(p => {
    const from = p.from || {};
    const avText = (from.name || 'anon').slice(0, 2).toUpperCase();
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
      actions = '<div class="ping-actions"><button class="pa-btn taken">\u2713 ' + esc(acted) + '</button></div>';
    }

    return '<div class="ping-card ' + (p.unread ? 'unread' : '') + '" data-id="' + p.id + '">' +
      '<div class="pc-av" style="background:' + color + ';color:#F4EDDC">' + avText + '</div>' +
      '<div class="pc-body">' +
      '<div class="pc-who">' + esc(who) + ' <span class="pc-verb">' + esc(p.verb || '') + '</span></div>' +
      '<div class="pc-msg">' + esc(p.msg || '') + '</div>' +
      '<div class="pc-time">' + ago + '</div>' +
      actions +
      '</div></div>';
  }).join('') + '<div class="empty-hint">that\'s the lot. go play.</div>';

  pingList.querySelectorAll('.pa-btn[data-ping]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const pingId = btn.dataset.ping;
      const action = btn.dataset.action;
      if (!action) return;
      await sb.from('pings').update({ unread: false, action_taken: action }).eq('id', pingId);
      const p = pings.find(x => x.id === pingId);
      if (p) { p.unread = false; p.action_taken = action; }
      renderPings();
      updatePingsBadge();
    })
  );
}

/* ── ME (prototype-exact: hero + status + weekly + stats + settings) ── */

function renderMe() {
  const w = document.getElementById('me-wrap');

  if (!profile) {
    w.innerHTML = '<div style="text-align:center;padding:40px 0">' +
      '<h2 style="font-family:Permanent Marker;font-size:28px;margin-bottom:12px">set up your profile</h2>' +
      '<p style="color:var(--muted);margin-bottom:20px">sign in to get started</p>' +
      '<button class="setup-btn" style="max-width:280px;margin:0 auto" onclick="showSetup()">let\'s go</button></div>';
    return;
  }

  const ini = profile.name.slice(0, 2).toUpperCase();
  const col = profile.color || AV_COLORS[Math.abs(hash(profile.name)) % AV_COLORS.length];
  const me = roster.find(r => r.id === profile.id);

  let nowIc = '\u26aa', nowHd = "you're off", nowSub = 'drop the ball onto a paddle to go on';
  if (me && me.status === 'playing') {
    nowIc = '\ud83c\udfd3';
    nowHd = 'playing at ' + (me.venue || PLACE);
    const m = me.started_at ? Math.floor((Date.now() - new Date(me.started_at).getTime()) / 60000) : 0;
    nowSub = 'since ' + timeStr() + ' \u00b7 ' + m + ' min in';
  } else if (me && me.status === 'down') {
    nowIc = '\u23f3';
    const dur = me.duration === 30 ? '30 min' : me.duration === 60 ? '1 hour' : '2 hours';
    nowHd = 'down for ' + dur;
    nowSub = 'hit me up, i\'m around';
  }

  // Weekly activity (placeholder data — will be real once we track games)
  const WEEK = [0, 0, 0, 0, 0, 0, 0];
  const WEEK_LABELS = ['M','T','W','T','F','S','S'];
  const TODAY_IDX = new Date().getDay();
  const adjustedIdx = TODAY_IDX === 0 ? 6 : TODAY_IDX - 1; // Mon=0
  const peak = 60;

  const weekHtml = WEEK_LABELS.map((label, i) => {
    const mins = WEEK[i];
    const pct = Math.max(0, Math.min(100, Math.round((mins / peak) * 100)));
    const mLabel = mins ? mins + 'm' : '\u2014';
    return '<div class="wd ' + (i === adjustedIdx ? 'today' : '') + '">' +
      '<div class="day">' + label + '</div>' +
      '<div class="bar"><div class="fill" style="height:' + pct + '%"></div></div>' +
      '<div class="mins">' + mLabel + '</div></div>';
  }).join('');

  w.innerHTML =
    // Hero card
    '<div class="me-hero">' +
    '<div class="me-av-big" style="color:' + col + '">' + ini + '</div>' +
    '<div class="me-body">' +
    '<div class="me-name-big">' + esc(profile.name) + '</div>' +
    '<div class="me-tag">ttu ping pong raider</div>' +
    '<div class="me-rank">rally-grade</div>' +
    '</div></div>' +

    // Current status
    '<div class="section-title">what\'s happening</div>' +
    '<div class="now-card"><div class="now-ic">' + nowIc + '</div>' +
    '<div class="now-body"><div class="now-hd">' + nowHd + '</div>' +
    '<div class="now-sub">' + nowSub + '</div></div></div>' +

    // Weekly activity
    '<div class="section-title">this week</div>' +
    '<div class="week-strip">' + weekHtml + '</div>' +

    // Stats
    '<div class="section-title">stats</div>' +
    '<div class="stat-grid">' +
    '<div class="stat-card"><div class="sn">0</div><div class="sl">games</div></div>' +
    '<div class="stat-card"><div class="sn">0-0</div><div class="sl">you vs them</div></div>' +
    '<div class="stat-card"><div class="sn">0h</div><div class="sl">weekly avg</div></div>' +
    '</div>' +

    // Settings
    '<div class="section-title">settings</div>' +
    '<div class="settings-group">' +
    '<div class="setting-row" id="sr-share"><div class="sr-label">share status</div>' +
    '<div class="tog-switch on" data-tog><div class="knob"></div></div></div>' +
    '<div class="setting-row" id="sr-notif"><div class="sr-label">notifications</div>' +
    '<div class="sr-val">' + (typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'on' : 'off') + '</div></div>' +
    '<div class="setting-row" id="sr-invite"><div class="sr-label">invite a friend</div>' +
    '<div class="sr-val">\u203a</div></div>' +
    '<div class="setting-row" id="sr-signout"><div class="sr-label">sign out</div>' +
    '<div class="sr-val danger">\u203a</div></div>' +
    '</div>' +

    '<div class="me-foot">pingme v1 \u00b7 made in lubbock \ud83c\udfd3</div>';

  // Wire settings
  document.getElementById('sr-notif').addEventListener('click', () => {
    if (!('Notification' in window)) { toast('not supported'); return; }
    Notification.requestPermission().then(p => {
      if (p === 'granted') { toast('pings are on'); renderMe(); }
      else toast('check browser settings');
    });
  });

  document.getElementById('sr-invite').addEventListener('click', () => {
    if (navigator.share) {
      navigator.share({ title: 'pingme', text: 'pickup ping pong at ttu', url: location.href }).catch(() => {});
    } else {
      navigator.clipboard.writeText(location.href).then(() => toast('link copied')).catch(() => toast('share not supported'));
    }
  });

  document.getElementById('sr-signout').addEventListener('click', async () => {
    if (profile) {
      await sb.from('profiles').update({ status: 'off', venue: null, duration: null, started_at: null }).eq('id', profile.id);
    }
    await sb.auth.signOut();
    profile = null;
    homeState = 'off';
    placeBall(SNAP.off, true);
    app.dataset.homeState = 'off';
    toast('signed out');
    setTab('home');
  });

  document.querySelectorAll('[data-tog]').forEach(t =>
    t.addEventListener('click', () => t.classList.toggle('on'))
  );
}

/* ── SETUP ── */

function showSetup() {
  const root = document.getElementById('setup-root');
  root.innerHTML = '<div class="setup-overlay"><div class="setup-sheet">' +
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
    id: user.id, name: n, color: color, status: 'off', ambient: 'just joined'
  }).select().single();

  if (error) { toast('error creating profile'); console.error(error); return; }

  profile = newProfile;
  homeState = 'off';
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
  try {
    await sb.rpc('expire_stale_profiles');
  } catch (_) {
    let changed = false;
    roster.forEach(r => {
      if (r.status === 'down' && r.started_at && r.duration) {
        if ((Date.now() - new Date(r.started_at).getTime()) / 60000 >= r.duration) {
          r.status = 'off'; r.venue = null; r.duration = null; r.started_at = null;
          changed = true;
        }
      }
      if (r.status === 'playing' && r.started_at) {
        if ((Date.now() - new Date(r.started_at).getTime()) / 60000 >= 90) {
          r.status = 'off'; r.venue = null; r.duration = null; r.started_at = null;
          changed = true;
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
    new Notification('pingme', { body: body, tag: 'pm-update', renotify: true });
  }
}
