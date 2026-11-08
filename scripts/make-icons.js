// make-icons.js — one-shot generator for the PNA icons from public/icon.svg.
// Run: node scripts/make-icons.js   (needs: npm i --no-save sharp)
// Writes: public/icon-192.png, public/icon-512.png, public/favicon.ico
// (favicon.ico is a 48x48 PNG inside a minimal ICO wrapper — every modern
// browser renders PNG-compressed ICO entries; /favicon.ico stops 404ing).
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const pub = path.join(__dirname, '..', 'public');
const svg = path.join(pub, 'icon.svg');

(async () => {
  await sharp(svg, { density: 384 }).resize(512, 512).png()
    .toFile(path.join(pub, 'icon-512.png'));
  await sharp(svg, { density: 192 }).resize(192, 192).png()
    .toFile(path.join(pub, 'icon-192.png'));
  const png = await sharp(svg, { density: 96 }).resize(48, 48).png().toBuffer();
  // minimal ICO wrapper around the PNG
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  const e = Buffer.alloc(16);
  e[0] = 48; e[1] = 48; e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8); e.writeUInt32LE(22, 12);
  fs.writeFileSync(path.join(pub, 'favicon.ico'), Buffer.concat([head, e, png]));
  console.log('icons written: icon-192.png icon-512.png favicon.ico');
})().catch(e => { console.error('icon generation failed:', e.message); process.exit(1); });
