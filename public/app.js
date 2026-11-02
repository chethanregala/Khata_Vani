/* ఖాతా వాణి — hash-routed SPA, vanilla JS, no build step.
   Routes: #/splash #/login #/verify #/profile #/home
   Ledger lives on the server (Supabase) — no localStorage. */
'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const appEl = () => document.getElementById('app');

const state = {
  phone: null,         // phone being verified
  exists: false,       // does this phone already have an account?
  voiceOkToken: null,  // proof the challenge word was heard (5 min JWT)
  shop: null,          // logged-in shop profile (never pin_hash)
  customers: [],       // customer list with balances (from /api/customers)
};

// ---------- helpers ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const delay = ms => new Promise(r => setTimeout(r, ms));
// exact normalized-name match: lowercase, strip ZWNJ/ZWJ, collapse spaces
function normalizeName(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase()
    .replace(/[\u200c\u200d]/g, '').replace(/\s+/g, ' ').trim();
}
function showErr(el, msg) { if (el) { el.textContent = msg; el.hidden = false; } }
function hideErr(el) { if (el) { el.textContent = ''; el.hidden = true; } }
function goLogin() {
  state.shop = null; state.customers = []; state.voiceOkToken = null; state.phone = null;
  if (location.hash !== '#/login') location.hash = '#/login';
}

// ---------- logo (inline SVG) ----------
function logoSVG() {
  return `<svg class="logo" viewBox="0 0 260 344" role="img" aria-label="ఖాతా వాణి Khata Vani" xmlns="http://www.w3.org/2000/svg">
  <rect x="30" y="8" width="200" height="200" rx="46" fill="#0a7d4b"/>
  <path d="M62 96c26-12 50-10 66 6 16-16 40-18 66-6v64c-26-12-50-10-66 6-16-16-40-18-66-6z" fill="#ffffff"/>
  <path d="M128 102v64" stroke="#0a7d4b" stroke-width="5"/>
  <path d="M76 112c16-6 32-5 42 3M138 115c10-8 26-9 42-3M76 132c16-6 32-5 42 3M138 135c10-8 26-9 42-3" stroke="#a8d8c2" stroke-width="4" fill="none" stroke-linecap="round"/>
  <g stroke="#ffffff" fill="none" stroke-linecap="round">
    <rect x="163" y="34" width="18" height="30" rx="9" fill="#ffffff" stroke="none"/>
    <path d="M157 60a15 15 0 0 0 30 0" stroke-width="5"/>
    <path d="M172 75v10" stroke-width="5"/>
    <path d="M148 40q-7 12 0 24" stroke-width="4" opacity=".85"/>
  </g>
  <text x="130" y="272" text-anchor="middle" font-size="36" font-weight="700" fill="#0a7d4b">ఖాతా వాణి</text>
  <text x="130" y="316" text-anchor="middle" font-size="21" letter-spacing="4" fill="#4a4a4a">Khata Vani</text>
</svg>`;
}

// ---------- router ----------
function route() {
  const view = (location.hash || '#/splash').split('?')[0];
  if (view === '#/login') return viewLogin();
  if (view === '#/verify') return viewVerify();
  if (view === '#/profile') return viewProfile();
  if (view === '#/home') return viewHome();
  return viewSplash();
}
window.addEventListener('hashchange', route);
function boot() {
  // splash shows on EVERY app open, then routes by session state
  if (location.hash !== '#/splash') history.replaceState(null, '', '#/splash');
  route();
}
boot();

// ---------- #/splash ----------
function viewSplash() {
  appEl().innerHTML = `<div class="splash"><div class="splash-in">${logoSVG()}</div></div>`;
  const meP = api('/api/me').catch(() => null); // 401 / offline -> null
  setTimeout(async () => {
    const me = await meP;
    if (!me) { state.shop = null; location.hash = '#/login'; }
    else if (!me.profileComplete) { state.shop = me.shop; location.hash = '#/profile'; }
    else { state.shop = me.shop; location.hash = '#/home'; }
  }, 1800);
}

