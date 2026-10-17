'use strict';
/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dstr = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;           // m is 0-based
const todayStr = () => { const d = new Date(); return dstr(d.getFullYear(), d.getMonth(), d.getDate()); };
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const longDate = s => parseDate(s).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const shortDate = s => parseDate(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uid = () => {   // always a valid UUID (Supabase needs one; crypto.randomUUID is missing on plain-http pages)
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const sum = list => list.reduce((t, p) => t + p.amount, 0);
const isWide = () => matchMedia('(min-width: 900px)').matches;

/* ---------- data ---------- */
// Local-only mode (no cloud config): everything lives in localStorage under KEY.
// Cloud mode (config.js filled in): Supabase is the source of truth; localStorage only caches the last copy.
const KEY = 'paymentCalendar.v1';
const CUR_KEY = 'paymentCalendar.currency';
const CFG = window.PAYMENT_CALENDAR_CONFIG || {};
const cloudOn = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
let sb = null, user = null;

const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
function readStore(key) {
  try {
    const raw = JSON.parse(lsGet(key));
    if (raw && Array.isArray(raw.payees) && Array.isArray(raw.payments)) return raw;
  } catch (e) {}
  return null;
}
let db = { currency: lsGet(CUR_KEY) || '$', payees: [], payments: [] };
if (!cloudOn) {
  const r = readStore(KEY);
  if (r) { db.payees = r.payees; db.payments = r.payments; if (!lsGet(CUR_KEY) && r.currency) db.currency = r.currency; }
}
const cacheKey = () => (cloudOn ? (user ? 'paymentCalendar.cache.' + user.id : null) : KEY);
function save() {
  const k = cacheKey(); if (!k) return;
  lsSet(k, JSON.stringify({ payees: db.payees, payments: db.payments, currency: db.currency }));
}

const money = n => db.currency + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const payeeName = id => (db.payees.find(p => p.id === id) || { name: '(deleted payee)' }).name;
const byPayeeThenInvoice = (a, b) => payeeName(a.payeeId).localeCompare(payeeName(b.payeeId)) || a.invoice.localeCompare(b.invoice, undefined, { numeric: true });

function sampleData() {
  const names = ['Meralco', 'Globe Telecom', 'Office Depot', 'ABC Suppliers', 'Prime Logistics', 'City Landlord'];
  const payees = names.map(name => ({ id: uid(), name }));
  const id = n => payees.find(p => p.name === n).id;
  const t = new Date(); const y = t.getFullYear(), m = t.getMonth(), d = t.getDate();
  const at = off => { const x = new Date(y, m, d + off); return dstr(x.getFullYear(), x.getMonth(), x.getDate()); };
  const rows = [
    ['Meralco', 'MER-10021', 18450.75, -20], ['Meralco', 'MER-10088', 19210.4, 10],
    ['Globe Telecom', 'GT-5521', 3499, -9], ['Globe Telecom', 'GT-5588', 3499, 21],
    ['Office Depot', 'OD-7731', 12980, 0], ['Office Depot', 'OD-7740', 4250.5, 0], ['Office Depot', 'OD-7802', 8800, 14],
    ['ABC Suppliers', 'ABC-0912', 56200, 3], ['ABC Suppliers', 'ABC-0913', 23890.25, 3], ['ABC Suppliers', 'ABC-0950', 41000, 17],
    ['ABC Suppliers', 'ABC-0871', 33500, -14],
    ['Prime Logistics', 'PL-3301', 9800, 3], ['Prime Logistics', 'PL-3342', 7450, 8], ['Prime Logistics', 'PL-3290', 6100, -6],
    ['City Landlord', 'RENT-OCT', 85000, 5], ['City Landlord', 'RENT-NOV', 85000, 35],
  ];
  const payments = rows.map(([n, invoice, amount, off]) => ({ id: uid(), payeeId: id(n), invoice, amount, date: at(off) }));
  return { payees, payments };
}

/* ---------- cloud (Supabase) ---------- */
const rowToPayment = r => ({ id: r.id, payeeId: r.payee_id, invoice: r.invoice, amount: Number(r.amount), date: r.pay_date });
const paymentToRow = p => ({ id: p.id, payee_id: p.payeeId, invoice: p.invoice, amount: p.amount, pay_date: p.date });
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const must = ({ error }) => { if (error) throw error; };

async function fetchAll(table, cols) {          // PostgREST caps a response at 1000 rows, so page through
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order('id').range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
const remote = {
  async load() {
    const [payees, payments] = await Promise.all([fetchAll('payees', 'id,name'), fetchAll('payments', 'id,payee_id,invoice,amount,pay_date')]);
    return { payees, payments: payments.map(rowToPayment) };
  },
  async upsertPayee(p) { must(await sb.from('payees').upsert({ id: p.id, name: p.name })); },
  async deletePayee(id) { must(await sb.from('payees').delete().eq('id', id)); },        // payments cascade
  async upsertPayment(p) { must(await sb.from('payments').upsert(paymentToRow(p))); },
  async deletePayment(id) { must(await sb.from('payments').delete().eq('id', id)); },
  async replaceAll(d) {
    must(await sb.from('payees').delete().not('id', 'is', null));
    for (const c of chunks(d.payees, 500)) must(await sb.from('payees').insert(c.map(p => ({ id: p.id, name: p.name }))));
    for (const c of chunks(d.payments, 500)) must(await sb.from('payments').insert(c.map(paymentToRow)));
  },
};

/* Apply a change locally right away, then push it to the cloud; roll back and tell the user if that fails. */
async function mutate(change, op) {
  const snap = JSON.stringify({ payees: db.payees, payments: db.payments });
  change(); save(); render();
  if (!cloudOn) return;
  try { await op(); setOnline(true); }
  catch (e) {
    const s = JSON.parse(snap); db.payees = s.payees; db.payments = s.payments; save(); render();
    toast(`Couldn’t save that change — check your connection. ${e.message || ''}`.trim());
    refresh();
  }
}

const norm = d => JSON.stringify([[...d.payees].sort((a, b) => a.id < b.id ? -1 : 1), [...d.payments].sort((a, b) => a.id < b.id ? -1 : 1)]);
async function refresh() {
  if (!cloudOn || !user) return;
  try {
    const d = await remote.load();
    setOnline(true);
    if (norm(d) !== norm(db)) { db.payees = d.payees; db.payments = d.payments; save(); softRender(); updateBadge(); }
  } catch (e) { setOnline(false); }
  finally { if (ui.loading) { ui.loading = false; render(); } }
}
function softRender() {      // re-render after a background refresh without clobbering what the user is typing
  if (ui.loading) return;
  if (ui.tab === 'lookup') renderResults();
  else if (ui.tab === 'payees' && /INPUT/.test(document.activeElement.tagName)) return;
  else render();
}
function setOnline(ok) { const b = $('#banner'); if (b) b.hidden = ok; }
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

let channel = null, refreshTimer = null;
function startRealtime() {
  stopRealtime();
  const later = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 300); };
  channel = sb.channel('payment-calendar')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payees' }, later)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, later)
    .subscribe();
}
function stopRealtime() { if (channel) { sb.removeChannel(channel); channel = null; } }

async function startSession(u) {
  user = u;
  document.body.classList.remove('auth');
  const cached = readStore(cacheKey());
  if (cached) { db.payees = cached.payees; db.payments = cached.payments; ui.loading = false; }
  else { db.payees = []; db.payments = []; ui.loading = true; }
  render();
  startRealtime();
  await refresh();
  resyncAlerts(); updateBadge();
}

function showAuth(msg = '', kind = 'err') {
  document.body.classList.add('auth');
  $('#main').innerHTML = `<div class="auth-box"><h1 class="page-title">Payment Calendar</h1>
    <form class="card" id="authForm">
      <div class="field"><label for="a-email">Email</label><input type="email" id="a-email" name="email" autocomplete="username" required></div>
      <div class="field"><label for="a-pw">Password</label><input type="password" id="a-pw" name="password" autocomplete="current-password" minlength="6" required></div>
      <div class="${kind === 'err' ? 'err' : 'ok'}" id="a-msg">${esc(msg)}</div>
      <div class="btn-row"><button class="btn primary" type="submit">Sign in</button>
        <button class="btn" type="button" data-action="signUp">Create account</button></div>
    </form>
    <p class="muted" style="font-size:13px">Sign in with the same account on every device to see the same payments.</p></div>`;
}
async function authSubmit(mode) {
  const f = $('#authForm'); const email = f.email.value.trim(), password = f.password.value;
  if (!email || password.length < 6) return showAuth('Enter your email and a password of at least 6 characters.');
  $('#a-msg').textContent = 'Please wait…';
  try {
    if (mode === 'signUp') {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) return showAuth('Account created. Check your email to confirm it, then sign in.', 'ok');
      return startSession(data.session.user);
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return startSession(data.user);
  } catch (e) { showAuth(e.message || 'Could not sign in.'); }
}
async function boot() {
  if (!cloudOn) { render(); return; }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') { user = null; db.payees = []; db.payments = []; showAuth(); } });
  const { data } = await sb.auth.getSession();
  if (data.session) await startSession(data.session.user); else showAuth();
}

/* ---------- push alerts (daily "due today" notification) ---------- */
const ALERT_KEY = 'paymentCalendar.alertHour';
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyToBytes = b64 => { const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const hourLabel = h => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } };

