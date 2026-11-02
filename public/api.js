// Fetch wrapper: JSON + session cookies (credentials: 'include').
// Throws an Error with .status and Telugu .message on failure.
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'include' };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try { res = await fetch(path, init); }
  catch (_) { throw new Error('ఇంటర్నెట్ సమస్య, మళ్లీ ప్రయత్నించండి'); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి');
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
  try { res = await fetch(path, init); }
  catch (_) { throw new Error('ఇంటర్నెట్ సమస్య, మళ్లీ ప్రయత్నించండి'); }
  if (!res.ok) {
    let msg = 'TTS సమస్య, మళ్లీ ప్రయత్నించండి';
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}