// ---------- #/login ----------
function viewLogin() {
  appEl().innerHTML = `
  <div class="page">
    <div class="brand mini-logo">${logoSVG()}</div>
    <h1>లాగిన్ అవ్వండి</h1>
    <p class="sub">మీ మొబైల్ నంబర్ నమోదు చేయండి</p>
    <div class="phone-row">
      <span class="cc">+91</span>
      <input id="phone" class="input" type="tel" inputmode="numeric" autocomplete="tel-national"
        maxlength="10" placeholder="98765 43210" aria-label="మొబైల్ నంబర్">
    </div>
    <div id="lerr" class="err" hidden></div>
    <button id="next" class="btn primary big">తదుపరి</button>
  </div>`;
  const input = $('#phone');
  const err = $('#lerr');
  input.focus();
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 10);
    hideErr(err);
  });
  $('#next').onclick = async () => {
    const phone = input.value.trim();
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return showErr(err, '10 అంకెల సరైన మొబైల్ నంబర్ వేయండి (6-9 తో మొదలవుతుంది)');
    }
    const btn = $('#next');
    btn.disabled = true;
    try {
      const r = await api('/api/auth/start', { method: 'POST', body: { phone } });
      state.phone = phone;
      state.exists = !!r.exists;
      state.voiceOkToken = null;
      location.hash = '#/verify';
    } catch (e) {
      showErr(err, e.message);
      btn.disabled = false;
    }
  };
}

// ---------- #/verify: voice word check + PIN ----------
let challenge = null;   // { challengeId, audioUrl, options } — answer never leaves the server
let wrongCount = 0;
let pinEntry = '';
let pinMode = 'enter';  // 'enter' | 'create'
let pinFirst = null;

function viewVerify() {
  if (!state.phone) { location.hash = '#/login'; return; }
  challenge = null; wrongCount = 0; pinEntry = ''; pinFirst = null;
  appEl().innerHTML = `
  <div class="page">
    <div class="mini-logo">${logoSVG()}</div>
    <div id="voiceSec">
      <h1>ధ్వని ధృవీకరణ</h1>
      <p class="sub">మీకు వినిపించిన పదాన్ని కింది పదాలలో ఎంచుకోండి</p>
      <button id="listen" class="listen pulse" aria-label="వినండి">🔊</button>
      <p class="hint">వినండి</p>
      <a href="#" id="again" class="link">▶ మళ్లీ వినండి</a>
      <div id="options" class="options"></div>
      <div id="verr" class="err" hidden></div>
      <div id="wnote" class="note" hidden></div>
    </div>
    <div id="pinSec" hidden>
      <h1 id="pinTitle"></h1>
      <p class="sub" id="pinSub"></p>
      <div class="pin-dots" id="dots" aria-live="polite"></div>
      <div class="pinpad" id="pad"></div>
      <div id="perr" class="err" hidden></div>
    </div>
  </div>`;
  $('#listen').onclick = playChallenge;
  $('#again').onclick = e => { e.preventDefault(); playChallenge(); };
  buildPad();
  loadChallenge().catch(e => showErr($('#verr'), e.message));
}

async function loadChallenge() {
  const r = await api('/api/auth/challenge?phone=' + encodeURIComponent(state.phone));
  challenge = r;
  const box = $('#options');
  if (!box) return;
  box.innerHTML = '';
  for (const word of r.options) {
    const b = document.createElement('button');
    b.className = 'option-card';
    b.type = 'button';
    b.textContent = word;
    b.onclick = () => answerChallenge(word);
    box.appendChild(b);
  }
  playChallenge(); // auto-play; the big 🔊 button is the fallback if blocked
}

function playChallenge() {
  if (!challenge) return;
  const btn = $('#listen');
  const a = new Audio(challenge.audioUrl);
  const p = a.play();
  if (p && p.catch) p.catch(() => { if (btn) btn.classList.add('pulse'); }); // autoplay blocked
}

async function answerChallenge(choice) {
  const err = $('#verr');
  hideErr(err);
  document.querySelectorAll('.option-card').forEach(b => b.disabled = true);
  try {
    const r = await api('/api/auth/challenge/answer', {
      method: 'POST',
      body: { challengeId: challenge.challengeId, phone: state.phone, choice },
    });
    state.voiceOkToken = r.voiceOkToken;
    wrongCount = 0;
    showPin();
  } catch (e) {
    // wrong answer burned this challenge → always fetch a fresh word
    wrongCount++;
    const note = $('#wnote');
    if (wrongCount >= 2) {
      showErr(note, 'రెండుసార్లు తప్పు! కొత్త పదం విని మళ్లీ ప్రయత్నించండి.');
      wrongCount = 0;
    } else {
      showErr(note, 'తప్పు! మళ్లీ ప్రయత్నించండి.');
    }
    try { await loadChallenge(); } catch (e2) { showErr(err, e2.message); }
  }
}

