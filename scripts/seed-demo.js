'use strict';
// Demo shop only. Idempotent: a second `npm run seed` reuses the same rows
// (stable idempotency keys). `npm run seed:clean` deletes that phone only.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const ledger = require('../lib/ledger');

const PHONE = '9000000001';
const PIN = '1234';
const CLEAN = process.argv.indexOf('--clean') !== -1;

const E = process.env;
const SB_URL = E.SUPABASE_URL || '';
const SB_KEY = E.SUPABASE_SERVICE_KEY || E.SUPABASE_SECRET_KEY || '';
if (!SB_URL || !SB_KEY) {
  console.error('seed: need SUPABASE_URL + SUPABASE_SERVICE_KEY');
  process.exit(2);
}

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
ledger.setClient(sb);

const ago = days => new Date(Date.now() - days * 86400000).toISOString();

function fail(e) {
  const code = (e && (e.code || e.name)) || 'ERROR';
  const pg = e && e.cause && e.cause.code ? ' pg=' + String(e.cause.code).slice(0, 12) : '';
  console.error('seed failed ' + code + pg);
  process.exit(1);
}

async function shopRow() {
  const r = await sb.from('shops').select('id').eq('phone', PHONE).limit(1);
  if (r.error) throw r.error;
  return (r.data && r.data[0]) || null;
}

async function wipe(id) {
  for (const t of ['acknowledgements', 'audit_events', 'transactions', 'customers']) {
    const r = await sb.from(t).delete().eq('shop_id', id);
    if (r.error) throw r.error;
  }
  const s = await sb.from('shops').delete().eq('id', id);
  if (s.error) throw s.error;
}

async function ensureShop() {
  const existing = await shopRow();
  if (existing) {
    const u = await sb.from('shops').update({
      owner_name: 'Demo Owner', shop_name: 'Demo Kirana', address: 'Demo Street',
    }).eq('id', existing.id);
    if (u.error) throw u.error;
    return existing.id;
  }
  const pin_hash = await bcrypt.hash(PIN, 10);
  const ins = await sb.from('shops').insert({
    phone: PHONE, pin_hash, owner_name: 'Demo Owner', shop_name: 'Demo Kirana',
    address: 'Demo Street', failed_pin: 0, created_at: new Date().toISOString(),
  }).select('id').single();
  if (ins.error) throw ins.error;
  return ins.data.id;
}

async function ensureCustomer(shopId, c) {
  let q = sb.from('customers').select('id').eq('shop_id', shopId).eq('kind', c.kind).eq('name', c.name);
  q = c.label ? q.eq('label', c.label) : q.is('label', null);
  const found = await q.limit(1);
  if (found.error) throw found.error;
  if (found.data && found.data[0]) return found.data[0].id;
  const ins = await sb.from('customers').insert({
    shop_id: shopId, name: c.name, label: c.label || null, phone: null,
    kind: c.kind, village: c.village || null, aliases: [], created_at: ago(c.days || 0),
  }).select('id').single();
  if (ins.error) throw ins.error;
  return ins.data.id;
}

async function post(shopId, row) {
  const out = await ledger.postTransactions(shopId, [row]);
  return out[0];
}

async function stampTx(shopId, key, days) {
  const r = await sb.from('transactions').update({ created_at: ago(days) })
    .eq('shop_id', shopId).eq('idempotency_key', key);
  if (r.error) throw r.error;
}

async function stampCustomer(id, days) {
  const r = await sb.from('customers').update({ created_at: ago(days) }).eq('id', id);
  if (r.error) throw r.error;
}

