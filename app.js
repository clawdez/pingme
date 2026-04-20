// ── CONFIG ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://ghasqxurquuzjpzrpjgv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdoYXNxeHVycXV1empwenJwamF2diIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzQxMzE1NjMwLCJleHAiOjIwNTY4OTE2MzB9.placeholder-replace-me';
const SESSION_MINUTES = 60;

const SKILL_LABELS = ['', 'Beginner', 'Casual', 'Intermediate', 'Advanced', 'Pro'];
const SKILL_CLASSES = ['', 's1', 's2', 's3', 's4', 's5'];

// ── STATE ─────────────────────────────────────────────────────────────────────
let sb = null;
let profile = null;
let activeSession = null;
let venues = [];
let waitingPlayers = [];
let realtimeSub = null;
let countdownInterval = null;

// ── INIT ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  // Register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Init Supabase
  try {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.warn('Supabase init failed — running in offline mode');
  }

  // Load profile
  profile = loadProfile();

  // Load venues
  await loadVenues();

  // Check for active session
  activeSession = loadActiveSession();
  if (activeSession && new Date(activeSession.expires_at) < new Date()) {
    activeSession = null;
    clearActiveSession();
  }

  // Route
  route();
  window.addEventListener('hashchange', route);

  // Subscribe to realtime
  subscribeRealtime();
});

// ── ROUTING ───────────────────────────────────────────────────────────────────
function route() {
  const hash = location.hash || '#home';
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  if (hash === '#home') {
    document.getElementById('screen-home').classList.add('active');
    document.querySelector('[data-nav="home"]').classList.add('active');
    renderHome();
  } else if (hash === '#play') {
    document.getElementById('screen-play').classList.add('active');
    document.querySelector('[data-nav="play"]').classList.add('active');
    renderPlay();
  } else if (hash === '#waiting') {
    document.getElementById('screen-waiting').classList.add('active');
    document.querySelector('[data-nav="play"]').classList.add('active');
    renderWaiting();
  } else if (hash === '#profile') {
    document.getElementById('screen-profile').classList.add('active');
    document.querySelector('[data-nav="profile"]').classList.add('active');
    renderProfile();
  }
}

// ── HOME SCREEN ───────────────────────────────────────────────────────────────
async function renderHome() {
  const el = document.getElementById('screen-home');

  if (!profile) {
    el.innerHTML = `
      <div class="header"><div class="logo">Ping<span>Me</span> 🏓</div></div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;">
        <span class="emoji-big" style="text-align:center">👋</span>
        <h2 style="text-align:center;margin-bottom:8px">Set up your profile</h2>
        <p class="muted" style="text-align:center;margin-bottom:28px">Takes 10 seconds</p>
        <div class="field"><label>Your name</label><input id="setup-name" placeholder="What do people call you?" /></div>
        <div class="field">
          <label>Skill level</label>
          <div class="skill-row" id="setup-skill-row">
            ${[1,2,3,4,5].map(i => `<button class="skill-btn${i===3?' active':''}" data-skill="${i}" onclick="selectSkill(this,'setup')">${i}</button>`).join('')}
          </div>
          <p class="muted" style="margin-top:8px;font-size:12px" id="setup-skill-label">3 — Intermediate</p>
        </div>
        <button class="btn btn-primary" onclick="saveSetup()">Let's go 🏓</button>
      </div>`;
    return;
  }

  // Fetch who is waiting
  await refreshWaitingPlayers();

  const others = waitingPlayers.filter(p => p.user_id !== profile.id);
  const mySession = waitingPlayers.find(p => p.user_id === profile.id);

  el.innerHTML = `
    <div class="header">
      <div class="logo">Ping<span>Me</span> 🏓</div>
      <button class="btn btn-secondary btn-sm" onclick="location.hash='#profile'">⚙️</button>
    </div>

    ${mySession ? `
      <div class="card" style="border-color:rgba(196,255,60,0.3);background:rgba(196,255,60,0.05);margin-bottom:20px">
        <div class="card-row">
          <div>
            <div style="font-weight:700;color:var(--accent)">🟢 You're live at ${mySession.venue_name}</div>
            <div class="muted" style="margin-top:4px">Waiting for a match · <span class="countdown" id="home-countdown"></span></div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="cancelSession()">Cancel</button>
        </div>
      </div>
    ` : `
      <button class="btn-play" onclick="location.hash='#play'" style="margin-bottom:24px">
        I want to play 🏓
      </button>
    `}

    <div class="section-title">Who's waiting now (${others.length})</div>
    ${others.length === 0 ? `
      <div class="empty">
        <div class="emoji">😴</div>
        <div>Nobody waiting right now</div>
        <div style="margin-top:6px;font-size:13px">Be the first — tap the button above</div>
      </div>
    ` : others.map(p => playerCard(p)).join('')}
  `;

  if (mySession) startCountdown('home-countdown', mySession.expires_at);
}

