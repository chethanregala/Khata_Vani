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
  mode: (() => { try { return localStorage.getItem('kv-mode') === 'rythu' ? 'rythu' : 'kirana'; } catch (_) { return 'kirana'; } })(),
  rythuFarmers: [],    // kind='farmer' customers (rythu mode)
  rythuSummary: null,  // rythu Home strip data (one IST day, computed on read)
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
// idempotency key minted in the browser when no server preview supplies one —
// a retried confirm then reuses the SAME key and can never double-post
const newKey = () => (self.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'k' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
// a negative balance is normal for payable flows: money already settled ahead
const ADVANCE_TE_EN = 'అడ్వాన్స్ వసూలు చేయాలి · advance to recover';
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
  if (view.startsWith('#/rythu/farmer/')) return viewRythuFarmer(decodeURIComponent(view.slice('#/rythu/farmer/'.length)));
  if (view.startsWith('#/customer/')) return viewCustomer(decodeURIComponent(view.slice('#/customer/'.length)));
  if (view === '#/customers') return viewCustomers();
  if (view === '#/dashboard') return viewDashboard();
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
// persistent "what I heard" line under the mic: shows the last transcript until
// the next main-mic recording starts. Separate element -> say()/speak() later
// messages can never overwrite it.
function showHeard(raw) {
  const el = $('#heard');
  if (!el) return;
  el.textContent = 'నేను విన్నది · I heard: ' + String(raw == null ? '' : raw);
  el.hidden = false;
}
function hideHeard() {
  const el = $('#heard');
  if (el) { el.hidden = true; el.textContent = ''; }
}
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
    say(e.message || 'TTS సమస్య');
    // speech is a convenience, never a gate: any card that offers the small
    // notice shows it, saving itself is untouched by TTS failures
    const n = $('#voiceNote');
    if (n) n.hidden = false;
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
  hideHeard();          // a new recording replaces the heard line
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

// ================= guided recovery (one missing field at a time) =================
// Never guesses: when the parser got exactly one field wrong/missing, the user is
// asked for THAT field (tap or voice), then the normal entry flow takes over.
function guidedRecovery(raw) {
  let d = null;
  try { d = diagnose(raw); } catch (_) {} // parser.js must be loaded; degrade politely
  if (!d) return askUnknown(raw);
  const entry = { type: d.type || null, amount: d.amount || null, name: d.name || null, raw };
  if (!d.missing.length) return startEntryFlow(entry); // parse is complete — nothing to recover
  if (d.missing.length > 1) return askUnknown(raw);    // too little to work with — ask for a fresh sentence
  if (!entry.type) return askMissingType(entry);
  if (!entry.name) return askMissingName(entry);
  return askMissingAmount(entry);
}
// after a missing field is supplied, continue (possibly asking for the next one)
function continuePartial() {
  const p = pending;
  if (!p || p.kind !== 'partial') return;
  const e = p.entry;
  if (!e.type) return askMissingType(e);
  if (!e.name) return askMissingName(e);
  if (!e.amount) return askMissingAmount(e);
  return startEntryFlow(e);
}

function askMissingType(entry) {
  pending = { kind: 'partial', entry };
  const el = $('#panel'); if (!el) return;
  el.innerHTML = `
  <div class="card">
    <div class="q-title">${esc(entry.name)}${entry.amount != null ? ', ' + esc(fmtINR(entry.amount)) : ''}</div>
    <p class="q-sub">ఉద్దెరా? జమా? · Credit or payment?</p>
    <div class="type-choice">
      <button id="tCredit" class="btn primary" type="button">ఉద్దెర<br><small>Credit</small></button>
      <button id="tPay" class="btn" type="button">జమ<br><small>Payment</small></button>
    </div>
    <button id="tMic" class="btn voice" type="button">🎤 మాటతో చెప్పండి · Say "credit" or "payment"</button>
  </div>`;
  $('#tCredit').onclick = () => { pending.entry.type = 'credit'; continuePartial(); };
  $('#tPay').onclick = () => { pending.entry.type = 'pay'; continuePartial(); };
  $('#tMic').onclick = pickTypeByVoice;
  speak('ఉద్దెరా, జమా?');
}

function askMissingName(entry) {
  if (!state.customers.length) return askNewCustomer(entry); // nobody yet -> it IS new
  // chooser sheet with every customer + the mic ("say the number") — no alias is
  // memorised from this transcript because we never heard a usable name
  openChooser(state.customers, '', 'entry', entry);
}

function askMissingAmount(entry) {
  pending = { kind: 'partial', entry };
  const el = $('#panel'); if (!el) return;
  el.innerHTML = `
  <div class="card">
    <div class="q-title">${esc(entry.name)} — ఎంత?</div>
    <p class="q-sub">మొత్తం · How much?</p>
    <input id="amtIn" class="input" type="number" inputmode="numeric" min="1" placeholder="500">
    <div id="amtErr" class="err" hidden></div>
    <div class="type-choice">
      <button id="amtOk" class="btn primary" type="button">కొనసాగించు</button>
      <button id="amtMic" class="btn" type="button">🎤 చెప్పండి</button>
    </div>
  </div>`;
  $('#amtOk').onclick = () => {
    const amt = Math.round(Number($('#amtIn').value));
    if (!Number.isInteger(amt) || amt <= 0) return showErr($('#amtErr'), 'మొత్తం 0 కంటే ఎక్కువ ఉండాలి');
    pending.entry.amount = amt;
    continuePartial();
  };
  $('#amtMic').onclick = pickAmountByVoice;
  speak(`${entry.name}, ఎంత?`);
}

function askUnknown(raw) {
  say(raw);
  const el = $('#panel'); if (!el) return;
  el.innerHTML = `
  <div class="card">
    <div class="q-title">అర్థం కాలేదు · Didn't understand</div>
    <div class="heard in-card">నేను విన్నది · I heard: ${esc(raw)}</div>
    <p class="q-sub">ఇలా చెప్పండి · Try like this:</p>
    <ul class="examples">
      <li>"రమేష్ కి 500 ఉద్దెర" — Credit ₹500 to Ramesh</li>
      <li>"లక్ష్మి 200 జమ" — Laxmi paid ₹200</li>
      <li>"రమేష్ కి ఎంత బాకీ" — How much does Ramesh owe</li>
    </ul>
  </div>`;
  speak('అర్థం కాలేదు, మళ్లీ చెప్పండి. ఉదాహరణలు తెరపై చూడండి.');
}

// spoken "credit"/"payment" for the type question
async function pickTypeByVoice() {
  if (activeRec || micBusy) return;
  const btn = $('#tMic');
  if (btn) { btn.disabled = true; btn.textContent = '… వింటున్నాను'; }
  micBusy = true;
  try {
    const r = await startRecording();
    const t = await r.done;
    if (!pending || pending.kind !== 'partial') return;
    const p = parse(t);
    if (p.type === 'credit' || p.type === 'pay') {
      pending.entry.type = p.type;
      return continuePartial();
    }
    say(t);
    speak('సరిలేదు, ఉద్దెర లేదా జమ అని చెప్పండి.');
  } catch (e) { speak(e.message || 'సమస్య జరిగింది'); }
  finally {
    micBusy = false;
    const b = $('#tMic');
    if (b) { b.disabled = false; b.textContent = '🎤 మాటతో చెప్పండి · Say "credit" or "payment"'; }
  }
}

// spoken amount for the amount question (digits or Telugu number words)
async function pickAmountByVoice() {
  if (activeRec || micBusy) return;
  const btn = $('#amtMic');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  micBusy = true;
  try {
    const r = await startRecording();
    const t = await r.done;
    if (!pending || pending.kind !== 'partial') return;
    const p = parse(t);
    if (Number.isInteger(p.amount) && p.amount > 0) {
      pending.entry.amount = p.amount;
      return continuePartial();
    }
    say(t);
    speak('సరిలేదు, మొత్తం మళ్లీ చెప్పండి.');
  } catch (e) { speak(e.message || 'సమస్య జరిగింది'); }
  finally {
    micBusy = false;
    const b = $('#amtMic');
    if (b) { b.disabled = false; b.textContent = '🎤 చెప్పండి'; }
  }
}

async function handleTranscript(raw) {
  say(raw);
  showHeard(raw);
  if (state.mode === 'rythu') return handleTranscriptRythu(raw);
  await ensureCustomers();
  const q = classifyQuery(raw);
  if (q) return runQuery(q, raw);
  const entries = buildEntries(splitTranscript(raw));
  if (!entries.length) return guidedRecovery(raw);
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
  // STEP 1 of the two-step save: this card is only a PREVIEW. POST
  // /api/voice/propose creates nothing — it returns the parsed candidate,
  // missing fields, balance before/after and the idempotency key to be used at
  // the confirm. Editing the transcript re-proposes (debounced, new key);
  // ✅ posts to /api/transactions with the key and only then says "saved".
  pending = { kind: 'single', entry, preview: null, ready: false, confirmKey: null, proposeSeq: 0 };
  renderConfirmCard();
  runPropose(entry.raw || entry.name);
  speak(`${entry.name}, ${entry.amount} రూపాయలు ${entry.type === 'credit' ? 'ఉద్దెర' : 'జమ'}. సరిగ్గా ఉందా?`);
}
const MISSING_LABELS = {
  CUSTOMER_UNKNOWN: 'కస్టమర్ పేరు · customer', CUSTOMER_AMBIGUOUS: 'ఖచ్చితమైన పేరు · exact person',
  AMOUNT: 'మొత్తం · amount', TRANSCRIPT: 'మాట · sentence', TYPE: 'రకం · type',
};
// only treat a missing code as blocking when the CLIENT entry cannot already
// supply it (guided recovery fixes fields by tap; the server transcript
// re-propose may then still fail to re-parse — that must not brick the save)
function missingLines(missing, entry) {
  return (missing || []).filter(code => {
    if ((code === 'CUSTOMER_UNKNOWN' || code === 'CUSTOMER_AMBIGUOUS') && entry.customerId) return false;
    if (code === 'AMOUNT' && Number(entry.amount) > 0) return false;
    if (code === 'TYPE' && (entry.type === 'credit' || entry.type === 'pay')) return false;
    if (code === 'TRANSCRIPT' && entry.name && Number(entry.amount) > 0 &&
        (entry.type === 'credit' || entry.type === 'pay')) return false;
    return true;
  });
}
function renderConfirmCard() {
  const p = pending, el = $('#panel');
  if (!p || !el) return;
  const e = p.entry;
  const v = p.preview;
  const c = state.customers.find(x => x.id === e.customerId);
  const balBefore = v && v.balanceBefore != null ? Number(v.balanceBefore)
    : (c && typeof c.balance === 'number' ? c.balance : null);
  const balAfter = balBefore == null ? null : balBefore + (e.type === 'credit' ? Number(e.amount) : -Number(e.amount));
  const warnings = (v && v.candidate && v.candidate[0] && v.candidate[0].warnings) || [];
  const missing = missingLines(v && v.missingFields, e);
  p.ready = !!v && !missing.length;
  el.innerHTML = `
  <div class="card confirm">
    <div class="confirm-head">
      <span class="avatar av-0">${esc(initialsOf(e.name))}</span>
      <span class="confirm-names"><b>${esc(e.name)}</b><small>${esc((c && c.label) || '')}</small></span>
      <span class="confirm-amt ${amtClass(e.type)}">${esc(fmtINR(e.amount))}</span>
    </div>
    <span class="type-tag ${e.type}">${typeTe(e.type)}</span>
    <div class="confirm-amount-edit">
      <label class="field" for="cfAmt">మొత్తం · Amount</label>
      <input id="cfAmt" class="input" type="number" inputmode="numeric" min="1" value="${esc(Number(e.amount) || '')}">
      <button id="cfType" class="chip-btn" type="button" aria-label="రకం మార్చండి">రకం · ${typeTe(e.type)} (tap to switch)</button>
    </div>
    <div class="bal-flip">బ్యాలెన్స్‌లోడవుతోంది…</div>
    ${warnings.indexOf('OVERPAYMENT') !== -1 ? `
      <div class="warn-note">జమ మిగిలిన బాకీ కంటే ఎక్కువ అవుతోంది — సేవ్ అయితె తిరస్కరించబడుతుంది · repayment exceeds balance; the save would be rejected</div>` : ''}
    ${missing.length ? `<div class="missing-note">అవసరం · needed: ${esc(missing.map(m => MISSING_LABELS[m] || m).join(', '))}</div>` : ''}
    <label class="field" for="cfTx">నేను విన్నది · I heard (editable)</label>
    <input id="cfTx" class="input" value="${esc(e.raw || '')}">
    <p class="q-sub">సరిగ్గా ఉందా? · Is this right?</p>
    <div class="confirm-actions">
      <button id="yes" class="btn primary" type="button"${p.ready ? '' : ' disabled'}>✅ అవును</button>
      <button id="no" class="btn ghost" type="button">❌ కాదు</button>
    </div>
    <div id="voiceNote" class="tts-note" hidden>🔇 వాయిస్ అందుబాటులో లేదు — సేవ్ మాత్రం చేయవచ్చు · voice unavailable, saving still works</div>
    <button id="other" class="link wide" type="button">➕ వేరే వ్యక్తి · Different person?</button>
  </div>`;
  $('#yes').onclick = () => { if (pending && pending.ready) onYes(); };
  $('#no').onclick = onNo;
  $('#other').onclick = () => askNewCustomer(e);
  $('#cfType').onclick = () => { e.type = e.type === 'credit' ? 'pay' : 'credit'; renderConfirmCard(); };
  const amtIn = $('#cfAmt'), txIn = $('#cfTx'), flip = $('.bal-flip', el);
  amtIn.addEventListener('input', () => {
    const a = Math.round(Number(amtIn.value));
    if (!Number.isInteger(a) || a <= 0) return;
    e.amount = a;
    const big = $('.confirm-amt', el);
    if (big) big.textContent = fmtINR(a);
    renderBalFlip(flip, e, a, balBefore);
  });
  let txTimer = null;
  txIn.addEventListener('input', () => {
    e.raw = txIn.value;
    if (txTimer) clearTimeout(txTimer);
    txTimer = setTimeout(() => runPropose(txIn.value), 700);
  });
  renderBalFlip(flip, e, e.amount, balBefore);
}
// balance before → after, shown live as the amount is edited
function renderBalFlip(flip, e, amount, fixedBefore) {
  if (!flip) return;
  let before = fixedBefore;
  if (before == null) {
    const c = state.customers.find(x => x.id === e.customerId);
    before = c && typeof c.balance === 'number' ? c.balance : null;
  }
  if (before == null) { flip.textContent = 'బ్యాలెన్స్ లోడ్ అవుతోంది… · loading balance…'; return; }
  const after = Number(before) + (e.type === 'credit' ? Number(amount) : -Number(amount));
  flip.innerHTML = `<span class="bal-flip-row">
    <span>${esc(fmtINR(before))}</span><span class="bal-flip-arrow">→</span>
    <b class="${after < 0 ? 'paid' : 'owed'}">${esc(fmtINR(after))}</b></span>
    ${after < 0 ? `<small class="advance-note">${esc(ADVANCE_TE_EN)}</small>` : ''}`;
}
// POST /api/voice/propose — step 1: never writes anything. A newer edit cancels
// an in-flight propose via proposeSeq; the key only becomes valid at confirm.
async function runPropose(transcript) {
  const p = pending;
  if (!p || p.kind !== 'single') return;
  const seq = ++p.proposeSeq;
  try {
    const v = await api('/api/voice/propose', {
      method: 'POST', body: { transcript: String(transcript || '').trim() || p.entry.name },
    });
    if (pending !== p || seq !== p.proposeSeq) return; // superseded by a newer edit
    p.preview = v;
    const first = v.candidate && v.candidate[0];
    if (first && first.idempotency_key) p.confirmKey = first.idempotency_key;
    if (first && first.customer_id && !p.entry.customerId) p.entry.customerId = first.customer_id;
    renderConfirmCard();
  } catch (e) {
    if (e.status === 401) return goLogin();
    // preview unavailable (offline etc.): fall back to a locally minted key so
    // the shopkeeper can still confirm; the save stays idempotent
    if (pending !== p || seq !== p.proposeSeq) return;
    p.preview = { candidate: [], missingFields: [], balanceBefore: null };
    if (!p.confirmKey) p.confirmKey = newKey();
    renderConfirmCard();
  }
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
      // the confirm carries the key minted when the preview was created
      // (a fallback key exists when the preview call itself failed)
      p.entry.idempotency_key = p.entry.idempotency_key || p.confirmKey || newKey();
      const txBox = $('#cfTx');
      p.entry.raw = (txBox && txBox.value.trim()) || p.entry.raw || p.entry.name;
      if (!p.entry.customer_id && state.customers.find(x => x.id === p.entry.customerId)) {
        p.entry.customer_id = p.entry.customerId;
      }
      await saveEntries([p.entry]);
      clearFlow();
      return speak('నమోదు చేశాను. · saved');
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
      // created → the entry itself still goes through the two-step preview
      // (propose supplies the idempotency key + balance before/after)
      btns.forEach(b => { b.disabled = true; });
      return askConfirm({ ...p.entry, customerId: c.id, raw: p.entry.raw || name });
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
      body: {
        customer_id: c.id, type: e.type, amount: e.amount,
        raw_transcript: e.raw || (e.customer_id ? '' : e.name),
        // keys come from the preview when propose made one; batch/screen entries
        // mint their own, so a dropped connection can never double-post
        idempotency_key: e.idempotency_key || newKey(),
        source: e.source || 'voice',
      },
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
  // every batch line gets its own idempotency key NOW (entry-minted); the
  // confirm then posts exactly those rows — retries reuse the same keys
  const withCust = entries.map(e => {
    const r = resolve(e.name, state.customers);
    const c = r.candidates[0] || null;
    return { ...e, customerId: c ? c.id : null, idempotency_key: newKey() };
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
  const bal = Number(c.balance) || 0;
  const msg = bal > 0
    ? `${c.name} బాకీ ${bal} రూపాయలు.`
    : bal < 0
      ? `${c.name} ఖాతాలో ${Math.abs(bal)} రూపాయల అడ్వాన్స్ ఉంది.` // advance to recover
      : `${c.name} కి బాకీ లేదు.`;
  renderResult({
    title: `${c.name} · బాకీ`,
    rows: [['బాకున్నది · Balance', bal < 0 ? 0 : bal]],
    ...(bal < 0
      ? { rows: [['అడ్వాన్స్ వసూలు చేయాలి · advance to recover', Math.abs(bal)]] }
      : {}),
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
// mode chips (kirana | rythu) persisted in localStorage 'kv-mode'; the rythu
// home replaces the kirana strip + recent list with the farmer day-summary
function modeChips() {
  return `<div class="mode-chips" id="modeChips" role="group" aria-label="మోడ్ · Mode">
    <button class="mode-chip${state.mode === 'kirana' ? ' on' : ''}" type="button" data-mode="kirana">కిరాణా · Kirana</button>
    <button class="mode-chip${state.mode === 'rythu' ? ' on' : ''}" type="button" data-mode="rythu">రైతు · Rythu</button>
  </div>`;
}
function wireModeChips() {
  const box = $('#modeChips');
  if (!box) return;
  box.querySelectorAll('[data-mode]').forEach(b => {
    b.onclick = () => {
      if (state.mode === b.dataset.mode) return;
      state.mode = b.dataset.mode;
      try { localStorage.setItem('kv-mode', state.mode); } catch (_) {}
      location.hash = '#/home';
      route();
    };
  });
}
async function viewHome() {
  const shop = await ensureShop();
  if (!shop) return;
  const ry = state.mode === 'rythu';
  appEl().innerHTML = `
  ${topbar()}
  <main class="screen">
    ${modeChips()}
    ${ry
      ? `<div class="strip" id="ryStrip">${skelRows(2)}</div>
         <h2 class="section">రైతులు · Farmers</h2>
         <div class="ry-add-row"><button id="ryAdd" class="btn ghost wide" type="button">➕ కొత్త రైతు · New farmer</button></div>
         <div id="ryFarmers" class="tx-list">${skelRows(3)}</div>`
      : `<div class="strip" id="strip">${skelRows(1)}</div>`}
    <div class="mic-wrap" id="micWrap">
      <span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span>
      <button id="mic" type="button" aria-label="మైక్">🎤</button>
    </div>
    <div id="heard" class="heard" hidden></div>
    <div id="say">నొక్కి మాట్లాడండి · Tap and speak</div>
    <div id="panel"></div>
    ${ry ? '' : `<h2 class="section">ఇటీవలి నమోదులు · Last 5 entries</h2>
    <div id="recent" class="tx-list">${skelRows(3)}</div>`}
    <div id="herr" class="err" hidden></div>
  </main>
  ${tabbar('#/home')}`;
  wireTopbar();
  wireModeChips();
  $('#mic').onclick = toggleMic;
  if (ry) $('#ryAdd').onclick = () => askRythuNewFarmer(null);
  try {
    if (ry) await refreshRythu();
    else await refreshHome();
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
        ${c.disputed ? '<span class="badge dispute">⚠️ వివాదం · Disputed entry</span>' : ''}
      </span>
      <span class="cust-right">
        <b class="bal ${c.balance > 0 ? 'owed' : ''}">${esc(fmtINR(c.balance || 0))}</b>
        ${c.balance < 0 ? `<small class="advance-note">${esc(ADVANCE_TE_EN)}</small>` : ''}
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
        ${c.balance < 0 ? `<small class="advance-note">${esc(ADVANCE_TE_EN)}</small>` : ''}
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
    ${ACK_FOOTNOTE}
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
      await api('/api/transactions', {
        method: 'POST',
        body: {
          customer_id: c.id, type: 'pay', amount: amt,
          raw_transcript: 'receive payment (screen)',
          idempotency_key: newKey(), // screen entries are idempotent too
          source: 'screen',
        },
      });
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
  const closeRevCard = () => { const rc = $('#revCard'); if (rc) rc.remove(); };
  if (!el) return r;
  if (!r.transactions.length) {
    el.innerHTML = emptyState('🧾', 'ఇంకా నమోదులు లేవు', 'No transactions yet');
    return r;
  }
  // Reversals replace deletion: an entry is never removed — a ⚖-offsetting row
  // and a 'reversed' flag preserve an auditable history. Reversal rows
  // themselves and anything already reversed offer no ⟲ action.
  el.innerHTML = r.transactions.map(t => {
    const reversed = t.status === 'reversed';
    const isRev = t.event === 'reversal';
    const ackable = !isRev && !reversed && ACKABLE_EVENT(t);
    const sign = t.type === 'credit' ? '+' : '−';
    const em = isRev ? 'రద్దు చేసింది · reversal' : (t.type === 'credit' ? 'ఉద్దెర' : 'జమ');
    const head = isRev
      ? `↺ ${esc(em)} ${sign === '+' ? '+' : '−'}${esc(fmtINR(t.amount))}`
      : `${sign}${esc(fmtINR(t.amount))} <em>${esc(em)}</em>`;
    return `
    <div class="tl-item${reversed ? ' reversed' : ''}${isRev ? ' is-reversal' : ''}">
      <span class="tl-dot ${t.type}"></span>
      <span class="tl-main">
        <b>${head}</b>
        <small>${esc(timeOf(t.created_at))}${!isRev && t.raw_transcript ? ' · “' + esc(String(t.raw_transcript).slice(0, 60)) + '”' : ''}${t.reason ? ' · ' + esc(String(t.reason).slice(0, 80)) : ''}</small>
        ${reversed ? '<small class="rev-note">రద్దు చేయబడింది · reversed</small>' : ''}
      </span>
      <span class="ack-chips">${ackChipHtml(t.ack_status, t.id)}</span>
      ${ackable ? `<button class="rev ack-send" type="button" data-ack-tx="${esc(t.id)}" aria-label="ధృవీకరణకు పంపు · Send for acknowledgement">📨</button>` : ''}
      ${(!isRev && !reversed) ? `<button class="rev" type="button" data-rev-tx="${esc(t.id)}" aria-label="రద్దు చేయండి">⟲</button>` : ''}
    </div>`;
  }).join('');
  closeRevCard();
  // acknowledgement actions: 📨 opens the link/QR sheet; a disputed chip opens
  // the resolve card (note shown back to the shopkeeper)
  wireAckActions(el,
    ackTx => {
      const t = r.transactions.find(x => x.id === ackTx);
      if (t) sendAckForEntry(t, r.customer, () => { try { loadTimeline(id); } catch (_) {} }, $('#derr'));
    },
    () => { try { loadTimeline(id); } catch (_) {} });
  el.querySelectorAll('[data-rev-tx]').forEach(b => {
    b.onclick = () => {
      closeRevCard();
      const card = document.createElement('div');
      card.id = 'revCard';
      card.className = 'card rev-card';
      card.innerHTML = `
        <div class="q-title">నమోదును రద్దు చేయండి · Reverse this entry</div>
        <p class="q-sub">ఒక ఎదురు నమోదు వస్తుంది; మొదటిది రద్దు అవుతుంది · One offsetting entry is posted and the original is marked reversed</p>
        <label class="field" for="revReason">కారణం · Reason</label>
        <input id="revReason" class="input" maxlength="200" placeholder="తప్పు మొత్తం · wrong amount">
        <div class="confirm-actions">
          <button id="revOk" class="btn primary" type="button">⟲ రద్దు చేయండి</button>
          <button id="revNo" class="btn ghost" type="button">❌ వదులుకోండి</button>
        </div>
        <div id="revErr" class="err" hidden></div>`;
      el.after(card);
      $('#revReason').focus();
      $('#revNo').onclick = closeRevCard;
      $('#revOk').onclick = async () => {
        const reason = $('#revReason').value.trim();
        if (!reason) return showErr($('#revErr'), 'రద్దు కారణం తప్పనిసరి · reason required');
        const btn = $('#revOk');
        btn.disabled = true;
        try {
          await api('/api/transactions/' + b.dataset.revTx + '/reverse', { method: 'POST', body: { reason } });
          closeRevCard();
          await refreshHome();
          await loadTimeline(id);
          speak('రద్దు చేశాను. · reversed');
        } catch (e) {
          if (e.status === 401) return goLogin();
          showErr($('#revErr'), e.message);
          btn.disabled = false;
        }
      };
    };
  });
  return r;
}

// ================= RYTHU MODE — produce buyer (sprint 2) =================
// The owner BUYS produce from farmers: a farmer account (kind='farmer') carries
// direction='payable' rows — the shop OWES the farmer until the delivery is
// settled in cash. The server is the only authority on amounts for deliveries
// (qty × rate, integer paise); this file only previews.
const PROD_UI = [
  ['వరి', 'paddy'], ['పత్తి', 'cotton'], ['మిరప', 'chilli'], ['మొక్కజొన్న', 'maize'],
  ['శనగ', 'bengal_gram'], ['కంది', 'red_gram'], ['పెసర', 'green_gram'],
  ['మినుము', 'black_gram'], ['వేరుశనగ', 'groundnut'], ['పసుపు', 'turmeric'],
  ['నువ్వులు', 'sesame'], ['జొన్న', 'jowar'],
];
const PROD_TE = {};
for (const [te, en] of PROD_UI) PROD_TE[en] = te;
const RY_UNIT_UI = [['క్వింటా', 'quintal'], ['కిలో', 'kg'], ['టన్ను', 'tonne'], ['బస్తా', 'bag']];
// the parser emits its own spellings; canonicalise to what tokenizes money-ready
const RY_UNIT_CANON = { quintal: 'quintal', kg: 'kg', kilo: 'kg', ton: 'tonne', tonnes: 'tonne', bag: 'bag', bags: 'bag' };
const RY_KG = { kg: 1, quintal: 100, tonne: 1000 };
const RY_CAT_UI = [['హమాలీ', 'hamali'], ['కమీషన్', 'commission'], ['రవాణా', 'transport'], ['తరుగు', 'tharugu'], ['ఇతర', 'other']];
const RY_CAT_TE = { hamali: 'హమాలీ', commission: 'కమీషన్', transport: 'రవాణా', tharugu: 'తరుగు', other: 'ఇతర' };
const RY_EVENT_TE = { delivery: 'సరుకు · Delivery', advance: 'అడ్వాన్స్', deduction: 'తగ్గింపు', payment: 'చెల్లింపు' };
const RY_EVENT_TAG = { delivery: 'సరుకు', advance: 'అడ్వాన్స్', deduction: 'తగ్గింపు', payment: 'చెల్లింపు' };
const RY_MISS_TE = {
  EVENT: 'ఏది? (సరుకు/అడ్వాన్స్/తగ్గింపు/చెల్లింపు)', FARMER: 'రైతు పేరు',
  PRODUCE: 'ఏ పంట?', QUANTITY: 'ఎన్ని?', UNIT: 'ఏ కొలత?', BAG_WEIGHT: 'బస్తా బరువు',
  RATE: 'రేటు', AMOUNT: 'మొత్తం', CATEGORY: 'తగ్గింపు రకం', SETTLEMENT: 'సెటిల్‌మెంట్',
};

// ---------- speech-friendly Telugu numbers (TTS) ----------
// the TTS provider chokes on digit runs and symbols, so the voice line spells
// every number as words (on-screen text keeps ₹/×/arrow symbols untouched)
const TE_NUM = ['సున్నా', 'ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది'];
const TE_TEEN = ['పది', 'పదకొండు', 'పన్నెండు', 'పదమూడు', 'పద్నాలుగు', 'పదిహేను', 'పదహారు', 'పదిఏడు', 'పద్దెనిమిది', 'పందొమ్మది'];
const TE_TENS = { 2: 'ఇరవై', 3: 'ముప్పై', 4: 'నలభై', 5: 'యాభై', 6: 'అరవై', 7: 'డెభై', 8: 'ఎనభై', 9: 'తొంభై' };
function teNum(n) {
  n = Math.round(Number(n) || 0);
  if (n < 0) return 'మైనస్ ' + teNum(-n);
  if (n < 10) return TE_NUM[n];
  if (n < 20) return TE_TEEN[n - 10];
  if (n < 100) return TE_TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + TE_NUM[n % 10] : '');
  if (n < 1000) return TE_NUM[Math.floor(n / 100)] + ' వందల' + (n % 100 ? ' ' + teNum(n % 100) : '');
  if (n < 100000) return teNum(Math.floor(n / 1000)) + ' వేల' + (n % 1000 ? ' ' + teNum(n % 1000) : '');
  if (n < 10000000) return teNum(Math.floor(n / 100000)) + ' లక్షల' + (n % 100000 ? ' ' + teNum(n % 100000) : '');
  if (n < 1000000000) return teNum(Math.floor(n / 10000000)) + ' కోట్ల' + (n % 10000000 ? ' ' + teNum(n % 10000000) : '');
  return String(n); // beyond crores: leave the digits (never happens on a card)
}
// .5 quantities speak as the Telugu half-words the parser already knows
function teSpeech(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return '';
  if (Number.isInteger(x)) return teNum(x);
  if (x > 0 && x < 1 && Math.abs(x - 0.5) < 0.001) return 'అర';
  const i = Math.floor(x);
  if (i >= 1 && Math.abs(x - (i + 0.5)) < 0.001) return teNum(i) + 'న్నర';
  return String(x); // rare decimal: spoken as digits
}
const RY_UNIT_PL = { quintal: 'క్వింటాళ్ల', kg: 'కిలోలు', tonne: 'టన్నులు', bag: 'బస్తాలు' };
// the VOICE line for the rythu confirm card — pure Telugu words, no symbols
function rySpeechText(e, total) {
  if (e.event === 'delivery') {
    const unit = RY_UNIT_PL[e.unit] || (ryUnitTe(e.unit) || '');
    const rUnit = (ryUnitTe(e.rateUnit || e.unit) || '') + 'కు';
    const totalS = total != null ? ', మొత్తం ' + teSpeech(total) + ' రూపాయలు' : ', మొత్తం తెలియదు';
    return `${e.name || ''}, ${e.quantity != null ? teSpeech(e.quantity) : ''} ${unit} ${PROD_TE[e.produce] || ''} అందింది. ${rUnit} ${e.rate != null ? teSpeech(e.rate) : ''} రూపాయలు${totalS}. సరిగ్గా ఉందా?`;
  }
  const kind = RY_EVENT_TAG[e.event] || (e.event === 'deduction' ? 'తగ్గింపు' : '');
  return `${e.name || ''}, ${e.amount != null ? teSpeech(e.amount) : ''} రూపాయలు ${kind}. సరిగ్గా ఉందా?`;
}

function ryEventTe(ev) { return RY_EVENT_TE[ev] || '?'; }
function ryUnitTe(u) { const x = RY_UNIT_UI.find(x => x[1] === u); return x ? x[0] : (u || ''); }

// preview-only delivery total (rupees); the server recomputes it in paise
function ryAmount(e) {
  if (!e || e.event !== 'delivery') return null;
  const q = Number(e.quantity), r = Number(e.rate);
  if (!(q > 0) || !(r > 0)) return null;
  const u = e.unit, ru = e.rateUnit || u;
  if (u === 'bag' && ru !== 'bag' && !(Number(e.bagKg) > 0)) return null;
  let amount = null;
  if (u === ru) amount = q * r;
  else if (RY_KG[u] && RY_KG[ru]) {
    const kg = u === 'bag' ? q * Number(e.bagKg) : q * RY_KG[u];
    amount = (kg / RY_KG[ru]) * r;
  }
  return amount == null ? null : Math.round(amount * 100) / 100;
}

// what is still missing from a rythu entry (drives guided recovery, in order)
function ryMissing(e) {
  const miss = [];
  if (!e.event) miss.push('EVENT');
  if (!e.customerId) miss.push('FARMER');
  if (e.event === 'delivery') {
    if (!e.produce) miss.push('PRODUCE');
    if (!(Number(e.quantity) > 0)) miss.push('QUANTITY');
    if (!e.unit) miss.push('UNIT');
    if (e.unit === 'bag' && !(Number(e.bagKg) > 0)) miss.push('BAG_WEIGHT');
    if (!(Number(e.rate) > 0)) miss.push('RATE');
  } else if (e.event) {
    if (!(Number(e.amount) > 0)) miss.push('AMOUNT');
    if (e.event === 'deduction' && !e.category) miss.push('CATEGORY');
  }
  return miss;
}

// farmer/produce inheritance between parts (numbers never inherit)
function buildRythuParts(parts) {
  const out = [];
  let prev = null;
  for (const part of parts) {
    let p;
    try { p = parseRythu(part); } catch (_) { continue; }
    const e = {
      event: p.event || null, name: p.farmer || null, raw: part,
      produce: p.produce || null, quantity: p.quantity != null ? p.quantity : null,
      unit: RY_UNIT_CANON[p.unit] || null, bagKg: p.bagKg != null ? p.bagKg : null,
      rate: p.rate != null ? p.rate : null, rateUnit: RY_UNIT_CANON[p.rateUnit] || null,
      amount: p.amount != null ? p.amount : null, category: p.category || null,
      customerId: null, idempotency_key: newKey(), source: 'voice',
    };
    if (p.rateUnit && !e.rateUnit && e.unit) e.rateUnit = e.unit;
    if (!e.name && prev) e.name = prev.name;
    if (e.event === 'delivery' && !e.produce && prev) e.produce = prev.produce;
    if (!e.event && !e.name) continue;
    out.push(e);
    prev = e;
  }
  return out;
}

// ---------- rythu data ----------
async function loadRythuFarmers(force) {
  if (!force && state.rythuFarmers.length) return state.rythuFarmers;
  const r = await api('/api/rythu/farmers');
  state.rythuFarmers = r.farmers || [];
  return state.rythuFarmers;
}
function ryRoster() {
  return (state.rythuFarmers || []).map(f => ({ id: f.id, name: f.name, label: f.village || '' }));
}
function ryResolve(name) { return resolve(String(name || ''), ryRoster()); }
// net payable to this farmer (positive = shop owes, negative = advance to recover)
function ryNet(f) { return f ? (Number(f.payable) || 0) - (Number(f.advance) || 0) : null; }

async function refreshRythu() {
  const [sum, farmers] = await Promise.all([
    api('/api/rythu/summary'),
    api('/api/rythu/farmers'),
  ]);
  state.rythuSummary = sum;
  state.rythuFarmers = farmers.farmers || [];
  renderRythuStrip();
  renderRythuFarmers();
}
function renderRythuStrip() {
  const el = $('#ryStrip'); if (!el) return;
  const s = state.rythuSummary || {};
  el.innerHTML = `
    <div class="stat"><span class="stat-te">సరుకు కొనుగోలు</span><span class="stat-en">Purchases today</span>
      <b class="stat-val owed">${esc(fmtINR(s.purchases || 0))}</b></div>
    <div class="stat"><span class="stat-te">అడ్వాన్స్‌లు</span><span class="stat-en">Advances</span>
      <b class="stat-val paid">${esc(fmtINR(s.advances || 0))}</b></div>
    <div class="stat"><span class="stat-te">చెల్లింపులు</span><span class="stat-en">Payments</span>
      <b class="stat-val paid">${esc(fmtINR(s.payments || 0))}</b></div>
    <div class="stat"><span class="stat-te">చెల్లించాల్సినది</span><span class="stat-en">Payable now</span>
      <b class="stat-val owed">${esc(fmtINR(s.payable_total || 0))}</b></div>`;
}
function renderRythuFarmers() {
  const el = $('#ryFarmers'); if (!el) return;
  const rows = state.rythuFarmers || [];
  if (!rows.length) {
    el.innerHTML = emptyState('🌾', 'ఇంకా రైతులు లేరు — ➕ తో మొదటి రైతును జతచేయండి', 'No farmers yet — add the first one');
    return;
  }
  el.innerHTML = rows.map(f => `
    <div class="ry-farmer-card" data-ry-open="${esc(f.id)}" role="button" tabindex="0">
      <span class="avatar av-${hashOf(f.id) % 6}">${esc(initialsOf(f.name))}</span>
      <span class="tx-main"><b>${esc(f.name)}${f.village ? ` <em>${esc(f.village)}</em>` : ''}</b>
        <small>${f.open_settlements ? `${f.open_settlements} సెటిల్‌మెంట్లు ఓపెన్` : 'ఓపెన్ సెటిల్‌మెంట్ లేదు'}</small>
        ${f.disputed ? '<span class="badge dispute">⚠️ వివాదం · Disputed entry</span>' : ''}</span>
      <span class="tx-amt ${Number(f.payable) > 0 ? 'owed' : 'paid'}">${Number(f.payable) > 0
        ? esc(fmtINR(f.payable)) : esc(fmtINR(-(f.advance || 0)))}</span>
    </div>`).join('');
  el.querySelectorAll('[data-ry-open]').forEach(card => {
    card.onclick = () => { location.hash = '#/rythu/farmer/' + card.dataset.ryOpen; };
    card.onkeydown = e => { if (e.key === 'Enter') location.hash = '#/rythu/farmer/' + card.dataset.ryOpen; };
  });
}

// ---------- rythu transcript handling ----------
async function handleTranscriptRythu(raw) {
  try { await loadRythuFarmers(); } catch (e) { if (e.status === 401) return goLogin(); }
  const q = classifyRythuQuery(raw);
  if (q) return runRythuQuery(q, raw);
  const entries = buildRythuParts(splitTranscript(raw));
  if (!entries.length) {
    // nothing usable — try the raw sentence once for a recovery seed
    let seed = null;
    try { seed = parseRythu(raw); } catch (_) {}
    return rythuFlow({
      event: null, name: seed && seed.farmer ? seed.farmer : null, raw,
      produce: null, quantity: null, unit: null, bagKg: null,
      rate: null, rateUnit: null, amount: null, category: null,
      customerId: null, idempotency_key: newKey(), source: 'voice',
    });
  }
  if (entries.length === 1) return rythuFlow(entries[0]);
  return startRythuBatch(entries);
}
// "<farmer> ki entha ivvali" style questions and the rythu day summary
function classifyRythuQuery(raw) {
  const t = String(raw || '');
  if (/(ఈ\s*రోజు|ఈరోజు|ee\s*roju|today)/i.test(t) &&
      /(కొనుగోలు|కొన్న|సరుకు|అడ్వాన్స్|చెల్లింపు|purchase|advance|payment)/i.test(t)) {
    return { kind: 'day' };
  }
  let p = null;
  try { p = parseRythu(t); } catch (_) {}
  const hasNumbers = p && (p.amount != null || p.quantity != null || p.rate != null);
  if (/(ఎంత|entha|ఇవ్వాలి|ఇవ్వవా|ivvali|మిగిలి|బాకీ)/i.test(t) && p && p.farmer && !hasNumbers && !p.event) {
    return { kind: 'farmer', name: p.farmer };
  }
  return null;
}
async function runRythuQuery(q) {
  try {
    if (q.kind === 'day') {
      const s = await api('/api/rythu/summary');
      renderResult({
        title: 'ఈ రోజు · Today (రైతు)',
        rows: [['సరుకు కొనుగోలు · Purchases', s.purchases || 0],
               ['అడ్వాన్స్‌లు · Advances', s.advances || 0],
               ['చెల్లింపులు · Payments', s.payments || 0]],
      });
      return speak(`ఈ రోజు సరుకు కొనుగోలు ${s.purchases || 0} రూపాయలు, అడ్వాన్స్ ${s.advances || 0}, చెల్లింపులు ${s.payments || 0} రూపాయలు.`);
    }
    await loadRythuFarmers();
    const r = ryResolve(q.name);
    if (r.status !== 'one' && r.candidates && r.candidates.length) {
      return ryFarmerSheet(r.candidates, q.name, c => rySpeakFarmerTotals(c));
    }
    if (r.status === 'one') return rySpeakFarmerTotals(r.candidates[0]);
    renderResult({ title: 'రైతు ఖాతా · Farmer', empty: `${q.name} — పేరు దొరకలేదు · not found` });
    return speak(`${q.name} పేరు దొరకలేదు.`);
  } catch (e) {
    if (e.status === 401) return goLogin();
    say(e.message || 'సమస్య జరిగింది');
  }
}
async function rySpeakFarmerTotals(f) {
  const d = await api('/api/rythu/farmers/' + encodeURIComponent(f.id) + '/settlements');
  let gross = 0, adv = 0, ded = 0, pay = 0;
  for (const s of (d.settlements || [])) {
    if (s.status === 'reversed') continue;
    gross += Number(s.gross) || 0;
    adv += Number(s.advance_total) || 0;
    ded += Number(s.deduction_total) || 0;
    pay += Number(s.payment_total) || 0;
  }
  for (const u of (d.unallocated || [])) {
    if (u.event === 'deduction') ded += Number(u.amount) || 0;
    else adv += Number(u.amount) || 0; // advance or an unlinked payment counts as cash in our hands
  }
  const rem = Math.round((gross - adv - ded - pay) * 100) / 100;
  const g = x => Math.round(x);
  renderResult({
    title: `${f.name} · ఖాతా`,
    rows: [['మొత్తం సరుకు · total produce', g(gross)], ['అడ్వాన్స్ · advances', g(adv)],
           ['తగ్గింపులు · deductions', g(ded)], ['చెల్లింపులు · payments', g(pay)],
           ['మిగిలింది · remaining', g(rem)]],
  });
  return speak(`${f.name} గారి మొత్తం సరుకు ${g(gross)} రూపాయలు, అడ్వాన్స్ ${g(adv)}, తగ్గింపులు ${g(ded)}, చెల్లింపులు ${g(pay)}, మిగిలింది ${g(rem)} రూపాయలు.`);
}

// ---------- generic pick sheet (farmer / settlement choose by tap or number) ----------
function rySheetPick(title, sub, items, onPick) {
  // items: [{ id, name, sub }] — shared by the farmer chooser and settlement chooser
  let sh;
  sh = showSheet(`
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <div><h3>${esc(title)}</h3><small>${esc(sub)}</small></div>
      <button id="sheetClose" class="sheet-x" type="button" aria-label="మూసివేయండి">✕</button>
    </div>
    <button id="sheetMic" class="btn voice" type="button">🎤 సంఖ్య చెప్పండి · Say the number</button>
    <div class="cand-list">${items.map((x, i) => `
      <button class="cand-card" type="button" data-idx="${i}">
        <span class="cand-idx">${i + 1}</span>
        <span class="cand-main"><span class="cand-top"><b>${esc(x.name)}</b></span>
          <span class="cand-sub">${esc(x.sub || '')}</span></span>
      </button>`).join('')}</div>`);
  sh.querySelector('#sheetClose').onclick = hideSheet;
  sh.querySelector('#sheetMic').onclick = async () => {
    if (activeRec || micBusy) return;
    const btn = $('#sheetMic');
    if (btn) { btn.disabled = true; btn.textContent = '… వింటున్నాను'; }
    micBusy = true;
    try {
      const r = await startRecording();
      const t = await r.done;
      const n = numberFrom(t);
      if (!n || n > items.length) { say(t); speak('సరిలేదు, మళ్లీ సంఖ్య చెప్పండి.'); }
      else { hideSheet(); onPick(items[n - 1]); }
    } catch (e) { speak(e.message || 'సమస్య జరిగింది'); }
    finally {
      micBusy = false;
      const b = $('#sheetMic');
      if (b) { b.disabled = false; b.innerHTML = '🎤 సంఖ్య చెప్పండి · Say the number'; }
    }
  };
  sh.querySelectorAll('[data-idx]').forEach(b => b.onclick = () => { hideSheet(); onPick(items[Number(b.dataset.idx)]); });
  const list = items.map((x, i) => `${TEL_NUM[i] || (i + 1)}: ${x.name}`).join(', ');
  speak(`${title}? ${list}. సంఖ్య చెప్పండి.`);
}

// ---------- new farmer (rythu) ----------
function askRythuNewFarmer(entry) {
  pending = entry ? { kind: 'ry-new', entry } : { kind: 'ry-new', entry: null };
  const el = $('#panel'); if (!el) return;
  el.innerHTML = `
  <div class="card">
    <div class="q-title">కొత్త రైతు · New farmer</div>
    <p class="q-sub">పంట అమ్మే రైతు ఖాతా. పేరు + గ్రామం (ఐచ్ఛికం) · A produce-selling farmer account + village (optional)</p>
    <label class="field" for="ryName">పేరు · Name</label>
    <input id="ryName" class="input" maxlength="100" value="${esc((entry && entry.name) || '')}">
    <label class="field" for="ryVillage">గ్రామం (ఐచ్ఛికం) · Village (optional)</label>
    <input id="ryVillage" class="input" maxlength="60">
    <div id="ryErr" class="err" hidden></div>
    <div class="confirm-actions">
      <button id="ryYes" class="btn primary" type="button">✅ చేర్చండి</button>
      <button id="ryNo" class="btn ghost" type="button">❌ కాదు</button>
    </div>
  </div>`;
  $('#ryNo').onclick = () => { clearFlow(); speak('సరే.'); };
  $('#ryYes').onclick = async () => {
    const name = ($('#ryName').value || '').trim();
    const village = ($('#ryVillage').value || '').trim() || null;
    if (!name) return showErr($('#ryErr'), 'పేరు తప్పనిసరి');
    const b = $('#ryYes'); b.disabled = true;
    try {
      const c = await api('/api/customers', { method: 'POST', body: { name, village, kind: 'farmer' } });
      state.rythuFarmers = state.rythuFarmers || [];
      state.rythuFarmers.push({ id: c.id, name: c.name, village: c.village || null, payable: 0, advance: 0, open_settlements: 0 });
      pending = null;
      clearFlow();
      speak(`${c.name} చేర్చాను.`);
      if (entry) {
        // the name the farmer/TYPER confirmed must REPLACE the entry's name —
        // otherwise the confirm card builds with a null name and shows "?"
        entry.name = c.name || name;
        entry.customerId = c.id;
        return rythuRecovery(entry);
      }
      if ($('#ryFarmers')) renderRythuFarmers();
    } catch (e) {
      if (e.status === 401) return goLogin();
      b.disabled = false;
      showErr($('#ryErr'), e.message);
    }
  };
  speak('కొత్త రైతు పేరు వ్రాయండి.');
}

// ---------- guided recovery (ONE missing field at a time) ----------
function rythuRecovery(entry) {
  pending = { kind: 'ry-partial', entry };
  const miss = ryMissing(entry);
  if (!miss.length) return askRythuConfirm(entry);
  switch (miss[0]) {
    case 'EVENT': return ryAskEvent(entry);
    case 'FARMER': return ryAskFarmer(entry);
    case 'PRODUCE': return ryAskProduce(entry);
    case 'QUANTITY': return ryAskNumber(entry, 'quantity', 'ఎన్ని?', 'Quantity (క్వింటా/కిలో/…)', true);
    case 'UNIT': return ryAskUnit(entry);
    case 'BAG_WEIGHT': return ryAskNumber(entry, 'bagKg', 'ఒక బస్తా ఎన్ని కిలోలు?', 'Bag weight (kg)', true);
    case 'RATE': return ryAskNumber(entry, 'rate', 'రేటు ఎంత?', 'Rate per unit (₹)', true);
    case 'AMOUNT': return ryAskNumber(entry, 'amount', 'ఎంత మొత్తం?', 'Amount (₹)', false);
    case 'CATEGORY': return ryAskCategory(entry);
  }
}
async function rythuFlow(entry) {
  try { await loadRythuFarmers(); } catch (e) { if (e.status === 401) return goLogin(); }
  const r = entry.name ? ryResolve(entry.name) : { status: 'none' };
  if (r.status === 'one') { entry.customerId = r.candidates[0].id; return rythuRecovery(entry); }
  if ((r.status === 'many' || r.status === 'fuzzy') && r.candidates && r.candidates.length) {
    return ryFarmerSheet(r.candidates, entry.name, c => { entry.customerId = c.id; rythuRecovery(entry); });
  }
  return askRythuNewFarmer(entry);
}
function ryFarmerSheet(candidates, spoken, onPick) {
  rySheetPick('ఏ రైతు?', 'Which farmer?' + (spoken ? ` · చెప్పినది: “${spoken}”` : ''),
    candidates.map(c => ({ id: c.id, name: c.name, sub: c.label || '' })),
    c => {
      // remember the spoken spelling like kirana does
      addAlias(c, spoken).then(() => onPick(c));
    });
}
function ryCard(title, bodyHtml) {
  const el = $('#panel'); if (!el) return null;
  el.innerHTML = `<div class="card"><div class="q-title">${esc(title)}</div>${bodyHtml}</div>`;
  return el;
}
function ryAskEvent(entry) {
  const el = ryCard(entry.name ? `${entry.name} — ఏది?` : 'ఏది?',
    `<p class="q-sub">సరుకు, అడ్వాన్స్, తగ్గింపు లేదా చెల్లింపు · What is this?</p>
     <div class="type-choice" id="ryEv"></div>`);
  if (!el) return;
  speak('సరుకు, అడ్వాన్స్, తగ్గింపు లేదా చెల్లింపు?');
  const box = $('#ryEv');
  [['సరుకు అందింది · Delivery', 'delivery'], ['అడ్వాన్స్ · Advance', 'advance'],
   ['తగ్గింపు · Deduction', 'deduction'], ['చెల్లింపు · Payment', 'payment']].forEach(([te, ev]) => {
    const b = document.createElement('button');
    b.className = 'btn' + (ev === 'delivery' ? ' primary' : '');
    b.type = 'button';
    b.innerHTML = te;
    b.onclick = () => { entry.event = ev; if (ev !== 'delivery') { entry.produce = null; } rythuRecovery(entry); };
    box.appendChild(b);
  });
}
function ryAskFarmer(entry) {
  const list = state.rythuFarmers || [];
  if (!list.length) return askRythuNewFarmer(entry);
  rySheetPick('ఏ రైతు?', 'Which farmer? · tap or say the number',
    list.map(f => ({ id: f.id, name: f.name, sub: f.village || '' })),
    f => { entry.customerId = f.id; rythuRecovery(entry); });
}
function ryAskProduce(entry) {
  const el = ryCard((entry.name || '') + ' — ఏ పంట?', '<p class="q-sub">Which produce?</p><div class="chips-wrap" id="ryPr"></div>');
  if (!el) return;
  speak('ఏ పంట తెచ్చారు? తెరపై ఎంచుకోండి.');
  const box = $('#ryPr');
  PROD_UI.forEach(([te, en]) => {
    const b = document.createElement('button');
    b.className = 'chip-btn'; b.type = 'button'; b.textContent = te;
    b.onclick = () => { entry.produce = en; rythuRecovery(entry); };
    box.appendChild(b);
  });
}
function ryAskUnit(entry) {
  const el = ryCard((entry.name || '') + ' — ఏ కొలత?', '<p class="q-sub">Which unit?</p><div class="chips-wrap" id="ryUn"></div>');
  if (!el) return;
  speak('క్వింటా, కిలో, టన్ను, బస్తా — ఏది?');
  const box = $('#ryUn');
  RY_UNIT_UI.forEach(([te, en]) => {
    const b = document.createElement('button');
    b.className = 'chip-btn'; b.type = 'button'; b.textContent = te;
    b.onclick = () => { entry.unit = en; if (!entry.rateUnit) entry.rateUnit = en; rythuRecovery(entry); };
    box.appendChild(b);
  });
}
function ryAskCategory(entry) {
  const el = ryCard((entry.name || '') + ' — ఏ తగ్గింపు?', '<p class="q-sub">Which deduction?</p><div class="chips-wrap" id="ryCa"></div>');
  if (!el) return;
  speak('హమాలీ, కమీషన్, రవాణా, తరుగు, ఇతర — ఏది?');
  const box = $('#ryCa');
  RY_CAT_UI.forEach(([te, en]) => {
    const b = document.createElement('button');
    b.className = 'chip-btn'; b.type = 'button'; b.textContent = te;
    b.onclick = () => { entry.category = en; rythuRecovery(entry); };
    box.appendChild(b);
  });
}
// numeric ask; decimals allowed only where money/weights make sense
function ryAskNumber(entry, field, teTitle, enSub, decimals) {
  const el = ryCard(`${entry.name || ''} — ${teTitle}`,
    `<p class="q-sub">${esc(enSub)}</p>
     <input id="ryNum" class="input" type="number" inputmode="decimal" ${decimals ? 'step="any"' : 'step="1"'} min="0">
     <div id="ryNErr" class="err" hidden></div>
     <div class="type-choice"><button id="ryNumOk" class="btn primary" type="button">కొనసాగించు</button></div>`);
  if (!el) return;
  speak(`${entry.name || ''}, ${teTitle}`);
  $('#ryNum').focus();
  $('#ryNumOk').onclick = () => {
    const v = Number($('#ryNum').value);
    if (!Number.isFinite(v) || v <= 0) return showErr($('#ryNErr'), '0 కంటే ఎక్కువ వేయండి');
    if (!decimals && !Number.isInteger(v)) return showErr($('#ryNErr'), 'పూర్ణ సంఖ్య వేయండి');
    entry[field] = v;
    rythuRecovery(entry);
  };
}

// ---------- single confirm card (preview → confirm) ----------
function askRythuConfirm(entry) {
  // HARD GUARD: no confirm card without a resolved farmer id AND a name —
  // a nameless card would post to an unknown customer or show "?" forever
  if (!entry.customerId || !entry.name) return rythuRecovery(entry);
  pending = {
    kind: 'ry-single', entry, key: entry.idempotency_key || newKey(),
    settleHint: null, settleOpen: null, overWarn: false, allowAdvance: false,
    proposeSeq: 0, preview: null,
  };
  entry.idempotency_key = null; // the propose key (or a fresh one at save) is used instead
  renderRythuConfirm();
  runProposeRythu();
}
// filter the server's missing list against what the client already holds
function ryServerBlocking(missing) {
  return (missing || []).filter(code => {
    if (code === 'CUSTOMER_UNKNOWN' || code === 'CUSTOMER_AMBIGUOUS') return true;
    return false; // numbers/units come from the client entry, which recovery filled
  });
}
async function runProposeRythu() {
  const p = pending;
  if (!p || p.kind !== 'ry-single') return;
  const seq = ++p.proposeSeq;
  try {
    const v = await api('/api/voice/propose', {
      method: 'POST', body: { transcript: String(p.entry.raw || '').trim() || (p.entry.name || ''), workflow: 'rythu' },
    });
    if (pending !== p || seq !== p.proposeSeq) return;
    p.preview = v;
    const f = v.candidate && v.candidate[0];
    if (f) {
      if (f.idempotency_key) p.key = f.idempotency_key;
      if (!p.entry.customerId && f.customer_id) p.entry.customerId = f.customer_id;
      if (!p.entry.event && f.event) p.entry.event = f.event;
      if (!p.entry.name && f.name) p.entry.name = f.name;
      if (!p.entry.produce && f.produce) p.entry.produce = f.produce;
      if (p.entry.quantity == null && f.quantity != null) p.entry.quantity = f.quantity;
      if (!p.entry.unit && f.unit) p.entry.unit = RY_UNIT_CANON[f.unit] || f.unit;
      if (!p.entry.bagKg && f.bag_kg != null) p.entry.bagKg = f.bag_kg;
      if (p.entry.rate == null && f.rate != null) p.entry.rate = f.rate;
      if (!p.entry.rateUnit && f.rateUnit) p.entry.rateUnit = RY_UNIT_CANON[f.rateUnit] || f.rateUnit;
      if (p.entry.amount == null && f.amount != null) p.entry.amount = f.amount;
      if (!p.entry.category && f.category) p.entry.category = f.category;
      if (f.settlement_hint) p.settleHint = f.settlement_hint;
      p.overWarn = Array.isArray(f.warnings) && f.warnings.indexOf('OVERPAYMENT') !== -1;
      if (p.settleHint === 'CHOOSE') {
        try { p.settleOpen = await ryOpenSettlements(p.entry.customerId); }
        catch (_) { p.settleOpen = []; }
      }
    }
    renderRythuConfirm();
  } catch (e) {
    if (e.status === 401) return goLogin();
    if (pending !== p || seq !== p.proposeSeq) return;
    // preview unavailable — a locally minted key keeps the save idempotent
    p.preview = { candidate: [] };
    p.settleHint = null;
    renderRythuConfirm();
  }
}
async function ryOpenSettlements(farmerId) {
  if (!farmerId) return [];
  const d = await api('/api/rythu/farmers/' + encodeURIComponent(farmerId) + '/settlements');
  return (d.settlements || []).filter(s => s.open && s.status !== 'reversed');
}
function ryFlipHtml(e, amount) {
  const f = (state.rythuFarmers || []).find(x => x.id === e.customerId);
  const before = ryNet(f);
  if (before == null) return 'బ్యాలెన్స్ లోడ్ అవుతోంది… · loading balance…';
  const delta = e.event === 'delivery' ? Number(amount) || 0 : -(Number(amount) || 0);
  const after = Math.round((Number(before) + delta) * 100) / 100;
  return `<span class="bal-flip-row"><span>${esc(fmtINR(before))}</span><span class="bal-flip-arrow">→</span>
    <b class="${after < 0 ? 'paid' : 'owed'}">${esc(fmtINR(after))}</b></span>
    ${after < 0 ? `<small class="advance-note">${esc(ADVANCE_TE_EN)}</small>` : ''}`;
}
function renderRythuConfirm() {
  const p = pending, el = $('#panel');
  if (!p || p.kind !== 'ry-single' || !el) return;
  const e = p.entry;
  const done = p.preview != null;
  const total = ryAmount(e);
  // a cash row with several open settlements must be pointed at one first;
  // an overpayment needs the explicit "record as advance" confirmation
  const needSettle = e.event && e.event !== 'delivery' && p.settleHint === 'CHOOSE' && !e.settlement_id;
  p.ready = !!done && !ryMissing(e).length && !needSettle && !(p.overWarn && !p.allowAdvance);
  const miss = done ? ryMissing(e) : [];
  const f = (state.rythuFarmers || []).find(x => x.id === e.customerId);
  el.innerHTML = `
  <div class="card confirm">
    <div class="confirm-head">
      <span class="avatar av-0">${esc(initialsOf(e.name))}</span>
      <span class="confirm-names"><b>${esc(e.name || '?')}</b><small>${esc((f && f.village) || '')}</small></span>
      <span class="confirm-amt ${e.event === 'delivery' ? 'owed' : 'paid'}">${esc(fmtINR(e.event === 'delivery' ? (total || 0) : (e.amount || 0)))}</span>
    </div>
    <button id="ryEvent" class="chip-btn" type="button">${esc(ryEventTe(e.event) || '— తగదు (tap event)')}</button>
    <button id="ryPerson" class="link wide" type="button">👤 మార్చండి · Different farmer?</button>
    ${e.event === 'delivery' ? `
      <div class="confirm-amount-edit">
        <div class="ry-grid">
          <label class="field">పంట · ${esc(PROD_TE[e.produce] || '?')}</label>
          <input id="ryQty" class="input" type="number" inputmode="decimal" step="any" min="0" value="${esc(e.quantity != null ? e.quantity : '')}" placeholder="ఎన్ని?">
          <div class="chips-wrap" id="ryUnitChips">${RY_UNIT_UI.map(([te, en]) =>
            `<button class="chip-btn${e.unit === en ? ' on' : ''}" data-unit="${en}" type="button">${te}</button>`).join('')}</div>
          ${e.unit === 'bag' ? `<input id="ryBag" class="input" type="number" inputmode="decimal" step="any" min="0" value="${esc(e.bagKg != null ? e.bagKg : '')}" placeholder="బస్తా బరువు kg">` : ''}
          <input id="ryRate" class="input" type="number" inputmode="decimal" step="any" min="0" value="${esc(e.rate != null ? e.rate : '')}" placeholder="₹ ${esc(ryUnitTe(e.rateUnit || e.unit) || '')}కి రేటు">
        </div>
        <div class="bal-flip" id="ryTotal">${e.event === 'delivery' && total != null ? `మొత్తం · Total ₹${total.toLocaleString('en-IN')}` : 'మొత్తం లెక్క అవుతోంది…'}</div>
        <div class="bal-flip" id="ryFlip">${ryFlipHtml(e, total || 0)}</div>
      </div>`
    : e.event ? `
      <div class="confirm-amount-edit">
        <label class="field" for="ryAmt">మొత్తం · Amount (₹)</label>
        <input id="ryAmt" class="input" type="number" inputmode="numeric" step="1" min="1" value="${esc(e.amount != null ? Math.round(e.amount) : '')}">
        ${e.event === 'deduction' ? `<div class="chips-wrap" id="ryCatChips">${RY_CAT_UI.map(([te, en]) =>
          `<button class="chip-btn${e.category === en ? ' on' : ''}" data-cat="${en}" type="button">${te}</button>`).join('')}</div>` : ''}
        <div class="bal-flip" id="ryFlip">${ryFlipHtml(e, e.amount || 0)}</div>
        <div class="settle-note" id="rySettleNote"></div>
      </div>`
    : ''}
    ${p.overWarn ? `<div class="warn-note">జమ ఈ సెటిల్‌మెంట్ మిగిలిన మొత్తం కంటే ఎక్కువ — <button id="ryAdv" class="chip-btn${p.allowAdvance ? ' on' : ''}" type="button">మిగిలింది అడ్వాన్స్‌గా నమోదు · record excess as advance</button></div>` : ''}
    ${miss.length || needSettle ? `<div class="missing-note">అవసరం · needed: ${esc([...miss, ...(needSettle ? ['SETTLEMENT'] : [])].map(m => RY_MISS_TE[m] || m).join(', '))}</div>` : ''}
    <div class="confirm-actions">
      <button id="ryYes" class="btn primary" type="button"${p.ready ? '' : ' disabled'}>✅ అవును</button>
      <button id="ryNo" class="btn ghost" type="button">❌ కాదు</button>
    </div>
    <div id="voiceNote" class="tts-note" hidden>🔇 వాయిస్ అందుబాటులో లేదు — సేవ్ మాత్రం చేయవచ్చు · voice unavailable, saving still works</div>
  </div>`;
  // ---- wiring ----
  $('#ryNo').onclick = () => { clearFlow(); speak('సరే, మళ్లీ చెప్పండి.'); };
  $('#ryEvent').onclick = () => { const x = pending; if (x && x.kind === 'ry-single') { x.entry.event = null; x.entry.amount = null; rythuRecovery(x.entry); } };
  $('#ryPerson').onclick = () => {
    rySheetPick('ఏ రైతు?', 'Which farmer?', (state.rythuFarmers || [])
      .map(x => ({ id: x.id, name: x.name, sub: x.village || '' })),
      c => { e.customerId = c.id; renderRythuConfirm(); });
  };
  const yes = $('#ryYes');
  if (yes) yes.onclick = () => { if (pending && pending.ready) onRythuYes(); };
  // delivery fields
  const qty = $('#ryQty'), rate = $('#ryRate'), bag = $('#ryBag');
  if (qty) qty.addEventListener('input', () => { e.quantity = Number(qty.value) || null; rySync(); });
  if (rate) rate.addEventListener('input', () => { e.rate = Number(rate.value) || null; rySync(); });
  if (bag) bag.addEventListener('input', () => { e.bagKg = Number(bag.value) || null; rySync(); });
  el.querySelectorAll('[data-unit]').forEach(b => {
    b.onclick = () => { e.unit = b.dataset.unit; if (!e.rateUnit) e.rateUnit = e.unit; renderRythuConfirm(); };
  });
  el.querySelectorAll('[data-cat]').forEach(b => {
    b.onclick = () => { e.category = b.dataset.cat; renderRythuConfirm(); };
  });
  const amt = $('#ryAmt');
  if (amt) amt.addEventListener('input', () => { e.amount = Number(amt.value) || null; rySync(); });
  const adv = $('#ryAdv');
  if (adv) adv.onclick = () => { p.allowAdvance = !p.allowAdvance; renderRythuConfirm(); };
  // settlement pick (CHOOSE case)
  const note = $('#rySettleNote');
  if (note) {
    if (p.settleHint === 'CHOOSE') {
      note.innerHTML = `<p class="q-sub">ఒకటి కంటే ఎక్కువ సెటిల్‌మెంట్లు ఓపెన్ — ఎంచుకోండి:</p>
        <button id="ryPickSettle" class="btn" type="button">${e.settlement_id ? esc(rySettleLabelFrom(p.settleOpen, e.settlement_id)) : 'సెటిల్‌మెంట్ ఎంచుకోండి'}</button>`;
      $('#ryPickSettle').onclick = () => {
        const items = (p.settleOpen || []).map(s => ({
          id: s.settlement_id,
          name: `${PROD_TE[s.produce] || s.produce || '—'} ${s.quantity || ''} ${ryUnitTe(s.unit)}`,
          sub: `మిగిలింది ₹${fmtINR(s.remaining)}`,
        }));
        if (!items.length) { speak('ఓపెన్ సెటిల్‌మెంట్లు లేవు.'); return; }
        rySheetPick('ఏ సెటిల్‌మెంట్?', 'Which settlement?', items,
          s => { e.settlement_id = s.id; renderRythuConfirm(); });
      };
    } else if (e.settlement_id) {
      note.textContent = 'ఈ సెటిల్‌మెంట్‌కు అనుబంధించబడుతుంది · will link to the chosen settlement';
    } else if (p.settleHint && p.settleHint !== 'CHOOSE') {
      note.textContent = 'ఓపెన్ సెటిల్‌మెంట్ ఒక్కటే ఉంది — ఆటోమాటిక్‌గా అనుబంధిస్తాము · auto-links';
    } else {
      note.textContent = 'ఓపెన్ సెటిల్‌మెంట్ లేదు — అనుబంధం లేకుండా నమోదవుతుంది · unallocated';
    }
  }
  // the VOICE sentence is speech-friendly Telugu (numbers as words, no
  // symbols); the on-screen card keeps ₹/× symbols untouched
  speak(rySpeechText(e, e.event === 'delivery' ? total : e.amount));
}
function rySettleLabelFrom(list, id) {
  const s = (list || []).find(x => x.settlement_id === id);
  return s ? `${PROD_TE[s.produce] || s.produce || '—'} · మిగిలింది ₹${fmtINR(s.remaining)}` : 'సెటిల్‌మెంట్ ఎంచుకోండి';
}
// recompute the live bits without re-rendering the whole card
function rySync() {
  const p = pending;
  if (!p || p.kind !== 'ry-single') return;
  const e = p.entry, el = $('#panel');
  if (!el) return;
  const total = ryAmount(e) || 0;
  const big = $('.confirm-amt', el);
  if (big) big.textContent = fmtINR(e.event === 'delivery' ? total : (e.amount || 0));
  if (e.event === 'delivery') {
    const t = $('#ryTotal');
    if (t) t.textContent = total != null ? `మొత్తం · Total ₹${total.toLocaleString('en-IN')}` : 'మొత్తం లెక్క అవుతోంది…';
  }
  const flip = $('#ryFlip');
  if (flip) flip.innerHTML = ryFlipHtml(e, e.event === 'delivery' ? total : (e.amount || 0));
  const needSettle = e.event && e.event !== 'delivery' && p.settleHint === 'CHOOSE' && !e.settlement_id;
  p.ready = p.preview != null && !ryMissing(e).length && !needSettle && !(p.overWarn && !p.allowAdvance);
  const yes = $('#ryYes');
  if (yes) yes.disabled = !p.ready;
}
async function onRythuYes() {
  const p = pending;
  const el = $('#panel');
  if (!p || p.kind !== 'ry-single' || !el) return;
  el.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    await postRythu(p.entry, { idempotency_key: p.key || newKey() });
    pending = null;
    clearFlow();
    speak('నమోదు చేశాను. · saved');
    await refreshRythu().catch(() => {});
  } catch (e) {
    const code = (e.data && e.data.code) || '';
    if (e.status === 401) return goLogin();
    if (code === 'SETTLEMENT_REQUIRED') return ryChooseSettleThenRetry(p);
    if (code === 'OVERPAYMENT') return ryOverpayThenRetry(p);
    el.querySelectorAll('button').forEach(b => { b.disabled = false; });
    speak(e.message || 'సేవ్ కాలేదు, మళ్లీ ప్రయత్నించండి');
  }
}
// POST /api/transactions for one rythu entry; extra overriding fields allowed
async function postRythu(e, extra) {
  const body = { customer_id: e.customerId, workflow: 'rythu', idempotency_key: e.idempotency_key || newKey(), raw_transcript: e.raw || '', source: e.source || 'voice' };
  if (e.event === 'delivery') {
    Object.assign(body, {
      type: 'credit', event: 'produce_delivery', produce: e.produce,
      quantity: String(e.quantity), unit: e.unit, rate: String(e.rate),
      rate_unit: e.rateUnit || e.unit,
      bag_kg: Number(e.bagKg) > 0 ? String(e.bagKg) : undefined,
    });
  } else {
    Object.assign(body, {
      type: 'pay', event: e.event, amount: Math.round(Number(e.amount)),
      settlement_id: e.settlement_id || undefined,
      deduction_category: e.event === 'deduction' ? e.category : undefined,
    });
  }
  return api('/api/transactions', { method: 'POST', body: Object.assign(body, extra || {}) });
}
// 409 SETTLEMENT_REQUIRED → pick an open settlement, then retry the same POST
async function ryChooseSettleThenRetry(p) {
  let open = [];
  try { open = await ryOpenSettlements(p.entry.customerId); } catch (_) {}
  const items = open.map(s => ({
    id: s.settlement_id,
    name: `${PROD_TE[s.produce] || s.produce || '—'} ${s.quantity || ''} ${ryUnitTe(s.unit)}`,
    sub: `మిగిలింది ₹${fmtINR(s.remaining)}`,
  }));
  if (!items.length) { speak('ఓపెన్ సెటిల్‌మెంట్లు లేవు, మళ్లీ చెప్పండి.'); pending = null; clearFlow(); return; }
  rySheetPick('ఏ సెటిల్‌మెంట్?', 'One settlement has to be picked', items, s => {
    p.entry.settlement_id = s.id;
    p.settleHint = null;
    return postRythuRetry(p);
  });
}
// 409 OVERPAYMENT → explicit consent to record the excess as advance
function ryOverpayThenRetry(p) {
  const el = $('#panel');
  el.innerHTML = `
  <div class="card">
    <div class="q-title">జమ ఎక్కువ అయింది · Payment exceeds the remaining</div>
    <p class="q-sub">ఈ సెటిల్‌మెంట్‌లో అంత మొత్తం లేదు. మిగిలిన భాగాన్ని కొత్త అడ్వాన్స్‌గా నమోదు చేయాలా? · Record the excess as a new advance?</p>
    <div class="confirm-actions">
      <button id="ryAdvOk" class="btn primary" type="button">✅ అడ్వాన్స్‌గా నమోదు చేయండి</button>
      <button id="ryAdvNo" class="btn ghost" type="button">❌ వదులుకోండి</button>
    </div>
  </div>`;
  speak('జమ మిగిలిన మొత్తం కంటే ఎక్కువ. తక్కినది అడ్వాన్స్‌గా నమోదు చేయాలా?');
  $('#ryAdvOk').onclick = () => postRythuRetry(p, { allow_advance: true });
  $('#ryAdvNo').onclick = () => { pending = null; clearFlow(); speak('సరే.'); };
}
async function postRythuRetry(p, extra) {
  try {
    await postRythu(p.entry, Object.assign({ idempotency_key: p.key || newKey() }, extra || {}));
    pending = null;
    clearFlow();
    speak('నమోదు చేశాను. · saved');
    await refreshRythu().catch(() => {});
  } catch (e) {
    if (e.status === 401) return goLogin();
    speak(e.message || 'సేవ్ కాలేదు');
    pending = null;
    clearFlow();
  }
}

// ---------- rythu batch (multi-part sentence, sequential posts) ----------
function startRythuBatch(entries) {
  pending = {
    kind: 'ry-batch',
    entries: entries.map(e => {
      const r = ryResolve(e.name);
      const x = { ...e };
      if (r.status === 'one') x.customerId = r.candidates[0].id;
      return x;
    }),
  };
  renderRythuBatch();
  const line = entries.map(e => `${e.name || ''} ${e.event === 'delivery'
    ? `${e.quantity || ''} ${ryUnitTe(e.unit) || ''} ${PROD_TE[e.produce] || ''}`
    : `${e.amount != null ? e.amount + ' రూపాయలు' : ''} ${RY_EVENT_TAG[e.event] || '?'}`}`).join(', ');
  speak(line + '. సరిగ్గా ఉందా?');
}
function ryEntryLine(e) {
  return e.event === 'delivery'
    ? `${e.quantity != null ? e.quantity : '?'} ${ryUnitTe(e.unit) || '?'} ${PROD_TE[e.produce] || '?'} × ₹${e.rate != null ? e.rate : '?'}`
    : `${e.amount != null ? fmtINR(e.amount) : '₹?'} ${ryEventTe(e.event)}${e.event === 'deduction' && e.category ? ' (' + esc(RY_CAT_TE[e.category] || e.category) + ')' : ''}`;
}
function renderRythuBatch() {
  const p = pending, el = $('#panel');
  if (!el) return;
  if (!p || p.kind !== 'ry-batch') return;
  if (!p.entries.length) { clearFlow(); return speak('సరే, మళ్లీ చెప్పండి.'); }
  el.innerHTML = `
  <div class="card">
    <div class="q-title">${p.entries.length} నమోదులు · entries</div>
    <p class="q-sub">రైతు నమోదులు ఒక్కొక్కటిగా సేవ్ అవుతాయి; సరుకు ముందు నమోదైతె అడ్వాన్స్/తగ్గింపు/చెల్లింపు దానికే అనుబంధించబడతాయి</p>
    <ul class="entry-list">${p.entries.map((e, i) => `
      <li class="entry">
        <span class="idx">${i + 1}</span>
        <span class="entry-main"><b>${esc(e.name || '?')}</b><small>${esc(ryEntryLine(e))}</small>
          ${ryMissing(e).length ? `<small class="warn-note">⚠ ${esc(ryMissing(e).map(m => RY_MISS_TE[m] || m).join(', '))}</small>` : ''}</span>
        <button class="del" type="button" data-del="${i}" aria-label="తొలగించండి">🗑</button>
      </li>`).join('')}</ul>
    <div class="confirm-actions">
      <button id="ryYes" class="btn primary" type="button">✅ అవును</button>
      <button id="ryNo" class="btn ghost" type="button">❌ కాదు</button>
    </div>
  </div>`;
  el.querySelectorAll('[data-del]').forEach(b => { b.onclick = () => { p.entries.splice(Number(b.dataset.del), 1); renderRythuBatch(); }; });
  $('#ryNo').onclick = () => { pending = null; clearFlow(); speak('సరే, మళ్లీ చెప్పండి.'); };
  $('#ryYes').onclick = () => saveRythuBatch(0);
}
async function saveRythuBatch(i) {
  const p = pending;
  if (!p || p.kind !== 'ry-batch') return;
  const e = p.entries[i];
  if (!e) {
    pending = null;
    clearFlow();
    speak('నమోదు చేశాను. · saved');
    return refreshRythu().catch(() => {});
  }
  try {
    await postRythu(e, { idempotency_key: e.idempotency_key || newKey() });
    return saveRythuBatch(i + 1);
  } catch (err) {
    if (err.status === 401) return goLogin();
    const code = (err.data && err.data.code) || '';
    speak(err.message || 'సేవ్ కాలేదు');
    const el = $('#panel');
    el.innerHTML = `
    <div class="card">
      <div class="q-title">నమోదు ${i + 1} అడ్డుకున్నది</div>
      <p class="q-sub">${esc(err.message || 'సమస్య జరిగింది')}</p>
      <div class="confirm-actions" id="ryBatchFix"></div>
    </div>`;
    const box = $('#ryBatchFix');
    const skip = () => saveRythuBatch(i + 1);
    if (code === 'SETTLEMENT_REQUIRED') {
      const b = document.createElement('button');
      b.className = 'btn primary'; b.type = 'button'; b.textContent = 'సెటిల్‌మెంట్ ఎంచుకోండి';
      b.onclick = async () => {
        let open = [];
        try { open = await ryOpenSettlements(p.entries[i].customerId); } catch (_) {}
        const items = open.map(s => ({
          id: s.settlement_id,
          name: `${PROD_TE[s.produce] || s.produce || '—'} ${s.quantity || ''} ${ryUnitTe(s.unit)}`,
          sub: `మిగిలింది ₹${fmtINR(s.remaining)}`,
        }));
        if (!items.length) { speak('ఓపెన్ సెటిల్‌మెంట్లు లేవు.'); return; }
        rySheetPick('ఏ సెటిల్‌మెంట్?', 'One settlement has to be picked', items, s => {
          p.entries[i].settlement_id = s.id;
          postRythu(p.entries[i], { idempotency_key: p.entries[i].idempotency_key || newKey() })
            .then(() => saveRythuBatch(i + 1)).catch(err2 => speak(err2.message || 'సేవ్ కాలేదు'));
        });
      };
      box.appendChild(b);
    }
    if (code === 'OVERPAYMENT') {
      const b = document.createElement('button');
      b.className = 'btn primary'; b.type = 'button'; b.textContent = 'అడ్వాన్స్‌గా నమోదు';
      b.onclick = () => postRythu(pending.entries[i], { idempotency_key: pending.entries[i].idempotency_key || newKey(), allow_advance: true }).then(() => saveRythuBatch(i + 1)).catch(() => {});
      box.appendChild(b);
    }
    if (code === 'KIND_MISMATCH') {
      const n = document.createElement('button');
      n.className = 'btn primary'; n.type = 'button'; n.textContent = 'కొత్త రైతుగా బదిలీ · move to a farmer';
      n.onclick = () => askRythuNewFarmer(pending.entries[i]);
      box.appendChild(n);
    }
    const c = document.createElement('button');
    c.className = 'btn ghost'; c.type = 'button'; c.textContent = '⏭ వదిలేయి · skip';
    c.onclick = skip;
    box.appendChild(c);
  }
}

// ================= #/rythu/farmer/:id — settlements detail =================
async function viewRythuFarmer(id) {
  const shop = await ensureShop();
  if (!shop) return;
  let d;
  try { d = await api('/api/rythu/farmers/' + encodeURIComponent(id) + '/settlements'); }
  catch (e) {
    if (e.status === 401) return goLogin();
    if (e.status === 404 || (e.data && e.data.error)) { location.hash = '#/home'; return; }
    throw e;
  }
  const f = d.customer || { name: '—' };
  state.rythuFarmerId = id;
  appEl().innerHTML = `
  <header class="topbar">
    <button id="back" class="back" type="button" aria-label="వెనుకకు">‹</button>
    <span class="shop-name">${esc(f.name)}</span>
    <button id="logout" class="logout" type="button">లాగ్ అవుట్</button>
  </header>
  <main class="screen">
    <div class="card detail-head">
      <span class="avatar big av-0">${esc(initialsOf(f.name))}</span>
      <div class="detail-id"><b>${esc(f.name)}</b><small>${esc(f.village || '')}</small></div>
      <div class="detail-bal">
        <small>${Number(d.balance) > 0 ? 'మేము చెల్లించాల్సినది · we owe' : 'అడ్వాన్స్ · advance'}</small>
        <b class="bal ${Number(d.balance) > 0 ? 'owed' : ''}">${esc(fmtINR(Math.abs(Number(d.balance) || 0)))}</b>
        ${Number(d.balance) < 0 ? `<small class="advance-note">${esc(ADVANCE_TE_EN)}</small>` : ''}
      </div>
    </div>
    <div class="chips-wrap" id="ryActions">
      <button class="chip-btn" type="button" data-act="delivery">🌾 సరుకు అందింది</button>
      <button class="chip-btn" type="button" data-act="advance">💸 అడ్వాన్స్</button>
      <button class="chip-btn" type="button" data-act="deduction">✂️ తగ్గింపు</button>
      <button class="chip-btn" type="button" data-act="payment">💵 చెల్లింపు</button>
    </div>
    <div id="ryForm" class="card" hidden></div>
    <h2 class="section">సెటిల్‌మెంట్లు · Settlements</h2>
    ${ACK_FOOTNOTE}
    <div id="rySettleList">${skelRows(2)}</div>
    ${(d.unallocated || []).length ? `<h2 class="section">అనుబంధం లేని నమోదులు · Unallocated</h2>
    <div id="ryUnalloc"></div>` : ''}
    <div id="ryerr" class="err" hidden></div>
  </main>
  ${tabbar('#/home')}`;
  wireTopbar();
  $('#back').onclick = () => { state.mode = 'rythu'; location.hash = '#/home'; };
  renderRythuSettlements(d);
  // quick actions: 48px chips opening ONE shared form
  const forms = {
    delivery(e) {
      e.hidden = false;
      e.innerHTML = `
      <div class="q-title">సరుకు అందింది · Produce delivery</div>
      <div class="chips-wrap" id="qfProd">${PROD_UI.map(([te, en]) => `<button class="chip-btn" data-v="${en}" type="button">${te}</button>`).join('')}</div>
      <label class="field" for="qfQty">ఎన్ని · Quantity</label>
      <input id="qfQty" class="input" type="number" inputmode="decimal" step="any" min="0">
      <div class="chips-wrap" id="qfUnit">${RY_UNIT_UI.map(([te, en]) => `<button class="chip-btn" data-v="${en}" type="button">${te}</button>`).join('')}</div>
      <div id="qfBagWrap" hidden><label class="field" for="qfBag">బస్తా బరువు kg · bag weight</label>
        <input id="qfBag" class="input" type="number" inputmode="decimal" step="any" min="0"></div>
      <label class="field" for="qfRate">రేటు · Rate (₹ per unit)</label>
      <input id="qfRate" class="input" type="number" inputmode="decimal" step="any" min="0">
      <div id="qfErr" class="err" hidden></div>
      <button id="qfSave" class="btn primary big" type="button">నమోదు · Save</button>`;
      let prod = null, unit = null;
      e.querySelector('#qfProd').addEventListener('click', ev => {
        const b = ev.target.closest('[data-v]'); if (!b) return;
        e.querySelectorAll('#qfProd .chip-btn').forEach(x => x.classList.toggle('on', x === b));
        prod = b.dataset.v;
      });
      e.querySelector('#qfUnit').addEventListener('click', ev => {
        const b = ev.target.closest('[data-v]'); if (!b) return;
        e.querySelectorAll('#qfUnit .chip-btn').forEach(x => x.classList.toggle('on', x === b));
        unit = b.dataset.v;
        e.querySelector('#qfBagWrap').hidden = unit !== 'bag';
      });
      ryQfSave(e, () => {
        if (!prod) return 'పంట ఎంచుకోండి';
        if (!(Number(e.querySelector('#qfQty').value) > 0)) return 'ఎన్ని? అంత వేయండి';
        if (!unit) return 'కొలత ఎంచుకోండి';
        if (unit === 'bag' && !(Number(e.querySelector('#qfBag').value) > 0)) return 'బస్తా బరువు వేయండి';
        if (!(Number(e.querySelector('#qfRate').value) > 0)) return 'రేటు వేయండి';
        return {
          customer_id: id, workflow: 'rythu', type: 'credit', event: 'produce_delivery',
          produce: prod, quantity: e.querySelector('#qfQty').value, unit,
          bag_kg: unit === 'bag' ? e.querySelector('#qfBag').value : undefined,
          rate: e.querySelector('#qfRate').value, rate_unit: unit,
          raw_transcript: 'produce delivery (screen)', idempotency_key: newKey(), source: 'screen',
        };
      });
    },
    async cash(event, cat) {
      const open = await ryOpenSettlements(id);
      e.hidden = false;
      e.innerHTML = `
      <div class="q-title">${esc(ryEventTe(event))}</div>
      <label class="field" for="qfAmt">మొత్తం · Amount (₹)</label>
      <input id="qfAmt" class="input" type="number" inputmode="numeric" step="1" min="1">
      ${event === 'deduction' ? `<p class="q-sub">తగ్గింపు రకం · Category</p>
        <div class="chips-wrap" id="qfCat">${RY_CAT_UI.map(([te, en]) =>
        `<button class="chip-btn${en === cat ? ' on' : ''}" data-v="${en}" type="button">${te}</button>`).join('')}</div>` : ''}
      ${open.length > 1 ? `<label class="field" for="qfSettle">సెటిల్‌మెంట్ · Settlement</label>
        <select id="qfSettle" class="input">${open.map(s =>
        `<option value="${esc(s.settlement_id)}">${esc(PROD_TE[s.produce] || s.produce || '—')} · మిగిలింది ₹${esc(fmtINR(s.remaining))}</option>`).join('')}</select>` : ''}
      <div id="qfErr" class="err" hidden></div>
      <button id="qfSave" class="btn primary big" type="button">నమోదు · Save</button>`;
      if (event === 'deduction') {
        e.querySelector('#qfCat').addEventListener('click', ev => {
          const b = ev.target.closest('[data-v]'); if (!b) return;
          cat = b.dataset.v;
          e.querySelectorAll('#qfCat .chip-btn').forEach(x => x.classList.toggle('on', x === b));
        });
        if (!cat) cat = null;
      }
      ryQfSave(e, () => {
        if (event === 'deduction' && !cat) throw 'తగ్గింపు రకం ఎంచుకోండి';
        if (!(Number(e.querySelector('#qfAmt').value) > 0)) throw 'మొత్తం 0 కంటే ఎక్కువ వేయండి';
        const body = {
          customer_id: id, workflow: 'rythu', type: 'pay', event,
          amount: Number(e.querySelector('#qfAmt').value),
          raw_transcript: `${event} (screen)`, idempotency_key: newKey(), source: 'screen',
        };
        if (event === 'deduction') body.deduction_category = cat;
        return body;
      }, () => (open.length > 1 ? e.querySelector('#qfSettle').value : undefined));
    },
  };
  // screens-level overpayment recover: one retry with allow_advance after consent
  function ryQfSave(e, bodyFn, settleFn) {
    const btn = e.querySelector('#qfSave');
    btn.onclick = async () => {
      const errEl = e.querySelector('#qfErr');
      hideErr(errEl);
      let body;
      try { body = bodyFn(); } catch (msg) { return showErr(errEl, String(msg)); }
      if (!body) return showErr(errEl, 'వివరాలు సరిలేవు');
      const settleId = settleFn && settleFn();
      if (settleId) body.settlement_id = settleId;
      btn.disabled = true;
      try {
        await api('/api/transactions', { method: 'POST', body });
        speak('నమోదు చేశాను. · saved');
        e.hidden = true;
        await viewRythuFarmer(id);
      } catch (err) {
        btn.disabled = false;
        if (err.status === 401) return goLogin();
        if ((err.data && err.data.code) === 'OVERPAYMENT') {
          showErr(errEl, err.message + ' — మిగిలింది అడ్వాన్స్‌గా నమోదు చేయాలంటే మళ్లీ నొక్కండి');
          btn.onclick = async () => {
            btn.disabled = true;
            try {
              await api('/api/transactions', { method: 'POST', body: { ...body, allow_advance: true } });
              speak('అడ్వాన్స్‌గా నమోదు చేశాను.');
              e.hidden = true;
              await viewRythuFarmer(id);
            } catch (e2) { btn.disabled = false; if (e2.status === 401) return goLogin(); showErr(errEl, e2.message); }
          };
          return;
        }
        showErr(errEl, err.message);
      }
    };
  }
  $('#ryActions').querySelectorAll('[data-act]').forEach(b => {
    b.onclick = async () => {
      const e = $('#ryForm');
      if (b.dataset.act === 'delivery') return forms.delivery(e);
      if (b.dataset.act === 'deduction') return forms.cash('deduction', 'hamali');
      return forms.cash(b.dataset.act, null);
    };
  });
  function renderRythuSettlements(dd) {
    const box = $('#rySettleList'); if (!box) return;
    if (!(dd.settlements || []).length) {
      box.innerHTML = emptyState('🌾', 'ఇంకా సరుకు నమోదులు లేవు', 'No deliveries yet');
    } else {
      box.innerHTML = dd.settlements.map(s => rySettleCard(s)).join('');
      box.querySelectorAll('[data-rev-tx]').forEach(b => { b.onclick = () => ryReverseCard(b.dataset.revTx, () => viewRythuFarmer(id)); });
      // acknowledgement actions on the delivery rows themselves
      wireAckActions(box,
        ackTx => {
          const s = (dd.settlements || []).find(x => x.settlement_id === ackTx);
          if (s) sendAckForEntry({
            id: s.settlement_id, amount: s.gross, event: 'produce_delivery',
            produce: s.produce, quantity: s.quantity, unit: s.unit,
          }, dd.customer, () => { try { viewRythuFarmer(id); } catch (_) {} }, $('#ryerr'));
        },
        () => { try { viewRythuFarmer(id); } catch (_) {} });
    }
    const ub = $('#ryUnalloc');
    if (ub && (dd.unallocated || []).length) {
      ub.innerHTML = (dd.unallocated || []).map(u => `
      <div class="ry-line">
        <span class="ry-line-main"><b>${esc(RY_EVENT_TAG[u.event] || u.event)} ${esc(u.deduction_category ? '· ' + (RY_CAT_TE[u.deduction_category] || u.deduction_category) : '')}</b>
          <small>${esc(timeOf(u.created_at))}</small></span>
        <b class="ry-amt">${esc(fmtINR(u.amount))}</b>
        <button class="btn small" type="button" data-alloc="${esc(u.id)}">సెటిల్‌మెంట్‌లో చేర్చండి</button>
      </div>`).join('');
      const openSettle = (dd.settlements || []).filter(s => s.open && s.status !== 'reversed');
      ub.querySelectorAll('[data-alloc]').forEach(b => {
        b.onclick = () => {
          if (!openSettle.length) { speak('ఓపెన్ సెటిల్‌మెంట్లు లేవు.'); return; }
          rySheetPick('ఏ సెటిల్‌మెంట్?', 'Apply to which settlement?',
            openSettle.map(s => ({ id: s.settlement_id, name: `${PROD_TE[s.produce] || s.produce || '—'} ${s.quantity || ''} ${ryUnitTe(s.unit)}`, sub: `మిగిలింది ₹${fmtINR(s.remaining)}` })),
            async s => {
              try {
                await api('/api/transactions/' + b.dataset.alloc + '/allocate', { method: 'POST', body: { settlement_id: s.id } });
                speak('అనుసంధానించాను.');
                await viewRythuFarmer(id);
              } catch (err) { if (err.status === 401) return goLogin(); showErr($('#ryerr'), err.message); }
            });
        };
      });
    }
  }
}
function rySettleCard(s) {
  const reversed = s.status === 'reversed';
  const badge = reversed
    ? '<span class="badge settled">రద్దు · Reversed</span>'
    : s.open ? '<span class="badge open">ఓపెన్ · Open</span>' : '<span class="badge settled">ఇచ్చేసింది · Settled</span>';
  const rows = [];
  const push = (list, evLabel, catMap) => {
    for (const r of (list || [])) {
      rows.push(`<div class="ry-line">
        <span class="ry-line-main"><b>${esc(evLabel)}${r.deduction_category ? ' · ' + esc(RY_CAT_TE[r.deduction_category] || r.deduction_category) : ''}</b>
          <small>${esc(timeOf(r.created_at))}</small></span>
        <b class="ry-amt">${esc(fmtINR(r.amount))}</b>
        <button class="rev" type="button" data-rev-tx="${esc(r.id)}" aria-label="రద్దు చేయండి">⟲</button>
      </div>`);
    }
  };
  push(s.advances, 'అడ్వాన్స్');
  push(s.deductions, 'తగ్గింపు');
  push(s.payments, 'చెల్లింపు');
  // the delivery row itself carries the acknowledgement chip + send action
  const ackChip = ackChipHtml(s.ack_status, s.settlement_id);
  const ackSend = !reversed
    ? `<button class="rev ack-send" type="button" data-ack-tx="${esc(s.settlement_id)}" aria-label="ధృవీకరణకు పంపు · Send for acknowledgement">📨</button>`
    : '';
  return `
  <div class="settle-card">
    <div class="sc-head">
      <b>${esc(PROD_TE[s.produce] || s.produce || '—')}</b>
      <span class="sc-qty">${esc(String(s.quantity != null ? s.quantity : '?'))} ${esc(ryUnitTe(s.unit))} × ₹${esc(String(s.rate != null ? s.rate : '?'))}</span>
      ${badge}
      <span class="ack-chips">${ackChip}</span>
      ${ackSend}
      <button class="rev" type="button" data-rev-tx="${esc(s.settlement_id)}" aria-label="రద్దు చేయండి">⟲</button>
    </div>
    ${rows.length ? `<div class="sc-rows">${rows.join('')}</div>` : '<div class="sc-rows muted-small">ఈ సెటిల్‌మెంట్‌కు అనుబంధ నమోదులు లేవు</div>'}
    <div class="sc-tot">
      <span>మొత్తం ₹${esc(fmtINR(s.gross))}</span>
      <span>అడ్వాన్స్ ₹${esc(fmtINR(s.advance_total || 0))}</span>
      <span>తగ్గింపు ₹${esc(fmtINR(s.deduction_total || 0))}</span>
      <span>చెల్లింపు ₹${esc(fmtINR(s.payment_total || 0))}</span>
      <span class="sc-rem">మిగిలింది <b>${esc(fmtINR(s.remaining))}</b></span>
    </div>
  </div>`;
}
// shared reverse card (rythu farmer screen)
function ryReverseCard(txId, onDone) {
  let rc = $('#revCard');
  if (rc) rc.remove();
  rc = document.createElement('div');
  rc.id = 'revCard';
  rc.className = 'card rev-card';
  rc.innerHTML = `
    <div class="q-title">నమోదును రద్దు చేయండి · Reverse this entry</div>
    <label class="field" for="revReason">కారణం · Reason</label>
    <input id="revReason" class="input" maxlength="200" placeholder="తప్పు మొత్తం · wrong amount">
    <div class="confirm-actions">
      <button id="revOk" class="btn primary" type="button">⟲ రద్దు చేయండి</button>
      <button id="revNo" class="btn ghost" type="button">❌ వదులుకోండి</button>
    </div>
    <div id="revErr" class="err" hidden></div>`;
  const list = $('#rySettleList');
  if (list) list.after(rc);
  else appEl().appendChild(rc);
  $('#revReason').focus();
  $('#revNo').onclick = () => rc.remove();
  $('#revOk').onclick = async () => {
    const reason = $('#revReason').value.trim();
    if (!reason) return showErr($('#revErr'), 'రద్దు కారణం తప్పనిసరి · reason required');
    const btn = $('#revOk');
    btn.disabled = true;
    try {
      await api('/api/transactions/' + txId + '/reverse', { method: 'POST', body: { reason } });
      rc.remove();
      speak('రద్దు చేశాను. · reversed');
      await onDone();
    } catch (e) {
      if (e.status === 401) return goLogin();
      showErr($('#revErr'), e.message);
      btn.disabled = false;
    }
  };
}

// ================= Sprint 3: acknowledgement UI (shared helpers) =================
const ACK_FOOTNOTE = '<p class="ack-foot">📨 link ద్వారా ధృవీకరణ · not legal proof</p>';
// shared entry-summary fragment for the WhatsApp share text
function ackEntrySummary(e) {
  if (e.event === 'produce_delivery') {
    const q = e.quantity != null ? `${e.quantity} ${ryUnitTe(e.unit) || (e.unit || '')}` : '';
    return `${q} ${PROD_TE[(e.produce || '').toLowerCase()] || (e.produce || '')}`.trim().replace(/\s+/g, ' ');
  }
  return 'ఉద్దెర';
}
// POSTs the link request (revokes an older link, mints a fresh one) and then
// opens the share sheet: large QR, copyable link, WhatsApp share
async function sendAckForEntry(entry, person, onDone, errEl) {
  try {
    const link = await api('/api/transactions/' + encodeURIComponent(entry.id) + '/ack-link', { method: 'POST' });
    showAckSheet(link, entry, person);
    if (onDone) onDone();
  } catch (e) {
    if (e.status === 401) return goLogin();
    showErr(errEl || $('#sheetErr') || appEl().querySelector('.err'), e.message || 'లింక్ సాధ్యం కాలేదు');
  }
}
function showAckSheet(link, entry, person) {
  const shopName = (state.shop && state.shop.shop_name) || 'ఖాతా వాణి';
  const money = `₹${fmtINR(entry.amount)}`;
  const msg = `${shopName}: ${money} ${ackEntrySummary(entry)}. దయచేసి ఈ లింక్ లో ధృవీకరించండి: ${link.url}`;
  let digits = String((person && person.phone) || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) digits = '91' + digits;
  const waUrl = 'https://wa.me/' + (digits.length >= 10 ? digits : '') + '?text=' + encodeURIComponent(msg);
  const sh = showSheet(`
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <div><h3>ధృవీకరణకు పంపండి</h3><small>Send for acknowledgement · one response per link, 14-day expiry</small></div>
      <button id="sheetClose" class="sheet-x" type="button" aria-label="మూసివేయండి">✕</button>
    </div>
    <div class="qr-wrap">${link.qrSvg}</div>
    <div class="ack-link-line"><span class="ack-url" id="ackUrlTxt">${esc(link.url)}</span></div>
    <div class="confirm-actions">
      <button id="ackCopy" class="btn" type="button">📋 కాపీ · Copy</button>
      <button id="ackWa" class="btn primary" type="button">🟢 WhatsApp లో పంపండి</button>
    </div>
    <p class="ack-foot">link ద్వారా ధృవీకరణ · not legal proof</p>`);
  sh.querySelector('#sheetClose').onclick = closeChooser;
  sh.querySelector('#ackCopy').onclick = async () => {
    const txt = link.url;
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; } catch (_) {}
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt; ta.id = 'ackCopyTa';
        document.body.appendChild(ta);
        ta.select(); ok = document.execCommand('copy'); ta.remove();
      } catch (_) { ok = false; }
    }
    say(ok ? 'లింక్ కాపీ అయింది · link copied' : 'కాపీ కాలేదు · copy failed');
  };
  sh.querySelector('#ackWa').onclick = () => { window.open(waUrl, '_blank', 'noopener'); };
}
// the shop's resolve card for a disputed entry: shows the customer's note and
// moves the row to 'resolved'
async function openResolveCard(txnId, listEl, onDone) {
  let inf = null;
  try { inf = await api('/api/transactions/' + encodeURIComponent(txnId) + '/ack'); }
  catch (e) { if (e.status === 401) return goLogin(); return showErr($('#revErr') || $('#derr') || $('#ryerr'), e.message); }
  const note = inf && inf.acknowledgement && inf.acknowledgement.dispute_note || '';
  const card = document.createElement('div');
  card.id = 'revCard';
  card.className = 'card rev-card';
  card.innerHTML = `
    <div class="q-title">వివాదాన్ని పరిష్కరించండి · Resolve dispute</div>
    ${note ? `<p class="disp-note">⚠️ కస్టమర్ నమోదించిన వివాదం: ${esc(note)}</p>` : '<p class="q-sub">కారణం నమోదు కాలేదు · no note was submitted</p>'}
    <div class="confirm-actions">
      <button id="resOk" class="btn primary" type="button">✅ పరిష్కరించినట్టు · Resolve</button>
      <button id="resNo" class="btn ghost" type="button">❌ వదులుకోండి · Cancel</button>
    </div>
    <div id="revErr" class="err" hidden></div>`;
  if (listEl && listEl.after) listEl.after(card);
  else appEl().appendChild(card);
  $('#resNo').onclick = () => card.remove();
  $('#resOk').onclick = async () => {
    const btn = $('#resOk');
    btn.disabled = true;
    try {
      await api('/api/transactions/' + encodeURIComponent(txnId) + '/ack-resolve', { method: 'POST', body: { note: 'పరిష్కరించబడింది · resolved' } });
      card.remove();
      speak('పరిష్కరించాను. · resolved');
      if (onDone) await onDone();
    } catch (e) {
      if (e.status === 401) return goLogin();
      showErr($('#revErr'), e.message);
      btn.disabled = false;
    }
  };
}
// status chips (Telugu first, colour classes in styles.css); disputed chips
// carry the transaction id so tapping them opens the resolve card
function ackChipHtml(ackStatus, txnId) {
  const s = ackStatus || 'not_required';
  if (s === 'awaiting') return '<span class="ack-chip awaiting">వేచి ఉంది · Awaiting</span>';
  if (s === 'acknowledged') return '<span class="ack-chip ok">ధృవీకరించబడింది · Acknowledged via link</span>';
  if (s === 'disputed') return `<span class="ack-chip disputed" data-ack-resolve data-resolve-tx="${esc(txnId)}">వివాదం · Disputed</span>`;
  if (s === 'resolved') return '<span class="ack-chip ok">పరిష్కరించబడింది · Resolved</span>';
  if (s === 'cancelled') return '<span class="ack-chip cancelled">రద్దు · Cancelled</span>';
  return '';
}
const ACKABLE_EVENT = t => t.type === 'credit' &&
  (t.event === 'goods_credit' || t.event === 'produce_delivery');
// wires [data-ack-tx] (send link) and [data-ack-resolve] (resolve card) chips —
// both carry their transaction id in data-resolve-tx style attributes-free data attrs
function wireAckActions(el, onSend, onResolved) {
  el.querySelectorAll('[data-ack-tx]').forEach(b => {
    b.onclick = e => {
      e.stopPropagation();
      onSend(b.dataset.ackTx, b);
    };
  });
  el.querySelectorAll('[data-ack-resolve]').forEach(ch => {
    ch.onclick = e => {
      e.stopPropagation();
      const id = ch.dataset.resolveTx;
      if (id) openResolveCard(id, ch, onResolved);
    };
  });
}

// ================= #/dashboard — minimal numbers, no charts =================
async function viewDashboard() {
  const shop = await ensureShop();
  if (!shop) return;
  appEl().innerHTML = `
  ${topbar()}
  <main class="screen">
    <h1 class="screen-title">డాష్‌బోర్డ్ <small>Dashboard</small></h1>
    <div class="dash-grid">
      <div class="card dash-card"><span class="stat-te">కిరాణాలో తీసుకోవాల్సినవి</span><span class="stat-en">Kirana receivable</span><b class="stat-val owed" id="dshKirana">…</b></div>
      <div class="card dash-card"><span class="stat-te">రైతులకు చెల్లించాల్సినది</span><span class="stat-en">Rythu payable</span><b class="stat-val paid" id="dshRythuPay">…</b></div>
      <div class="card dash-card"><span class="stat-te">అడ్వాన్స్ వసూలు</span><span class="stat-en">Advances to recover</span><b class="stat-val owed" id="dshRythuAdv">…</b></div>
      <div class="card dash-card"><span class="stat-te">ఈ రోజు నమోదులు</span><span class="stat-en">Today's entries</span><b class="stat-val" id="dshToday">…</b></div>
    </div>
    <div class="card dash-card" id="dshAcks"><span class="stat-te">ధృవీకరణలు</span><span class="stat-en">Acknowledgements</span><div class="dash-ack-row" id="dshAckRow">…</div></div>
    <div class="card dash-card"><span class="stat-te">ఎక్కువ బాకీ — మొదటి 5</span><span class="stat-en">Top 5 balances</span><div id="dshTop">${skelRows(2)}</div></div>
    <div id="dsherr" class="err" hidden></div>
  </main>
  ${tabbar('#/dashboard')}`;
  wireTopbar();
  try {
    const [cust, today, ry, ac] = await Promise.all([
      api('/api/customers'),
      api('/api/transactions?date=' + istToday()),
      api('/api/rythu/summary').catch(() => null),
      api('/api/acknowledgements/summary').catch(() => null),
    ]);
    const kirana = (cust || []).filter(c => (c.kind || 'customer') !== 'farmer');
    let receive = 0;
    for (const c of kirana) if (c.balance > 0) receive += Number(c.balance) || 0;
    $('#dshKirana').textContent = fmtINR(receive);
    $('#dshRythuPay').textContent = fmtINR((ry && ry.payable_total) || 0);
    $('#dshRythuAdv').textContent = fmtINR((ry && ry.advance_to_recover) || 0);
    $('#dshToday').textContent = String(((today && today.transactions) || []).length);
    const acs = ac || { awaiting: 0, acknowledged: 0, disputed: 0 };
    $('#dshAckRow').innerHTML = `
      <span class="ack-chip awaiting">వేచి ${acs.awaiting}</span>
      <span class="ack-chip ok">ధృవీకరించి ${acs.acknowledged}</span>
      <span class="ack-chip disputed">వివాదం ${acs.disputed}</span>`;
    const top = (cust || []).filter(c => c.balance > 0)
      .sort((a, b) => b.balance - a.balance).slice(0, 5);
    $('#dshTop').innerHTML = top.length
      ? top.map((c, i) => `<div class="tx-row"><span class="dash-rank">${i + 1}</span>
        <span class="tx-main"><b>${esc(c.name)}</b></span>
        <b class="tx-amt owed">${esc(fmtINR(c.balance))}</b></div>`).join('')
      : emptyState('📊', 'ఎవరికీ బాకీ లేదు · nobody owes anything', '');
  } catch (e) {
    if (e.status === 401) return goLogin();
    showErr($('#dsherr'), e.message);
  }
}
