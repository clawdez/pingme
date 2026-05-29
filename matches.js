/* pingme — matches, ELO, voice scoring, access codes */
/* Loaded after app.js. Reads global `sb`, `profile`, `roster`, `toast`, `esc`, `getVenueName`. */

(function () {
  'use strict';

  const WIN_BY = 2;
  const TARGET = 11;

  // ── state ─────────────────────────────────────
  let live = null;          // { id, p1, p2, s1, s2, scoring_mode }
  let recog = null;         // SpeechRecognition instance
  let listening = false;

  // ── DOM bootstrapping ─────────────────────────
  function ensureModal() {
    let m = document.getElementById('sheet-match');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'sheet-wrap';
    m.id = 'sheet-match';
    m.innerHTML = `
      <div class="sheet-scrim" data-dismiss></div>
      <div class="modal-center modal-tall match-modal">
        <button class="modal-close" data-match-close>&times;</button>
        <div class="match-head">
          <h3 class="match-title">live match</h3>
          <div class="match-venue" id="match-venue"></div>
        </div>
        <div class="match-board">
          <div class="mside" id="mside-1">
            <div class="mside-name" id="mname-1">—</div>
            <button class="mscore" id="mscore-1" type="button">0</button>
            <div class="mside-actions">
              <button class="mbtn-minus" data-side="1" type="button">−</button>
              <button class="mbtn-plus" data-side="1" type="button">+1</button>
            </div>
          </div>
          <div class="mvs">vs</div>
          <div class="mside" id="mside-2">
            <div class="mside-name" id="mname-2">—</div>
            <button class="mscore" id="mscore-2" type="button">0</button>
            <div class="mside-actions">
              <button class="mbtn-minus" data-side="2" type="button">−</button>
              <button class="mbtn-plus" data-side="2" type="button">+1</button>
            </div>
          </div>
        </div>
        <div class="match-status" id="match-status">first to 11, win by 2</div>
        <div class="match-voice">
          <button class="match-voice-btn" id="match-voice-btn" type="button">
            <span class="mvb-icon">&#127908;</span>
            <span class="mvb-label">voice scoring: off</span>
          </button>
          <div class="match-voice-heard" id="match-voice-heard"></div>
        </div>
        <div class="match-bottom">
          <button class="match-end" id="match-end" type="button">end match</button>
          <button class="match-abandon" id="match-abandon" type="button">abandon</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);

    m.querySelector('[data-match-close]').addEventListener('click', closeModal);
    m.querySelector('.sheet-scrim').addEventListener('click', closeModal);
    m.querySelectorAll('.mbtn-plus').forEach(b => {
      b.addEventListener('click', () => bump(+1, +b.dataset.side));
    });
    m.querySelectorAll('.mbtn-minus').forEach(b => {
      b.addEventListener('click', () => bump(-1, +b.dataset.side));
    });
    document.getElementById('mscore-1').addEventListener('click', () => bump(+1, 1));
    document.getElementById('mscore-2').addEventListener('click', () => bump(+1, 2));
    document.getElementById('match-voice-btn').addEventListener('click', toggleVoice);
    document.getElementById('match-end').addEventListener('click', endMatch);
    document.getElementById('match-abandon').addEventListener('click', abandonMatch);
    return m;
  }

  function closeModal() {
    stopVoice();
    document.getElementById('sheet-match')?.classList.remove('open');
  }

  // ── open / start ──────────────────────────────
  async function openMatch(opponentId) {
    if (!profile) { toast('sign in first'); return; }
    if (!opponentId || opponentId === profile.id) { toast('pick someone else'); return; }
    const opp = (roster || []).find(r => r.id === opponentId);
    if (!opp) { toast('opponent not found'); return; }

    ensureModal();
    const { data, error } = await sb.from('matches').insert({
      p1_id: profile.id,
      p2_id: opp.id,
      venue: (typeof getVenueName === 'function' ? getVenueName() : null),
      scoring_mode: 'tap'
    }).select().single();
    if (error) { console.error(error); toast('could not start match'); return; }

    live = {
      id: data.id,
      p1: { id: profile.id, name: profile.name, color: profile.color },
      p2: { id: opp.id, name: opp.name, color: opp.color },
      s1: 0,
      s2: 0,
      scoring_mode: 'tap'
    };
    document.getElementById('mname-1').textContent = live.p1.name + ' (you)';
    document.getElementById('mname-2').textContent = live.p2.name;
    document.getElementById('match-venue').textContent = data.venue || '';
    document.getElementById('mside-1').style.setProperty('--mside-color', live.p1.color || '#E8502A');
    document.getElementById('mside-2').style.setProperty('--mside-color', live.p2.color || '#2544D6');
    renderScore();
    document.getElementById('sheet-match').classList.add('open');
  }

  function renderScore() {
    if (!live) return;
    document.getElementById('mscore-1').textContent = live.s1;
    document.getElementById('mscore-2').textContent = live.s2;
    const status = document.getElementById('match-status');
    const done = matchPoint(live.s1, live.s2);
    if (done.winner) {
      status.textContent = `match point — ${done.winner === 1 ? live.p1.name : live.p2.name} wins!`;
      status.classList.add('match-status-win');
    } else {
      status.classList.remove('match-status-win');
      status.textContent = 'first to 11, win by 2';
    }
  }

  function matchPoint(a, b) {
    if (a >= TARGET && a - b >= WIN_BY) return { winner: 1 };
    if (b >= TARGET && b - a >= WIN_BY) return { winner: 2 };
    return { winner: 0 };
  }

  async function bump(delta, side) {
    if (!live) return;
    const key = side === 1 ? 's1' : 's2';
    const next = Math.max(0, Math.min(50, live[key] + delta));
    if (next === live[key]) return;
    live[key] = next;
    renderScore();
    // fire-and-forget persist
    sb.from('matches').update({
      p1_score: live.s1,
      p2_score: live.s2
    }).eq('id', live.id).then(({ error }) => {
      if (error) console.error('score update failed', error);
    });
  }

  // ── voice scoring ─────────────────────────────
  function toggleVoice() {
    if (listening) { stopVoice(); return; }
    startVoice();
  }

  function startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast('voice not supported on this device');
      return;
    }
    recog = new SR();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = 'en-US';
    recog.onresult = onVoiceResult;
    recog.onerror = (e) => {
      console.warn('voice err', e.error);
      if (e.error === 'not-allowed') {
        toast('mic permission denied');
        stopVoice();
      }
    };
    recog.onend = () => {
      if (listening) {
        try { recog.start(); } catch {}
      }
    };
    try { recog.start(); listening = true; updateVoiceBtn(); }
    catch (e) { console.error(e); }
    if (live) {
      live.scoring_mode = live.scoring_mode === 'tap' ? 'mixed' : 'voice';
      sb.from('matches').update({ scoring_mode: live.scoring_mode }).eq('id', live.id);
    }
  }

  function stopVoice() {
    listening = false;
    if (recog) { try { recog.stop(); } catch {} recog = null; }
    updateVoiceBtn();
  }

  function updateVoiceBtn() {
    const btn = document.getElementById('match-voice-btn');
    if (!btn) return;
    btn.classList.toggle('on', listening);
    btn.querySelector('.mvb-label').textContent = 'voice scoring: ' + (listening ? 'on' : 'off');
    if (!listening) {
      const heard = document.getElementById('match-voice-heard');
      if (heard) heard.textContent = '';
    }
  }

  // parse spoken score: "three to eight", "3-8", "8 3", "score is 5 7"
  const WORDS = {
    zero: 0, oh: 0, o: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5,
    six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, love: 0, nil: 0
  };

  function parseScore(text) {
    if (!text) return null;
    const t = text.toLowerCase().trim();
    // digits with separator
    let m = t.match(/(\b\d{1,2})\s*(?:-|to|,|–|vs|versus|\s)\s*(\d{1,2}\b)/);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
    // two number words
    const tokens = t.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    const nums = [];
    for (const tok of tokens) {
      if (/^\d{1,2}$/.test(tok)) nums.push(parseInt(tok, 10));
      else if (tok in WORDS) nums.push(WORDS[tok]);
      if (nums.length >= 2) break;
    }
    if (nums.length >= 2) return [nums[0], nums[1]];
    return null;
  }

  function onVoiceResult(ev) {
    if (!live) return;
    let finalText = '';
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' ';
      else interim += r[0].transcript;
    }
    const heard = document.getElementById('match-voice-heard');
    if (heard) heard.textContent = '“' + (finalText || interim).trim() + '”';
    if (!finalText) return;

    const parsed = parseScore(finalText);
    if (!parsed) return;
    let [a, b] = parsed;
    // sanity: ignore wild numbers
    if (a > 30 || b > 30) return;
    // require monotonic progress (never decrease both, never jump > +3)
    const da = a - live.s1, db = b - live.s2;
    if ((da < 0 && db < 0) || da > 3 || db > 3) {
      if (heard) heard.textContent += '  (ignored)';
      return;
    }
    live.s1 = a;
    live.s2 = b;
    renderScore();
    sb.from('matches').update({
      p1_score: a, p2_score: b
    }).eq('id', live.id);
  }

  // ── end / abandon ─────────────────────────────
  async function endMatch() {
    if (!live) return;
    if (live.s1 === live.s2) { toast('tied — keep playing'); return; }
    const btn = document.getElementById('match-end');
    btn.disabled = true; btn.textContent = 'saving…';
    stopVoice();
    const { data, error } = await sb.rpc('finalize_match', { match_id: live.id });
    if (error) {
      console.error(error);
      toast('could not finalize');
      btn.disabled = false; btn.textContent = 'end match';
      return;
    }
    const m = Array.isArray(data) ? data[0] : data;
    const won = m?.winner_id === profile.id;
    const myBefore = m?.p1_id === profile.id ? m.p1_elo_before : m?.p2_elo_before;
    const myAfter = m?.p1_id === profile.id ? m.p1_elo_after : m?.p2_elo_after;
    const delta = (myAfter ?? 0) - (myBefore ?? 0);
    const sign = delta >= 0 ? '+' : '';
    toast((won ? 'W ' : 'L ') + sign + delta + ' ELO');
    if (profile && typeof myAfter === 'number') profile.elo = myAfter;
    closeModal();
    live = null;
    // refresh leaderboard if visible
    if (typeof window.renderLeaderboard === 'function') {
      try { window.renderLeaderboard(); } catch {}
    }
  }

  async function abandonMatch() {
    if (!live) return;
    if (!confirm('abandon this match? no ELO change.')) return;
    await sb.from('matches').update({ status: 'abandoned', ended_at: new Date().toISOString() }).eq('id', live.id);
    stopVoice();
    closeModal();
    live = null;
  }

  // ── access codes ──────────────────────────────
  const AC_KEY = 'pm_invited_via';

  function getCodeFromUrl() {
    try { return new URLSearchParams(location.search).get('code'); } catch { return null; }
  }

  async function maybeClaimAccessCode() {
    if (!profile || !sb) return;
    if (profile.invited_via) return;
    // Allow via ref param (referral): considered an open invite
    const ref = (new URLSearchParams(location.search)).get('ref');
    if (ref) {
      await sb.from('profiles').update({ invited_via: 'ref:' + ref }).eq('id', profile.id);
      profile.invited_via = 'ref:' + ref;
      return;
    }
    let code = getCodeFromUrl() || localStorage.getItem(AC_KEY);
    if (code) {
      code = code.trim().toUpperCase();
      const { data, error } = await sb.rpc('claim_access_code', { p_code: code, p_user: profile.id });
      if (!error && data === true) {
        localStorage.removeItem(AC_KEY);
        profile.invited_via = 'code:' + code;
        return;
      }
    }
    promptAccessCode();
  }

  function promptAccessCode() {
    let el = document.getElementById('sheet-access');
    if (!el) {
      el = document.createElement('div');
      el.className = 'sheet-wrap';
      el.id = 'sheet-access';
      el.innerHTML = `
        <div class="sheet-scrim"></div>
        <div class="modal-center">
          <h3>got an invite code?</h3>
          <p class="ac-sub">enter the code a friend shared with you, or use <b>PINGME</b> to join the public table.</p>
          <input class="ac-input" id="ac-input" maxlength="16" autocapitalize="characters" placeholder="CODE"/>
          <button class="ping-confirm-btn" id="ac-submit">join</button>
          <div class="ac-error" id="ac-error"></div>
        </div>
      `;
      document.body.appendChild(el);
      el.querySelector('#ac-submit').addEventListener('click', async () => {
        const inp = el.querySelector('#ac-input');
        const err = el.querySelector('#ac-error');
        const v = (inp.value || '').trim().toUpperCase();
        if (v.length < 4) { err.textContent = 'too short'; return; }
        err.textContent = '';
        const { data, error } = await sb.rpc('claim_access_code', { p_code: v, p_user: profile.id });
        if (error || data !== true) {
          err.textContent = 'invalid or expired code';
          return;
        }
        localStorage.removeItem(AC_KEY);
        profile.invited_via = 'code:' + v;
        el.classList.remove('open');
      });
    }
    el.classList.add('open');
  }

  // capture code from URL even before sign-in
  (function captureCodeEarly() {
    const c = getCodeFromUrl();
    if (c) localStorage.setItem(AC_KEY, c.trim().toUpperCase());
  })();

  // ── public surface ────────────────────────────
  window.pmMatch = {
    open: openMatch,
    close: closeModal,
    claimAccessCode: maybeClaimAccessCode,
    promptAccessCode
  };
})();
