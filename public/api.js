// Fetch wrapper: JSON + session cookies (credentials: 'include').
// Throws an Error with .status and Telugu .message on failure.
// Cold-start UX: free-tier servers sleep, so a request that takes >4s shows a
// non-blocking "waking up" banner; GETs retry ONCE automatically; every request
// times out at 30s with a clear message. CSP-safe: no inline handlers.
const OFFLINE_MSG = 'ఇంటర్నెట్ లేదు — కనెక్షన్ తనిఖీ చేయండి · you are offline, check your connection';
const SLOW_DOWN_MSG = 'చాలా వేగంగా ప్రయత్నిస్తున్నారు — కాసేపు ఆగి మళ్లీ చేయండి · please slow down and retry in a bit';
const WAKING_TEXT = 'సర్వర్ మేల్కొంటోంది… · Server waking up, please wait';
const TIMEOUT_MSG = 'సమయం ముగిసిందు — సర్వర్ మేల్కొనడానికి ఎక్కువ సమయం పట్టింది. కొద్ది క్షణాల తర్వాత మళ్లీ ప్రయత్నించండి · request timed out (server took too long); please try again shortly';
const REQ_TIMEOUT_MS = 30000;   // hard cap on every request
const WAKE_BANNER_MS = 4000;    // how long we wait before assuming a cold start

// non-blocking banner (created once, CSP-safe, no inline styles)
let wakeTimer = null;
function showWakeBanner() {
  let bar = document.getElementById('wake-banner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'wake-banner';
    bar.className = 'wake-banner';
    bar.setAttribute('role', 'status');
    bar.textContent = WAKING_TEXT;
    document.body.appendChild(bar);
  }
  bar.hidden = false;
}
function hideWakeBanner() {
  if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
  const bar = document.getElementById('wake-banner');
  if (bar) bar.hidden = true;
}

// fetch with an abortable timeout; on timeout the banner is hidden and a
// clear Telugu error is raised (a retried GET re-arms it)
async function timedFetch(path, init, slowMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(showWakeBanner, slowMs);
  try {
    return await fetch(path, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'include' };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  let res = null;
  try {
    res = await timedFetch(path, init, WAKE_BANNER_MS);
    // GETs retry once automatically (cold servers often answer the second time)
    if (res && !res.ok && res.status >= 502 && res.status <= 504 &&
        (opts.method || 'GET') === 'GET' && !opts.__retried) {
      res = await timedFetch(path, { ...init }, WAKE_BANNER_MS);
    }
  } catch (e) {
    hideWakeBanner();
    if (e && e.name === 'AbortError') throw new Error(TIMEOUT_MSG);
    throw new Error((typeof navigator !== 'undefined' && navigator.onLine === false)
      ? OFFLINE_MSG : 'ఇంటర్నెట్ సమస్య, మళ్లీ ప్రయత్నించండి');
  }
  hideWakeBanner();
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.__kvSessionExpired = true; // login screen explains the redirect
    }
    const err = new Error((data && data.error) ||
      (res.status === 429 ? SLOW_DOWN_MSG : 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి'));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// POST binary/JSON and expect an audio blob back (used for TTS playback).
async function apiAudio(path, opts = {}) {
  const init = { method: opts.method || 'POST', credentials: 'include' };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try { res = await timedFetch(path, init, WAKE_BANNER_MS); }
  catch (e) {
    hideWakeBanner();
    if (e && e.name === 'AbortError') throw new Error(TIMEOUT_MSG);
    throw new Error((typeof navigator !== 'undefined' && navigator.onLine === false)
      ? OFFLINE_MSG : 'ఇంటర్నెట్ సమస్య, మళ్లీ ప్రయత్నించండి');
  }
  hideWakeBanner();
  if (!res.ok) {
    let msg = 'TTS సమస్య, మళ్లీ ప్రయత్నించండి';
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}
