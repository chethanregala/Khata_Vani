/* ack.js — the customer's acknowledgement page logic.
   Self-contained, CSP-safe: no inline handlers, all wiring via addEventListener.
   Fetches carry credentials:'omit' — this page is for the link holder, it must
   never leak or depend on the shopkeeper's session cookie. */
'use strict';

(function () {
  var $ = function (s) { return document.querySelector(s); };

  // the token is the last path segment of /a/<token>
  var token = decodeURIComponent(String(location.pathname).split('/').pop() || '');

  var PROD_TE = {
    paddy: 'వరి', cotton: 'పత్తి', chilli: 'మిరప', maize: 'మొక్కజొన్న',
    bengal_gram: 'శనగ', red_gram: 'కంది', green_gram: 'పెసర',
    black_gram: 'మినుము', groundnut: 'వేరుశనగ', turmeric: 'పసుపు',
    sesame: 'నువ్వులు', jowar: 'జొన్న',
  };
  var UNIT_TE = { quintal: 'క్వింటా', kg: 'కిలో', tonne: 'టన్ను', bag: 'బస్తా' };
  var KIND_TE = {
    goods_credit: 'దుకాణంలో తీసుకున్న ఉద్దెర · Credit taken',
    produce_delivery: 'సరుకు అందించారు · Produce delivered',
  };
  var STATE_TE = {
    acknowledged: '✅ ధృవీకరించబడింది · Acknowledged',
    disputed: '⚠️ వివాదం నమోదైంది · Disputed',
    resolved: '✅ పరిష్కరించబడింది · Resolved',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function show(el, on) { if (el) el.hidden = !on; }
  function setText(el, v) { if (el) el.textContent = String(v == null ? '' : v); }
  function showErr(msg) { var el = $('#ackErr'); setText(el, msg); show(el, true); }
  function hideErr() { var el = $('#ackErr'); setText(el, ''); show(el, false); }
  function fmtINR(n) {
    return '₹' + new Intl.NumberFormat('en-IN').format(Math.round(Number(n) || 0));
  }

  function renderView(v) {
    hideErr();
    var shop = $('#ackShop'), kind = $('#ackKind'), amount = $('#ackAmount'),
      item = $('#ackItem'), date = $('#ackDate'), note = $('#ackNote'),
      state = $('#ackState'), actions = $('#ackActions'), listen = $('#ackListen');
    setText(shop, v.shop_name || '');
    show(shop, !!v.shop_name);
    setText(kind, KIND_TE[v.entry_kind] || '');
    show(kind, !!v.entry_kind);
    setText(amount, v.amount != null ? fmtINR(v.amount) : '');
    var itemText = '';
    if (v.item) {
      if (v.item.note) itemText = 'వివరం · ' + esc(v.item.note);
      else if (v.entry_kind === 'produce_delivery') {
        var p = PROD_TE[(v.item.produce || '').toLowerCase()] || v.item.produce || '';
        var u = UNIT_TE[v.item.unit] || v.item.unit || '';
        itemText = ''.concat(
          v.item.quantity != null ? v.item.quantity + ' ' + u : '',
          p ? ' ' + p : '',
          v.item.rate != null ? ' × ₹' + v.item.rate : ''
        ).trim();
      }
    }
    item.innerHTML = itemText;   // only esc()-ed content / own markup
    show(item, !!itemText);
    setText(date, v.entry_date || '');
    show(date, !!v.entry_date);
    setText(note, v.dispute_note ? '⚠️ మీ వివాదం: ' + esc(v.dispute_note) : '');
    show(note, !!v.dispute_note);

    if (v.status === 'awaiting') {
      setText(state, '');
      show(state, false);
      show(actions, true);
      show(listen, !!v.audio);
      return;
    }
    show(actions, false);
    show(listen, false);
    if (v.status === 'expired') {
      setText(state, '⏳ గడువు ముగిసింది · This link has expired');
      show(state, true);
    } else if (v.status === 'cancelled') {
      setText(state, '🚫 రద్దు చేయబడింది · This link was cancelled');
      show(state, true);
    } else if (STATE_TE[v.status]) {
      setText(state, STATE_TE[v.status]);
      show(state, true);
      setText($('#ackSent'), 'ఇప్పటికే సమాధానం నమోదైంది — మరోసారి సమాధానం ఇవ్వలేరు · already answered — one response only');
      show($('#ackSent'), true);
    } else {
      setText(state, 'లింక్ అందుబాటులో లేదు · Link not available');
      show(state, true);
    }
  }

  function genericNotFound() {
    renderView({ status: 'not_found' });
  }

  // one read path for boot AND after a successful response
  function load() {
    return fetch('/api/public/ack/' + encodeURIComponent(token), { credentials: 'omit' })
      .then(function (r) {
        return r.text().then(function (txt) {
          var v = null;
          try { v = JSON.parse(txt); } catch (e) { v = null; }
          if (r.status === 404) {
            // expired links earn their own wording; unknown/revoked stay generic
            renderView(v && v.status === 'expired' ? v : { status: 'not_found' });
            return true;
          }
          if (!v || !v.status) return genericNotFound(), true;
          renderView(v);
          return true;
        });
      })
      .catch(function () { genericNotFound(); });
  }

  function playAudio() {
    var btn = $('#ackListen');
    if (btn) btn.disabled = true;
    fetch('/a/' + encodeURIComponent(token) + '/audio', { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('no audio'); return r.blob(); })
      .then(function (b) { return new Audio(URL.createObjectURL(b)).play(); })
      .catch(function () { showErr('ఆడియో వినడం సాధ్యం కాలేదు · could not play audio'); })
      .finally(function () { if (btn) btn.disabled = false; });
  }

  function sendResponse(action, note) {
    var btn = action === 'acknowledge' ? $('#ackYes') : $('#dSend');
    if (btn) btn.disabled = true;
    hideErr();
    return fetch('/api/public/ack/' + encodeURIComponent(token), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, note: note }),
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) {}
        if (r.status === 404) { genericNotFound(); return null; }
        if (!r.ok) {
          showErr((data && data.error) || 'సెర్వర్ సమస్య · server problem');
          if (btn) btn.disabled = false;
          return null;
        }
        load(); // re-render — the page now shows the recorded state, no buttons
        return data;
      });
    }).catch(function () {
      showErr('ఇంటర్నెట్ సమస్య, మళ్లీ ప్రయత్నించండి');
      if (btn) btn.disabled = false;
    });
  }

  // ---- wiring (no inline handlers, CSP-safe) ----
  var yes = $('#ackYes');
  if (yes) yes.addEventListener('click', function () { sendResponse('acknowledge', ''); });
  var no = $('#ackNo');
  if (no) no.addEventListener('click', function () {
    show($('#ackActions'), false);
    show($('#disputeForm'), true);
    var ta = $('#dNote');
    if (ta) ta.focus();
  });
  var back = $('#dBack');
  if (back) back.addEventListener('click', function () {
    show($('#disputeForm'), false);
    show($('#ackActions'), true);
  });
  var send = $('#dSend');
  if (send) send.addEventListener('click', function () {
    var note = $('#dNote').value.trim().slice(0, 200);
    sendResponse('dispute', note);
  });
  var listen = $('#ackListen');
  if (listen) listen.addEventListener('click', playAudio);

  load();
})();
