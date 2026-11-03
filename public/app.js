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
  today: [],           // today's transactions (IST)
  recent: [],          // last 5 entries across days
  custSort: 'balance', // customers screen sort chip
  custQuery: '',       // customers screen search box
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
  state.shop = null; state.customers = []; state.today = []; state.recent = [];
  state.voiceOkToken = null; state.phone = null;
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
  if (view.startsWith('#/customer/')) return viewCustomer(decodeURIComponent(view.slice('#/customer/'.length)));
  if (view === '#/customers') return viewCustomers();
  if (view === '#/dashboard') return viewDashboard();
  if (view === '#/reports') return viewReports();
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

// ================= small UI helpers =================
function say(msg) { const el = $('#say'); if (el) el.textContent = String(msg == null ? '' : msg); }
function clearFlow() { pending = null; const p = $('#panel'); if (p) p.innerHTML = ''; }
function setRecUI(on) {
  document.body.classList.toggle('recording', on);
  const w = $('#micWrap'); if (w) w.classList.toggle('rec', on);
}
function skelRows(n) {
  let s = '';
  for (let i = 0; i < (n || 3); i++) s += '<div class="skel"></div>';
  return s;
}
function emptyState(icon, te, en) {
  return `<div class="empty"><span class="empty-ic">${icon}</span><p>${esc(te)}</p><small>${esc(en)}</small></div>`;
}
function initialsOf(name) {
  const w = String(name == null ? '' : name).trim().split(/\s+/);
  const a = (w[0] || '?').trim()[0] || '?';
  const b = w[1] ? (w[1].trim()[0] || '') : '';
  return (a + b).toUpperCase();
}
function topbar() {
  const s = state.shop || {};
  return `<header class="topbar"><span class="shop-name">${esc(s.shop_name || '')}</span>
    <button id="logout" class="logout" type="button">లాగ్ అవుట్</button></header>`;
}
function wireTopbar() {
  const b = $('#logout');
  if (b) b.onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {} goLogin(); };
}
// tab bar: always visible on the main screens
function tabbar(active) {
  const tabs = [
    ['#/home', '🎤', 'హోమ్', 'Home'],
    ['#/customers', '👥', 'కస్టమర్లు', 'Customers'],
    ['#/dashboard', '📊', 'డాష్‌బోర్డ్', 'Dashboard'],
    ['#/reports', '📋', 'రిపోర్ట్లు', 'Reports'],
  ];
  return `<nav class="tabbar" aria-label="మెను">${tabs.map(([href, ic, te, en]) => `
    <a class="tab${active === href ? ' on' : ''}" href="${href}">
      <span class="tab-ic">${ic}</span><span class="tab-te">${te}</span><span class="tab-en">${en}</span>
    </a>`).join('')}</nav>`;
}
async function ensureShop() {
  if (state.shop) return state.shop;
  try {
    const me = await api('/api/me');
    if (!me.profileComplete) { location.hash = '#/profile'; return null; }
    state.shop = me.shop;
    return state.shop;
  } catch (e) { if (e.status === 401) { goLogin(); return null; } throw e; }
}
const istToday = () => new Date(Date.now() + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10);
// Indian grouping: ₹1,25,000
const fmtINR = n => '₹' + new Intl.NumberFormat('en-IN').format(Math.round(Number(n) || 0));
// "2 రోజుల క్రితం · 2 days ago" — Telugu first, English second
function relTime(iso) {
  if (!iso) return 'ఇంకా నమోదు లేదు · no activity';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  let te, en;
  if (d <= 0) { te = 'ఈరోజు'; en = 'today'; }
  else if (d === 1) { te = 'నిన్న'; en = 'yesterday'; }
  else if (d < 30) { te = `${d} రోజుల క్రితం`; en = `${d} days ago`; }
  else if (d < 365) { const m = Math.max(1, Math.floor(d / 30)); te = `${m} నెలల క్రితం`; en = `${m} months ago`; }
  else { const y = Math.floor(d / 365); te = `${y} సంవత్సరాల క్రితం`; en = `${y} years ago`; }
  return te + ' · ' + en;
}
function timeOf(iso) {
  try { return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return ''; }
}
// overdue: balance > 0 and no payment in the last 30 days (never paid -> since creation)
function isOverdue(c) {
  if (!(c.balance > 0)) return false;
  const ref = c.last_payment_at || c.created_at;
  if (!ref) return false;
  return (Date.now() - new Date(ref).getTime()) > 30 * 86400000;
}

// ---------- audio helpers (PCM16 wav -> 16 kHz mono for STT) ----------
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

// ---------- TTS (one audio at a time) ----------
let ttsAudio = null;
async function speak(text) {
  say(text);
  try {
    if (ttsAudio) { try { ttsAudio.pause(); } catch (_) {} ttsAudio = null; }
    const b = await apiAudio('/api/tts', { body: { text } });
    const a = new Audio(URL.createObjectURL(b));
    ttsAudio = a;
    await a.play().catch(() => {});
    return b;
  } catch (e) {
    if (e.status === 401) return goLogin();
    say('TTS సమస్య: ' + e.message);
    return null;
  }
}

