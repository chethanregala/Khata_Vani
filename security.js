// security.js — reusable security middleware & helpers for Khata Vani.
// Plain CommonJS, zero new dependencies. Never logs or returns secret values.
'use strict';
const { randomUUID } = require('crypto');

// ---------- request correlation (log id + response header, no sensitive data) ----------
function requestId(req, res, next) {
  req.id = randomUUID().replace(/-/g, '').slice(0, 12);
  res.locals.reqId = req.id;
  res.set('X-Request-Id', req.id);
  next();
}

// ---------- HTTP security headers ----------
// CSP is strict because the frontend has NO inline scripts, NO inline style
// attributes, NO event-handler attributes and NO external images: index.html
// loads 4 same-origin scripts + styles.css, and the font CSS comes from Google
// Fonts. Audio: challenge WAV is same-origin, TTS playback uses blob: URLs.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders({ production = false } = {}) {
  return function securityHeadersMw(req, res, next) {
    res.set('Content-Security-Policy', CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('Permissions-Policy',
      'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=()');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    // HSTS only in production HTTPS deployments (never on plain-HTTP dev).
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

// ---------- acknowledgement-token redaction for logs ----------
// Ack link tokens are bearer secrets (anyone holding one can answer for the
// customer). Any log line that would carry the full /a/<token> path or the
// public /api/public/ack/<token> path prints the token as <redacted> instead —
// the token itself is never logged, echoed or persisted.
const TOKENISH_RE = /^[A-Za-z0-9_-]{43}$/;
const PATH_TOKEN_RE1 = /(^|[^\w])\/a\/([A-Za-z0-9_-]{43})(?=[/?#]|$)/;
const PATH_TOKEN_RE2 = /(^|[^\w])\/api\/public\/ack\/([A-Za-z0-9_-]{43})(?=[/?#]|$)/;
function redactAckToken(s) {
  return String(s == null ? '' : s)
    .replace(PATH_TOKEN_RE1, '$1/a/<redacted>')
    .replace(PATH_TOKEN_RE2, '$1/api/public/ack/<redacted>');
}
function isAckTokenShape(s) { return TOKENISH_RE.test(String(s || '')); }

// ---------- keep-alive token redaction for logs ----------
// GET /keepalive?k=<token> carries its cron secret in the query string, so any
// log line that might echo the URL (access logs, error dumps) must print the
// k value as <redacted>. Same shape of guarantee as redactAckToken above.
function redactKeepaliveToken(s) {
  return String(s == null ? '' : s).replace(/([?&])k=[^&#]*/g, '$1k=<redacted>');
}

// ---------- same-origin / CSRF guard for browser mutations ----------
// Signed httpOnly cookies + SameSite=Lax already block classic cross-site form
// POSTs; this adds an explicit Origin check (covers same-site attackers, older
// patterns, and makes the guarantee testable).
const ORIGIN_MSG = 'అనుమతించని మూలం నుండి అభ్యర్థన · cross-origin denied';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sameOrigin({ allowedOrigins = [] } = {}) {
  const extra = (allowedOrigins || []).filter(Boolean);
  return function sameOriginMw(req, res, next) {
    if (!MUTATING.has(req.method)) return next();
    const origin = req.get('Origin');
    if (origin) {
      let u = null;
      try { u = new URL(origin); } catch (_) { u = null; }
      // scheme-agnostic host match: works behind TLS-terminating proxies where
      // the browser origin is https but the app sees http
      const hostOk = !!u && (u.protocol === 'http:' || u.protocol === 'https:') &&
        u.host === String(req.get('Host') || '');
      if (!hostOk && extra.indexOf(origin) === -1) {
        return res.status(403).json({ error: ORIGIN_MSG });
      }
      return next();
    }
    // No Origin: modern browsers always send it on mutations, so this is a
    // non-browser client (curl / server-to-server) or a legacy browser.
    // Handle it explicitly: reject only when Fetch metadata says cross-site.
    const site = req.get('Sec-Fetch-Site');
    if (site === 'cross-site') return res.status(403).json({ error: ORIGIN_MSG });
    return next();
  };
}

// ---------- request-body size guard (checked before the handler runs) ----------
const TOO_LARGE_MSG = 'అభ్యర్థన చాలా పెద్దది · request too large';
function contentLength(maxBytes, message) {
  return function contentLengthMw(req, res, next) {
    const raw = req.get('Content-Length');
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n > maxBytes) {
      return res.status(413).json({ error: message || TOO_LARGE_MSG });
    }
    next();
  };
}

// ---------- last-resort error responder (JSON only, no stack traces) ----------
// Maps body-parser failures to proper status codes and logs only a
// non-sensitive error category + request id — never message bodies, PII or
// upstream payloads.
function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return function securityErrorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const rid = (res.locals && res.locals.reqId) || '-';
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      console.error('[error] id=' + rid + ' body-too-large');
      return res.status(413).json({ error: TOO_LARGE_MSG });
    }
    if (err && (err.type === 'entity.parse.failed' ||
      (err instanceof SyntaxError && err.status === 400))) {
      console.error('[error] id=' + rid + ' bad-json');
      return res.status(400).json({ error: 'సరైన JSON కాదు · invalid JSON body' });
    }
    if (err && err.type === 'request.aborted') {
      console.error('[error] id=' + rid + ' request-aborted');
      return res.status(400).json({ error: 'అభ్యర్థన ఆగిపోయింది · request aborted' });
    }
    console.error('[error] id=' + rid + ' ' + ((err && (err.code || err.name)) || 'ERROR'));
    return res.status(500).json({ error: 'సర్వర్ సమస్య, మళ్లీ ప్రయత్నించండి', id: rid });
  };
}

// ---------- production JWT-secret validation ----------
// Weak/placeholder secrets are fatal only in production; development keeps
// working (warn only) so local work is never blocked. The secret value itself
// is never echoed in any message.
const PLACEHOLDER_RE =
  /^(change[_-]?me|change-this|your[_-]|placeholder|example|insecure|secret$|password$|jwt[_-]?secret$)/i;

function validateJwtSecret(secret, { production = false } = {}) {
  const fatal = message => ({ level: 'fatal', message });
  const warn = message => ({ level: 'warn', message });
  const ok = { level: 'ok', message: '' };
  if (!secret || typeof secret !== 'string' || !secret.trim()) {
    return fatal('JWT_SECRET is missing in .env — .env లో JWT_SECRET కావాలి');
  }
  const s = secret.trim();
  const uniqueChars = new Set(s).size;
  const weak = s.length < 32 || PLACEHOLDER_RE.test(s) || uniqueChars < 12 || /^(.)\1*$/.test(s);
  if (!production) {
    return weak
      ? warn('JWT_SECRET is weak or a placeholder — production will refuse to start (dev is allowed)')
      : ok;
  }
  if (weak) {
    return fatal('JWT_SECRET is not strong enough for production — ' +
      'need >=32 chars, >=12 distinct chars, and no placeholder value');
  }
  return ok;
}

module.exports = {
  requestId,
  securityHeaders,
  sameOrigin,
  contentLength,
  errorHandler,
  validateJwtSecret,
  redactAckToken,
  isAckTokenShape,
  redactKeepaliveToken,
  CSP, // exported for tests
};