// serviceWorker.ready never settles if registration failed, so give up after a few seconds instead of hanging.
const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('The offline helper (service worker) isn’t running. Reload the page and try again.')), 5000))]);
async function pushSub() {
  if (!pushSupported()) return null;
  try { return await (await swReady()).pushManager.getSubscription(); } catch (e) { return null; }
}
async function saveSub(sub, hour) {
  const j = sub.toJSON();
  must(await sb.from('push_subscriptions').upsert(
    { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, timezone: tz(), notify_hour: hour, currency: db.currency },
    { onConflict: 'endpoint' }));
}
async function enableAlerts(hour) {
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted')
    throw new Error('Notifications are blocked for this app. Allow them in your device settings, then try again.');
  const reg = await swReady();
  const sub = (await reg.pushManager.getSubscription())
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(CFG.vapidPublicKey) });
  await saveSub(sub, hour);
  lsSet(ALERT_KEY, String(hour));
}
async function disableAlerts() {
  const sub = await pushSub();
  if (sub) { try { must(await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)); } catch (e) {} await sub.unsubscribe(); }
  try { localStorage.removeItem(ALERT_KEY); } catch (e) {}
}
async function resyncAlerts() {      // after sign-in / currency change: keep this device's row current
  const h = lsGet(ALERT_KEY);
  if (h === null || !cloudOn || !user || !pushSupported() || Notification.permission !== 'granted') return;
  const sub = await pushSub();
  if (sub) { try { await saveSub(sub, Number(h)); } catch (e) {} }
}
async function refreshPushState() {
  ui.push = { on: !!(await pushSub()) && lsGet(ALERT_KEY) !== null, hour: Number(lsGet(ALERT_KEY) ?? 8) };
  if (ui.tab === 'payees' && !/INPUT|SELECT/.test(document.activeElement.tagName)) render();
}
function updateBadge() {     // app-icon badge = payments due today (where supported)
  if (!navigator.setAppBadge) return;
  const n = db.payments.filter(p => p.date === todayStr()).length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
function alertsCard() {
  if (!cloudOn) return '';
  const hours = h => Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${i === h ? 'selected' : ''}>${hourLabel(i)}</option>`).join('');
  const st = ui.push || { on: false, hour: 8 };
  let body;
  if (!CFG.vapidPublicKey) body = '<p class="muted small">Alerts aren’t set up yet — see “Daily alerts” in the README.</p>';
  else if (IOS && !STANDALONE) body = '<p class="muted small">On iPhone and iPad, alerts only work once the app is on your Home Screen: tap <b>Share → Add to Home Screen</b>, then open the app from its icon and come back here.</p>';
  else if (!pushSupported()) body = '<p class="muted small">This browser doesn’t support push notifications. Try Safari or Chrome.</p>';
  else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') body = '<p class="muted small">Notifications are blocked for this app. Allow them in your browser or device settings, then reload.</p>';
  else if (st.on) body = `<p class="small">On — this device gets a notification at
      <select id="alertHour" style="width:auto;display:inline-block;min-height:36px;padding:4px 8px">${hours(st.hour)}</select>
      on days that have payments due.</p>
      <div class="btn-row"><button class="btn" data-action="alertsTest">Send test</button><button class="btn danger" data-action="alertsOff">Turn off</button></div>`;
  else body = `<p class="muted small" style="margin-top:0">Get a notification each morning listing what’s due that day. Set up per device.</p>
      <div class="btn-row"><select id="alertHour" style="width:auto;min-height:44px">${hours(st.hour)}</select>
      <button class="btn primary" data-action="alertsOn">Enable alerts on this device</button></div>`;
  return `<div class="card"><h3>Daily payment alert</h3>${body}</div>`;
}

/* ---------- UI state ---------- */
const now = new Date();
const ui = { tab: 'calendar', year: now.getFullYear(), month: now.getMonth(), selected: todayStr(), sheet: false,
  mode: 'payee', q: '', past: false, lastPayee: null };

/* ---------- render: calendar ---------- */
function calendarView() {
  const { year, month } = ui;
  const title = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const prefix = `${year}-${pad(month + 1)}-`;
  const monthPays = db.payments.filter(p => p.date.startsWith(prefix));
  const map = {};
  monthPays.forEach(p => (map[p.date] ||= []).push(p));
  const lead = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div class="cell empty"></div>';
  for (let d = 1; d <= days; d++) {
    const key = dstr(year, month, d);
    const list = map[key] || [];
    let body = '';
    if (list.length) {
      const per = {};
      list.forEach(p => (per[p.payeeId] = (per[p.payeeId] || 0) + p.amount));
      const rows = Object.entries(per).sort((a, b) => b[1] - a[1]);
      const lines = rows.slice(0, 2).map(([id, amt]) => `<span class="pl"><b>${esc(payeeName(id))}</b><i>${compact(amt)}</i></span>`).join('')
        + (rows.length > 2 ? `<span class="pl">+${rows.length - 2} more</span>` : '');
      body = `<span class="tot">${compact(sum(list))}</span><span class="lines">${lines}</span>`;
    }
    cells += `<button class="cell${key === today ? ' today' : ''}${key === ui.selected ? ' sel' : ''}" data-action="selectDate" data-date="${key}">
      <span class="dn">${d}</span>${body}</button>`;
  }
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => `<div>${w}</div>`).join('');
  const hasData = db.payments.length > 0;
  return `
  <div class="cal-wrap">
    <div>
      <div class="cal-head">
        <div class="title"><h1>${esc(title)}</h1>
          <div class="sub">${monthPays.length} payment${monthPays.length === 1 ? '' : 's'} · ${money(sum(monthPays))}</div></div>
        <button class="btn" data-action="prev" aria-label="Previous month">‹</button>
        <button class="btn" data-action="today">Today</button>
        <button class="btn" data-action="next" aria-label="Next month">›</button>
        <button class="btn primary" data-action="addPayment" data-date="${ui.selected}">+ Add</button>
      </div>
      ${hasData ? '' : `<div class="card"><b>No payments yet.</b>
        <p class="muted" style="margin:6px 0 10px">Add payees on the Payees tab, then tap “+ Add” to schedule a payment — or try it with sample data.</p>
        <button class="btn" data-action="sample">Load sample data</button></div>`}
      <div class="wd">${wd}</div>
      <div class="grid">${cells}</div>
    </div>
    ${detailPanel()}
  </div>
  <div class="backdrop" data-action="closeSheet" ${ui.sheet ? '' : 'hidden'}></div>`;
}

function detailPanel() {
  const list = db.payments.filter(p => p.date === ui.selected).sort(byPayeeThenInvoice);
  const groups = {};
  list.forEach(p => (groups[p.payeeId] ||= []).push(p));
  const body = list.length ? Object.entries(groups).map(([id, items]) => `
    <div class="group">
      <div class="group-h"><span>${esc(payeeName(id))}</span><span class="amt">${money(sum(items))}</span></div>
      ${items.map(p => `<button class="row" data-action="editPayment" data-id="${p.id}">
        <span class="inv">Invoice ${esc(p.invoice)}</span><span class="amt">${money(p.amount)}</span></button>`).join('')}
    </div>`).join('') : '<div class="empty-msg">No payments scheduled for this day.</div>';
  return `<aside class="detail${ui.sheet ? ' open' : ''}">
    <div class="detail-head">
      <div class="t"><h2>${esc(longDate(ui.selected))}</h2>
        <div class="muted" style="font-size:13px">${list.length} payment${list.length === 1 ? '' : 's'} · ${Object.keys(groups).length} payee${Object.keys(groups).length === 1 ? '' : 's'}</div></div>
      <button class="btn sm primary" data-action="addPayment" data-date="${ui.selected}">+ Add</button>
      <button class="btn sm close-x" data-action="closeSheet" aria-label="Close">✕</button>
    </div>
    <div class="detail-total">${money(sum(list))}</div>
    ${body}
  </aside>`;
}

/* ---------- render: look up ---------- */
function lookupView() {
  return `<h1 class="page-title">Look up</h1>
  <div class="seg">
    <button data-action="mode" data-mode="payee" class="${ui.mode === 'payee' ? 'on' : ''}">Payee</button>
    <button data-action="mode" data-mode="invoice" class="${ui.mode === 'invoice' ? 'on' : ''}">Invoice</button>
  </div>
  <input type="search" id="q" autocomplete="off" autocapitalize="off" placeholder="${ui.mode === 'payee' ? 'Search payee name…' : 'Search invoice number…'}" value="${esc(ui.q)}">
  <label class="chk" id="pastBox" ${ui.mode === 'payee' ? '' : 'hidden'}><input type="checkbox" id="past" ${ui.past ? 'checked' : ''}> Show past payments</label>
  <div id="results"></div>`;
}

function renderResults() {
  const box = $('#results'); if (!box) return;
  const q = ui.q.trim().toLowerCase();
  const today = todayStr();
  const row = (p, withPayee) => {
    const past = p.date < today;
    return `<button class="row" data-action="editPayment" data-id="${p.id}">
      <span class="date-col">${esc(shortDate(p.date))}</span>
      <span style="flex:1;min-width:0">${withPayee ? `<b>${esc(payeeName(p.payeeId))}</b><br>` : ''}<span class="inv">Invoice ${esc(p.invoice)}</span></span>
      ${past ? '<span class="tag past">Past</span>' : ''}<span class="amt">${money(p.amount)}</span></button>`;
  };

  if (ui.mode === 'invoice') {
    if (!q) { box.innerHTML = '<div class="empty-msg">Type an invoice number to find it.</div>'; return; }
    const hits = db.payments.filter(p => p.invoice.toLowerCase().includes(q))
      .sort((a, b) => a.date.localeCompare(b.date) || a.invoice.localeCompare(b.invoice));
    box.innerHTML = hits.length
      ? `<div class="card"><h3>${hits.length} match${hits.length === 1 ? '' : 'es'} · ${money(sum(hits))}</h3>${hits.map(p => row(p, true)).join('')}</div>`
      : '<div class="empty-msg">No invoice matches that number.</div>';
    return;
  }

  const payees = db.payees.filter(p => p.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  const cards = payees.map(pe => {
    const all = db.payments.filter(p => p.payeeId === pe.id);
    const upcoming = all.filter(p => p.date >= today);
    const shown = (ui.past ? all : upcoming).sort((a, b) => a.date.localeCompare(b.date));
    if (!q && !shown.length) return '';
    return `<div class="card">
      <div class="group-h" style="margin-bottom:4px"><span>${esc(pe.name)}</span><span class="amt">${money(sum(upcoming))}</span></div>
      <div class="muted" style="font-size:13px;margin-bottom:4px">${upcoming.length} upcoming payment${upcoming.length === 1 ? '' : 's'}</div>
      ${shown.length ? shown.map(p => row(p, false)).join('') : '<div class="muted" style="padding:6px 0">No upcoming payments.</div>'}
    </div>`;
  }).join('');
  box.innerHTML = cards || `<div class="empty-msg">${db.payees.length ? 'Nothing found.' : 'No payees yet — add them on the Payees tab.'}</div>`;
}

/* ---------- render: payees & settings ---------- */
function payeesView() {
  const today = todayStr();
  const rows = [...db.payees].sort((a, b) => a.name.localeCompare(b.name)).map(pe => {
    const all = db.payments.filter(p => p.payeeId === pe.id);
    const up = all.filter(p => p.date >= today);
    return `<div class="payee-row">
      <div class="n"><b>${esc(pe.name)}</b><span class="muted" style="font-size:13px">${all.length} payment${all.length === 1 ? '' : 's'} · ${money(sum(up))} upcoming</span></div>
      <button class="btn sm" data-action="renamePayee" data-id="${pe.id}">Rename</button>
      <button class="btn sm danger" data-action="deletePayee" data-id="${pe.id}">Delete</button></div>`;
  }).join('');
  return `<h1 class="page-title">Payees</h1>
  <form class="card add-row" id="payeeForm"><input type="text" id="newPayee" placeholder="New payee name" autocomplete="off" required>
    <button class="btn primary" type="submit">Add</button></form>
  <div class="card">${rows || '<div class="muted">No payees yet.</div>'}</div>
  ${alertsCard()}
  <div class="card"><h3>Settings &amp; backup</h3>
    <div class="field" style="max-width:200px"><label for="cur">Currency symbol</label><input type="text" id="cur" maxlength="4" value="${esc(db.currency)}"></div>
    ${cloudOn
      ? `<p class="muted" style="font-size:13px;margin:0 0 10px">Signed in as <b>${esc(user ? user.email : '')}</b>. Payments sync to every device signed in to this account. Import replaces the cloud data.</p>`
      : '<p class="muted" style="font-size:13px;margin:0 0 10px">Cloud sync is off: data is stored on this device only (see README to turn sync on). Use Export / Import to back up or move it.</p>'}
    <div class="btn-row">
      ${cloudOn ? '<button class="btn" data-action="signOut">Sign out</button>' : ''}
      <button class="btn" data-action="export">Export backup</button>
      <button class="btn" data-action="importPick">Import backup</button>
      <button class="btn" data-action="sample">Load sample data</button>
      <button class="btn danger" data-action="erase">Erase everything</button>
    </div>
    <input type="file" id="importFile" accept="application/json,.json" hidden>
  </div>`;
}

function render() {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  const main = $('#main');
  if (cloudOn && !user) return;
  if (ui.loading) { main.innerHTML = '<div class="empty-msg">Loading your payments…</div>'; return; }
  if (ui.tab === 'calendar') main.innerHTML = calendarView();
  else if (ui.tab === 'lookup') { main.innerHTML = lookupView(); renderResults(); }
  else main.innerHTML = payeesView();
}

/* ---------- payment form ---------- */
function openPaymentModal(id, date) {
  const editing = id ? db.payments.find(p => p.id === id) : null;
  if (!db.payees.length) {
    $('#overlay').innerHTML = `<div class="modal-wrap" data-action="closeModal"><div class="modal">
      <h2>Add a payee first</h2><p class="muted">Every payment belongs to a payee. Add one, then come back.</p>
      <div class="btn-row"><button class="btn primary" data-action="goPayees">Go to Payees</button><button class="btn" data-action="closeModal">Cancel</button></div></div></div>`;
    return;
  }
  const p = editing || { payeeId: ui.lastPayee && db.payees.some(x => x.id === ui.lastPayee) ? ui.lastPayee : db.payees[0].id, invoice: '', amount: '', date: date || ui.selected };
  const opts = [...db.payees].sort((a, b) => a.name.localeCompare(b.name))
    .map(x => `<option value="${x.id}" ${x.id === p.payeeId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#overlay').innerHTML = `<div class="modal-wrap" data-action="closeModal"><form class="modal" id="pf" data-id="${editing ? editing.id : ''}">
    <h2>${editing ? 'Edit payment' : 'New payment'}</h2>
    <div class="field"><label for="f-payee">Payee</label>
      <select id="f-payee" name="payee">${opts}<option value="__new">＋ New payee…</option></select>
      <input type="text" id="f-new" name="newPayee" placeholder="New payee name" style="margin-top:8px" hidden></div>
    <div class="field"><label for="f-inv">Invoice number</label>
      <input type="text" id="f-inv" name="invoice" value="${esc(p.invoice)}" autocomplete="off" required></div>
    <div class="field"><label for="f-amt">Amount</label>
      <input type="number" id="f-amt" name="amount" value="${esc(p.amount)}" step="0.01" min="0.01" inputmode="decimal" required></div>
    <div class="field"><label for="f-date">Payment date</label>
      <input type="date" id="f-date" name="date" value="${esc(p.date)}" required></div>
    <div class="err" id="f-err"></div>
    <div class="btn-row">
      <button class="btn primary" type="submit">Save</button>
      <button class="btn" type="button" data-action="closeModal">Cancel</button>
      ${editing ? '<button class="btn danger" type="button" data-action="deletePayment" style="margin-left:auto">Delete</button>' : ''}
    </div></form></div>`;
  if (!editing) setTimeout(() => $('#f-inv') && $('#f-inv').focus(), 50);
}
const closeModal = () => { $('#overlay').innerHTML = ''; };

function submitPayment(form) {
  const err = m => { $('#f-err').textContent = m; };
  let payeeId = form.payee.value, newPayee = null;
  if (payeeId === '__new') {
    const name = form.newPayee.value.trim();
    if (!name) return err('Enter the new payee name.');
    const found = db.payees.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (found) payeeId = found.id; else { newPayee = { id: uid(), name }; payeeId = newPayee.id; }
  }
  const invoice = form.invoice.value.trim();
  const amount = Math.round(parseFloat(form.amount.value) * 100) / 100;
  const date = form.date.value;
  if (!invoice) return err('Enter the invoice number.');
  if (!(amount > 0)) return err('Enter an amount greater than zero.');
  if (!date) return err('Pick a payment date.');
  const id = form.dataset.id;
  const pay = { id: id || uid(), payeeId, invoice, amount, date };
  closeModal();
  mutate(() => {
    if (newPayee) db.payees.push(newPayee);
    const existing = id && db.payments.find(p => p.id === id);
    if (existing) Object.assign(existing, pay); else db.payments.push(pay);
    ui.lastPayee = payeeId;
    ui.selected = date;
    ui.year = parseDate(date).getFullYear(); ui.month = parseDate(date).getMonth();
  }, async () => { if (newPayee) await remote.upsertPayee(newPayee); await remote.upsertPayment(pay); });
}

function addPayee(name) {
  if (db.payees.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
  const p = { id: uid(), name };
  mutate(() => db.payees.push(p), () => remote.upsertPayee(p));
}

/* ---------- events ---------- */
function shiftMonth(n) {
  const d = new Date(ui.year, ui.month + n, 1);
  ui.year = d.getFullYear(); ui.month = d.getMonth(); render();
}

function cleanImport(data) {      // validate a backup file and give every record a valid UUID
  const ids = new Map();
  const payees = data.payees.filter(p => p && typeof p.name === 'string' && p.name.trim())
    .map(p => { const id = UUID_RE.test(p.id) ? p.id : uid(); ids.set(p.id, id); return { id, name: p.name.trim() }; });
  const payments = data.payments.filter(p => p && ids.has(p.payeeId) && Number(p.amount) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .map(p => ({ id: UUID_RE.test(p.id) ? p.id : uid(), payeeId: ids.get(p.payeeId), invoice: String(p.invoice ?? ''), amount: Math.round(Number(p.amount) * 100) / 100, date: p.date }));
  return { payees, payments };
}

const actions = {
  tab: t => { ui.tab = t.dataset.tab; ui.sheet = false; window.scrollTo(0, 0); render(); if (ui.tab === 'payees') refreshPushState(); },
  prev: () => shiftMonth(-1),
  next: () => shiftMonth(1),
  today: () => { const n = new Date(); ui.year = n.getFullYear(); ui.month = n.getMonth(); ui.selected = todayStr(); ui.sheet = !isWide(); render(); },
  selectDate: t => { ui.selected = t.dataset.date; ui.sheet = true; render(); },
  closeSheet: () => { ui.sheet = false; render(); },
  addPayment: t => openPaymentModal(null, t.dataset.date),
  editPayment: t => openPaymentModal(t.dataset.id),
  deletePayment: () => {
    const id = $('#pf').dataset.id;
    if (!confirm('Delete this payment?')) return;
    closeModal();
    mutate(() => { db.payments = db.payments.filter(p => p.id !== id); }, () => remote.deletePayment(id));
  },
  closeModal: (t, e) => { if (e.target === t || t.tagName === 'BUTTON') closeModal(); },
  goPayees: () => { closeModal(); ui.tab = 'payees'; render(); },
  mode: t => { ui.mode = t.dataset.mode; render(); },
  renamePayee: t => {
    const pe = db.payees.find(p => p.id === t.dataset.id);
    const name = (prompt('Rename payee', pe.name) || '').trim();
    if (name) mutate(() => { pe.name = name; }, () => remote.upsertPayee(pe));
  },
  deletePayee: t => {
    const pe = db.payees.find(p => p.id === t.dataset.id);
    const n = db.payments.filter(p => p.payeeId === pe.id).length;
    if (!confirm(`Delete “${pe.name}”${n ? ` and its ${n} scheduled payment${n === 1 ? '' : 's'}` : ''}?`)) return;
    mutate(() => {
      db.payees = db.payees.filter(p => p.id !== pe.id);
      db.payments = db.payments.filter(p => p.payeeId !== pe.id);
    }, () => remote.deletePayee(pe.id));
  },
  sample: () => {
    if (db.payments.length && !confirm('Replace your current data with sample data?')) return;
    mutate(() => {
      Object.assign(db, sampleData());
      ui.year = now.getFullYear(); ui.month = now.getMonth(); ui.selected = todayStr();
    }, () => remote.replaceAll(db));
  },
  erase: () => {
    if (!confirm(cloudOn ? 'Erase all payees and payments from the cloud and every device? This cannot be undone.'
                         : 'Erase all payees and payments on this device? This cannot be undone.')) return;
    mutate(() => { db.payees = []; db.payments = []; }, () => remote.replaceAll(db));
  },
  signOut: async () => {
    const k = cacheKey();
    try { const sub = await pushSub(); if (sub) must(await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)); } catch (e) {}
    await sb.auth.signOut();
    stopRealtime(); if (k) try { localStorage.removeItem(k); } catch (e) {}
  },
  signUp: () => authSubmit('signUp'),
  alertsOn: async t => {
    t.disabled = true;
    try { await enableAlerts(Number($('#alertHour').value)); toast('Alerts are on for this device.'); }
    catch (e) { toast(e.message || 'Could not turn on alerts.'); }
    await refreshPushState(); render();
  },
  alertsOff: async () => { await disableAlerts(); toast('Alerts are off for this device.'); await refreshPushState(); render(); },
  alertsTest: async t => {
    t.disabled = true;
    const sub = await pushSub();
    const { data, error } = await sb.functions.invoke('send-due-alerts', { body: { test: true, endpoint: sub && sub.endpoint } });
    t.disabled = false;
    if (error) {
      let m = error.message; try { m = (await error.context.json()).error || m; } catch (e) {}
      return toast(`Test failed: ${m}. Is the send-due-alerts function deployed? (see README)`);
    }
    toast(data && data.sent ? 'Test sent — it should arrive in a few seconds.' : 'No device to notify. Try turning alerts off and on again.');
  },
  export: () => {
    const blob = new Blob([JSON.stringify({ currency: db.currency, payees: db.payees, payments: db.payments }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `payment-calendar-${todayStr()}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  importPick: () => $('#importFile').click(),
};

document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  // clicks inside a modal box must not trigger the backdrop's close action
  if (t.dataset.action === 'closeModal' && t.classList.contains('modal-wrap') && e.target !== t) return;
  const fn = actions[t.dataset.action];
  if (fn) fn(t, e);
});