// ================= recording =================
let activeRec = null, micBusy = false;
async function startRecording() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (_) { throw new Error('మైక్ అనుమతి లేదు, బ్రౌజర్‌లో అనుమతించండి'); }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  const done = new Promise((resolve, reject) => {
    rec.onstop = async () => {
      clearTimeout(timer);
      stream.getTracks().forEach(t => t.stop());
      if (activeRec && activeRec.rec === rec) activeRec = null;
      try {
        const res = await fetch('/api/stt', {
          method: 'POST', headers: { 'Content-Type': 'audio/wav' }, credentials: 'include',
          body: await toWav(new Blob(chunks)),
        });
        const x = await res.text();
        if (res.status === 401) { goLogin(); reject(new Error('సెషన్ ముగిసింది')); return; }
        let j = {}; try { j = JSON.parse(x); } catch (_) {}
        if (!j.transcript) { reject(new Error('వినపడలేదు, మళ్లీ చెప్పండి')); return; }
        resolve(String(j.transcript));
      } catch (e) { reject(e); }
    };
  });
  const timer = setTimeout(() => { try { rec.stop(); } catch (_) {} }, 20000);
  rec.start();
  activeRec = { rec, stop() { try { rec.stop(); } catch (_) {} }, done };
  return activeRec;
}
async function toggleMic() {
  if (activeRec) { activeRec.stop(); return; }   // the awaiting call below finishes the job
  if (micBusy) return;
  micBusy = true;
  clearFlow();
  say('వింటున్నాను… · listening…');
  setRecUI(true);
  try {
    const r = await startRecording();
    const transcript = await r.done;
    setRecUI(false);
    await handleTranscript(transcript);
  } catch (e) {
    setRecUI(false);
    say(e.message || 'సమస్య జరిగింది');
  } finally { micBusy = false; }
}

// ================= transcript pipeline =================
// separators: ",", " and ", " aur ", " mariyu ", "మరియు", "और", "తరువాత"
// (comma must be followed by whitespace so "1,000" stays one amount)
function splitTranscript(raw) {
  const SEP = /\s*,\s+|,\s*$|\s+and\s+|\s+aur\s+|\s+mariyu\s+|\s+మరియు\s+|\s+ఔరు?\s+|\s+और\s+|\s+తరువాత\s+/gi;
  return String(raw || '').split(SEP).map(s => s.trim()).filter(Boolean);
}
// Build entries from the parts. A later part that lacks a type or a name uses only
// what it has plus the previous entry's context ("Ramesh 500 udhaar, 200 jama").
// Amount always comes from the part itself — it is never copied.
function buildEntries(parts) {
  const out = [];
  let prev = null;
  for (const part of parts) {
    const p = parse(part);
    let type = p.type === 'query' ? null : p.type;
    let name = p.name;
    const amount = p.amount;
    if (!type && prev) type = prev.type;
    if (!name && prev) name = prev.name;
    if (!amount || !type || !name) continue;
    const e = { type, amount, name, raw: part };
    out.push(e);
    prev = e;
  }
  return out;
}
// queries read from the whole utterance (parser keeps handling entries untouched)
function classifyQuery(raw) {
  const t = String(raw || '');
  const money = /(entha|ఎంత|kitna|कितना|how\s*much|balance|బ్యాలెన్స్|baaki|baki|బాకీ|udhaar|udhar|उधार)/i;
  if (/(^|\s)top(\s|$)|టాప్/i.test(t) && money.test(t)) {
    const m = t.match(/\d+/);
    return { kind: 'top', n: m ? Math.min(Math.max(parseInt(m[0], 10), 1), 10) : 3 };
  }
  if (/(ee\s*roju|ఈ\s*రోజు|today)/i.test(t) && (money.test(t) || /(credit|collection|జమ|వసూలు|ఇచ్చిన)/i.test(t))) {
    return { kind: 'day' };
  }
  const p = parse(t);
  if (p.type === 'query' && p.name) return { kind: 'name', name: p.name };
  return null;
}
async function handleTranscript(raw) {
  say(raw);
  await ensureCustomers();
  const q = classifyQuery(raw);
  if (q) return runQuery(q, raw);
  const entries = buildEntries(splitTranscript(raw));
  if (!entries.length) return speak('అర్థం కాలేదు, మళ్లీ చెప్పండి.');
  if (entries.length === 1) return startEntryFlow(entries[0]);
  return startBatchFlow(entries);
}

// ================= single-entry flow (resolver aware) =================
let pending = null;   // { kind:'single'|'new'|'fuzzy'|'batch', ... }

async function startEntryFlow(entry) {
  const r = resolve(entry.name, state.customers);
  if (r.status === 'one') return askConfirm({ ...entry, customerId: r.candidates[0].id });
  if (r.status === 'many') return openChooser(r.candidates, entry.name, 'entry', entry);
  if (r.status === 'fuzzy') return askFuzzy(r.candidates[0], entry.name, entry);
  return askNewCustomer(entry); // 'none' — brand new customer
}
function typeTe(t) { return t === 'credit' ? 'ఉద్దెర · Credit' : 'జమ · Payment'; }
function amtClass(t) { return t === 'credit' ? 'owed' : 'paid'; }

function askConfirm(entry) {
  pending = { kind: 'single', entry };
  const el = $('#panel'); if (!el) return;
  const c = state.customers.find(x => x.id === entry.customerId);
  el.innerHTML = `
  <div class="card confirm">
    <div class="confirm-head">
      <span class="avatar av-0">${esc(initialsOf(entry.name))}</span>
      <span class="confirm-names"><b>${esc(entry.name)}</b><small>${esc((c && c.label) || '')}</small></span>
      <span class="confirm-amt ${amtClass(entry.type)}">${esc(fmtINR(entry.amount))}</span>
    </div>
    <span class="type-tag ${entry.type}">${typeTe(entry.type)}</span>
    <p class="q-sub">సరిగ్గా ఉందా? · Is this right?</p>
    <div class="confirm-actions">
      <button id="yes" class="btn primary" type="button">✅ అవును</button>
      <button id="no" class="btn ghost" type="button">❌ కాదు</button>
    </div>
    <button id="other" class="link wide" type="button">➕ వేరే వ్యక్తి · Different person?</button>
  </div>`;
  $('#yes').onclick = onYes;
  $('#no').onclick = onNo;
  $('#other').onclick = () => askNewCustomer(entry); // a second person with the same name
  speak(`${entry.name}, ${entry.amount} రూపాయలు ${entry.type === 'credit' ? 'ఉద్దెర' : 'జమ'}. సరిగ్గా ఉందా?`);
}