function showPin() {
  const vs = $('#voiceSec'), ps = $('#pinSec');
  if (!vs || !ps) return;
  vs.hidden = true;
  ps.hidden = false;
  pinMode = state.exists ? 'enter' : 'create';
  pinFirst = null; pinEntry = '';
  $('#pinTitle').textContent = state.exists ? 'పిన్ నమోదు చేయండి' : 'కొత్త 4-అంకెల పిన్ సృష్టించండి';
  $('#pinSub').textContent = state.exists ? 'మీ 4 అంకెల పిన్ వేయండి' : '4 అంకెల పిన్ సృష్టించి, మళ్లీ నమోదు చేయండి';
  renderDots();
}

function buildPad() {
  const pad = $('#pad');
  if (!pad) return;
  pad.innerHTML = '';
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0']) {
    const b = document.createElement('button');
    b.className = 'key';
    b.type = 'button';
    b.textContent = k;
    b.setAttribute('aria-label', k === '⌫' ? 'తొలగించు' : k);
    b.onclick = () => pressKey(k);
    pad.appendChild(b);
  }
  renderDots();
}
function renderDots() {
  const d = $('#dots');
  if (d) d.textContent = '●'.repeat(pinEntry.length) + '○'.repeat(4 - pinEntry.length);
}
async function pressKey(k) {
  hideErr($('#perr'));
  if (k === '⌫') { pinEntry = pinEntry.slice(0, -1); renderDots(); return; }
  if (!/\d/.test(k) || pinEntry.length >= 4) return;
  pinEntry += k;
  renderDots();
  if (pinEntry.length === 4) {
    const pin = pinEntry;
    pinEntry = '';
    setTimeout(() => submitPin(pin), 160);
  }
}
function backToVoice(msg) {
  // voiceOk token expired/invalid → start the voice check again
  state.voiceOkToken = null;
  const vs = $('#voiceSec'), ps = $('#pinSec');
  if (vs && ps) {
    ps.hidden = true;
    vs.hidden = false;
    showErr($('#verr'), msg || 'ధ్వని ధృవీకరణ ముగిసింది, మళ్లీ వినండి.');
    loadChallenge().catch(e => showErr($('#verr'), e.message));
  } else location.hash = '#/login';
}
async function submitPin(pin) {
  const err = $('#perr');
  if (pinMode === 'create' && !pinFirst) {
    pinFirst = pin;
    renderDots();
    $('#pinTitle').textContent = 'మళ్లీ నమోదు చేయండి';
    $('#pinSub').textContent = 'అదే పిన్ మళ్లీ వేయండి';
    return;
  }
  if (pinMode === 'create') {
    if (pin !== pinFirst) {
      pinFirst = null;
      renderDots();
      showErr(err, 'పిన్ సరిలేదు! మళ్లీ కొత్త పిన్ సృష్టించండి.');
      $('#pinTitle').textContent = 'కొత్త 4-అంకెల పిన్ సృష్టించండి';
      $('#pinSub').textContent = '4 అంకెల పిన్ సృష్టించి, మళ్లీ నమోదు చేయండి';
      return;
    }
    try {
      const r = await api('/api/auth/signup', {
        method: 'POST',
        body: { phone: state.phone, pin, voiceOkToken: state.voiceOkToken },
      });
      state.shop = r.shop;
      state.voiceOkToken = null;
      location.hash = '#/profile';
    } catch (e) {
      renderDots();
      if (e.status === 400 && e.message.indexOf('ధ్వని') !== -1) return backToVoice(e.message);
      showErr(err, e.message);
      if (e.status === 409) setTimeout(() => goLogin(), 1600);
    }
    return;
  }
  // login
  try {
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: { phone: state.phone, pin, voiceOkToken: state.voiceOkToken },
    });
    state.shop = r.shop;
    state.voiceOkToken = null;
    location.hash = '#/home';
  } catch (e) {
    renderDots();
    if (e.status === 400 && e.message.indexOf('ధ్వని') !== -1) return backToVoice(e.message);
    showErr(err, e.message); // wrong PIN / locked — generic Telugu message from server
  }
}