// ── PLAY SCREEN ───────────────────────────────────────────────────────────────
function renderPlay() {
  if (!profile) { location.hash = '#home'; return; }
  if (activeSession) { location.hash = '#waiting'; return; }

  const el = document.getElementById('screen-play');
  el.innerHTML = `
    <div class="header">
      <button class="btn btn-secondary btn-sm" onclick="history.back()">← Back</button>
      <div class="logo">Ping<span>Me</span></div>
    </div>
    <h2 style="margin-bottom:6px">Where are you going?</h2>
    <p class="muted" style="margin-bottom:24px">We'll ping players at that spot</p>

    <div class="field">
      <label>Venue</label>
      <select id="play-venue">
        ${venues.map(v => `<option value="${v.id}" data-name="${v.name}">${v.name}</option>`).join('')}
        <option value="other">Other spot...</option>
      </select>
    </div>

    <div id="other-venue-field" style="display:none" class="field">
      <label>Spot name</label>
      <input id="play-venue-custom" placeholder="e.g. Stangel Hall basement" />
    </div>

    <div class="field">
      <label>Your skill level</label>
      <div class="skill-row" id="play-skill-row">
        ${[1,2,3,4,5].map(i => `<button class="skill-btn${i===profile.skill?' active':''}" data-skill="${i}" onclick="selectSkill(this,'play')">${i}<br><span style="font-size:10px;font-weight:400">${SKILL_LABELS[i]}</span></button>`).join('')}
      </div>
    </div>

    <div style="margin-top:8px">
      <button class="btn btn-primary" onclick="startSession()">I'm heading there now 🏃</button>
    </div>
    <p class="muted" style="text-align:center;margin-top:12px;font-size:13px">Session auto-expires in ${SESSION_MINUTES} min</p>
  `;

  document.getElementById('play-venue').addEventListener('change', function() {
    document.getElementById('other-venue-field').style.display = this.value === 'other' ? 'block' : 'none';
  });
}

// ── WAITING SCREEN ────────────────────────────────────────────────────────────
async function renderWaiting() {
  if (!profile || !activeSession) { location.hash = '#home'; return; }

  await refreshWaitingPlayers();
  const others = waitingPlayers.filter(p => p.user_id !== profile.id && p.venue_id === activeSession.venue_id);

  const el = document.getElementById('screen-waiting');
  el.innerHTML = `
    <div class="waiting-big">
      <div style="font-size:56px;margin-bottom:12px" class="pulse">🏓</div>
      <div class="title">Signal sent!</div>
      <div class="sub">📍 ${activeSession.venue_name}</div>
      <div class="muted" style="margin-top:8px">Expires in <span class="countdown" id="waiting-countdown"></span></div>
    </div>

    <div class="section-title">Also waiting at ${activeSession.venue_name} (${others.length})</div>
    ${others.length === 0 ? `
      <div class="empty">
        <div class="emoji">📡</div>
        <div>Waiting for someone to show up...</div>
        <div style="margin-top:6px;font-size:13px">Share the app with your crew</div>
      </div>
    ` : others.map(p => playerCard(p, true)).join('')}

    <div style="margin-top:24px;display:flex;flex-direction:column;gap:10px">
      <button class="btn btn-secondary" onclick="markMatched()">✅ Found someone! Mark as matched</button>
      <button class="btn btn-danger" onclick="cancelSession()">Cancel — can't make it</button>
    </div>
  `;

  startCountdown('waiting-countdown', activeSession.expires_at);
}

