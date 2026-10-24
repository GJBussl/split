/* Split – pure logic shared by the app (browser) and the tests (Node). No DOM here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SplitCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** "1 234,50" / "1234.5" / "99" → öre (integer), or null if not a valid amount. */
  function parseAmount(input) {
    if (input === null || input === undefined) return null;
    var s = String(input).replace(/kr|sek/gi, '').replace(/[\s  ']/g, '');
    if (!s) return null;
    var neg = false;
    if (s[0] === '-' || s[0] === '−') { neg = true; s = s.slice(1); }
    if (!/^[\d.,]+$/.test(s)) return null;
    var commas = s.split(',').length - 1, dots = s.split('.').length - 1;
    var dec = null, thou = null;
    if (commas && dots) { dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'; thou = dec === ',' ? '.' : ','; }
    else if (commas + dots > 1) thou = commas ? ',' : '.';
    else if (commas + dots === 1) {
      // A lone comma or dot is always the decimal separator ("2,50" / "2.50"). Three or more decimals
      // ("2,500", "12.500") are rejected rather than guessed, so an amount can never be 1000× too big.
      dec = commas ? ',' : '.';
    }
    var intPart = s, frac = '';
    if (dec) {
      if (s.split(dec).length !== 2) return null;
      intPart = s.split(dec)[0]; frac = s.split(dec)[1];
    }
    if (thou && intPart.indexOf(thou) >= 0) {
      var groups = intPart.split(thou);
      if (!/^\d{1,3}$/.test(groups[0])) return null;
      for (var g = 1; g < groups.length; g++) if (!/^\d{3}$/.test(groups[g])) return null;
      intPart = groups.join('');
    }
    if (!/^\d*$/.test(intPart) || !/^\d{0,2}$/.test(frac) || (intPart === '' && frac === '')) return null;
    var ore = parseInt(intPart || '0', 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
    if (!isFinite(ore)) return null;
    return neg ? -ore : ore;
  }

  /** Same rule as the server: first person's share rounded, second gets the remainder. */
  function computeShares(amountOre, pct0) {
    var sign = amountOre < 0 ? -1 : 1;
    var s0 = sign * Math.round(Math.abs(amountOre) * pct0 / 100);
    return [s0, amountOre - s0];
  }

  /** Positive = people[1] owes people[0]. */
  function entryEffect(type, amountOre, paidBy, share0, share1, people) {
    var dir = paidBy === people[0] ? 1 : -1;
    if (type === 'expense' || type === 'full') return dir === 1 ? share1 : -share0;
    if (type === 'settle') return dir * amountOre;
    if (type === 'received') return -dir * amountOre;
    throw new Error('Unknown type ' + type);
  }

  /** Fill in shares/effect for an entry the same way the server will. */
  function buildItem(entry, categories, people) {
    var item = {};
    for (var k in entry) item[k] = entry[k];
    var share0 = '', share1 = '', pct0 = '';
    if (entry.type === 'expense' || entry.type === 'full') {
      if (entry.type === 'full') pct0 = entry.paidBy === people[0] ? 0 : 100;
      else if (entry.pct0 === undefined || entry.pct0 === null || entry.pct0 === '') {
        var c = (categories || []).filter(function (x) { return x.name === entry.category; })[0];
        pct0 = c ? c.pct0 : 50;
      } else pct0 = Number(entry.pct0);
      var s = computeShares(entry.amount, pct0);
      share0 = s[0]; share1 = s[1];
    } else {
      item.category = '';
    }
    item.pct0 = pct0; item.share0 = share0; item.share1 = share1;
    item.effect = entryEffect(entry.type, entry.amount, entry.paidBy, share0 || 0, share1 || 0, people);
    return item;
  }

  var fmtCache = {};
  /** öre → "1 234 kr" or "1 234,50 kr" (decimals only when needed). */
  function formatMoney(ore, opts) {
    opts = opts || {};
    var abs = Math.abs(ore);
    var whole = abs % 100 === 0;
    var key = whole ? 'w' : 'd';
    if (!fmtCache[key]) {
      fmtCache[key] = new Intl.NumberFormat('sv-SE', {
        minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2
      });
    }
    var sign = ore < 0 ? '−' : (opts.plus && ore > 0 ? '+' : '');
    return sign + fmtCache[key].format(abs / 100) + ' kr';
  }

  /** Amount for an input field: 123450 → "1234,50", 500 → "5". */
  function amountToInput(ore) {
    var abs = Math.abs(ore);
    var s = String(Math.floor(abs / 100));
    if (abs % 100) s += ',' + ('0' + (abs % 100)).slice(-2);
    return s;
  }

  /** Extract {u, k} from a setup link like https://x.github.io/split/#u=...&k=... */
  function parseSetupLink(text) {
    if (!text) return null;
    var m = String(text).match(/[#&?]u=([^&\s]+)&k=([A-Za-z0-9]+)(?:&me=([^&\s]+))?/);
    if (!m) return null;
    var u, me = null;
    try { u = decodeURIComponent(m[1]); if (m[3]) me = decodeURIComponent(m[3]); } catch (e) { return null; }
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) return null;
    var out = { u: u, k: m[2] };
    if (me) out.me = me;
    return out;
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    var s = '';
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function sortItems(items) {
    return items.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      var ac = a.createdAt || '9', bc = b.createdAt || '9';   // pending (no createdAt) first
      return ac < bc ? 1 : ac > bc ? -1 : 0;
    });
  }

  /**
   * Optimistic view: server snapshot + operations still waiting in the queue.
   * Returns {balance, recent} without mutating the inputs.
   */
  function applyQueue(snapshot, queue, people) {
    var balance = snapshot.balance || 0;
    var recent = (snapshot.recent || []).map(function (x) { return x; });
    (queue || []).forEach(function (op) {
      var id = op.op === 'save' ? op.entry.id : op.id;
      var idx = -1;
      for (var i = 0; i < recent.length; i++) if (recent[i].id === id) { idx = i; break; }
      var prev = idx >= 0 ? recent[idx] : null;
      var prevEffect = prev ? prev.effect : (op.prevEffect || 0);
      if (prev) recent.splice(idx, 1);
      balance -= prevEffect;
      if (op.op === 'save') {
        var item = buildItem(op.entry, snapshot.categories, people);
        item.pending = true;
        item.createdBy = prev ? prev.createdBy : op.by;
        item.createdAt = prev ? prev.createdAt : '';
        if (prev) item.updatedBy = op.by;
        item.version = op.opId;
        balance += item.effect;
        recent.push(item);
      }
    });
    return { balance: balance, recent: sortItems(recent) };
  }

  /** The version the server will have for an entry once the queue is applied (used as an edit's base). */
  function latestVersion(id, item, queue) {
    var v = item ? item.version || null : null;
    (queue || []).forEach(function (op) {
      if ((op.op === 'save' ? op.entry.id : op.id) === id) v = op.opId;
    });
    return v;
  }

  return {
    parseAmount: parseAmount, computeShares: computeShares, entryEffect: entryEffect,
    buildItem: buildItem, formatMoney: formatMoney, amountToInput: amountToInput,
    parseSetupLink: parseSetupLink, uuid: uuid, todayISO: todayISO, sortItems: sortItems,
    applyQueue: applyQueue, latestVersion: latestVersion, MAX_ORE: 100000000
  };
});