// ---------- #/profile: onboarding ----------
async function viewProfile() {
  let me = null;
  try { me = await api('/api/me'); }
  catch (e) { if (e.status === 401) return goLogin(); }
  if (!me) return;
  state.shop = me.shop;
  const s = me.shop || {};
  appEl().innerHTML = `
  <div class="page">
    <div class="mini-logo">${logoSVG()}</div>
    <h1>మీ దుకాణ వివరాలు</h1>
    <p class="sub">ఖాతా వాడటానికి ఈ మూడు వివరాలు తప్పనిసరి</p>
    <label class="field" for="owner">మీ పేరు</label>
    <input id="owner" class="input" maxlength="80" value="${esc(s.owner_name)}" autocomplete="name">
    <label class="field" for="shop">దుకాణం పేరు</label>
    <input id="shop" class="input" maxlength="120" value="${esc(s.shop_name)}" autocomplete="organization">
    <label class="field" for="addr">చిరునామా</label>
    <textarea id="addr" class="input" maxlength="500" rows="3">${esc(s.address)}</textarea>
    <div id="perr2" class="err" hidden></div>
    <button id="cont" class="btn primary big">కొనసాగించండి</button>
  </div>`;
  $('#cont').onclick = async () => {
    const err = $('#perr2');
    hideErr(err);
    const owner_name = $('#owner').value.trim();
    const shop_name = $('#shop').value.trim();
    const address = $('#addr').value.trim();
    if (!owner_name || !shop_name || !address) return showErr(err, 'అన్ని వివరాలు తప్పనిసరి');
    if (owner_name.length > 80 || shop_name.length > 120 || address.length > 500) {
      return showErr(err, 'వివరాలు చాలా పొడవుగా ఉన్నాయి');
    }
    const btn = $('#cont');
    btn.disabled = true;
    try {
      const r = await api('/api/me', { method: 'PUT', body: { owner_name, shop_name, address } });
      state.shop = r.shop;
      location.hash = '#/home';
    } catch (e) {
      btn.disabled = false;
      if (e.status === 401) return goLogin();
      showErr(err, e.message);
    }
  };
}

// ---------- #/home: mic + ledger ----------
let pending = null, rec = null, chunks = [], recTimer = null;

async function loadCustomers() {
  state.customers = await api('/api/customers');
}

function draw() {
  const list = $('#list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.customers.length) {
    list.innerHTML = '<div class="empty">ఇంకా కస్టమర్లు లేరు — మొదటి నమోదు చేయండి</div>';
    return;
  }
  const rows = state.customers.slice().sort((a, b) =>
    String(b.last_activity || '').localeCompare(String(a.last_activity || '')));
  for (const c of rows) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.innerHTML = `${esc(c.name)}: <b>₹${c.balance}</b>`;
    li.appendChild(span);
    if (c.balance > 0) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '🔊 రిమైండర్';
      b.onclick = () => remind(c);
      li.appendChild(b);
    }
    list.appendChild(li);
  }
}

function wav(d, sr) {
  const v = new DataView(new ArrayBuffer(44 + d.length * 2)), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + d.length * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, d.length * 2, true);
  d.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true));
  return v.buffer;
}
async function toWav(blob) {
  const dec = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000), s = off.createBufferSource();
  s.buffer = dec; s.connect(off.destination); s.start();
  return wav((await off.startRendering()).getChannelData(0), 16000);
}

async function speak(text) {
  const sayEl = $('#say');
  if (sayEl) sayEl.textContent = text;
  try {
    const b = await apiAudio('/api/tts', { body: { text } });
    const a = new Audio(URL.createObjectURL(b));
    await a.play().catch(() => {});
    return b;
  } catch (e) {
    if (e.status === 401) return goLogin();
    if (sayEl) sayEl.textContent = 'TTS సమస్య: ' + e.message;
    return null;
  }
}

async function remind(c) {
  const b = await speak(`${c.name} గారూ, మీ ${c.balance} రూపాయల బాకీ ఉంది. వీలైనప్పుడు ఇవ్వగలరు, ధన్యవాదాలు.`);
  if (b) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = c.name + '-reminder.wav';
    a.click();
  }
}

async function handle(p) {
  if (p.type === 'query' && p.name) {
    const c = state.customers.find(x => normalizeName(x.name) === normalizeName(p.name));
    if (!c) return speak(`${p.name} పేరు దొరకలేదు.`);
    return speak(`${p.name} బాకీ ${c.balance} రూపాయలు.`);
  }
  if (!p.type || !p.amount || !p.name) return speak('అర్థం కాలేదు, మళ్లీ చెప్పండి.');
  pending = p;
  const ok = $('#ok');
  if (ok) ok.hidden = false;
  speak(`${p.name}, ${p.amount} రూపాయలు ${p.type === 'credit' ? 'ఉద్దెర' : 'జమ'}. సరిగ్గా ఉందా?`);
}