// ── PROFILE SCREEN ────────────────────────────────────────────────────────────
function renderProfile() {
  const p = profile || { name: '', skill: 3 };
  const el = document.getElementById('screen-profile');
  el.innerHTML = `
    <div class="header"><div class="logo">Ping<span>Me</span> 🏓</div></div>
    <h2 style="margin-bottom:20px">Profile</h2>

    <div class="field"><label>Name</label><input id="prof-name" value="${p.name}" placeholder="Your name" /></div>
    <div class="field">
      <label>Skill level</label>
      <div class="skill-row" id="prof-skill-row">
        ${[1,2,3,4,5].map(i => `<button class="skill-btn${i===p.skill?' active':''}" data-skill="${i}" onclick="selectSkill(this,'prof')">${i}<br><span style="font-size:10px;font-weight:400">${SKILL_LABELS[i]}</span></button>`).join('')}
      </div>
    </div>
    <button class="btn btn-primary" onclick="saveProfile()" style="margin-top:8px">Save</button>

    <div class="divider"></div>
    <p class="muted" style="font-size:12px;text-align:center">Your ID: ${p.id ? p.id.slice(0,8) : 'not set'}...</p>

    <div class="divider"></div>
    <h3 style="margin-bottom:12px">📲 Add to Home Screen</h3>
    <p class="muted" style="font-size:14px;margin-bottom:12px">To get push notifications when someone wants to play, add PingMe to your home screen.</p>
    <div class="card">
      <p style="font-size:14px"><b>iPhone:</b> Tap the Share button → "Add to Home Screen"</p>
      <p style="font-size:14px;margin-top:8px"><b>Android:</b> Tap the menu (⋮) → "Add to Home Screen" or "Install App"</p>
    </div>
  `;
}

// ── ACTIONS ───────────────────────────────────────────────────────────────────
function saveSetup() {
  const name = document.getElementById('setup-name').value.trim();
  if (!name) { toast('Enter your name first'); return; }
  const skillBtn = document.querySelector('#setup-skill-row .skill-btn.active');
  const skill = skillBtn ? parseInt(skillBtn.dataset.skill) : 3;
  profile = { id: crypto.randomUUID(), name, skill };
  saveProfileLocal(profile);
  renderHome();
}

function saveProfile() {
  const name = document.getElementById('prof-name').value.trim();
  if (!name) { toast('Name required'); return; }
  const skillBtn = document.querySelector('#prof-skill-row .skill-btn.active');
  const skill = skillBtn ? parseInt(skillBtn.dataset.skill) : profile.skill;
  profile = { ...profile, name, skill };
  saveProfileLocal(profile);
  if (sb) sb.from('profiles').upsert({ id: profile.id, name, skill }).then(() => {});
  toast('Saved ✓');
}

async function startSession() {
  if (!profile) return;
  const venueSelect = document.getElementById('play-venue');
  let venueId, venueName;

  if (venueSelect.value === 'other') {
    const custom = document.getElementById('play-venue-custom').value.trim();
    if (!custom) { toast('Enter a venue name'); return; }
    venueId = null;
    venueName = custom;
  } else {
    venueId = venueSelect.value;
    venueName = venueSelect.options[venueSelect.selectedIndex].dataset.name;
  }

  const skillBtn = document.querySelector('#play-skill-row .skill-btn.active');
  const skill = skillBtn ? parseInt(skillBtn.dataset.skill) : profile.skill;
  profile.skill = skill;
  saveProfileLocal(profile);

  const expiresAt = new Date(Date.now() + SESSION_MINUTES * 60 * 1000).toISOString();
  const session = {
    id: crypto.randomUUID(),
    user_id: profile.id,
    user_name: profile.name,
    skill,
    venue_id: venueId,
    venue_name: venueName,
    status: 'waiting',
    expires_at: expiresAt,
    created_at: new Date().toISOString()
  };

  if (sb) {
    const { error } = await sb.from('sessions').insert(session);
    if (error) console.warn('DB insert failed:', error.message);
  }

  activeSession = session;
  saveActiveSession(session);
  location.hash = '#waiting';
}

