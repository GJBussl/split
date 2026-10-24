/* Split – phone app. Plain JavaScript, no build step. Depends on core.js. */
(function () {
  'use strict';
  var C = window.SplitCore;
  var VERSION = '4.1.0';            // keep in step with ?v= in index.html and VERSION in sw.js (tools/release.js does all three)
  var API_VERSION = 2;                 // must match API_VERSION in Code.gs
  var DEFAULT_PEOPLE = ['George', 'Julia'];
  var DEMO = window.SPLIT_DEMO || null;

  // ---------- Storage (never throws; falls back to memory) ----------
  var mem = {};
  function load(k, d) {
    try { var v = localStorage.getItem('split.' + k); if (v !== null) return JSON.parse(v); } catch (e) { /* ignore */ }
    return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : d;
  }
  function store(k, v) { mem[k] = v; try { localStorage.setItem('split.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function drop(k) { delete mem[k]; try { localStorage.removeItem('split.' + k); } catch (e) { /* ignore */ } }

  var state = {
    creds: DEMO ? { u: 'demo', k: 'demo' } : load('creds', null),
    me: DEMO ? DEMO.me : load('me', null),
    snap: load('snap', null),
    queue: load('queue', []),
    rejected: load('rejected', []),
    lastSync: load('lastSync', null),
    syncing: false, syncAgain: false, syncError: null, authError: false, apiMismatch: null,
    screen: 'home', installPrompt: null, list: null, lastFocus: null
  };

  // ---------- Helpers ----------
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var money = C.formatMoney;
  function people() { return (state.snap && state.snap.people) || DEFAULT_PEOPLE; }
  function otherOf(p) { var ps = people(); return p === ps[0] ? ps[1] : ps[0]; }
  function forMe(effect) { return state.me === people()[0] ? effect : -effect; }
  function you(p, cap) { return p === state.me ? (cap ? 'You' : 'you') : p; }
  function categories() { return (state.snap && state.snap.categories) || []; }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function view() { return C.applyQueue(state.snap || { balance: 0, recent: [] }, state.queue, people()); }
  function localISO(d) { return C.todayISO(d); }
  function fmtDate(iso) {
    if (!iso) return '';
    var today = C.todayISO();
    var y = new Date(); y.setDate(y.getDate() - 1);
    if (iso === today) return 'Today';
    if (iso === C.todayISO(y)) return 'Yesterday';
    var p = iso.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var opts = { day: 'numeric', month: 'short' };
    if (+p[0] !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-GB', opts);
  }
  function fmtStamp(isoTime) { return isoTime ? fmtDate(localISO(new Date(isoTime))) : ''; }
  function setupLinkFromCreds() {
    return location.origin + location.pathname + '#u=' + encodeURIComponent(state.creds.u) + '&k=' + state.creds.k +
      (state.me ? '&me=' + encodeURIComponent(state.me) : '');
  }
  /** Short description of the other person's part of an entry, e.g. "Julia's share 249,50 kr" / "Your share 320 kr". */
  function impactWords(it) {
    var eff = forMe(it.effect), other = otherOf(state.me), mine = it.paidBy === state.me;
    var cls = eff > 0 ? 'pos' : eff < 0 ? 'neg' : '';
    if (it.type === 'settle') return { text: 'Payment', cls: '' };
    if (it.type === 'full' || it.type === 'received') return { text: eff > 0 ? other + ' owes all' : 'You owe all', cls: cls };
    if (!eff) return { text: 'No share', cls: '' };
    return { text: (mine ? other + '\'s share ' : 'Your share ') + money(Math.abs(eff)), cls: cls };
  }

  // ---------- Server ----------
  function api(action, payload) {
    var p = DEMO ? window.SplitDemoServer.handle(action, payload || {}) : realApi(action, payload);
    return p.then(function (data) {
      state.apiMismatch = data.apiVersion === API_VERSION ? null : (data.apiVersion || 1);
      return data;
    });
  }
  function realApi(action, payload) {
    var body = { key: state.creds.k, action: action };
    for (var k in payload) body[k] = payload[k];
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 60000);   // longer than the server's 10 s lock wait + a cold start
    return fetch(state.creds.u, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // "simple" request: no CORS preflight
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('Server error ' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      var e = new Error('offline'); e.offline = true; e.cause = err; throw e;
    }).then(function (data) {
      if (!data.ok) {
        var e = new Error(data.error || 'Unknown error');
        if (data.error === 'unauthorized') e.auth = true;
        throw e;
      }
      return data;
    });
  }

  function acceptSnapshot(data) {
    state.snap = {
      people: data.people, currency: data.currency, categories: data.categories,
      balance: data.balance, recent: data.recent, count: data.count, sheetUrl: data.sheetUrl || '', build: data.build || ''
    };
    store('snap', state.snap);
    state.lastSync = new Date().toISOString();
    store('lastSync', state.lastSync);
  }

  /** Pick up queue changes made in another tab/app window on this phone (they share storage). */
  function mergeStoredQueue() {
    var stored = load('queue', []), have = {}, finished = {};
    load('finishedOps', []).forEach(function (id) { finished[id] = true; });
    state.queue.forEach(function (o) { have[o.opId] = o; });
    var merged = stored.filter(function (o) { return !finished[o.opId]; }).map(function (o) { return have[o.opId] || o; });
    var inMerged = {};
    merged.forEach(function (o) { inMerged[o.opId] = true; });
    state.queue.forEach(function (o) { if (!inMerged[o.opId] && !finished[o.opId]) merged.push(o); });
    state.queue = merged;
  }
  /** Ops that are done (synced, rejected or undone) – kept briefly so another window can't send them again. */
  function markFinished(ids) {
    if (!ids.length) return;
    store('finishedOps', load('finishedOps', []).concat(ids).slice(-300));
  }
  function saveQueue() { store('queue', state.queue); }

  function sync() {
    if (!state.creds) return Promise.resolve();
    if (state.syncing) { state.syncAgain = true; return Promise.resolve(); }
    if (navigator.onLine === false && !DEMO) { state.syncError = 'offline'; renderStatus(); return Promise.resolve(); }
    state.syncing = true;
    mergeStoredQueue();
    renderStatus();
    var sent = state.queue.slice();
    sent.forEach(function (o) { o.sent = true; });     // may reach the server even if the reply is lost
    if (sent.length) saveQueue();
    var req = sent.length ? api('sync', { ops: sent }) : api('bootstrap', {});
    return req.then(function (data) {
      state.syncError = null; state.authError = false;
      if (data.results) {
        var done = {}, newlyRejected = 0;
        data.results.forEach(function (r) {
          var op = sent.filter(function (o) { return o.opId === r.opId; })[0];
          if (r.retry) {                              // server hiccup on this op: keep it, give up after 3 tries
            if (!op) return;
            op.firstFailAt = op.firstFailAt || Date.now();
            state.syncError = 'The server had a problem – will try again';
            if (Date.now() - op.firstFailAt < 24 * 3600000) return;          // keep retrying for a day
            r.error = 'The server couldn\'t save this for a whole day (' + r.error + ').';
          }
          done[r.opId] = true;
          if (!r.ok) {
            newlyRejected++;
            state.rejected.push({ rid: C.uuid(), error: r.error, conflict: !!r.conflict, current: r.current || null, op: op, at: new Date().toISOString() });
          }
        });
        if (newlyRejected) toast((newlyRejected === 1 ? 'Something wasn\'t' : newlyRejected + ' changes weren\'t') + ' saved – see the red card at the top');
        markFinished(Object.keys(done));
        mergeStoredQueue();
        state.queue = state.queue.filter(function (o) { return !done[o.opId]; });
        saveQueue();
        store('rejected', state.rejected);
      }
      acceptSnapshot(data);
    }).catch(function (err) {
      if (err.auth) state.authError = true;
      state.syncError = err.offline ? 'offline' : err.message;
    }).then(function () {
      state.syncing = false;
      renderAll();
      if (state.screen === 'all' && !state.syncError && sent.length) loadList(false);
      if (state.syncAgain) { state.syncAgain = false; sync(); }
    });
  }

  function enqueue(op) {
    if (!op.opId) op.opId = C.uuid();
    mergeStoredQueue();
    state.queue.push(op);
    saveQueue();
    renderAll();
    if (state.screen === 'all') renderList(null, true);
    sync();
    return op;
  }

  /** Version an edit or delete should be based on (includes changes still waiting in the queue). */
  function baseOf(item) { return C.latestVersion(item.id, item, state.queue); }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg, undoFn) {
    var t = $('#toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (undoFn ? '<button type="button" class="link" data-undo>Undo</button>' : '');
    t.hidden = false;
    var b = $('[data-undo]', t);
    if (b) b.onclick = function () { hideToast(); undoFn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 7000);
  }
  function hideToast() { $('#toast').hidden = true; }

  // ---------- Rendering ----------
  function renderAll() {
    if (!state.creds || (state.authError && !state.snap)) return renderSetup();
    if (!state.me) return renderWho();
    if (!$('#screen-' + state.screen)) return state.screen === 'all' ? renderAllScreen() : renderHome();
    renderStatus();
    if (state.screen === 'home') { renderBalance(); renderRecent(); renderNotices(); if (addForm) addForm.refresh(); }
  }

  function shell(inner, screenId) {
    $('#app').innerHTML =
      '<header class="top"><div class="brand">Split</div><button type="button" class="status" data-act="settings" aria-label="Sync status and settings"></button></header>' +
      '<main id="screen-' + screenId + '">' + inner + '</main>';
    renderStatus();
  }

  function renderStatus() {
    var el = $('.status');
    if (!el) return;
    var n = state.queue.length, txt, cls = '';
    if (state.authError) { txt = 'Setup link expired'; cls = 'bad'; }
    else if (state.syncing) txt = 'Syncing…';
    else if (n && state.syncError === 'offline') { txt = n + ' waiting · offline'; cls = 'warn'; }
    else if (n) { txt = n + ' waiting to sync'; cls = 'warn'; }
    else if (state.syncError === 'offline') { txt = 'Offline'; cls = 'warn'; }
    else if (state.syncError) { txt = 'Sync problem'; cls = 'bad'; }
    else txt = state.lastSync ? 'Synced ' + ago(state.lastSync) : 'Not synced';
    el.className = 'status ' + cls;
    el.setAttribute('aria-label', txt + '. Open settings');
    el.innerHTML = '<span class="dot" aria-hidden="true"></span>' + esc(txt) + ' <span class="gear" aria-hidden="true">⚙</span>';
  }
  function ago(iso) {
    var s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return fmtStamp(iso);
  }

  // ----- Setup (no link yet) -----
  function renderSetup(errMsg) {
    var canPaste = !!(navigator.clipboard && navigator.clipboard.readText);
    $('#app').innerHTML =
      '<main class="setup"><div class="logo" aria-hidden="true"></div><h1>Split</h1>' +
      '<p class="muted">Shared expenses for George &amp; Julia.</p>' +
      (state.authError ? '<p class="error">This phone\'s setup link no longer works (the secret key was reset). Paste the new link.</p>' : '') +
      (isIOS() && isStandalone() ?
        '<p><b>One more step:</b> go back to Split in <b>Safari</b>, tap <b>Copy setup link</b>, then come back here and tap <b>Paste from clipboard</b> (and <b>Paste</b> when iPhone asks).</p>' :
        '<p>Open the setup link you were sent (a long link starting with https://), or paste it here:</p>') +
      '<label class="sr" for="link">Setup link</label>' +
      '<textarea id="link" rows="3" placeholder="https://…#u=…&amp;k=…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>' +
      (canPaste ? '<button type="button" class="secondary" data-act="paste">Paste from clipboard</button>' : '') +
      '<button type="button" class="primary" data-act="connect">Connect</button>' +
      '<p class="error" id="setup-err" role="alert">' + esc(errMsg || '') + '</p></main>';
  }

  function connect(text) {
    var c = C.parseSetupLink(text);
    var err = $('#setup-err');
    if (!c) { if (err) err.textContent = 'That doesn\'t look like a Split setup link. It should be one long line containing "#u=" and "&k=" – copy the whole thing and try again.'; return; }
    state.creds = { u: c.u, k: c.k }; store('creds', state.creds); state.authError = false;
    if (err) err.textContent = 'Connecting…';
    api('bootstrap', {}).then(function (data) {
      acceptSnapshot(data); state.syncError = null;
      if (c.me && !state.me && people().indexOf(c.me) >= 0) { state.me = c.me; store('me', c.me); }
      renderAll();
    }).catch(function (e) {
      state.creds = null; drop('creds');
      renderSetup(e.offline ? 'Couldn\'t reach the server. Check your connection and try again.' :
        e.auth ? 'That link\'s secret key is wrong or has been reset.' : 'Problem: ' + e.message);
    });
  }

  // ----- Who are you -----
  function renderWho() {
    var ps = people();
    $('#app').innerHTML = '<main class="setup"><div class="logo" aria-hidden="true"></div><h1>Who\'s using this phone?</h1>' +
      '<p class="muted">Entries you add will be recorded under this name.</p>' +
      ps.map(function (p) { return '<button type="button" class="primary big" data-me="' + esc(p) + '">I\'m ' + esc(p) + '</button>'; }).join('') +
      '</main>';
  }

  // ----- Home -----
  function renderHome() {
    shell('<h1 class="sr">Split – shared expenses</h1><section id="balance" class="balance" aria-live="polite"></section>' +
      '<section id="notices"></section>' +
      (isIOS() ? '<section id="install"></section>' : '') +
      '<section class="card add" aria-labelledby="add-h"><h2 id="add-h" class="sr">Add an entry</h2><div id="add-form"></div></section>' +
      (isIOS() ? '' : '<section id="install"></section>') +
      '<section class="recent"><div class="section-head"><h2>Recent</h2><button type="button" class="link" data-act="all">See all</button></div><ul id="recent" class="items"></ul></section>', 'home');
    entryForm($('#add-form'), null, null);
    renderBalance(); renderRecent(); renderNotices();
  }

  function renderBalance() {
    var el = $('#balance');
    if (!el) return;
    var b = forMe(view().balance), other = otherOf(state.me), head, cls;
    if (b > 0) { head = esc(other) + ' owes you'; cls = 'pos'; }
    else if (b < 0) { head = 'You owe ' + esc(other); cls = 'neg'; }
    else { head = 'All square'; cls = 'zero'; }
    var html = '<div><div class="b-head">' + head + '</div><div class="b-amt">' + (b ? money(Math.abs(b)) : '0 kr') + '</div></div>' +
      '<button type="button" class="secondary small" data-act="settle">Settle up</button>';
    if (el.getAttribute('data-sig') === html) return;
    el.setAttribute('data-sig', html);
    el.className = 'balance ' + cls;
    el.innerHTML = html;
  }

  function renderNotices() {
    var el = $('#notices');
    if (!el) return;
    var html = '';
    if (state.apiMismatch) {
      html += '<div class="notice bad"><strong>' + (state.apiMismatch < API_VERSION ? 'The Google script needs updating' : 'A newer version of Split is ready') + '</strong><p>' +
        (state.apiMismatch < API_VERSION ? 'George: paste the latest Code.gs into Apps Script, then Deploy → Manage deployments → Edit → New version.' :
          'Close Split completely and open it again to load it.') + '</p></div>';
    }
    state.rejected.forEach(function (r) {
      var e = r.op && r.op.entry;
      var what = e ? money(Math.abs(e.amount)) + (e.description || e.category ? ' ' + (e.description || e.category) : '') : 'A deletion';
      html += '<div class="notice bad" data-rid="' + esc(r.rid) + '"><strong>' + esc(what) + ' wasn\'t saved</strong><p>' + esc(r.error) + '</p>' +
        '<button type="button" class="secondary small" data-act="review" data-rid="' + esc(r.rid) + '">Review</button> ' +
        '<button type="button" class="link" data-act="dismiss-rejected" data-rid="' + esc(r.rid) + '">Dismiss</button></div>';
    });
    el.innerHTML = html;
    renderInstall();
  }

  function renderInstall() {
    var el = $('#install');
    if (!el) return;
    var html = '';
    if (!isStandalone() && (!load('installDismissed', false) || state.showInstall)) {
      if (isIOS()) {
        html = '<div class="notice"><strong>Add Split to your Home Screen</strong>' +
          '<ol><li>Tap <b>Copy setup link</b>.</li><li>Tap Safari\'s Share button, then <b>Add to Home Screen</b>.</li>' +
          '<li>Open Split from your Home Screen and tap <b>Paste from clipboard</b>, then <b>Paste</b> when iPhone asks (only needed once).</li></ol>' +
          '<button type="button" class="secondary small" data-act="copy-link">Copy setup link</button> ' +
          '<button type="button" class="link" data-act="dismiss-install">Not now</button></div>';
      } else {
        html = '<div class="notice"><strong>Install Split as an app</strong><p>It then opens full-screen from your home screen.' +
          (state.installPrompt ? '' : ' In Chrome, tap the <b>⋮</b> menu, then <b>Install app</b> or <b>Add to Home screen</b>.') + '</p>' +
          (state.installPrompt ? '<button type="button" class="secondary small" data-act="install">Install</button> ' : '') +
          '<button type="button" class="link" data-act="dismiss-install">Not now</button></div>';
      }
    }
    el.innerHTML = html;
  }

  function itemHtml(it) {
    var payer = you(it.paidBy, true), other = otherOf(it.paidBy), title, sub;
    if (it.type === 'expense') {
      title = it.description || it.category;
      sub = (it.description ? it.category + ' · ' : '') + payer + ' paid';
      if (it.amount < 0) sub += ' · refund';
    } else if (it.type === 'full') {
      title = it.description || it.category;
      sub = 'Only for ' + you(other) + ' · ' + payer + ' paid';
    } else if (it.type === 'received') {
      title = it.description || (other === state.me ? 'Your money' : other + '\'s money');
      sub = payer + ' received money for ' + you(other);
    } else {
      title = payer + ' paid ' + you(other) + ' back';
      sub = it.description || 'Settle up';
    }
    var imp = impactWords(it);
    var label = title + ', ' + money(it.amount) + ', ' + sub + ', ' + fmtDate(it.date) + '. ' + imp.text + (it.pending ? '. Not synced yet' : '');
    return '<li><button type="button" class="item" data-edit="' + esc(it.id) + '" aria-label="' + esc(label) + '">' +
      '<span class="i-main"><span class="i-title">' + esc(title) + '</span><span class="i-sub">' + esc(sub) + ' · ' + esc(fmtDate(it.date)) +
      (it.pending ? ' · <span class="pending">not synced yet</span>' : '') + '</span></span>' +
      '<span class="i-right"><span class="i-amt">' + money(it.amount) + '</span>' +
      '<span class="i-eff ' + imp.cls + '">' + esc(imp.text) + '</span></span>' +
      '</button></li>';
  }

  function renderRecent() {
    var el = $('#recent');
    if (!el) return;
    var items = view().recent.slice(0, 10);
    el.innerHTML = items.length ? items.map(itemHtml).join('') :
      '<li class="empty">No entries yet. Add your first one above.</li>';
  }

  // ----- Entry form (add inline, edit in a sheet) -----
  var addForm = null;
  /**
   * existing: the entry being edited (null = new).
   * prefill: values to start from (used when reviewing an entry that wasn't saved).
   */
  function entryForm(root, existing, onDone, prefill, onSaved) {
    var ps = people();
    var src = prefill || existing;
    var today = C.todayISO();
    var f = src ? {
      type: src.type, amount: C.amountToInput(src.amount), refund: src.amount < 0,
      category: src.category, paidBy: src.paidBy, date: src.date, dateTouched: true,
      description: src.description || '', pct0: src.type === 'expense' && src.pct0 !== '' && src.pct0 !== undefined ? src.pct0 : null, showSplit: false
    } : blankForm();
    function blankForm() {
      return { type: 'expense', amount: '', refund: false, category: '', paidBy: state.me, date: C.todayISO(), dateTouched: false, description: '', pct0: null, showSplit: false };
    }
    var original = existing ? C.buildItem(existing, categories(), ps) : null;

    var cats = [], catSig = null;
    function loadCats() {
      cats = categories().slice();
      [existing, prefill].forEach(function (x) {
        if (x && x.category && !cats.some(function (c) { return c.name === x.category; }) && existing && x === existing) {
          cats.push({ name: existing.category, pct0: existing.pct0 === '' ? 50 : existing.pct0 });
        }
      });
    }
    loadCats();
    if (f.pct0 !== null) {
      var c0 = cats.filter(function (c) { return c.name === f.category; })[0];
      if (c0 && c0.pct0 === f.pct0) f.pct0 = null;    // same as the category default
    }
    if (f.category && !cats.some(function (c) { return c.name === f.category; })) f.category = '';   // e.g. renamed

    var uid = 'f' + Math.random().toString(36).slice(2, 8);
    root.innerHTML =
      '<form class="entry" novalidate autocomplete="off">' +
      '<div class="row payer-row"><span class="payer-label" id="' + uid + '-payer">Paid by</span><div class="seg payers" role="radiogroup" aria-labelledby="' + uid + '-payer">' + ps.map(function (p) {
        return '<button type="button" role="radio" data-payer="' + esc(p) + '">' + esc(p === state.me ? 'You' : p) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="seg types" role="radiogroup" aria-label="Kind of entry">' +
      '<button type="button" role="radio" data-type="expense"></button><button type="button" role="radio" data-type="full"></button><button type="button" role="radio" data-type="received"></button></div>' +
      '<p class="hint type-hint" id="' + uid + '-hint"></p>' +
      '<label class="amount"><span class="sr">Amount in kronor</span><input name="amount" inputmode="decimal" enterkeyhint="next" placeholder="0" maxlength="14" aria-describedby="' + uid + '-hint"><span class="cur" aria-hidden="true">kr</span></label>' +
      '<label class="refund-row refund-chip"><input type="checkbox" name="refund"> <span>Refund / money back</span></label>' +
      '<div class="chips" role="radiogroup" aria-label="Category"></div>' +
      '<label class="sr" for="' + uid + '-note">Note</label><input class="note" id="' + uid + '-note" name="description" placeholder="Note (optional), e.g. ICA" maxlength="200">' +
      '<div class="split-line"><span class="split-text"></span> <button type="button" class="link" data-act="toggle-split" aria-expanded="false">Change split</button></div>' +
      '<div class="split-edit" hidden><input type="range" name="pct0" min="0" max="100" step="1" aria-label="Your share in percent">' +
      '<div class="split-vals"><span class="sv0"></span>' +
      '<label class="pct-box"><span class="sr">Your share in percent</span><input name="pctnum" inputmode="numeric" maxlength="3">%</label>' +
      '<span class="sv1"></span></div>' +
      '<p class="small muted presets-cap">Quick splits – you first, then ' + esc(otherOf(state.me)) + ':</p>' +
      '<div class="presets" role="group" aria-label="Quick splits, your share first">' +
      [35, 40, 50, 60, 65, 70].map(function (n) {
        var mine = n, pct0 = state.me === ps[0] ? n : 100 - n;   // n = viewer's share
        return '<button type="button" class="chip small" data-preset="' + pct0 + '" aria-label="You ' + mine + '%, ' + esc(otherOf(state.me)) + ' ' + (100 - mine) + '%">' + mine + '/' + (100 - mine) + '</button>';
      }).join('') +
      '</div>' +
      '<button type="button" class="link" data-act="reset-split">Use category default</button></div>' +
      '<details class="more"' + (existing || prefill ? ' open' : '') + '><summary>Date</summary>' +
      '<label class="row"><span>Date</span><input type="date" name="date"></label>' +
      '</details>' +
      '<p class="impact"></p>' +
      '<p class="error form-err" role="alert"></p>' +
      '<button type="submit" class="primary save">' + (existing ? 'Save changes' : 'Save') + '</button>' +
      '<p class="save-hint muted small"></p>' +
      (existing ? '<button type="button" class="danger" data-act="delete">Delete entry</button>' +
        '<p class="meta">Added by ' + esc(existing.createdBy || '?') + (existing.createdAt ? ' · ' + esc(fmtStamp(existing.createdAt)) : '') +
        (existing.updatedBy ? ' · last edited by ' + esc(existing.updatedBy) + (existing.updatedAt ? ' ' + esc(fmtStamp(existing.updatedAt)) : '') : '') + '</p>' : '') +
      '</form>';

    var form = $('form', root);
    var el = form.elements;
    var amountEl = el.amount, dateEl = el.date, noteEl = el.description, rangeEl = el.pct0, pctEl = el.pctnum, refundEl = el.refund;

    function catDefault() {
      var c = cats.filter(function (x) { return x.name === f.category; })[0];
      return c ? c.pct0 : 50;
    }
    function effectivePct() { return f.pct0 === null ? catDefault() : f.pct0; }
    function hasCat() { return f.type === 'expense' || f.type === 'full'; }
    function amountOre() {
      var a = C.parseAmount(f.amount);
      if (a === null || a === 0) return null;
      a = Math.abs(a);
      return f.refund && hasCat() ? -a : a;
    }
    function entry() {
      var e = {
        id: existing ? existing.id : C.uuid(), date: f.date || C.todayISO(), type: f.type,
        category: hasCat() ? f.category : '', description: f.description.trim(), amount: amountOre(), paidBy: f.paidBy
      };
      if (f.type === 'expense') e.pct0 = effectivePct();
      return e;
    }
    function missing() {
      var a = amountOre();
      if (!a) return 'Enter an amount, e.g. 249 or 249,50.';
      if (Math.abs(a) > C.MAX_ORE) return 'That\'s over 1 000 000 kr – check the amount.';
      if (hasCat() && !f.category) return 'Pick a category.';
      return '';
    }
    function sayImpact(eff, prefix) {
      var om = otherOf(state.me);
      return prefix + (eff > 0 ? om + ' owes you ' + money(eff) : eff < 0 ? 'you owe ' + om + ' ' + money(-eff) : 'no change to the balance');
    }

    function refresh() {
      if (!existing && !f.dateTouched && f.date !== C.todayISO()) { f.date = C.todayISO(); dateEl.value = f.date; }  // app left open overnight
      var other = otherOf(f.paidBy);
      var labels = f.paidBy === state.me ?
        { expense: 'Shared', full: 'Only for ' + other, received: 'Got ' + other + '\'s money' } :
        { expense: 'Shared', full: 'Only for you', received: f.paidBy + ' got your money' };
      form.querySelectorAll('[data-type]').forEach(function (b) {
        var t = b.getAttribute('data-type');
        b.textContent = labels[t];
        b.setAttribute('aria-checked', String(t === f.type));
      });
      var P = you(f.paidBy, true), p = you(f.paidBy), o = you(other);
      var owes = function (who) { return who === 'you' ? 'you owe' : who + ' owes'; };
      $('.type-hint', form).textContent = {
        expense: 'Split by category.',
        full: P + ' paid for something that\'s only ' + (o === 'you' ? 'yours' : o + '\'s') + ' – ' + owes(o) + ' all of it.',
        received: P + ' got money that belongs to ' + o + ' – ' + owes(p) + ' all of it.'
      }[f.type];
      loadCats();
      var sig = JSON.stringify(cats);
      if (sig !== catSig) {
        catSig = sig;
        $('.chips', form).innerHTML = cats.map(function (c) {
          return '<button type="button" role="radio" class="chip" data-cat="' + esc(c.name) + '">' + esc(c.name) + '</button>';
        }).join('') || '<span class="muted small">Loading categories…</span>';
      }
      $('.chips', form).hidden = !hasCat();
      form.querySelectorAll('[data-cat]').forEach(function (b) {
        b.setAttribute('aria-checked', String(b.getAttribute('data-cat') === f.category));
      });
      form.querySelectorAll('[data-payer]').forEach(function (b) {
        b.setAttribute('aria-checked', String(b.getAttribute('data-payer') === f.paidBy));
      });
      $('.payer-label', form).textContent = f.type === 'received' ? 'Received by' : 'Paid by';
      $('.refund-row', form).hidden = !hasCat();
      refundEl.checked = f.refund;

      var a = amountOre();
      var splitLine = $('.split-line', form), splitEdit = $('.split-edit', form);
      if (f.type === 'expense' && f.category) {
        var pct = effectivePct(), sh = C.computeShares(a || 0, pct);
        splitLine.hidden = false;
        var meFirst = state.me === ps[0];
        var part = function (i) { var p = ps[i], v = i === 0 ? pct : 100 - pct; return (p === state.me ? 'You' : p) + ' ' + v + '%' + (a ? ' (' + money(sh[i]) + ')' : ''); };
        $('.split-text', form).textContent = (meFirst ? part(0) + ' · ' + part(1) : part(1) + ' · ' + part(0)) + (f.pct0 !== null ? ' · custom' : '');
        splitEdit.hidden = !f.showSplit;
        $('[data-act=toggle-split]', form).setAttribute('aria-expanded', String(f.showSplit));
        var myPct = state.me === ps[0] ? pct : 100 - pct;
        rangeEl.value = myPct;
        rangeEl.setAttribute('aria-valuetext', 'You ' + myPct + '%, ' + otherOf(state.me) + ' ' + (100 - myPct) + '%');
        if (document.activeElement !== pctEl) pctEl.value = myPct;
        form.querySelectorAll('[data-preset]').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-preset')) === pct)); });
        $('.sv0', form).textContent = 'You';
        $('.sv1', form).textContent = otherOf(state.me) + ' ' + (100 - myPct) + '%';
      } else {
        splitLine.hidden = true; splitEdit.hidden = true;
      }

      var impact = $('.impact', form), miss = missing();
      if (!miss) {
        var eff = forMe(C.buildItem(entry(), cats, ps).effect);
        impact.className = 'impact ' + (eff > 0 ? 'pos' : eff < 0 ? 'neg' : '');
        if (f.type === 'settle') impact.textContent = '';
        else if (original) {
          var was = forMe(original.effect);
          impact.textContent = sayImpact(eff, 'For this entry: ') + (was !== eff ? ' (before: ' + sayImpact(was, '').trim() + ')' : '');
        } else impact.textContent = sayImpact(eff, 'For this entry: ');
      } else {
        impact.textContent = ''; impact.className = 'impact';
      }
      var save = $('.save', form);
      save.classList.toggle('incomplete', !!miss);
      save.setAttribute('aria-disabled', String(!!miss));
      $('.save-hint', form).textContent = miss && f.amount ? miss : '';
    }

    amountEl.value = f.amount; dateEl.value = f.date; noteEl.value = f.description;
    amountEl.addEventListener('input', function () {
      var v = amountEl.value;
      if (/^\s*[-−]/.test(v) && hasCat()) { f.refund = true; v = v.replace(/^\s*[-−]\s*/, ''); amountEl.value = v; }
      f.amount = v; $('.form-err', form).textContent = ''; refresh();
    });
    amountEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && missing()) { ev.preventDefault(); amountEl.blur(); }
    });
    dateEl.addEventListener('change', function () { f.date = dateEl.value; f.dateTouched = true; });
    noteEl.addEventListener('input', function () { f.description = noteEl.value; });
    var toPct0 = function (mine) { return state.me === ps[0] ? mine : 100 - mine; };   // stored % is always George's
    rangeEl.addEventListener('input', function () { f.pct0 = toPct0(Number(rangeEl.value)); refresh(); });
    pctEl.addEventListener('input', function () {
      var n = parseInt(pctEl.value, 10);
      if (isFinite(n) && n >= 0 && n <= 100) { f.pct0 = toPct0(n); refresh(); }
    });
    refundEl.addEventListener('change', function () { f.refund = refundEl.checked; refresh(); });
    form.addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t || !form.contains(t)) return;
      if (t.hasAttribute('data-type')) {
        f.type = t.getAttribute('data-type'); if (f.type !== 'expense') f.pct0 = null;
        if (f.type === 'full' && !f.category && cats.some(function (c) { return c.name === 'Other'; })) f.category = 'Other';
        refresh();
      }
      else if (t.hasAttribute('data-preset')) { f.pct0 = Number(t.getAttribute('data-preset')); refresh(); }
      else if (t.hasAttribute('data-cat')) {
        f.category = t.getAttribute('data-cat'); if (!f.showSplit) f.pct0 = null;
        amountEl.blur(); noteEl.blur();           // close the keyboard so Save is visible
        refresh();
      }
      else if (t.hasAttribute('data-payer')) { f.paidBy = t.getAttribute('data-payer'); refresh(); }
      else if (t.getAttribute('data-act') === 'toggle-split') { f.showSplit = !f.showSplit; refresh(); }
      else if (t.getAttribute('data-act') === 'reset-split') { f.pct0 = null; refresh(); }
      else if (t.getAttribute('data-act') === 'delete') {
        if (window.confirm('Delete this entry? You can undo straight after.')) {
          var del = enqueue({ op: 'delete', by: state.me, base: baseOf(existing), id: existing.id, prevEffect: original.effect });
          if (onDone) onDone();
          toast('Entry deleted', function () {
            enqueue({ op: 'save', by: state.me, base: del.opId, restore: true, entry: stripItem(existing), prevEffect: 0 });
          });
        }
      }
    });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var miss = missing();
      if (miss) {
        $('.form-err', form).textContent = miss;
        if (!amountOre()) amountEl.focus();
        return;
      }
      var e = entry();
      var newEffect = C.buildItem(e, cats, ps).effect;
      amountEl.blur(); noteEl.blur();
      var label = (money(Math.abs(e.amount)) + ' ' + (e.description || e.category || '')).trim();
      if (existing) {
        var op = enqueue({ op: 'save', by: state.me, base: baseOf(existing), entry: e, prevEffect: original.effect });
        if (onSaved) onSaved();
        if (onDone) onDone();
        toast('Changes saved' + offlineNote(), function () {
          enqueue({ op: 'save', by: state.me, base: op.opId, entry: stripItem(existing), prevEffect: newEffect });
        });
      } else {
        e.enteredAt = new Date().toISOString();
        var created = enqueue({ op: 'save', by: state.me, base: null, entry: e });
        if (onSaved) onSaved();
        if (onDone) onDone();
        if (!prefill) {
          f = blankForm();
          amountEl.value = ''; noteEl.value = ''; dateEl.value = f.date;
          $('details.more', form).open = false;
          refresh();
        }
        toast('Saved ' + label + offlineNote(), function () { undoCreate(created, e, newEffect); });
      }
    });
    refresh();
    var ctl = { focus: function () { amountEl.focus(); }, refresh: refresh };
    if (!existing && !prefill) addForm = ctl;
    return ctl;
  }

  function offlineNote() { return navigator.onLine === false || state.syncError === 'offline' ? ' on this phone – will sync when online' : ''; }

  function stripItem(it) {
    var e = { id: it.id, date: it.date, type: it.type, category: it.category, description: it.description, amount: it.amount, paidBy: it.paidBy };
    if (it.type === 'expense') e.pct0 = it.pct0;
    return e;
  }

  function undoCreate(op, e, effect) {
    var i = state.queue.indexOf(op);
    if (i >= 0 && !op.sent) { state.queue.splice(i, 1); markFinished([op.opId]); saveQueue(); renderAll(); if (state.screen === 'all') renderList(null, true); toast('Removed'); return; }
    enqueue({ op: 'delete', by: state.me, base: op.opId, id: e.id, prevEffect: effect });
    toast('Removed');
  }

  // ---------- Sheets (modals) ----------
  function openSheet(title, build) {
    var m = $('#modal');
    state.lastFocus = document.activeElement;
    m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">' +
      '<div class="sheet-head"><h2 id="sheet-title">' + esc(title) + '</h2><button type="button" class="link" data-close>Close</button></div><div class="sheet-body"></div></div>';
    m.hidden = false;
    document.body.classList.add('modal-open');
    try { history.pushState({ split: 'sheet' }, ''); } catch (e) { /* ignore */ }
    $('#app').setAttribute('inert', '');
    $('#app').setAttribute('aria-hidden', 'true');
    $('[data-close]', m).onclick = closeSheet;
    m.onclick = function (ev) { if (ev.target === m) closeSheet(); };
    build($('.sheet-body', m));
    $('.sheet', m).focus();
  }
  function closeSheet(fromBack) {
    var m = $('#modal');
    if (m.hidden) return;
    if (fromBack !== true && history.state && history.state.split === 'sheet') { history.back(); return; }   // popstate closes it
    m.hidden = true; m.innerHTML = '';
    document.body.classList.remove('modal-open');
    $('#app').removeAttribute('inert');
    $('#app').removeAttribute('aria-hidden');
    renderAll();
    if (state.lastFocus && document.body.contains(state.lastFocus)) state.lastFocus.focus();
  }
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !$('#modal').hidden) closeSheet(); });
  window.addEventListener('popstate', function () {
    if (!$('#modal').hidden) closeSheet(true);
    else if (state.screen === 'all') { state.screen = 'home'; state.list = null; renderHome(); }
  });

  function findItem(id) {
    var it = view().recent.filter(function (x) { return x.id === id; })[0];
    if (!it && state.list) it = listView().filter(function (x) { return x.id === id; })[0];
    return it;
  }

  function openEdit(id) {
    var it = typeof id === 'string' ? findItem(id) : id;
    if (!it) return;
    if (it.type === 'settle') return openSettle(it);
    openSheet('Edit entry', function (body) { entryForm(body, it, closeSheet); });
  }

  /** Re-open an entry the server refused, so it can be fixed and saved again. */
  function openReview(rid) {
    var r = state.rejected.filter(function (x) { return x.rid === rid; })[0];
    if (!r) return;
    var resolved = function () {
      state.rejected = state.rejected.filter(function (x) { return x.rid !== rid; });
      store('rejected', state.rejected);
    };
    var attempted = r.op && r.op.entry;
    var current = r.current && !r.current.deleted ? r.current : (attempted ? findItem(attempted.id) : null);
    if (r.op && r.op.op === 'delete') {
      resolved();                                   // nothing of yours to lose: just show the current entry
      if (current) openEdit(current); else renderAll();
      return;
    }
    if (current) {
      if (attempted.type === 'settle') return openSettle(current, attempted, resolved);
      openSheet('Review entry', function (body) {
        body.insertAdjacentHTML('afterbegin', '<p class="notice">' + esc(r.error) + ' Below is your version on top of the latest one – save to keep it.</p>');
        var holder = document.createElement('div'); body.appendChild(holder);
        entryForm(holder, current, closeSheet, attempted, resolved);
      });
    } else {
      var fresh = {}; for (var k in attempted) fresh[k] = attempted[k];
      fresh.id = C.uuid();
      if (attempted.type === 'settle') return openSettle(null, fresh, resolved);
      openSheet('Add again', function (body) {
        body.insertAdjacentHTML('afterbegin', '<p class="notice">' + esc(r.error) + '</p>');
        var holder = document.createElement('div'); body.appendChild(holder);
        entryForm(holder, null, closeSheet, fresh, resolved);
      });
    }
  }

  function openSettle(existing, prefill, onSaved) {
    openSheet(existing ? 'Edit payment' : 'Settle up', function (body) {
      var b = forMe(view().balance), me = state.me, other = otherOf(me);
      var src = prefill || existing;
      var payer = src ? src.paidBy : (b > 0 ? other : me);
      var amount = src ? src.amount : Math.abs(b);
      body.innerHTML = '<form class="entry" novalidate>' +
        (existing ? '' : '<p class="muted">' + (b === 0 ? 'You\'re all square right now.' : (b > 0 ? esc(other) + ' owes you ' : 'You owe ' + esc(other) + ' ') + esc(money(Math.abs(b))) + '.') +
          ' Record a payment after the money has been sent (Swish, bank transfer…).</p>') +
        '<div class="seg payers" role="radiogroup" aria-label="Who paid"><button type="button" role="radio" data-payer="' + esc(other) + '">' + esc(other) + ' paid you</button>' +
        '<button type="button" role="radio" data-payer="' + esc(me) + '">You paid ' + esc(other) + '</button></div>' +
        '<label class="amount"><span class="sr">Amount in kronor</span><input name="amount" inputmode="decimal" placeholder="0"><span class="cur" aria-hidden="true">kr</span></label>' +
        '<label class="row"><span>Date</span><input type="date" name="date"></label>' +
        '<label class="sr" for="settle-note">Note</label><input class="note" id="settle-note" name="description" placeholder="Note (optional), e.g. Swish" maxlength="200">' +
        '<p class="impact" aria-live="polite"></p><p class="error form-err" role="alert"></p>' +
        '<button type="submit" class="primary save">' + (existing ? 'Save changes' : 'Record payment') + '</button>' +
        (existing ? '<button type="button" class="danger" data-act="delete">Delete payment</button>' +
          '<p class="meta">Added by ' + esc(existing.createdBy || '?') + (existing.createdAt ? ' · ' + esc(fmtStamp(existing.createdAt)) : '') +
          (existing.updatedBy ? ' · last edited by ' + esc(existing.updatedBy) + (existing.updatedAt ? ' ' + esc(fmtStamp(existing.updatedAt)) : '') : '') + '</p>' : '') + '</form>';
      var form = $('form', body);
      form.elements.amount.value = amount ? C.amountToInput(amount) : '';
      form.elements.date.value = src ? src.date : C.todayISO();
      form.elements.description.value = src ? src.description || '' : '';
      var prevMine = existing ? forMe(existing.effect) : 0;
      function refresh() {
        form.querySelectorAll('[data-payer]').forEach(function (x) { x.setAttribute('aria-checked', String(x.getAttribute('data-payer') === payer)); });
        var a = C.parseAmount(form.elements.amount.value);
        var ok = a !== null && a > 0 && a <= C.MAX_ORE;
        var imp = form.querySelector('.impact');
        if (ok) {
          var after = b - prevMine + forMe(C.entryEffect('settle', a, payer, 0, 0, people()));
          imp.textContent = 'Balance afterwards: ' + (after === 0 ? 'all square' : after > 0 ? other + ' owes you ' + money(after) : 'you owe ' + other + ' ' + money(-after));
        } else imp.textContent = '';
      }
      form.addEventListener('input', refresh);
      form.addEventListener('click', function (ev) {
        var t = ev.target.closest('button');
        if (!t) return;
        if (t.hasAttribute('data-payer')) { payer = t.getAttribute('data-payer'); refresh(); }
        if (t.getAttribute('data-act') === 'delete' && window.confirm('Delete this payment?')) {
          var del = enqueue({ op: 'delete', by: me, base: baseOf(existing), id: existing.id, prevEffect: existing.effect });
          closeSheet();
          toast('Payment deleted', function () { enqueue({ op: 'save', by: me, base: del.opId, restore: true, entry: stripItem(existing), prevEffect: 0 }); });
        }
      });
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var a = C.parseAmount(form.elements.amount.value);
        if (!(a > 0)) { form.querySelector('.form-err').textContent = 'Enter the amount that was paid.'; return; }
        if (a > C.MAX_ORE) { form.querySelector('.form-err').textContent = 'That\'s over 1 000 000 kr – check the amount.'; return; }
        var e = { id: existing ? existing.id : (prefill && prefill.id) || C.uuid(), date: form.elements.date.value || C.todayISO(), type: 'settle', category: '',
          description: form.elements.description.value.trim(), amount: a, paidBy: payer };
        if (!existing) e.enteredAt = new Date().toISOString();
        var eff = C.entryEffect('settle', a, payer, 0, 0, people());
        var op = enqueue({ op: 'save', by: me, base: existing ? baseOf(existing) : null, entry: e, prevEffect: existing ? existing.effect : undefined });
        if (onSaved) onSaved();
        closeSheet();
        toast((existing ? 'Payment updated' : 'Payment recorded') + offlineNote(), function () {
          if (existing) enqueue({ op: 'save', by: me, base: op.opId, entry: stripItem(existing), prevEffect: eff });
          else undoCreate(op, e, eff);
        });
      });
      refresh();
    });
  }

  function openSettings() {
    openSheet('Settings', function (body) {
      var other = otherOf(state.me), n = state.queue.length;
      body.innerHTML =
        '<div class="settings">' +
        '<p><strong>Status:</strong> ' + esc(state.authError ? 'setup link no longer valid' : state.syncing ? 'syncing…' :
          state.syncError === 'offline' ? 'offline' : state.syncError ? 'problem – ' + state.syncError : 'connected') +
        (state.lastSync ? '<br><span class="muted">Last synced ' + esc(ago(state.lastSync)) + '</span>' : '') +
        (n ? '<br>' + n + ' entr' + (n === 1 ? 'y' : 'ies') + ' waiting to be sent. They\'re safe on this phone.' : '') + '</p>' +
        '<button type="button" class="secondary" data-act="sync">Sync now</button>' +
        (state.snap && state.snap.sheetUrl ? '<a class="secondary btn" href="' + esc(state.snap.sheetUrl) + '" target="_blank" rel="noopener">Open the Google Sheet</a>' : '') +
        '<p>This phone belongs to <strong>' + esc(state.me) + '</strong>.</p>' +
        '<button type="button" class="secondary" data-act="switch">This is ' + esc(other) + '\'s phone</button>' +
        (state.installPrompt ? '<button type="button" class="secondary" data-act="install">Install app</button>' : '') +
        '<button type="button" class="secondary" data-act="copy-link">Copy setup link</button>' +
        (isStandalone() ? '' : '<button type="button" class="secondary" data-act="show-install">How to add Split to the home screen</button>') +
        (state.authError ? '<button type="button" class="primary" data-act="relink">Paste a new setup link</button>' : '') +
        '<button type="button" class="danger" data-act="forget">Disconnect this phone</button>' +
        '<p class="muted small">Split app ' + VERSION + (state.snap && state.snap.build ? ' · Google script ' + esc(state.snap.build) : '') + '</p></div>';
    });
  }

  // ----- All entries -----
  function renderAllScreen() {
    shell('<div class="section-head"><button type="button" class="link" data-act="home">‹ Back</button><h2>All entries</h2><span class="spacer"></span></div>' +
      '<label class="sr" for="f-q">Search</label><input id="f-q" class="note search" type="search" placeholder="Search note, category or amount" autocomplete="off">' +
      '<div class="filters">' +
      '<select id="f-month" aria-label="Month"><option value="">All months</option></select>' +
      '<select id="f-cat" aria-label="Category"><option value="">All categories</option></select>' +
      '<select id="f-payer" aria-label="Paid by"><option value="">Anyone paid</option>' + people().map(function (p) {
        return '<option value="' + esc(p) + '">' + esc(p === state.me ? 'You' : p) + ' paid</option>';
      }).join('') + '</select></div>' +
      '<p id="list-summary" class="muted" aria-live="polite"></p><ul id="all-items" class="items"></ul>' +
      '<button type="button" class="secondary" id="more" hidden data-act="more">Load more</button>', 'all');
    fillFacets(state.facets || { months: [], categories: categories().map(function (c) { return c.name; }) });
    ['#f-month', '#f-cat', '#f-payer'].forEach(function (sel) { $(sel).addEventListener('change', function () { loadList(false); }); });
    var qTimer = null;
    $('#f-q').addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(function () { loadList(false); }, 350); });
    loadList(false);
  }

  function fillFacets(f) {
    var m = $('#f-month'), c = $('#f-cat');
    if (!m || !c) return;
    var mv = m.value, cv = c.value;
    m.innerHTML = '<option value="">All months</option>' + (f.months || []).map(function (v) {
      var p = v.split('-'), d = new Date(+p[0], +p[1] - 1, 1);
      return '<option value="' + esc(v) + '">' + esc(d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })) + '</option>';
    }).join('');
    c.innerHTML = '<option value="">All categories</option>' + (f.categories || []).map(function (n) {
      return '<option>' + esc(n) + '</option>';
    }).join('');
    m.value = mv; c.value = cv;
  }

  var listSeq = 0;
  function loadList(append) {
    var req = {
      month: $('#f-month') ? $('#f-month').value : '', category: $('#f-cat') ? $('#f-cat').value : '',
      paidBy: $('#f-payer') ? $('#f-payer').value : '', q: $('#f-q') ? $('#f-q').value : '',
      offset: append && state.list ? state.list.serverCount : 0, limit: 50
    };
    var sum = $('#list-summary');
    if (sum && !append) sum.textContent = 'Loading…';
    var seq = ++listSeq;
    api('list', req).then(function (data) {
      if (seq !== listSeq) return;          // a newer request (other filter) has started
      var items = data.items;
      if (append && state.list) {
        var seen = {};
        state.list.items.forEach(function (x) { seen[x.id] = true; });
        items = state.list.items.concat(data.items.filter(function (x) { return !seen[x.id]; }));
      }
      state.list = { items: items, serverCount: (append && state.list ? state.list.serverCount : 0) + data.items.length, data: data };
      state.facets = { months: data.months, categories: data.categories };
      fillFacets(state.facets);
      renderList(data);
    }).catch(function (e) {
      if (seq !== listSeq) return;
      if (sum) sum.textContent = e.offline ? 'You\'re offline. Showing recent entries saved on this phone.' : 'Couldn\'t load: ' + e.message;
      if (!append) { state.list = { items: (state.snap && state.snap.recent) || [], serverCount: 0, data: null }; renderList(null); }
    });
  }

  /** The list as loaded from the server, with this phone's unsynced changes laid on top. */
  function listView() {
    var items = state.list.items.slice();
    state.queue.forEach(function (op) {
      var id = op.op === 'save' ? op.entry.id : op.id;
      var i = -1;
      for (var k = 0; k < items.length; k++) if (items[k].id === id) { i = k; break; }
      if (op.op === 'delete') { if (i >= 0) items.splice(i, 1); return; }
      if (i < 0) return;                                  // new entries show on the home screen
      var it = C.buildItem(op.entry, categories(), people());
      it.pending = true; it.version = op.opId;
      it.createdBy = items[i].createdBy; it.createdAt = items[i].createdAt; it.updatedBy = op.by;
      items[i] = it;
    });
    return items;
  }

  function renderList(data, overlayOnly) {
    var el = $('#all-items');
    if (!el || !state.list) return;
    var items = listView();
    el.innerHTML = items.length ? items.map(itemHtml).join('') : '<li class="empty">Nothing here.</li>';
    var d = data || state.list.data;
    var sum = $('#list-summary');
    if (d) {
      var eff = forMe(d.effect), om = otherOf(state.me);
      var waiting = state.queue.length ? ' · ' + state.queue.length + ' change' + (state.queue.length === 1 ? '' : 's') + ' not synced yet' : '';
      sum.textContent = d.count + ' entr' + (d.count === 1 ? 'y' : 'ies') +
        (d.total ? ' · spending ' + money(d.total) : '') +
        (eff ? ' · net: ' + (eff > 0 ? om + ' owes you ' + money(eff) : 'you owe ' + om + ' ' + money(-eff)) : '') + waiting;
      $('#more').hidden = state.list.serverCount >= d.count;
    } else if (!overlayOnly) {
      $('#more').hidden = true;
    }
  }

  // ---------- Global events ----------
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act],[data-me],[data-edit]');
    if (!t) return;
    if (t.closest('form') && t.hasAttribute('data-act') && ['toggle-split', 'reset-split', 'delete'].indexOf(t.getAttribute('data-act')) >= 0) return;
    if (t.hasAttribute('data-me')) { state.me = t.getAttribute('data-me'); store('me', state.me); state.screen = 'home'; renderHome(); return; }
    if (t.hasAttribute('data-edit')) { openEdit(t.getAttribute('data-edit')); return; }
    var act = t.getAttribute('data-act');
    if (act === 'settings') openSettings();
    else if (act === 'settle') openSettle(null);
    else if (act === 'all') {
      state.screen = 'all'; renderAllScreen(); window.scrollTo(0, 0);
      try { history.pushState({ split: 'all' }, ''); } catch (e) { /* ignore */ }
    }
    else if (act === 'home') {
      if (history.state && history.state.split === 'all') { history.back(); return; }
      state.screen = 'home'; state.list = null; renderHome();
    }
    else if (act === 'more') loadList(true);
    else if (act === 'sync') { sync(); closeSheet(); }
    else if (act === 'review') openReview(t.getAttribute('data-rid'));
    else if (act === 'connect') connect($('#link').value);
    else if (act === 'paste') {
      navigator.clipboard.readText().then(function (txt) { $('#link').value = txt; connect(txt); })
        .catch(function () { $('#setup-err').textContent = 'Couldn\'t read the clipboard – long-press the box and choose Paste.'; });
    } else if (act === 'copy-link') {
      var link = setupLinkFromCreds();
      (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(link) : Promise.reject())
        .then(function () { toast('Setup link copied'); }, function () { window.prompt('Copy this link:', link); });
    } else if (act === 'dismiss-install') { state.showInstall = false; store('installDismissed', true); renderInstall(); }
    else if (act === 'show-install') { state.showInstall = true; closeSheet(); window.scrollTo(0, 0); }
    else if (act === 'dismiss-rejected') {
      var rid = t.getAttribute('data-rid');
      if (!window.confirm('Throw away this unsaved change? The other version stays as it is.')) return;
      state.rejected = state.rejected.filter(function (x) { return x.rid !== rid; });
      store('rejected', state.rejected); renderNotices();
    } else if (act === 'install' && state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt.userChoice.then(function () { state.installPrompt = null; renderAll(); });
    } else if (act === 'switch') {
      var o = otherOf(state.me);
      if (window.confirm('Use this phone as ' + o + '? New entries will be recorded as ' + o + '\'s.')) {
        state.me = o; store('me', state.me); closeSheet(); state.screen = 'home'; renderHome();
        toast('This phone now belongs to ' + state.me);
      }
    } else if (act === 'relink') { closeSheet(); state.creds = null; renderSetup(); }
    else if (act === 'forget') {
      var n = state.queue.length;
      if (window.confirm((n ? n + ' unsynced entr' + (n === 1 ? 'y' : 'ies') + ' will be lost. ' : '') + 'Disconnect this phone from Split?')) {
        ['creds', 'me', 'snap', 'queue', 'rejected', 'lastSync'].forEach(drop);
        state.creds = null; state.me = null; state.snap = null; state.queue = []; state.rejected = [];
        closeSheet(); renderSetup();
      }
    }
  });

  // Another tab/app window on this phone changed the saved state: pick it up.
  window.addEventListener('storage', function (ev) {
    if (!ev.key || ev.key.indexOf('split.') !== 0) return;
    if (ev.key === 'split.queue') mergeStoredQueue();
    if (ev.key === 'split.snap') state.snap = load('snap', state.snap);
    renderAll();
  });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); state.installPrompt = e; renderInstall(); });
  window.addEventListener('online', function () { sync(); });
  window.addEventListener('offline', function () { state.syncError = 'offline'; renderStatus(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    renderAll(); sync();
    if (!DEMO && navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {});
    }
  });
  setInterval(function () {
    if (document.visibilityState === 'visible' && state.creds) {
      if (state.queue.length || Date.now() - Date.parse(state.lastSync || 0) > 120000) sync(); else renderStatus();
    }
  }, 30000);

  // ---------- Start ----------
  function start() {
    if (!DEMO) {
      var c = C.parseSetupLink(location.href);
      if (c) {
        state.creds = { u: c.u, k: c.k }; store('creds', state.creds); state.authError = false;
        if (c.me && !state.me && DEFAULT_PEOPLE.indexOf(c.me) >= 0) { state.me = c.me; store('me', c.me); }
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
      }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* best effort */ });
    }
    if (DEMO && DEMO.screen === 'setup') { state.creds = null; return renderSetup(); }
    renderAll();
    if (state.creds) sync();
    if (DEMO && DEMO.after) DEMO.after({ openEdit: openEdit, openSettle: openSettle, openSettings: openSettings, renderAllScreen: function () { state.screen = 'all'; renderAllScreen(); } });
    if (!DEMO && 'serviceWorker' in navigator) {
      var hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (hadController) toast('Split has been updated – the new version opens next time.');
      });
    }
  }
  start();
})();