function askNewCustomer(entry) {
  pending = { kind: 'new', entry };
  const el = $('#panel'); if (!el) return;
  el.innerHTML = `
  <div class="card">
    <div class="q-title">కొత్త కస్టమర్ · New customer</div>
    <p class="q-sub">వీరు కొత్తవారు. పేరు సరిచూసి, చేర్చాలా? · Check the name, then add.</p>
    <label class="field" for="ncName">పేరు · Name</label>
    <input id="ncName" class="input" maxlength="100" value="${esc(entry.name)}">
    <label class="field" for="ncLabel">లేబుల్ (ఐచ్ఛికం) · Label (optional)</label>
    <input id="ncLabel" class="input" maxlength="60" placeholder="tailor, driver…">
    <label class="field" for="ncPhone">ఫోన్ (ఐచ్ఛికం) · Phone (optional)</label>
    <input id="ncPhone" class="input" type="tel" inputmode="numeric" maxlength="10" placeholder="98765 43210">
    <div id="ncErr" class="err" hidden></div>
    <div class="confirm-actions">
      <button id="yes" class="btn primary" type="button">✅ చేర్చండి</button>
      <button id="no" class="btn ghost" type="button">❌ కాదు</button>
    </div>
  </div>`;
  $('#yes').onclick = onYes;
  $('#no').onclick = onNo;
  speak(`కొత్త కస్టమర్ ${entry.name}. చేర్చాలా?`);
}

function askFuzzy(candidate, spoken, entry) {
  pending = { kind: 'fuzzy', candidate, spoken, entry };
  const el = $('#panel'); if (!el) return;
  el.innerHTML = `
  <div class="card">
    <div class="q-title">మీరు <b>${esc(candidate.name)}</b> అని ఉద్దేశించారా?</div>
    <p class="q-sub">Did you mean <b>${esc(candidate.name)}</b>? (చెప్పినది: “${esc(spoken)}”)</p>
    <div class="confirm-actions">
      <button id="yes" class="btn primary" type="button">✅ అవును</button>
      <button id="no" class="btn ghost" type="button">❌ కాదు</button>
    </div>
  </div>`;
  $('#yes').onclick = onYes;
  $('#no').onclick = onNo;
  speak(`మీరు ${candidate.name} అని ఉద్దేశించారా?`);
}

async function onYes() {
  const p = pending;
  const panel = $('#panel');
  if (!p || !panel) return;
  const btns = panel.querySelectorAll('button');
  btns.forEach(b => { b.disabled = true; });
  try {
    if (p.kind === 'single') {
      await saveEntries([p.entry]);
      clearFlow();
      return speak('నమోదు చేశాను.');
    }
    if (p.kind === 'new') {
      const name = ($('#ncName') && $('#ncName').value.trim()) || p.entry.name;
      const label = ($('#ncLabel') && $('#ncLabel').value.trim()) || null;
      const phoneRaw = ($('#ncPhone') && $('#ncPhone').value.replace(/\s+/g, '')) || '';
      if (!name) { btns.forEach(b => { b.disabled = false; }); return showErr($('#ncErr'), 'పేరు తప్పనిసరి'); }
      if (phoneRaw && !/^[6-9]\d{9}$/.test(phoneRaw)) {
        btns.forEach(b => { b.disabled = false; });
        return showErr($('#ncErr'), '10 అంకెల సరైన మొబైల్ నంబర్ వేయండి');
      }
      // if the corrected name is already an exact match for somebody, reuse them instead of duplicating
      const n = resolve.normalize(name);
      let c = state.customers.find(x => resolve.normalize(x.name) === n ||
        (x.aliases || []).some(a => resolve.normalize(a) === n)) || null;
      if (!c) {
        c = await api('/api/customers', { method: 'POST', body: { name, label, phone: phoneRaw || null } });
        state.customers.push({ ...c, balance: 0, last_activity: null, last_payment_at: null });
      }
      await saveEntries([{ ...p.entry, customerId: c.id }]);
      clearFlow();
      return speak('కొత్త కస్టమర్ చేర్చి, నమోదు చేశాను.');
    }
    if (p.kind === 'fuzzy') {
      await addAlias(p.candidate, p.spoken);
      if (p.entry) {
        const entry = { ...p.entry, customerId: p.candidate.id };
        return askConfirm(entry);
      }
      return speakBalance(p.candidate);
    }
    if (p.kind === 'batch') return confirmBatch();
  } catch (e) {
    if (e.status === 401) return goLogin();
    btns.forEach(b => { b.disabled = false; });
    speak(e.message || 'సేవ్ కాలేదు, మళ్లీ ప్రయత్నించండి');
  }
}
function onNo() {
  const p = pending;
  clearFlow();
  if (p && p.kind === 'fuzzy' && p.entry) return askNewCustomer(p.entry); // not him -> treat as new
  if (p && p.kind === 'fuzzy') return speak(`${p.spoken} పేరు దొరకలేదు.`);
  speak('సరే, మళ్లీ చెప్పండి.');
}