document.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'pf') submitPayment(e.target);
  else if (e.target.id === 'authForm') authSubmit('signIn');
  else if (e.target.id === 'payeeForm') {
    const name = $('#newPayee').value.trim();
    if (name) { addPayee(name); setTimeout(() => $('#newPayee') && $('#newPayee').focus(), 0); }
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'q') { ui.q = e.target.value; renderResults(); }
  else if (e.target.id === 'cur') { db.currency = e.target.value; lsSet(CUR_KEY, db.currency); save(); }
});

document.addEventListener('change', e => {
  if (e.target.id === 'past') { ui.past = e.target.checked; renderResults(); }
  else if (e.target.id === 'alertHour') {
    const h = Number(e.target.value);
    if (ui.push && ui.push.on) { lsSet(ALERT_KEY, String(h)); ui.push.hour = h; resyncAlerts().then(() => toast(`Alert time set to ${hourLabel(h)}.`)); }
  } else if (e.target.id === 'cur') resyncAlerts();
  else if (e.target.id === 'f-payee') {
    const n = $('#f-new'); n.hidden = e.target.value !== '__new'; if (!n.hidden) n.focus();
  } else if (e.target.id === 'importFile') {
    const file = e.target.files[0]; if (!file) return;
    file.text().then(txt => {
      const data = JSON.parse(txt);
      if (!Array.isArray(data.payees) || !Array.isArray(data.payments)) throw new Error('bad file');
      const clean = cleanImport(data);
      if (!confirm(`Import ${clean.payees.length} payees and ${clean.payments.length} payments? This replaces the data ${cloudOn ? 'in the cloud (all devices)' : 'on this device'}.`)) return;
      mutate(() => { db.payees = clean.payees; db.payments = clean.payments; }, () => remote.replaceAll(db));
    }).catch(() => alert('That file is not a valid Payment Calendar backup.'));
    e.target.value = '';
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); if (ui.sheet) { ui.sheet = false; render(); } } });

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
addEventListener('online', refresh);
addEventListener('offline', () => setOnline(false));
boot();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