function wireMic() {
  const mic = $('#mic');
  if (!mic) return;
  mic.onclick = async () => {
    if (rec) { rec.stop(); return; }
    const ok = $('#ok');
    if (ok) ok.hidden = true;
    let st;
    try { st = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (_) { const s = $('#say'); if (s) s.textContent = 'మైక్ అనుమతి లేదు, బ్రౌజర్‌లో అనుమతించండి'; return; }
    rec = new MediaRecorder(st);
    chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      clearTimeout(recTimer);
      st.getTracks().forEach(t => t.stop());
      rec = null;
      mic.classList.remove('rec');
      const sayEl = $('#say');
      if (sayEl) sayEl.textContent = '…';
      try {
        const r = await fetch('/api/stt', {
          method: 'POST', headers: { 'Content-Type': 'audio/wav' }, credentials: 'include',
          body: await toWav(new Blob(chunks)),
        });
        const x = await r.text();
        if (r.status === 401) return goLogin();
        const dbg = $('#dbg');
        if (dbg) dbg.textContent = 'STT ' + r.status + ': ' + x.slice(0, 300);
        let j = {};
        try { j = JSON.parse(x); } catch (_) {}
        if (!j.transcript) { if (sayEl) sayEl.textContent = 'వినపడలేదు, మళ్లీ చెప్పండి'; return; }
        const p = parse(j.transcript);
        if (dbg) dbg.textContent += ' | ' + JSON.stringify(p);
        handle(p);
      } catch (e) {
        if (sayEl) sayEl.textContent = 'సమస్య జరిగింది';
        const dbg = $('#dbg');
        if (dbg) dbg.textContent = 'ERR: ' + e;
      }
    };
    rec.start();
    mic.classList.add('rec');
    const sayEl = $('#say');
    if (sayEl) sayEl.textContent = 'వింటున్నాను…';
    recTimer = setTimeout(() => { if (rec) rec.stop(); }, 20000);
  };

  $('#yes').onclick = async () => {
    const p = pending;
    if (!p) return;
    pending = null;
    $('#ok').hidden = true;
    try {
      // exact normalized-name match; create the customer only when confirmed
      let c = state.customers.find(x => normalizeName(x.name) === normalizeName(p.name));
      if (!c) c = await api('/api/customers', { method: 'POST', body: { name: p.name } });
      await api('/api/transactions', {
        method: 'POST',
        body: { customer_id: c.id, type: p.type, amount: p.amount, raw_transcript: p.raw },
      });
      await loadCustomers();
      draw();
      speak('నమోదు చేశాను.');
    } catch (e) {
      if (e.status === 401) return goLogin();
      speak(e.message || 'సేవ్ కాలేదు, మళ్లీ ప్రయత్నించండి');
    }
  };
  $('#no').onclick = () => {
    pending = null;
    $('#ok').hidden = true;
    speak('సరే, మళ్లీ చెప్పండి.');
  };
}

async function viewHome() {
  let me = state.shop
    ? { shop: state.shop, profileComplete: !!(state.shop.owner_name && state.shop.shop_name && state.shop.address) }
    : null;
  if (!me) {
    try { me = await api('/api/me'); } catch (e) { if (e.status === 401) return goLogin(); }
  }
  if (!me) return;
  if (!me.profileComplete) { location.hash = '#/profile'; return; }
  state.shop = me.shop;
  const s = me.shop;
  appEl().innerHTML = `
  <header class="topbar">
    <span class="shop-name">${esc(s.shop_name)}</span>
    <button id="logout" class="logout" type="button">లాగ్ అవుట్</button>
  </header>
  <div class="page">
    <button id="mic" aria-label="మైక్">🎤</button>
    <div id="say">నొక్కి మాట్లాడండి (Tap and speak)</div>
    <div id="ok" hidden><button id="yes" type="button" aria-label="అవును">✅</button><button id="no" type="button" aria-label="కాదు">❌</button></div>
    <pre id="dbg"></pre>
    <h2 class="list-title">కస్టమర్లు · బాకీలు</h2>
    <ul id="list"></ul>
    <div id="herr" class="err" hidden></div>
  </div>`;
  $('#logout').onclick = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    goLogin();
  };
  wireMic();
  try {
    await loadCustomers();
    draw();
  } catch (e) {
    if (e.status === 401) return goLogin();
    showErr($('#herr'), e.message);
  }
}