// save entries one after another; customer is created only when it does not exist yet
async function saveEntries(list) {
  const saved = [];
  for (const e of list) {
    let c = e.customerId ? state.customers.find(x => x.id === e.customerId) : null;
    if (e.customerId && !c) {
      // the id is set but not in the local list (e.g. after a merge) -> reload it
      try { c = (await api('/api/customers/' + e.customerId + '/transactions')).customer; } catch (_) {}
    }
    if (!c) {
      c = await api('/api/customers', { method: 'POST', body: { name: e.name, label: e.label || null, phone: e.phone || null } });
      state.customers.push({ ...c, balance: 0, last_activity: null, last_payment_at: null });
    }
    const tx = await api('/api/transactions', {
      method: 'POST',
      body: { customer_id: c.id, type: e.type, amount: e.amount, raw_transcript: e.raw || e.name },
    });
    saved.push({ entry: e, customer: c, tx });
  }
  await refreshHome();
  return saved;
}
// remember how the shopkeeper spoke it, so next time it resolves exactly
async function addAlias(c, spoken) {
  const norm = resolve.normalize(spoken);
  if (!norm || resolve.normalize(c.name) === norm) return c;
  const aliases = Array.isArray(c.aliases) ? c.aliases.slice() : [];
  if (aliases.some(a => resolve.normalize(a) === norm)) return c;
  aliases.push(String(spoken).trim());
  try {
    const upd = await api('/api/customers/' + c.id, { method: 'PATCH', body: { aliases } });
    Object.assign(c, upd);
    const live = state.customers.find(x => x.id === c.id);
    if (live && live !== c) Object.assign(live, upd);
  } catch (e) { if (e.status === 401) goLogin(); }
  return c;
}

// ================= multi-entry (one sentence, one confirmation) =================
async function startBatchFlow(entries) {
  const withCust = entries.map(e => {
    const r = resolve(e.name, state.customers);
    const c = r.candidates[0] || null;
    return { ...e, customerId: c ? c.id : null };
  });
  pending = { kind: 'batch', entries: withCust };
  renderBatch();
  const line = withCust.map(e => `${e.name}, ${e.amount} రూపాయలు ${e.type === 'credit' ? 'ఉద్దెర' : 'జమ'}`).join(', ');
  say(withCust.map(e => `${e.name} ${fmtINR(e.amount)} ${e.type === 'credit' ? 'ఉద్దెర' : 'జమ'}`).join('  ·  '));
  speak(line + '. సరిగ్గా ఉందా?');
}
function renderBatch() {
  const p = pending;
  const el = $('#panel');
  if (!el || !p || p.kind !== 'batch') return;
  if (!p.entries.length) { clearFlow(); return speak('సరే, మళ్లీ చెప్పండి.'); }
  el.innerHTML = `
  <div class="card">
    <div class="q-title">${p.entries.length} నమోదులు · ${p.entries.length} entries</div>
    <p class="q-sub">తప్పు అయితె🗑 తొలగించండి · delete a wrong line</p>
    <ul class="entry-list">${p.entries.map((e, i) => `
      <li class="entry">
        <span class="idx">${i + 1}</span>
        <span class="entry-main"><b>${esc(e.name)}</b><small>${typeTe(e.type)}${e.customerId ? '' : ' · కొత్తది'}</small></span>
        <span class="entry-amt ${amtClass(e.type)}">${esc(fmtINR(e.amount))}</span>
        <button class="del" type="button" data-del="${i}" aria-label="తొలగించండి">🗑</button>
      </li>`).join('')}</ul>
    <div class="confirm-actions">
      <button id="yes" class="btn primary" type="button">✅ అవును</button>
      <button id="no" class="btn ghost" type="button">❌ కాదు</button>
    </div>
  </div>`;
  el.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = () => { p.entries.splice(Number(b.dataset.del), 1); renderBatch(); };
  });
  $('#yes').onclick = onYes;
  $('#no').onclick = onNo;
}
async function confirmBatch() {
  const p = pending;
  if (!p || p.kind !== 'batch') return;
  await saveEntries(p.entries.slice());
  clearFlow();
  speak('నమోదు చేశాను.');
}

// ================= voice queries =================
function renderResult(o) {
  const el = $('#panel'); if (!el) return;
  el.innerHTML = `
  <div class="card result">
    <div class="q-title">${esc(o.title)}</div>
    ${o.empty ? `<p class="q-empty">${esc(o.empty)}</p>` :
      (o.rows || []).map(([k, v]) => `<div class="res-row"><span>${esc(k)}</span><b>${esc(fmtINR(v))}</b></div>`).join('')}
    <div class="confirm-actions"><button id="rclose" class="btn ghost" type="button">మూసివేయండి ✕</button></div>
  </div>`;
  $('#rclose').onclick = clearFlow;
}
async function speakBalance(c) {
  const msg = c.balance > 0
    ? `${c.name} బాకీ ${c.balance} రూపాయలు.`
    : `${c.name} కి బాకీ లేదు.`;
  renderResult({
    title: `${c.name} · బాకీ`,
    rows: [['బాకున్నది · Balance', c.balance]],
  });
  return speak(msg);
}
async function runQuery(q, raw) {
  try {
    await ensureCustomers();
    if (q.kind === 'day') {
      const r = await api('/api/transactions?date=' + istToday());
      let credit = 0, pay = 0;
      for (const t of (r.transactions || [])) {
        if (t.type === 'credit') credit += Number(t.amount) || 0;
        else if (t.type === 'pay') pay += Number(t.amount) || 0;
      }
      renderResult({
        title: 'ఈ రోజు · Today',
        rows: [['ఇచ్చిన ఉద్దెర · Credit given', credit], ['వసూలైనది · Collected', pay]],
      });
      return speak(`ఈ రోజు ఇచ్చిన ఉద్దెర ${credit} రూపాయలు, వసూలైనది ${pay} రూపాయలు.`);
    }
    if (q.kind === 'top') {
      const top = state.customers.filter(c => c.balance > 0)
        .sort((a, b) => b.balance - a.balance).slice(0, q.n || 3);
      if (!top.length) {
        renderResult({ title: 'ఎక్కువ బాకీ · Top balances', empty: 'ఎవరికీ బాకీ లేదు · nobody owes anything' });
        return speak('ఎవరికీ బాకీ లేదు.');
      }
      renderResult({
        title: `ఎక్కువ బాకీ · Top ${top.length}`,
        rows: top.map((c, i) => [`${i + 1}. ${c.name}`, c.balance]),
      });
      const msg = top.map((c, i) => `${TEL_NUM[i] || (i + 1)}: ${c.name} ${c.balance} రూపాయలు`).join(', ') + '.';
      return speak(msg);
    }
    // "<name> ki entha baaki" — resolver, ask when there are duplicates
    const r = resolve(q.name, state.customers);
    if (r.status === 'one') return speakBalance(r.candidates[0]);
    if (r.status === 'many') return openChooser(r.candidates, q.name, 'query', null);
    if (r.status === 'fuzzy') return askFuzzy(r.candidates[0], q.name, null);
    renderResult({ title: 'బాకీ · Balance', empty: `${q.name} — పేరు దొరకలేదు · not found` });
    return speak(`${q.name} పేరు దొరకలేదు.`);
  } catch (e) {
    if (e.status === 401) return goLogin();
    say(e.message || 'సమస్య జరిగింది');
  }
}

