/* mb-sync.js 1.0.2 · optional account sync for mcbflow.com apps (shared file: copy it unchanged into each app).
   Local-first: the app always saves to the device first; this file mirrors its records to the account
   database when the person is signed in. Signed out, it loads nothing extra and contacts no server.

   Usage (in the app):
     const sync = MBSync.create({
       app: 'payday',                      // app name, as allowed by the database
       label: 'Payday',
       toRecords()      { return { key: data, ... } },   // the app's data as independent records
       fromRecords(map) { ... },                          // rebuild app state from records, save locally, re-render
       hasData()        { return true/false },            // does this device hold the person's own data?
       onStatus(s)      { ... }                           // optional: show sync state in the app's UI
     });
     sync.changed();   // call after every local save
     sync.open();      // open the account dialog (sign in, or status + sign out)

   Merge rule: each record keeps the time it was last edited; the newest edit wins (the database enforces it too). */
(function () {
'use strict';

const SUPABASE_URL = 'https://rxvcjdwmvxhwbdwncfhj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_i786YYip9yEZ_KC0CwOcZw_q7yOIoyM';
const SESSION_KEY  = 'sb-rxvcjdwmvxhwbdwncfhj-auth-token';   // where supabase-js keeps the sign-in on this site
const ACCOUNT_URL  = 'https://mcbflow.com/account.html';
const LIB_SRC      = 'vendor/supabase.js';
const VERSION      = '1.0.2';
const PAGE = 1000, BATCH = 500, PUSH_DELAY = 1200, RETRY_MS = 30000;
const MAX_BYTES = 230000, BATCH_BYTES = 1000000;   // one record must fit the database's 256 KB limit; keep each upload request small
const OVERLAP_MS = 120000;   // re-read the last 2 minutes on each pull, so a slow save that lands late is never skipped

/* ---------- small helpers ---------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
// Key order doesn't matter: the database re-orders JSON keys, so compare a sorted form.
function stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function hash(v) {   // cyrb53
  const s = stable(v); let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
function hasSavedSignIn() { try { const t = JSON.parse(lsGet(SESSION_KEY) || 'null'); return !!(t && t.refresh_token); } catch (e) { return false; } }
function ago(ms) {
  if (!ms) return 'not yet';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ms).toLocaleDateString();
}
let libPromise = null;
function loadLib() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve();
  if (libPromise) return libPromise;
  libPromise = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = LIB_SRC; s.async = true;
    s.onload = () => res(); s.onerror = () => { libPromise = null; rej(new Error('The sync code didn’t load. Check your connection.')); };
    document.head.appendChild(s);
  });
  return libPromise;
}
function friendly(error) {
  const m = (error && (error.message || error.error_description)) || String(error || 'Something went wrong.');
  if (/invalid login credentials/i.test(m)) return 'That email and password don’t match an account.';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first: open the link in the email we sent you.';
  if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a few minutes and try again.';
  if (/failed to fetch|network|load failed/i.test(m)) return 'Can’t reach the sync server. Check your connection.';
  return m;
}

/* ---------- dialog (styled with the app's own colour variables) ---------- */
const CSS = `
.mbs-dlg{border:1px solid var(--border,#dfe2e7);border-radius:var(--r-lg,8px);padding:0;width:min(420px,calc(100% - 32px));background:var(--surface,#fff);color:var(--ink,#1b1f24);box-shadow:0 18px 50px rgba(0,0,0,.25)}
.mbs-dlg::backdrop{background:rgba(10,12,16,.45)}
.mbs-in{padding:20px 22px 18px;font-size:14px;line-height:1.55}
.mbs-in h2{margin:0 0 6px;font-size:18px}
.mbs-in p{margin:0 0 12px;color:var(--ink-2,#48505c)}
.mbs-f{display:block;margin:0 0 12px}
.mbs-f span{display:block;margin:0 0 5px;font-size:13px;font-weight:600;color:var(--ink-2,#48505c)}
.mbs-f input{width:100%;box-sizing:border-box;min-height:38px;padding:6px 10px;border:1px solid var(--border-strong,#c6cbd3);border-radius:var(--r-sm,4px);background:var(--surface,#fff);color:var(--ink,#1b1f24);font:inherit;font-size:15px}
.mbs-f input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.mbs-msg{margin:0 0 10px;font-size:13.5px}.mbs-msg:empty{display:none}
.mbs-msg.err{color:var(--crit,#c9302c)}.mbs-msg.ok{color:var(--good-ink,#0b7a35)}
.mbs-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:6px}
.mbs-b{min-height:36px;padding:0 14px;border-radius:var(--r-sm,4px);border:1px solid var(--border-strong,#c6cbd3);background:var(--surface,#fff);color:var(--ink,#1b1f24);font:inherit;font-size:14px;font-weight:550;cursor:pointer}
.mbs-b:hover{background:var(--surface-2,#f6f7f9)}
.mbs-b.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,#fff)}
.mbs-b.pri:hover{background:var(--accent-hover,var(--accent))}
.mbs-b:disabled{opacity:.55;cursor:not-allowed}
.mbs-links{margin:14px 0 0;padding-top:12px;border-top:1px solid var(--border,#dfe2e7);font-size:13px;color:var(--muted,#5f6773)}
.mbs-links a{color:var(--accent)}
.mbs-choice{display:block;width:100%;text-align:left;margin:0 0 8px;padding:10px 12px;border:1px solid var(--border-strong,#c6cbd3);border-radius:var(--r,6px);background:var(--surface,#fff);color:var(--ink,#1b1f24);font:inherit;cursor:pointer}
.mbs-choice:hover{border-color:var(--accent);background:var(--surface-2,#f6f7f9)}
.mbs-choice b{display:block;font-size:14px}.mbs-choice small{display:block;color:var(--muted,#5f6773);font-size:12.5px;margin-top:2px}
.mbs-stat{display:flex;gap:8px;align-items:center;margin:0 0 12px;font-size:13.5px}
.mbs-dot{width:8px;height:8px;border-radius:50%;background:var(--muted,#5f6773);flex:none}
.mbs-dot.on{background:var(--good,#16a34a)}.mbs-dot.warn{background:var(--warn,#e5a100)}.mbs-dot.err{background:var(--crit,#c9302c)}`;
let dlg = null;
function ensureDialog() {
  if (dlg) return dlg;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  dlg = document.createElement('dialog'); dlg.className = 'mbs-dlg'; dlg.setAttribute('aria-labelledby', 'mbsTitle');
  dlg.innerHTML = '<div class="mbs-in" id="mbsBody"></div>';
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  document.body.appendChild(dlg);
  return dlg;
}
function showDialog(html) {
  const d = ensureDialog(); d.querySelector('#mbsBody').innerHTML = html;
  if (!d.open) d.showModal();
  const f = d.querySelector('input,button.pri,.mbs-choice'); if (f) f.focus();
  return d;
}
async function busy(btn, fn) {
  const t = btn.textContent; btn.disabled = true; btn.textContent = 'Please wait…';
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = t; }
}

/* ---------- engine ---------- */
function create(o) {
  const APP = o.app, META_KEY = APP + '.sync';
  // meta: { uid, email, cursor (server time of last pull), h: {key: hash}, t: {key: edited ms}, dirty: {key: 1}, big: {key: 1}, last: ms }
  // toRecords() may throw to pause syncing (e.g. while demo data is loaded): nothing is sent or applied until it stops throwing.
  let meta = blankMeta();
  try { const m = JSON.parse(lsGet(META_KEY) || 'null'); if (m && typeof m === 'object') meta = Object.assign(blankMeta(), m); } catch (e) {}
  let sb = null, user = null, state = 'off', errorText = '', pushTimer = 0, retryTimer = 0, pulling = null, pushing = null, linking = false;

  function blankMeta() { return { v: 1, uid: null, email: '', cursor: null, h: {}, t: {}, dirty: {}, big: {}, last: 0 }; }
  function saveMeta() { lsSet(META_KEY, JSON.stringify(meta)); }
  function setState(s, err) {
    state = s; errorText = err || '';
    const info = status();
    if (o.onStatus) try { o.onStatus(info); } catch (e) {}
    if (dlg && dlg.open && dlg.dataset.mbsView === 'status') renderStatus();
  }
  function status() {
    return { signedIn: !!user, email: user ? user.email : '', state, error: errorText, lastSync: meta.last,
             pending: Object.keys(meta.dirty).length, tooBig: Object.keys(meta.big || {}).length, label: label() };
  }
  function label() {
    if (!user) return 'Sign in to sync';
    if (state === 'syncing') return 'Syncing…';
    if (state === 'offline') return 'Offline · will sync later';
    if (state === 'error') return 'Sync problem';
    if (Object.keys(meta.dirty).length) return 'Waiting to sync';
    const big = Object.keys(meta.big || {}).length;
    return 'Synced ' + ago(meta.last) + (big ? ` · ${big} too large` : '');
  }

  /* -- local change tracking: compare the app's records with what was last synced -- */
  // keepTime: differences found right after the app opens come from the app tidying its own data on load, not from
  // an edit (edits are tracked when they're saved), so they keep their old time and can't override newer edits from other devices.
  function track(keepTime) {
    if (!user || linking) return 0;
    let recs; try { recs = o.toRecords() || {}; } catch (e) { return 0; }
    const now = Date.now(); let n = 0;
    for (const k of Object.keys(recs)) {
      const hv = hash(recs[k]);
      if (meta.h[k] !== hv) { meta.h[k] = hv; meta.t[k] = keepTime ? (meta.t[k] || 1) : now; meta.dirty[k] = 1; n++; }
    }
    for (const k of Object.keys(meta.h)) {
      if (!(k in recs)) { delete meta.h[k]; meta.t[k] = now; meta.dirty[k] = 1; n++; }   // deleted locally → tombstone
    }
    if (n) saveMeta();
    return n;
  }
  function changed() {
    if (!user) return;
    if (track()) { if (state !== 'error' && state !== 'offline') setState('idle'); schedulePush(); }
  }
  function schedulePush(delay) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { push().catch(() => {}); }, delay == null ? PUSH_DELAY : delay);
  }
  function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(() => sync().catch(() => {}), RETRY_MS); }

  async function push() {
    if (!user || !sb) return;
    if (pushing) return pushing;
    pushing = (async () => {
      const keys = Object.keys(meta.dirty);
      if (!keys.length) return;
      if (!navigator.onLine) { setState('offline'); return; }
      setState('syncing');
      let recs; try { recs = o.toRecords() || {}; } catch (e) { setState('idle'); return; }   // paused by the app: send nothing
      if (!meta.big) meta.big = {};
      // A record too large for the database stays on this device (never sent as a deletion); it's retried when it changes.
      const sendable = keys.filter(k => {
        if (!(k in recs)) { delete meta.big[k]; return true; }
        let n = 0; try { n = new Blob([JSON.stringify(recs[k])]).size; } catch (e) {}
        if (n > MAX_BYTES) { meta.big[k] = 1; delete meta.dirty[k]; return false; }
        delete meta.big[k]; return true;
      });
      saveMeta();
      const batches = []; let cur = [], bytes = 0;
      for (const k of sendable) {
        let n = 200; try { if (k in recs) n += JSON.stringify(recs[k]).length; } catch (e) {}
        if (cur.length && (cur.length >= BATCH || bytes + n > BATCH_BYTES)) { batches.push(cur); cur = []; bytes = 0; }
        cur.push(k); bytes += n;
      }
      if (cur.length) batches.push(cur);
      for (const part of batches) {
        const rows = part.map(k => {
          const gone = !(k in recs);
          return { user_id: user.id, app: APP, key: k, data: gone ? null : recs[k], deleted: gone,
                   updated_at: new Date(meta.t[k] || Date.now()).toISOString() };
        });
        const sentT = part.map(k => meta.t[k]);
        const { error } = await sb.from('app_data').upsert(rows, { onConflict: 'user_id,app,key' });
        if (error) throw error;
        part.forEach((k, j) => {   // clear only if the record wasn't edited again while sending
          if (meta.t[k] === sentT[j]) { delete meta.dirty[k]; if (!(k in recs)) delete meta.t[k]; }
        });
        saveMeta();
      }
      meta.last = Date.now(); saveMeta(); setState('idle');
    })().catch(err => {
      const off = !navigator.onLine || /fetch|network|load failed/i.test(String(err && err.message));
      setState(off ? 'offline' : 'error', off ? '' : friendly(err)); scheduleRetry(); throw err;
    }).finally(() => { pushing = null; });
    return pushing;
  }

  async function fetchRows(since) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      let q = sb.from('app_data').select('key,data,updated_at,deleted,synced_at').eq('app', APP)
        .order('synced_at', { ascending: true }).order('key', { ascending: true }).range(from, from + PAGE - 1);
      if (since) q = q.gt('synced_at', since);
      const { data, error } = await q;
      if (error) throw error;
      out.push(...data);
      if (data.length < PAGE) break;
    }
    return out;
  }

  // Apply remote rows to the app: newest edit wins per record.
  function applyRows(rows, opts) {
    opts = opts || {};
    track(opts.startup);   // capture any local edit first, so it can win if it's newer
    let recs; try { recs = Object.assign({}, o.toRecords() || {}); } catch (e) { return 0; }   // paused by the app: apply later (cursor not moved)
    if (!meta.big) meta.big = {};
    let n = 0;
    for (const r of rows) {
      const rt = Date.parse(r.updated_at) || 0;
      if (!opts.force && (meta.dirty[r.key] || meta.big[r.key]) && (meta.t[r.key] || 0) > rt) continue;   // ours is newer; it will be pushed (or is too large to send)
      delete meta.big[r.key];
      if (r.deleted) {
        if (r.key in recs) { delete recs[r.key]; n++; }
        delete meta.h[r.key];
      } else {
        if (!(r.key in recs) || hash(recs[r.key]) !== hash(r.data)) { recs[r.key] = r.data; n++; }
        meta.h[r.key] = hash(r.data);
      }
      meta.t[r.key] = rt; delete meta.dirty[r.key];
      if (r.deleted) delete meta.t[r.key];
    }
    if (rows.length) meta.cursor = rows.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), meta.cursor || '');
    saveMeta();
    if (n) {
      linking = true;
      try { o.fromRecords(recs); } finally { linking = false; }
      // the app may normalise what it received (defaults, ids); remember that as the synced form
      try { const now = o.toRecords() || {}; for (const k of Object.keys(now)) if (!meta.dirty[k]) meta.h[k] = hash(now[k]); saveMeta(); } catch (e) {}
    }
    return n;
  }

  async function pull(startup) {
    if (!user || !sb) return 0;
    if (pulling) return pulling;
    pulling = (async () => {
      if (!navigator.onLine) { setState('offline'); return 0; }
      setState('syncing');
      const since = meta.cursor ? new Date(Date.parse(meta.cursor) - OVERLAP_MS).toISOString() : null;
      const rows = await fetchRows(since);
      const n = applyRows(rows, { startup });
      meta.last = Date.now(); saveMeta();
      setState('idle');
      return n;
    })().catch(err => {
      const off = !navigator.onLine || /fetch|network|load failed/i.test(String(err && err.message));
      setState(off ? 'offline' : 'error', off ? '' : friendly(err)); scheduleRetry(); throw err;
    }).finally(() => { pulling = null; });
    return pulling;
  }

  async function sync(startup) { if (!user) return; await pull(startup); track(startup); await push(); }

  /* -- first sign-in on this device: decide how local and account data combine -- */
  async function link() {
    linking = true;
    try {
      setState('syncing');
      const cloud = (await fetchRows(null)).filter(r => !r.deleted);
      const local = !!(o.hasData && o.hasData());
      const fresh = blankMeta(); fresh.uid = user.id; fresh.email = user.email || '';
      let choice = 'merge';
      if (cloud.length && local) choice = await askChoice(cloud.length);
      else if (cloud.length) choice = 'cloud';
      else choice = 'device';
      if (choice === 'cancel') { linking = false; await signOut(true); return; }
      let recs = null; try { recs = o.toRecords() || {}; } catch (e) {}
      if (!recs) { recs = {}; if (choice === 'device' && cloud.length) choice = 'cloud'; }   // app paused: never let an empty device wipe the account
      meta = fresh;
      const now = Date.now();
      if (choice === 'device') {
        for (const k of Object.keys(recs)) { meta.h[k] = hash(recs[k]); meta.t[k] = now; meta.dirty[k] = 1; }
        for (const r of cloud) if (!(r.key in recs)) { meta.t[r.key] = now; meta.dirty[r.key] = 1; }  // remove cloud-only records
        meta.cursor = cloud.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), '');
        saveMeta(); linking = false; await push();
      } else {
        // cloud: the account's copy replaces this device's; merge: keep both, the account's copy wins where both have the same record
        const merged = choice === 'cloud' ? {} : Object.assign({}, recs);
        for (const r of cloud) merged[r.key] = r.data;
        const keepLocal = choice === 'merge' ? Object.keys(recs).filter(k => !cloud.some(r => r.key === k)) : [];
        linking = true; o.fromRecords(merged); linking = false;
        const after = o.toRecords() || {};
        for (const r of cloud) { meta.h[r.key] = hash(after[r.key] !== undefined ? after[r.key] : r.data); meta.t[r.key] = Date.parse(r.updated_at) || now; }
        for (const k of keepLocal) { if (k in after) { meta.h[k] = hash(after[k]); meta.t[k] = now; meta.dirty[k] = 1; } }
        meta.cursor = cloud.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), '');
        saveMeta(); track(); await push(); await pull();
      }
      meta.last = Date.now(); saveMeta(); setState('idle');
    } catch (err) {
      linking = false; setState('error', friendly(err)); throw err;
    } finally { linking = false; }
  }
  function askChoice(count) {
    return new Promise(res => {
      const d = showDialog(`
        <h2 id="mbsTitle">This device already has ${esc(o.label)} data</h2>
        <p>Your account also has ${count.toLocaleString()} synced record${count === 1 ? '' : 's'}. How should they combine?</p>
        <button class="mbs-choice" data-c="merge" type="button"><b>Merge both (recommended)</b><small>Keeps everything. Where the same item is on both, the account’s copy is kept.</small></button>
        <button class="mbs-choice" data-c="cloud" type="button"><b>Use the account’s copy</b><small>Replaces this device’s ${esc(o.label)} data with what’s synced.</small></button>
        <button class="mbs-choice" data-c="device" type="button"><b>Use this device’s copy</b><small>Replaces the synced data with what’s on this device.</small></button>
        <p class="mbs-links">Not sure? Export a backup first from the app’s Data menu, then choose.</p>
        <div class="mbs-row"><button class="mbs-b" data-c="cancel" type="button">Cancel and sign out</button></div>`);
      d.dataset.mbsView = 'choice';
      const done = c => { d.onclose = null; d.close(); res(c); };
      d.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => done(b.dataset.c)));
      d.onclose = () => res('cancel');
    });
  }

  /* -- sign in / out -- */
  async function start() {
    await loadLib();
    if (sb) return;
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { if (user) { user = null; meta = blankMeta(); saveMeta(); setState('off'); } return; }
      if (session && session.user) user = session.user;
    });
    const { data } = await sb.auth.getSession();
    user = data && data.session ? data.session.user : null;
  }
  async function afterSignIn() {
    if (meta.uid !== user.id) await link();
    else await sync(true);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }
  async function signOut(silent) {
    clearTimeout(pushTimer); clearTimeout(retryTimer);
    if (sb) await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    user = null; meta = blankMeta(); saveMeta(); setState('off');
    if (!silent && dlg && dlg.open) dlg.close();
  }

  function renderSignIn(note) {
    const d = showDialog(`
      <h2 id="mbsTitle">Sync ${esc(o.label)} across your devices</h2>
      <p>Optional and free. Sign in with your mcbflow.com account; your data stays saved on this device too.</p>
      <form id="mbsForm" novalidate>
        <label class="mbs-f"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
        <label class="mbs-f"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <p class="mbs-msg ${note ? 'ok' : ''}" id="mbsMsg" role="alert">${esc(note || '')}</p>
        <div class="mbs-row"><button class="mbs-b" type="button" id="mbsCancel">Not now</button><button class="mbs-b pri" type="submit">Sign in</button></div>
      </form>
      <p class="mbs-links">No account yet, or forgot your password? <a href="${ACCOUNT_URL}" target="_blank" rel="noopener">Go to your mcbflow.com account page</a>, then come back and sign in here.</p>`);
    d.dataset.mbsView = 'signin';
    d.querySelector('#mbsCancel').onclick = () => d.close();
    d.querySelector('#mbsForm').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.currentTarget, out = d.querySelector('#mbsMsg');
      out.textContent = ''; out.className = 'mbs-msg';
      busy(f.querySelector('[type=submit]'), async () => {
        try {
          await start();
          const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
          if (error) throw error;
          user = data.user; d.close();
          await afterSignIn();
          renderStatus();
        } catch (err) { out.textContent = friendly(err); out.className = 'mbs-msg err'; }
      });
    });
  }
  function renderStatus() {
    if (!user) return renderSignIn();
    const s = status(), dot = s.state === 'error' ? 'err' : (s.state === 'offline' || s.pending) ? 'warn' : 'on';
    const d = showDialog(`
      <h2 id="mbsTitle">${esc(o.label)} sync</h2>
      <p>Signed in as <b>${esc(s.email)}</b>.</p>
      <div class="mbs-stat"><span class="mbs-dot ${dot}"></span><span>${esc(s.label)}${s.pending ? ` · ${s.pending} change${s.pending === 1 ? '' : 's'} waiting` : ''}</span></div>
      ${s.error ? `<p class="mbs-msg err">${esc(s.error)}</p>` : ''}
      ${s.tooBig ? `<p class="mbs-msg err">${s.tooBig === 1 ? 'One item is' : s.tooBig + ' items are'} too large to sync (over about 230 KB, usually from pasted images), so ${s.tooBig === 1 ? 'it stays' : 'they stay'} on this device only. ${s.tooBig === 1 ? 'It syncs' : 'They sync'} again once smaller.</p>` : ''}
      <p>Changes save on this device first and sync when you’re online. Photos and other files aren’t synced.</p>
      <div class="mbs-row"><button class="mbs-b" type="button" id="mbsOut">Sign out</button><button class="mbs-b" type="button" id="mbsNow">Sync now</button><button class="mbs-b pri" type="button" id="mbsClose">Done</button></div>
      <p class="mbs-links">Manage your account, export or delete synced data: <a href="${ACCOUNT_URL}" target="_blank" rel="noopener">mcbflow.com account page</a>. Signing out keeps this device’s data.</p>`);
    d.dataset.mbsView = 'status';
    d.querySelector('#mbsClose').onclick = () => d.close();
    d.querySelector('#mbsNow').onclick = e => busy(e.currentTarget, () => sync().catch(() => {}));
    d.querySelector('#mbsOut').onclick = e => busy(e.currentTarget, () => signOut());
  }
  function open() { if (user) renderStatus(); else renderSignIn(); }

  /* -- triggers -- */
  document.addEventListener('visibilitychange', () => {
    if (!user) return;
    if (document.visibilityState === 'visible') sync().catch(() => {});
    else if (Object.keys(meta.dirty).length) push().catch(() => {});
  });
  window.addEventListener('online', () => { if (user) sync().catch(() => {}); });
  window.addEventListener('offline', () => { if (user) setState('offline'); });
  window.addEventListener('storage', e => { if (e.key === META_KEY) { try { meta = Object.assign(blankMeta(), JSON.parse(e.newValue || 'null')); } catch (_) {} } });

  // Signed out: nothing loads and nothing is sent. Signed in: load the library, then sync.
  if (hasSavedSignIn()) {
    start().then(() => {
      if (!user) { meta = blankMeta(); saveMeta(); setState('off'); return; }
      setState('idle');
      return afterSignIn();
    }).catch(err => setState(navigator.onLine ? 'error' : 'offline', navigator.onLine ? friendly(err) : ''));
  } else if (meta.uid) { meta = blankMeta(); saveMeta(); }
  setTimeout(() => setState(state), 0);

  return { changed, open, sync: () => sync(), signOut: () => signOut(), status, version: VERSION };
}

window.MBSync = { create, version: VERSION };
})();
