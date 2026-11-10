// test-audio.js — BUG 4 audio-manager dedupe: hermetic, no DOM.
// The pure rule lives in public/app.js (ttsDedupeHit); this test extracts and
// exercises it so the "same text twice in 3s stays silent" behaviour is pinned.
'use strict';
const fs = require('fs');
const src = fs.readFileSync('public/app.js', 'utf8');
const m = src.match(/function ttsDedupeHit\(st, text, now, ms\) \{[\s\S]*?\n\}/);
let checks = 0;
const ok = (label, cond) => { checks++; if (!cond) { console.error('FAIL ' + label); process.exitCode = 1; } };

ok('ttsDedupeHit exists in app.js', !!m);
if (m) {
  const fn = new Function('return ' + m[0])();
  ok('same text inside the window is a dedupe hit',
    fn({ text: 'x', at: 1000 }, 'x', 3900, 3000) === true);
  ok('same text after the window plays again',
    fn({ text: 'x', at: 1000 }, 'x', 4500, 3000) === false);
  ok('different text is never a hit',
    fn({ text: 'x', at: 1000 }, 'y', 2000, 3000) === false);
  ok('falsy/null state never hits', fn(null, 'x', 1000, 3000) === false);
  ok('empty text collapses to one instance',
    fn({ text: '', at: 1000 }, '', 2000, 3000) === true);
  ok('boundary: at exactly ms it is NOT a hit',
    fn({ text: 'x', at: 1000 }, 'x', 4000, 3000) === false);
}

// the app must route ALL playback through the manager: no second Audio holder,
// no raw a.play() outside playAudioEl, no browser speechSynthesis calls
const code = src.replace(/\/\/[^\n]*/g, '');
ok('previous single-holder variable removed', !/let\s+ttsAudio/.test(code));
ok('no browser speechSynthesis usage', !/speechSynthesis/.test(code));
ok('every Audio playback goes through playAudioEl',
  /playChallenge[\s\S]{0,400}playAudioEl\(a\)/.test(src) && /async function speak[\s\S]{0,700}playAudioEl\(a\)/.test(src));

console.log('[audio] ' + checks + ' checks passed');
