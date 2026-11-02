require('dotenv').config();
const express = require('express');
const app = express();
const B = 'https://api.vachana.ai', K = process.env.GNANI_API_KEY;
const E = process.env;
app.use(express.static('public'));

app.post('/api/stt', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: 'empty or invalid audio body' });
  console.log('STT audio bytes:', req.body.length, 'head:', req.body.slice(0, 4).toString('ascii'));
  try {
    const f = new FormData();
    f.append('audio_file', new Blob([req.body], { type: 'audio/wav' }), 'a.wav');
    f.append('model', 'prisma-v3.0');
    f.append('format', 'transcribe');
    f.append('language_code', E.STT_LANG || 'indic-auto');
    const r = await fetch(B + '/stt/v3', { method: 'POST', headers: { 'X-API-Key-ID': K }, body: f });
    const x = await r.text(); console.log('STT', r.status, x.slice(0, 300));
    let tr = ''; try { tr = JSON.parse(x).transcript || ''; } catch (_) {}
    console.log('STT transcript raw:', JSON.stringify(tr));
    res.status(r.status).type('json').send(x);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/tts', express.json(), async (req, res) => {
  try {
    const r = await fetch(B + '/api/v1/tts/inference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': K },
      body: JSON.stringify({
        text: req.body.text, voice: E.TTS_VOICE || 'Nalini', model: E.TTS_MODEL || 'timbre-v2.5',
        language: E.TTS_LANG || 'te-IN', speed: 1.0,
        audio_config: { sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'wav' }
      })
    });
    console.log('TTS', r.status); if (!r.ok) { const x = await r.text(); console.log(x.slice(0, 300)); return res.status(r.status).send(x); }
    res.type('audio/wav').send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

console.log('API key loaded:', K ? K.length + ' chars' : 'MISSING', K === 'your_key_here' ? '(STILL THE PLACEHOLDER!)' : '');
app.listen(E.PORT || 3000, () => console.log('Khata Vani on http://localhost:' + (E.PORT || 3000)));