// ================= chooser sheet (many candidates) =================
const TEL_NUM = ['ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది', 'పది'];
const NUMWORD = {
  'ఒకటి': 1, 'ఒక': 1, 'రెండు': 2, 'మూడు': 3, 'నాలుగు': 4, 'ఐదు': 5,
  'ఆరు': 6, 'ఏడు': 7, 'ఎనిమిది': 8, 'తొమ్మిది': 9, 'పది': 10,
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6,
  'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'ek': 1, 'do': 2, 'teen': 3, 'tin': 3, 'char': 4, 'panch': 5, 'chah': 6, 'sat': 7, 'aath': 8, 'nau': 9, 'das': 10,
};
function numberFrom(text) {
  for (const w of String(text || '').toLowerCase().split(/[^a-zఀ-౿]+/).filter(Boolean)) {
    if (NUMWORD[w]) return NUMWORD[w];
    if (/^\d+$/.test(w)) return parseInt(w, 10);
  }
  return null;
}
let chooser = null;
function showSheet(html) {
  hideSheet();
  const bd = document.createElement('div');
  bd.className = 'sheet-backdrop'; bd.id = 'sheetBd';
  const sh = document.createElement('div');
  sh.className = 'sheet'; sh.id = 'sheet'; sh.setAttribute('role', 'dialog');
  sh.innerHTML = html;
  document.body.appendChild(bd);
  document.body.appendChild(sh);
  bd.onclick = closeChooser;
  return sh;
}
function hideSheet() {
  const bd = document.getElementById('sheetBd'), sh = document.getElementById('sheet');
  if (bd) bd.remove();
  if (sh) sh.remove();
}
function closeChooser() { chooser = null; hideSheet(); }
function openChooser(candidates, spoken, mode, entry) {
  chooser = { candidates, spoken, mode, entry };
  const sh = showSheet(`
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <div><h3>ఏ కస్టమర్?</h3><small>Which customer? · tap or say the number</small></div>
      <button id="sheetClose" class="sheet-x" type="button" aria-label="మూసివేయండి">✕</button>
    </div>
    <button id="sheetMic" class="btn voice" type="button">🎤 సంఖ్య చెప్పండి · Say the number</button>
    <div class="cand-list">${candidates.map((c, i) => `
      <button class="cand-card" type="button" data-idx="${i}">
        <span class="avatar av-${i % 6}">${esc(initialsOf(c.name))}</span>
        <span class="cand-main">
          <span class="cand-top"><b>${esc(c.name)}</b><span class="cand-idx">${i + 1}</span></span>
          <span class="cand-sub">${esc(c.label || '—')}${c.phone ? ' · ••••' + esc(String(c.phone).slice(-4)) : ''}</span>
          <span class="cand-sub dim">${esc(relTime(c.last_activity))}</span>
        </span>
        <span class="cand-bal ${c.balance > 0 ? 'owed' : ''}">${esc(fmtINR(c.balance || 0))}</span>
      </button>`).join('')}</div>`);
  sh.querySelector('#sheetClose').onclick = closeChooser;
  sh.querySelector('#sheetMic').onclick = pickByVoice;
  sh.querySelectorAll('[data-idx]').forEach(b => b.onclick = () => choose(Number(b.dataset.idx)));
  const list = candidates.map((c, i) => `${TEL_NUM[i] || (i + 1)}: ${c.name}`).join(', ');
  speak(`ఏ కస్టమర్? ${list}. సంఖ్య చెప్పండి.`);
}
async function choose(idx) {
  const ch = chooser;
  if (!ch) return;
  const c = ch.candidates[idx];
  if (!c) { speak('సరిలేదు, మళ్లీ చెప్పండి.'); return; }
  closeChooser();
  await addAlias(c, ch.spoken);           // remember the spoken spelling
  if (ch.mode === 'query') return speakBalance(c);
  return askConfirm({ ...ch.entry, customerId: c.id });
}
async function pickByVoice() {
  if (activeRec || micBusy) return;
  const btn = $('#sheetMic');
  if (btn) { btn.disabled = true; btn.textContent = '… వింటున్నాను'; }
  micBusy = true;
  try {
    const r = await startRecording();
    const t = await r.done;
    const n = numberFrom(t);
    if (!n || n > (chooser ? chooser.candidates.length : 0)) {
      say(t);
      speak('సరిలేదు, మళ్లీ సంఖ్య చెప్పండి.');
    } else {
      await choose(n - 1);
    }
  } catch (e) { speak(e.message || 'సమస్య జరిగింది'); }
  finally {
    micBusy = false;
    const b = $('#sheetMic');
    if (b) { b.disabled = false; b.innerHTML = '🎤 సంఖ్య చెప్పండి · Say the number'; }
  }
}