async function cancelSession() {
  if (!activeSession) return;
  if (sb) await sb.from('sessions').update({ status: 'cancelled' }).eq('id', activeSession.id);
  activeSession = null;
  clearActiveSession();
  location.hash = '#home';
  toast('Session cancelled');
}

async function markMatched() {
  if (!activeSession) return;
  if (sb) await sb.from('sessions').update({ status: 'matched' }).eq('id', activeSession.id);
  activeSession = null;
  clearActiveSession();
  toast('🏓 Nice! Have a great game!');
  setTimeout(() => { location.hash = '#home'; }, 1500);
}

// ── REALTIME ──────────────────────────────────────────────────────────────────
function subscribeRealtime() {
  if (!sb) return;
  if (realtimeSub) sb.removeChannel(realtimeSub);

  realtimeSub = sb.channel('sessions-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, async (payload) => {
      await refreshWaitingPlayers();
      const hash = location.hash || '#home';
      if (hash === '#home') renderHome();
      if (hash === '#waiting') renderWaiting();
    })
    .subscribe();
}

async function refreshWaitingPlayers() {
  if (!sb) { waitingPlayers = []; return; }
  const { data } = await sb.from('sessions')
    .select('*')
    .eq('status', 'waiting')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  waitingPlayers = data || [];
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function loadVenues() {
  if (sb) {
    const { data } = await sb.from('venues').select('*').order('name');
    if (data && data.length) { venues = data; return; }
  }
  venues = [
    { id: 'v1', name: 'Student Center - Ping Pong Room', location: 'TTU Student Union' },
    { id: 'v2', name: 'Rec Center', location: 'TTU Recreation Center' },
    { id: 'v3', name: 'Library 2nd Floor', location: 'TTU Library' }
  ];
}

function playerCard(p, showMatchBtn = false) {
  const ago = timeAgo(p.created_at);
  return `
    <div class="player-card">
      <div class="player-avatar">🏓</div>
      <div class="player-info">
        <div class="player-name">${escHtml(p.user_name)}</div>
        <div class="player-meta">
          <span class="skill-dot ${SKILL_CLASSES[p.skill]}"></span>
          ${SKILL_LABELS[p.skill]} · ${escHtml(p.venue_name)}
        </div>
      </div>
      <div style="text-align:right">
        <div class="player-time">${ago}</div>
        <span class="badge badge-waiting pulse" style="margin-top:4px">waiting</span>
      </div>
    </div>`;
}

function selectSkill(btn, prefix) {
  document.querySelectorAll(`#${prefix}-skill-row .skill-btn`).forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const labelEl = document.getElementById(`${prefix}-skill-label`);
  if (labelEl) labelEl.textContent = `${btn.dataset.skill} — ${SKILL_LABELS[parseInt(btn.dataset.skill)]}`;
}

function startCountdown(elId, expiresAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  function update() {
    const el = document.getElementById(elId);
    if (!el) { clearInterval(countdownInterval); return; }
    const diff = new Date(expiresAt) - new Date();
    if (diff <= 0) { el.textContent = 'expired'; clearInterval(countdownInterval); return; }
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `${m}:${String(s).padStart(2,'0')}`;
  }
  update();
  countdownInterval = setInterval(update, 1000);
}

function timeAgo(ts) {
  const diff = Date.now() - new Date(ts);
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  return `${Math.floor(diff/3600000)}h ago`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, duration = 2500) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

// ── LOCAL STORAGE ──────────────────────────────────────────────────────────────
function loadProfile() { try { return JSON.parse(localStorage.getItem('pingme_profile')); } catch { return null; } }
function saveProfileLocal(p) { localStorage.setItem('pingme_profile', JSON.stringify(p)); }
function loadActiveSession() { try { return JSON.parse(localStorage.getItem('pingme_session')); } catch { return null; } }
function saveActiveSession(s) { localStorage.setItem('pingme_session', JSON.stringify(s)); }
function clearActiveSession() { localStorage.removeItem('pingme_session'); }