(async () => {
  try {
    if (CLEAN) {
      const row = await shopRow();
      if (row) await wipe(row.id);
      console.log('seed:clean done phone=' + PHONE);
      return;
    }
    const shopId = await ensureShop();

    const kirana = [
      { name: 'రమేష్', label: 'టైలర్', kind: 'customer', days: 45 },
      { name: 'రమేష్', label: 'పాలవాడు', kind: 'customer', days: 2 },
      { name: 'అనిల్', kind: 'customer', days: 1 },
      { name: 'కవిత', kind: 'customer', days: 1 },
      { name: 'రవి', kind: 'customer', days: 1 },
      { name: 'సునీత', kind: 'customer', days: 35 },
      { name: 'మోహన్', kind: 'customer', days: 1 },
      { name: 'ప్రియ', kind: 'customer', days: 1 },
    ];
    const ids = {};
    for (const c of kirana) ids[c.label ? c.name + '|' + c.label : c.name] = await ensureCustomer(shopId, c);
    const farmers = [
      { name: 'సురేష్', kind: 'farmer', village: 'డెమోపల్లి', days: 20 },
      { name: 'లక్ష్మి', kind: 'farmer', village: 'ఊరు-ఎ', days: 20 },
      { name: 'వెంకట్', kind: 'farmer', village: 'ఊరు-బి', days: 20 },
    ];
    for (const c of farmers) ids['f|' + c.name] = await ensureCustomer(shopId, c);
    for (const c of kirana.concat(farmers)) {
      if (c.days > 30) await stampCustomer(ids[c.label ? c.name + '|' + c.label : (c.kind === 'farmer' ? 'f|' + c.name : c.name)], c.days);
    }

    const K = (key, who, type, amount, days, event) => ({
      key, who, type, amount, days, event,
      workflow: 'kirana', direction: 'receivable',
    });
    const kiranaRows = [
      K('seed-k-01', 'రమేష్|టైలర్', 'credit', 500, 45, 'goods_credit'),
      K('seed-k-02', 'రమేష్|టైలర్', 'credit', 250, 40, 'goods_credit'),
      K('seed-k-03', 'సునీత', 'credit', 700, 35, 'goods_credit'),
      K('seed-k-04', 'రమేష్|పాలవాడు', 'credit', 1200, 18, 'goods_credit'),
      K('seed-k-05', 'రమేష్|పాలవాడు', 'credit', 400, 10, 'goods_credit'),
      K('seed-k-06', 'రమేష్|పాలవాడు', 'pay', 500, 3, 'repayment'),
      K('seed-k-07', 'అనిల్', 'credit', 300, 16, 'goods_credit'),
      K('seed-k-08', 'అనిల్', 'credit', 200, 12, 'goods_credit'),
      K('seed-k-09', 'అనిల్', 'pay', 150, 8, 'repayment'),
      K('seed-k-10', 'అనిల్', 'credit', 100, 2, 'goods_credit'),
      K('seed-k-11', 'కవిత', 'credit', 800, 19, 'goods_credit'),
      K('seed-k-12', 'కవిత', 'pay', 800, 14, 'repayment'),
      K('seed-k-13', 'కవిత', 'credit', 60, 1, 'goods_credit'),
      K('seed-k-14', 'రవి', 'credit', 450, 17, 'goods_credit'),
      K('seed-k-15', 'రవి', 'credit', 220, 11, 'goods_credit'),
      K('seed-k-16', 'రవి', 'pay', 200, 6, 'repayment'),
      K('seed-k-17', 'రవి', 'credit', 90, 4, 'goods_credit'),
      K('seed-k-18', 'మోహన్', 'credit', 550, 15, 'goods_credit'),
      K('seed-k-19', 'మోహన్', 'pay', 200, 9, 'repayment'),
      K('seed-k-20', 'మోహన్', 'credit', 130, 5, 'goods_credit'),
      K('seed-k-21', 'ప్రియ', 'credit', 180, 20, 'goods_credit'),
      K('seed-k-22', 'ప్రియ', 'credit', 90, 13, 'goods_credit'),
      K('seed-k-23', 'ప్రియ', 'pay', 70, 7, 'repayment'),
      K('seed-k-24', 'ప్రియ', 'credit', 110, 3, 'goods_credit'),
      K('seed-k-25', 'ప్రియ', 'pay', 40, 1, 'repayment'),
    ];
    for (const row of kiranaRows) {
      await post(shopId, {
        customer_id: ids[row.who], type: row.type, amount: row.amount,
        workflow: row.workflow, direction: row.direction, event: row.event,
        idempotency_key: row.key, source: 'screen',
      });
      await stampTx(shopId, row.key, row.days);
    }

    const ry = async (key, body, days) => {
      const posted = await post(shopId, Object.assign({ idempotency_key: key, source: 'screen' }, body));
      await stampTx(shopId, key, days);
      return posted;
    };
    const suresh = ids['f|సురేష్'];
    const lakshmi = ids['f|లక్ష్మి'];
    const venkat = ids['f|వెంకట్'];
    const del = (customer_id, produce, quantity, rate) => ({
      customer_id, type: 'credit', workflow: 'rythu', direction: 'payable',
      event: 'produce_delivery', produce, quantity, unit: 'kg', rate, rate_unit: 'kg',
    });
    const a = await ry('seed-ry-01', del(suresh, 'Tomato', 100, 20), 12);
    await ry('seed-ry-02', {
      customer_id: suresh, type: 'pay', amount: 400, workflow: 'rythu', direction: 'payable',
      event: 'advance', settlement_id: a.id,
    }, 10);
    await ry('seed-ry-03', del(suresh, 'Onion', 40, 30), 6);
    const b = await ry('seed-ry-04', del(lakshmi, 'Chilli', 20, 80), 14);
    await ry('seed-ry-05', {
      customer_id: lakshmi, type: 'pay', amount: 100, workflow: 'rythu', direction: 'payable',
      event: 'deduction', deduction_category: 'hamali', settlement_id: b.id,
    }, 13);
    await ry('seed-ry-06', {
      customer_id: lakshmi, type: 'pay', amount: 500, workflow: 'rythu', direction: 'payable',
      event: 'payment', settlement_id: b.id,
    }, 8);
    const c = await ry('seed-ry-07', del(venkat, 'Tomato', 15, 40), 9);
    await ry('seed-ry-08', {
      customer_id: venkat, type: 'pay', amount: 600, workflow: 'rythu', direction: 'payable',
      event: 'payment', settlement_id: c.id,
    }, 4);

    console.log('seed ok phone=' + PHONE + ' PIN=' + PIN);
  } catch (e) { fail(e); }
})();