// ================= data =================
async function ensureCustomers() {
  if (state.customers.length) return state.customers;
  await loadCustomers();
  return state.customers;
}
async function loadCustomers() {
  state.customers = await api('/api/customers');
}
async function refreshHome() {
  const [cust, today, recent] = await Promise.all([
    api('/api/customers'),
    api('/api/transactions?date=' + istToday()),
    api('/api/transactions?recent=5'),
  ]);
  state.customers = cust;
  state.today = today.transactions || [];
  state.recent = recent.transactions || [];
  renderStrip();
  renderRecent();
  if ($('#custList')) renderCustomers();
}
function renderStrip() {
  const el = $('#strip'); if (!el) return;
  let credit = 0, pay = 0;
  for (const t of (state.today || [])) {
    if (t.type === 'credit') credit += Number(t.amount) || 0;
    else if (t.type === 'pay') pay += Number(t.amount) || 0;
  }
  el.innerHTML = `
    <div class="stat"><span class="stat-te">ఇచ్చిన ఉద్దెర</span><span class="stat-en">Credit given</span>
      <b class="stat-val owed">${esc(fmtINR(credit))}</b></div>
    <div class="stat"><span class="stat-te">వసూలైనది</span><span class="stat-en">Collected</span>
      <b class="stat-val paid">${esc(fmtINR(pay))}</b></div>`;
}
function renderRecent() {
  const el = $('#recent'); if (!el) return;
  const rows = (state.recent || []).slice(0, 5);
  if (!rows.length) { el.innerHTML = emptyState('🧾', 'ఇంకా నమోదులు లేవు — మైక్ నొక్కి మొదటిది చెప్పండి', 'No entries yet — tap the mic and say the first one'); return; }
  el.innerHTML = rows.map(t => `
    <div class="tx-row">
      <span class="avatar av-${hashOf(t.customer_id) % 6}">${esc(initialsOf(t.customer_name || '?'))}</span>
      <span class="tx-main"><b>${esc(t.customer_name || '—')}</b><small>${esc(timeOf(t.created_at))}</small></span>
      <span class="tx-amt ${t.type === 'credit' ? 'owed' : 'paid'}">${t.type === 'credit' ? '+' : '−'}${esc(fmtINR(t.amount))}</span>
      <span class="tx-tag ${t.type}">${t.type === 'credit' ? 'ఉద్దెర' : 'జమ'}</span>
    </div>`).join('');
}
function hashOf(s) {
  let h = 0; const x = String(s || '');
  for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0;
  return h;
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

// ================= #/home =================
async function viewHome() {
  const shop = await ensureShop();
  if (!shop) return;
  appEl().innerHTML = `
  ${topbar()}
  <main class="screen">
    <div class="strip" id="strip">${skelRows(1)}</div>
    <div class="mic-wrap" id="micWrap">
      <span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span>
      <button id="mic" type="button" aria-label="మైక్">🎤</button>
    </div>
    <div id="say">నొక్కి మాట్లాడండి · Tap and speak</div>
    <div id="panel"></div>
    <h2 class="section">ఇటీవలి నమోదులు · Last 5 entries</h2>
    <div id="recent" class="tx-list">${skelRows(3)}</div>
    <div id="herr" class="err" hidden></div>
  </main>
  ${tabbar('#/home')}`;
  wireTopbar();
  $('#mic').onclick = toggleMic;
  try {
    await refreshHome();
  } catch (e) {
    if (e.status === 401) return goLogin();
    showErr($('#herr'), e.message);
  }
}

// ================= #/customers =================
async function viewCustomers() {
  const shop = await ensureShop();
  if (!shop) return;
  appEl().innerHTML = `
  ${topbar()}
  <main class="screen">
    <h1 class="screen-title">కస్టమర్లు <small>Customers</small></h1>
    <input id="search" class="input search" type="search" placeholder="పేరు వెతకండి · Search name" aria-label="వెతకండి">
    <div class="chips" id="sortChips">
      <button class="chip-btn${state.custSort === 'balance' ? ' on' : ''}" data-sort="balance" type="button">ఎక్కువ బాకీ · Highest</button>
      <button class="chip-btn${state.custSort === 'recent' ? ' on' : ''}" data-sort="recent" type="button">ఇటీవల · Recent</button>
    </div>
    <div id="custList">${skelRows(4)}</div>
    <div id="cerr" class="err" hidden></div>
  </main>
  ${tabbar('#/customers')}`;
  wireTopbar();
  $('#search').value = state.custQuery || '';
  $('#search').oninput = e => { state.custQuery = e.target.value; renderCustomers(); };
  $('#sortChips').querySelectorAll('[data-sort]').forEach(b => {
    b.onclick = () => {
      state.custSort = b.dataset.sort;
      $('#sortChips').querySelectorAll('.chip-btn').forEach(x => x.classList.toggle('on', x === b));
      renderCustomers();
    };
  });
  try {
    if (!state.customers.length) await loadCustomers();
    renderCustomers();
  } catch (e) {
    if (e.status === 401) return goLogin();
    showErr($('#cerr'), e.message);
  }
}
function renderCustomers() {
  const el = $('#custList');
  if (!el) return;
  const q = resolve.normalize(state.custQuery || '');
  let rows = state.customers.slice();
  if (q) {
    rows = rows.filter(c =>
      resolve.normalize(c.name).indexOf(q) !== -1 ||
      resolve.normalize(c.label || '').indexOf(q) !== -1 ||
      String(c.phone || '').indexOf(q) !== -1 ||
      (c.aliases || []).some(a => resolve.normalize(a).indexOf(q) !== -1));
  }
  rows.sort((a, b) => state.custSort === 'recent'
    ? String(b.last_activity || '').localeCompare(String(a.last_activity || ''))
    : (b.balance || 0) - (a.balance || 0));
  if (!rows.length) {
    el.innerHTML = state.customers.length
      ? emptyState('🔍', 'పేరు దొరకలేదు — వేరే పేరుతో వెతకండి', 'No match — try another spelling')
      : emptyState('👥', 'ఇంకా కస్టమర్లు లేరు — మొదటి కస్టమర్‌ని జతచేయండి', 'No customers yet — add the first one by voice');
    return;
  }
  el.innerHTML = rows.map(c => `
    <div class="cust-card" data-open="${esc(c.id)}" role="button" tabindex="0">
      <span class="avatar av-${hashOf(c.id) % 6}">${esc(initialsOf(c.name))}</span>
      <span class="cust-main">
        <span class="cust-name">${esc(c.name)}${c.label ? ` <em>${esc(c.label)}</em>` : ''}</span>
        <span class="cust-act">${esc(relTime(c.last_activity))}</span>
        ${isOverdue(c) ? '<span class="badge overdue">30+ రోజుల ఆలస్యం · Overdue 30+ days</span>' : ''}
      </span>
      <span class="cust-right">
        <b class="bal ${c.balance > 0 ? 'owed' : ''}">${esc(fmtINR(c.balance || 0))}</b>
        <button class="remind" type="button" data-remind="${esc(c.id)}" aria-label="రిమైండర్">🔊</button>
      </span>
    </div>`).join('');
  el.querySelectorAll('[data-open]').forEach(card => {
    card.onclick = e => {
      if (e.target.closest('[data-remind]')) return;
      location.hash = '#/customer/' + card.dataset.open;
    };
    card.onkeydown = e => { if (e.key === 'Enter') location.hash = '#/customer/' + card.dataset.open; };
  });
  el.querySelectorAll('[data-remind]').forEach(b => {
    b.onclick = e => {
      e.stopPropagation();
      const c = state.customers.find(x => x.id === b.dataset.remind);
      if (c) remind(c);
    };
  });
}

// ================= #/customer/:id — detail, timeline, receive payment, edit, merge =================
async function viewCustomer(id) {
  const shop = await ensureShop();
  if (!shop) return;
  await ensureCustomers().catch(() => {});
  const c = state.customers.find(x => x.id === id);
  if (!c) { location.hash = '#/customers'; return; }
  appEl().innerHTML = `
  <header class="topbar">
    <button id="back" class="back" type="button" aria-label="వెనుకకు">‹</button>
    <span class="shop-name">${esc(c.name)}</span>
    <button id="logout" class="logout" type="button">లాగ్ అవుట్</button>
  </header>
  <main class="screen">
    <div class="card detail-head">
      <span class="avatar big av-${hashOf(c.id) % 6}">${esc(initialsOf(c.name))}</span>
      <div class="detail-id">
        <b>${esc(c.name)}</b>
        <small>${esc(c.label || '')}${c.phone ? ' · ' + esc(c.phone) : ''}</small>
        <small class="muted">${esc(relTime(c.last_activity))}</small>
      </div>
      <div class="detail-bal">
        <small>బాకీ · Balance</small>
        <b class="bal ${c.balance > 0 ? 'owed' : ''}">${esc(fmtINR(c.balance || 0))}</b>
        ${isOverdue(c) ? '<span class="badge overdue">Overdue 30+ days</span>' : ''}
      </div>
    </div>
    <div class="actions">
      <button id="payBtn" class="btn primary" type="button">💰 చెల్లింపు తీసుకోండి · Receive payment</button>
      <button id="editBtn" class="btn" type="button">✏️ మార్చండి · Edit</button>
      <button id="mergeBtn" class="btn" type="button">🔗 డూప్లికేట్ కలపండి · Merge</button>
      <button id="remindBtn" class="btn" type="button">🔊 రిమైండర్ · Reminder</button>
    </div>
    <div id="payForm" class="card" hidden>
      <label class="field" for="payAmt">మొత్తం · Amount (₹)</label>
      <input id="payAmt" class="input" type="number" inputmode="numeric" min="1" placeholder="500">
      <div id="payErr" class="err" hidden></div>
      <button id="paySave" class="btn primary big" type="button">జమ చేయండి · Receive</button>
    </div>
    <div id="editForm" class="card" hidden>
      <label class="field" for="edName">పేరు · Name</label>
      <input id="edName" class="input" maxlength="100" value="${esc(c.name)}">
      <label class="field" for="edLabel">లేబుల్ · Label</label>
      <input id="edLabel" class="input" maxlength="60" value="${esc(c.label || '')}" placeholder="tailor, driver…">
      <label class="field" for="edPhone">ఫోన్ · Phone</label>
      <input id="edPhone" class="input" type="tel" inputmode="numeric" maxlength="10" value="${esc(c.phone || '')}">
      <div id="edErr" class="err" hidden></div>
      <button id="edSave" class="btn primary big" type="button">సేవ్ చేయండి · Save</button>
    </div>
    <div id="mergeForm" class="card" hidden>
      <p class="q-sub">ఏ కస్టమర్‌ని ఈయనలో కలపాలి? · Which customer should be merged into this one?</p>
      <div id="mergeList"></div>
      <div id="mgErr" class="err" hidden></div>
    </div>
    <h2 class="section">లావాదేవీలు · Transactions</h2>
    <div id="timeline">${skelRows(3)}</div>
    <div id="derr" class="err" hidden></div>
  </main>
  ${tabbar('#/customers')}`;
  wireTopbar();
  $('#back').onclick = () => { location.hash = '#/customers'; };
  $('#remindBtn').onclick = () => remind(c);
  const forms = ['#payForm', '#editForm', '#mergeForm'];
  const toggle = (btnSel, formSel) => {
    $(btnSel).onclick = () => {
      const opening = $(formSel).hidden;
      forms.forEach(f => { $(f).hidden = true; });
      if (opening) {
        $(formSel).hidden = false;
        if (formSel === '#mergeForm') renderMergeList(c);
        $(formSel).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
  };
  toggle('#payBtn', '#payForm');
  toggle('#editBtn', '#editForm');
  toggle('#mergeBtn', '#mergeForm');

  $('#paySave').onclick = async () => {
    const amt = Math.round(Number($('#payAmt').value));
    if (!Number.isFinite(amt) || amt <= 0) return showErr($('#payErr'), 'మొత్తం 0 కంటే ఎక్కువ ఉండాలి');
    const b = $('#paySave'); b.disabled = true;
    try {
      await api('/api/transactions', { method: 'POST', body: { customer_id: c.id, type: 'pay', amount: amt, raw_transcript: 'receive payment (screen)' } });
      $('#payForm').hidden = true;
      $('#payAmt').value = '';
      await refreshHome();
      await loadTimeline(c.id);
      speak(`${fmtINR(amt)} జమ నమోదు చేశాను.`);
    } catch (e) {
      if (e.status === 401) return goLogin();
      showErr($('#payErr'), e.message);
    } finally { b.disabled = false; }
  };
  $('#edSave').onclick = async () => {
    const name = $('#edName').value.trim();
    const label = $('#edLabel').value.trim();
    const phone = $('#edPhone').value.replace(/\s+/g, '');
    if (!name) return showErr($('#edErr'), 'పేరు తప్పనిసరి');
    if (phone && !/^[6-9]\d{9}$/.test(phone)) return showErr($('#edErr'), '10 అంకెల సరైన మొబైల్ నంబర్ వేయండి');
    const b = $('#edSave'); b.disabled = true;
    try {
      await api('/api/customers/' + c.id, { method: 'PATCH', body: { name, label, phone } });
      await loadCustomers();
      await viewCustomer(c.id);
    } catch (e) {
      if (e.status === 401) return goLogin();
      showErr($('#edErr'), e.message);
      b.disabled = false;
    }
  };
  try { await loadTimeline(c.id); }
  catch (e) { if (e.status === 401) return goLogin(); showErr($('#derr'), e.message); }
}
function renderMergeList(c) {
  const box = $('#mergeList');
  if (!box) return;
  const others = state.customers.filter(x => x.id !== c.id);
  if (!others.length) { box.innerHTML = '<p class="q-empty">వేరే కస్టమర్లు లేరు · no other customers</p>'; return; }
  box.innerHTML = others.map(o => `
    <button class="merge-row" type="button" data-merge="${esc(o.id)}">
      <span class="avatar av-${hashOf(o.id) % 6}">${esc(initialsOf(o.name))}</span>
      <span class="cand-main"><b>${esc(o.name)}</b><small>${esc(o.label || '')} · ${esc(fmtINR(o.balance || 0))}</small></span>
      <span class="merge-go">కలపండి</span>
    </button>`).join('');
  box.querySelectorAll('[data-merge]').forEach(b => {
    b.onclick = async () => {
      const other = state.customers.find(x => x.id === b.dataset.merge);
      if (!other) return;
      if (!confirm(`${other.name} ఖాతాను ${c.name} లో కలపాలా? రెండవది తొలగించబడుతుంది.`)) return;
      b.disabled = true;
      try {
        await api('/api/customers/merge', { method: 'POST', body: { keep_id: c.id, remove_id: other.id } });
        await loadCustomers();
        await viewCustomer(c.id);
        speak('కలిపాను.');
      } catch (e) {
        if (e.status === 401) return goLogin();
        showErr($('#mgErr'), e.message);
        b.disabled = false;
      }
    };
  });
}
async function loadTimeline(id) {
  const el = $('#timeline');
  const r = await api('/api/customers/' + id + '/transactions');
  if (!el) return r;
  if (!r.transactions.length) {
    el.innerHTML = emptyState('🧾', 'ఇంకా నమోదులు లేవు', 'No transactions yet');
    return r;
  }
  const today = istToday();
  el.innerHTML = r.transactions.map(t => {
    const isToday = String(t.created_at).slice(0, 10) === today;
    return `
    <div class="tl-item">
      <span class="tl-dot ${t.type}"></span>
      <span class="tl-main">
        <b>${t.type === 'credit' ? '+' : '−'}${esc(fmtINR(t.amount))} <em>${t.type === 'credit' ? 'ఉద్దెర' : 'జమ'}</em></b>
        <small>${esc(timeOf(t.created_at))}${t.raw_transcript ? ' · “' + esc(String(t.raw_transcript).slice(0, 60)) + '”' : ''}</small>
      </span>
      ${isToday ? `<button class="del" type="button" data-del-tx="${esc(t.id)}" aria-label="రద్దు చేయండి">🗑</button>` : ''}
    </div>`;
  }).join('');
  el.querySelectorAll('[data-del-tx]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('ఈ నమోదును రద్దు చేయాలా? · Undo this entry?')) return;
      b.disabled = true;
      try {
        await api('/api/transactions/' + b.dataset.delTx, { method: 'DELETE' });
        await refreshHome();
        await loadTimeline(id);
        speak('రద్దు చేశాను.');
      } catch (e) {
        if (e.status === 401) return goLogin();
        showErr($('#derr'), e.message);
        b.disabled = false;
      }
    };
  });
  return r;
}

// ================= #/dashboard, #/reports (placeholders) =================
async function viewPlaceholder(hash, icon, te, en, sub) {
  const shop = await ensureShop();
  if (!shop) return;
  appEl().innerHTML = `
  ${topbar()}
  <main class="screen">
    <h1 class="screen-title">${esc(te)} <small>${esc(en)}</small></h1>
    <div class="card coming">
      <span class="coming-ic">${icon}</span>
      <b>త్వరలో వస్తోంది · Coming soon</b>
      <p>${esc(sub)}</p>
    </div>
  </main>
  ${tabbar(hash)}`;
  wireTopbar();
}
const viewDashboard = () => viewPlaceholder('#/dashboard', '📊', 'డాష్‌బోర్డ్', 'Dashboard', 'వారపు మొత్తాలు, ట్రెండ్‌లు ఇక్కడ చూడవచ్చు');
const viewReports = () => viewPlaceholder('#/reports', '📋', 'రిపోర్ట్లు', 'Reports', 'ప్రింట్ / షేర్ చేసే నివేదికలు ఇక్కడ వస్తాయి');
