/* ==========================================================================================================
   mb-ui.js 1.0.1  ·  2026-10-17  ·  SHARED FILE: copy it into every mcbflow.com app UNCHANGED.
   If you ever edit it, raise VERSION (below and on line 2), add a row to "SHARED FILES/SHARED-FILES-VERSIONS.md"
   and copy the new file into every app. No dependencies, no network, nothing leaves the device.
   Styles itself with the app's own CSS variables (--accent, --surface, --ink, --border, --r …), light and dark.
   ----------------------------------------------------------------------------------------------------------
   The pieces every app shows the same way (SUITE-STANDARDS §14, decided 2026-10-17):

   MBUI.toast(msg, { action: { label: 'Undo', fn }, ms: 4500 })      (or actions: [two at most], e.g. Add size + Undo)
        The one small message. Centered at the bottom (above the phone bottom bar), newest replaces the old one.
        msg is plain text. Returns { close() }.
   MBUI.sheet({ title: 'More', items: [{ label, sub, icon: '<svg…>', onClick, current }], opener })
        The phone "More" menu: a bottom sheet with a title, ✕, and one row per item (icon · label · chevron).
        Order inside: Settings, the app's other views, Help, What's new. Esc / backdrop / ✕ close; focus returns to opener.
   MBUI.whatsNew({ app: 'Money', releases: [{ version: '1.8', date: '2026-10-17', items: ['…'] }
                                            | { version, date, groups: { New: [], Improved: [], Fixed: [] } }] })
        The one What's new dialog: "What's new in Money", entries "Version 1.8 · Oct 17, 2026", newest first marked Latest.
   MBUI.search.setup({ placeholder: 'Search transactions…', run: q => [{ title, sub, tag, onSelect }] })
        One search overlay; "/" and Ctrl/Cmd+K open it (not while typing in a field). MBUI.search.open(q) opens it from a button.
   MBUI.empty(el, { title: 'No transactions yet', text: 'One line on why it matters.', action: { label, fn } })
        The empty-screen block: small accent sprout art, title, one line, one primary button.
   MBUI.sample(el, { onRemove, text })
        The one sample-data notice: "You're looking at sample data." + [Remove sample data].
   MBUI.dateLine(date)   → "Saturday, Oct 17"   (first part of every welcome-banner subtitle)
   MBUI.fileName(key, kind, ext, date) → "money-backup-2026-10-17.json"   (kind: backup | transactions | …)
   MBUI.savedTheme(app) → 'light' | 'dark'  The person's saved choice. A static page (404, Privacy, Terms) with
        <html data-mb-app="money"> and <script src="/mb-ui.js"> in <head> gets data-theme set before first paint.
   ========================================================================================================== */
(function () {
'use strict';
const VERSION = '1.0.1';
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const IC = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'
};
const SPROUT = '<svg class="mbu-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false"><path class="s" transform="translate(80 98)" d="M-48 2.2 C-48 -15.8 26.4 -16.5 48 -1.5 C49 14.2 -26.4 16.5 -48 2.2Z"/><path class="sd" d="M80 92 C75.6 71.8 83.3 54 80 41.4"/><path class="d" transform="translate(80 41.4) rotate(-38) scale(0.5)" d="M0 0 C 20 -34 66 -40 96 -6 C 70 28 22 34 0 0Z"/><path class="m" transform="translate(80 52.5) rotate(-150) scale(0.4)" d="M0 0 C 20 -34 66 -40 96 -6 C 70 28 22 34 0 0Z"/><circle class="b" cx="122" cy="40" r="7"/><path class="m" transform="translate(40 104)" d="M-13 0.9 C-13 -6.3 7.2 -6.6 13 -0.6 C13.3 5.7 -7.2 6.6 -13 0.9Z"/></svg>';

const CSS = `
.mbu-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147482000;display:flex;align-items:center;gap:12px;
  max-width:min(520px,calc(100vw - 24px));box-sizing:border-box;padding:10px 12px 10px 16px;border-radius:var(--r,6px);background:var(--ink,#1b1f24);color:var(--surface,#fff);
  font:500 14px/1.4 var(--font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);box-shadow:0 8px 24px rgba(0,0,0,.22)}
.mbu-toast[hidden]{display:none}
.mbu-toast .t{min-width:0;overflow-wrap:anywhere}
.mbu-toast button{flex:none;min-height:32px;padding:0 10px;border:0;border-radius:var(--r-sm,4px);background:transparent;color:inherit;font:inherit;font-weight:650;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.mbu-toast button:hover{background:rgba(127,127,127,.18)}
.mbu-toast button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.mbu-toast .x{width:32px;padding:0;text-decoration:none;opacity:.75}
.mbu-toast .x svg{width:16px;height:16px;display:block;margin:auto}
@media (max-width:767px){ .mbu-toast{bottom:calc(72px + env(safe-area-inset-bottom));width:calc(100vw - 24px)} }
@media (prefers-reduced-motion:no-preference){ .mbu-toast{animation:mbu-up .16s ease-out} @keyframes mbu-up{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}} }

.mbu-dlg{border:1px solid var(--border,#dfe2e7);border-radius:var(--r-lg,8px);padding:0;background:var(--surface,#fff);color:var(--ink,#1b1f24);box-shadow:0 18px 50px rgba(0,0,0,.25);
  font:14px/1.5 var(--font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);box-sizing:border-box;max-width:calc(100vw - 24px);max-height:calc(100dvh - 32px)}
.mbu-dlg::backdrop{background:rgba(10,12,16,.45)}
.mbu-dlg[open]{display:flex;flex-direction:column}
.mbu-hd{display:flex;align-items:center;gap:8px;padding:14px 12px 10px 20px;border-bottom:1px solid var(--border,#dfe2e7)}
.mbu-hd h2{flex:1;min-width:0;margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}
.mbu-x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;border:0;border-radius:var(--r-sm,4px);background:none;color:var(--muted,#5f6773);cursor:pointer}
.mbu-x:hover{background:var(--surface-2,#f3f4f6);color:var(--ink,#1b1f24)}
.mbu-x:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mbu-x svg{width:18px;height:18px}
.mbu-bd{overflow:auto;padding:14px 20px}
.mbu-ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px 16px;border-top:1px solid var(--border,#dfe2e7)}
.mbu-b{min-height:38px;padding:0 16px;border-radius:var(--r-sm,4px);border:1px solid var(--border-strong,#c6cbd3);background:var(--surface,#fff);color:var(--ink,#1b1f24);font:inherit;font-size:14px;font-weight:550;cursor:pointer;white-space:nowrap}
.mbu-b:hover{background:var(--surface-2,#f6f7f9)}
.mbu-b:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mbu-b.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,#fff)}

/* More sheet */
.mbu-sheet{width:min(440px,calc(100vw - 24px))}
@media (max-width:767px){
  .mbu-sheet{width:100vw;max-width:100vw;margin:auto 0 0;border-radius:var(--r-lg,8px) var(--r-lg,8px) 0 0;border-bottom:0;max-height:80dvh;padding-bottom:env(safe-area-inset-bottom)}
  @media (prefers-reduced-motion:no-preference){ .mbu-sheet[open]{animation:mbu-sheet .18s ease-out} @keyframes mbu-sheet{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}} }
}
.mbu-sheet .mbu-bd{padding:6px 8px 10px}
.mbu-row{display:flex;align-items:center;gap:12px;width:100%;min-height:48px;padding:0 12px;border:0;border-radius:var(--r,6px);background:none;color:var(--ink,#1b1f24);font:inherit;font-size:15px;font-weight:500;text-align:left;text-decoration:none;cursor:pointer;box-sizing:border-box}
.mbu-row:hover{background:var(--surface-2,#f3f4f6)}
.mbu-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.mbu-row .ic{flex:none;display:inline-flex;width:22px;height:22px;color:var(--ink-2,#48505c)}
.mbu-row .ic svg{width:22px;height:22px}
.mbu-row .lb{flex:1;min-width:0}
.mbu-row .lb small{display:block;font-size:12.5px;font-weight:400;color:var(--muted,#5f6773)}
.mbu-row .ch{flex:none;width:18px;height:18px;color:var(--muted,#5f6773)}
.mbu-row[aria-current="page"]{color:var(--accent);background:var(--accent-soft,var(--surface-2,#f3f4f6));font-weight:600}
.mbu-row[aria-current="page"] .ic{color:var(--accent)}
.mbu-sep{height:1px;margin:6px 12px;background:var(--border,#dfe2e7)}

/* What's new */
.mbu-wn{width:min(560px,calc(100vw - 24px))}
.mbu-rel{padding:4px 0 14px}
.mbu-rel + .mbu-rel{border-top:1px solid var(--border,#dfe2e7);padding-top:14px}
.mbu-rel h3{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:14.5px;font-weight:650}
.mbu-pill{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--r-sm,4px);background:var(--accent-soft,var(--surface-2,#eef0f3));color:var(--accent);font-size:11.5px;font-weight:650}
.mbu-rt{margin:0 0 6px;color:var(--ink-2,#48505c)}
.mbu-rel h4{margin:10px 0 4px;font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#5f6773)}
.mbu-rel ul{margin:0;padding-left:20px;list-style:disc}
.mbu-rel li{margin:3px 0;color:var(--ink-2,#48505c)}

/* search */
.mbu-srch{width:min(620px,calc(100vw - 24px));margin-top:10vh}
@media (max-width:767px){ .mbu-srch{margin-top:12px} }
.mbu-sbox{display:flex;align-items:center;gap:10px;padding:10px 12px 10px 16px;border-bottom:1px solid var(--border,#dfe2e7)}
.mbu-sbox svg{flex:none;width:20px;height:20px;color:var(--muted,#5f6773)}
.mbu-sbox input{flex:1;min-width:0;min-height:40px;border:0;outline:0;background:transparent;color:var(--ink,#1b1f24);font:inherit;font-size:16px}
.mbu-res{list-style:none;margin:0;padding:6px;overflow:auto;max-height:min(60dvh,520px)}
.mbu-res li{margin:0}
.mbu-res button{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:6px 10px;border:0;border-radius:var(--r,6px);background:none;color:var(--ink,#1b1f24);font:inherit;text-align:left;cursor:pointer}
.mbu-res button .lb{flex:1;min-width:0}
.mbu-res button b{display:block;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mbu-res button small{display:block;color:var(--muted,#5f6773);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mbu-res button .tg{flex:none;font-size:11.5px;font-weight:600;color:var(--muted,#5f6773);text-transform:uppercase;letter-spacing:.05em}
.mbu-res button:hover,.mbu-res button.on{background:var(--surface-2,#f3f4f6)}
.mbu-res button.on{box-shadow:inset 2px 0 0 var(--accent)}
.mbu-none{padding:18px 16px;color:var(--muted,#5f6773)}
.mbu-hint{padding:8px 16px 12px;color:var(--muted,#5f6773);font-size:12px;border-top:1px solid var(--border,#dfe2e7)}
.mbu-hint kbd{font:inherit;font-weight:600}
@media (hover:none){ .mbu-hint{display:none} }

/* empty screen */
.mbu-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:28px 16px}
.mbu-empty .mbu-art{width:120px;height:90px;margin-bottom:4px}
.mbu-art .s{fill:color-mix(in srgb,var(--accent) 16%,var(--surface,#fff))}
.mbu-art .m{fill:color-mix(in srgb,var(--accent) 55%,var(--surface,#fff))}
.mbu-art .d{fill:var(--accent)}
.mbu-art .b{fill:#f6c768}
.mbu-art .sd{fill:none;stroke:var(--accent);stroke-width:3;stroke-linecap:round}
.mbu-empty h3{margin:0;font-size:16px;font-weight:650;color:var(--ink,#1b1f24)}
.mbu-empty p{margin:0;max-width:42ch;font-size:14px;color:var(--ink-2,#48505c)}
.mbu-empty .mbu-b{margin-top:8px}

/* sample-data notice */
.mbu-sample{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 12px 10px 14px;margin:0 0 16px;border:1px solid var(--border,#dfe2e7);border-left:3px solid var(--accent);
  border-radius:var(--r,6px);background:var(--surface,#fff);color:var(--ink-2,#48505c);font-size:14px}
.mbu-sample svg{flex:none;width:18px;height:18px;color:var(--accent)}
.mbu-sample .t{flex:1 1 220px;min-width:0}
.mbu-sample .t b{color:var(--ink,#1b1f24)}
.mbu-sample .mbu-b{min-height:34px;font-size:13.5px}`;

let styled = false;
function style() { if (styled) return; styled = true; const st = document.createElement('style'); st.setAttribute('data-mb-ui', VERSION); st.textContent = CSS; document.head.appendChild(st); }

/* ---------- dialog helper ---------- */
function dialog(cls, title, bodyHTML, footHTML, opener) {
  style();
  const d = document.createElement('dialog');
  d.className = 'mbu-dlg ' + cls;
  const id = 'mbu' + Math.random().toString(36).slice(2, 8);
  d.setAttribute('aria-labelledby', id);
  d.innerHTML = `<div class="mbu-hd"><h2 id="${id}">${esc(title)}</h2><button type="button" class="mbu-x" aria-label="Close">${IC.x}</button></div>` +
    `<div class="mbu-bd">${bodyHTML}</div>` + (footHTML ? `<div class="mbu-ft">${footHTML}</div>` : '');
  document.body.appendChild(d);
  const back = opener || document.activeElement;
  d.querySelector('.mbu-x').onclick = () => d.close();
  d.addEventListener('click', e => { if (e.target === d) d.close(); });          // backdrop
  d.addEventListener('close', () => { d.remove(); if (back && back.focus) try { back.focus(); } catch (e) {} });
  d.showModal();
  return d;
}

/* ---------- toast ---------- */
let toastEl = null, toastTimer = 0;
function toast(msg, opts) {
  opts = opts || {}; style();
  if (!toastEl) {
    toastEl = document.createElement('div'); toastEl.className = 'mbu-toast'; toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); toastEl.hidden = true;
    document.body.appendChild(toastEl);
  }
  clearTimeout(toastTimer);
  const acts = (opts.actions || (opts.action ? [opts.action] : [])).slice(0, 2), a = acts[0];
  toastEl.innerHTML = `<span class="t">${esc(msg)}</span>` + acts.map((x, i) => `<button type="button" class="act" data-i="${i}">${esc(x.label)}</button>`).join('') + `<button type="button" class="x" aria-label="Dismiss">${IC.x}</button>`;
  toastEl.hidden = false;
  const close = () => { clearTimeout(toastTimer); if (toastEl) toastEl.hidden = true; };
  toastEl.querySelectorAll('.act').forEach(b => { b.onclick = () => { close(); try { acts[+b.dataset.i].fn(); } catch (e) {} }; });
  toastEl.querySelector('.x').onclick = close;
  toastTimer = setTimeout(close, opts.ms || (a ? 7000 : 4500));
  return { close };
}

/* ---------- More sheet ---------- */
function sheet(opts) {
  opts = opts || {};
  const items = opts.items || [];
  const rows = items.map((it, i) => it === '-' ? '<div class="mbu-sep" role="separator"></div>' :
    `<button type="button" class="mbu-row" data-i="${i}"${it.current ? ' aria-current="page"' : ''}><span class="ic">${it.icon || ''}</span><span class="lb">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span><span class="ch">${IC.chev}</span></button>`).join('');
  const d = dialog('mbu-sheet', opts.title || 'More', rows, '', opts.opener);
  if (opts.opener) { opts.opener.setAttribute('aria-expanded', 'true'); d.addEventListener('close', () => opts.opener.setAttribute('aria-expanded', 'false')); }
  d.querySelectorAll('.mbu-row').forEach(b => b.addEventListener('click', () => { const it = items[+b.dataset.i]; d.close(); try { it.onClick && it.onClick(); } catch (e) {} }));
  const first = d.querySelector('.mbu-row'); if (first) setTimeout(() => { try { first.focus({ focusVisible: false }); } catch (e) { first.focus(); } }, 20);
  d.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const r = [...d.querySelectorAll('.mbu-row')], i = r.indexOf(document.activeElement);
    r[(i + (e.key === 'ArrowDown' ? 1 : -1) + r.length) % r.length].focus(); e.preventDefault();
  });
  return d;
}

/* ---------- What's new ---------- */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (m) return `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  const d = new Date(s); return isNaN(d) ? String(s || '') : `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function whatsNew(opts) {
  opts = opts || {};
  const rel = (opts.releases || []).map((r, i) => {
    let body = '';
    if (r.groups) for (const [k, list] of (Array.isArray(r.groups) ? r.groups : Object.entries(r.groups))) {
      if (list && list.length) body += `<h4>${esc(k)}</h4><ul>${list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    } else body = `<ul>${(r.items || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    return `<section class="mbu-rel"><h3>Version ${esc(r.version)}${r.date ? ' · ' + esc(shortDate(r.date)) : ''}${i === 0 ? ' <span class="mbu-pill">Latest</span>' : ''}</h3>${r.title ? `<p class="mbu-rt">${esc(r.title)}</p>` : ''}${body}</section>`;
  }).join('');
  const d = dialog('mbu-wn', `What’s new in ${opts.app || 'this app'}`, rel || '<p>No release notes yet.</p>', '<button type="button" class="mbu-b mbu-close">Close</button>', opts.opener);
  d.querySelector('.mbu-close').onclick = () => d.close();
  return d;
}

/* ---------- search ---------- */
const search = (() => {
  let cfg = null, bound = false;
  function typing(t) { return t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); }
  function bind() {
    if (bound) return; bound = true;
    document.addEventListener('keydown', e => {
      if (!cfg || document.querySelector('dialog[open]')) return;
      const w = document.querySelector('.mbw'); if (w && w.getClientRects().length && getComputedStyle(w).display !== 'none') return;   // not over the welcome screen
      const k = (e.key || '').toLowerCase();
      if ((k === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey) || (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target))) { e.preventDefault(); open(); }
    });
  }
  function setup(c) { cfg = Object.assign({ placeholder: 'Search…', limit: 30 }, c || {}); bind(); }
  function open(q, opener) {
    if (!cfg) return null;
    const d = dialog('mbu-srch', 'Search', `<div class="mbu-sbox">${IC.search}<input type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" aria-label="${esc(cfg.placeholder)}" placeholder="${esc(cfg.placeholder)}"></div><ul class="mbu-res" role="listbox" aria-label="Results"></ul><div class="mbu-hint"><kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close</div>`, '', opener);
    d.querySelector('.mbu-hd').style.display = 'none';
    d.querySelector('.mbu-bd').style.padding = '0';
    const inp = d.querySelector('input'), ul = d.querySelector('.mbu-res');
    let res = [], on = -1, seq = 0;
    const paint = () => {
      if (!inp.value.trim()) { ul.innerHTML = cfg.emptyHint ? `<li class="mbu-none">${esc(cfg.emptyHint)}</li>` : ''; return; }
      if (!res.length) { ul.innerHTML = `<li class="mbu-none">No matches for “${esc(inp.value.trim())}”</li>`; return; }
      ul.innerHTML = res.map((r, i) => `<li><button type="button" role="option" data-i="${i}" class="${i === on ? 'on' : ''}" aria-selected="${i === on}"><span class="lb"><b>${esc(r.title)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>${r.tag ? `<span class="tg">${esc(r.tag)}</span>` : ''}</button></li>`).join('');
      ul.querySelectorAll('button').forEach(b => b.onclick = () => pick(+b.dataset.i));
    };
    const pick = i => { const r = res[i]; if (!r) return; d.close(); try { r.onSelect && r.onSelect(); } catch (e) {} };
    const run = async () => {
      const q = inp.value.trim(), my = ++seq;
      let out = [];
      if (q) { try { out = await cfg.run(q); } catch (e) { out = []; } }
      if (my !== seq) return;
      res = (out || []).slice(0, cfg.limit); on = res.length ? 0 : -1; paint();
    };
    inp.addEventListener('input', run);
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!res.length) return; on = (on + (e.key === 'ArrowDown' ? 1 : -1) + res.length) % res.length; paint(); const b = ul.querySelector('button.on'); if (b) b.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (on >= 0) pick(on); }
      else if (e.key === 'Escape') { e.preventDefault(); d.close(); }   // one Esc closes (a search field would only clear its text first)
    });
    if (q) inp.value = q;
    inp.focus(); run();   // focus at once so the first keystrokes aren't lost
    return d;
  }
  return { setup, open };
})();

/* ---------- empty screen + sample notice ---------- */
function empty(el, o) {
  if (!el) return; style(); o = o || {};
  el.innerHTML = `<div class="mbu-empty">${SPROUT}<h3>${esc(o.title || 'Nothing here yet')}</h3>${o.text ? `<p>${esc(o.text)}</p>` : ''}${o.action ? '<button type="button" class="mbu-b pri"></button>' : ''}</div>`;
  if (o.action) { const b = el.querySelector('.mbu-b'); b.textContent = o.action.label; b.onclick = () => o.action.fn(); }
  return el.firstChild;
}
function sample(el, o) {
  if (!el) return; style(); o = o || {};
  el.innerHTML = `<div class="mbu-sample" role="note">${IC.info}<span class="t"><b>You’re looking at sample data.</b> ${esc(o.text || 'Remove it when you’re ready to add your own.')}</span><button type="button" class="mbu-b">Remove sample data</button></div>`;
  el.querySelector('.mbu-b').onclick = () => o.onRemove && o.onRemove();
  return el.firstChild;
}

/* ---------- formats ---------- */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dateLine(d) { d = d ? new Date(d) : new Date(); return `${DAYS[d.getDay()]}, ${MON[d.getMonth()]} ${d.getDate()}` + (d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ''); }
function fileName(key, kind, ext, d) {
  d = d ? new Date(d) : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${key}-${kind}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${ext}`;
}

/* ---------- the person's saved Light | Dark choice, for pages outside the app (404, Privacy, Terms) ---------- */
function savedTheme(app) {
  try {
    const g = k => localStorage.getItem(k), dark = v => v === 'dark' || v === 'night';
    let v = g(app + '.theme');
    if (v != null) { try { v = JSON.parse(v); } catch (e) {} return dark(v) ? 'dark' : 'light'; }
    for (const k of [app, app + '.prefs', app + '.reader', app + '.settings']) {
      const raw = g(k); if (!raw) continue;
      let o; try { o = JSON.parse(raw); } catch (e) { continue; }
      const t = o && (o.theme || (o.settings && o.settings.theme) || o.look);
      if (t) return dark(t) ? 'dark' : 'light';
    }
  } catch (e) {}
  return 'light';
}
// <html data-mb-app="money"> on a static page: apply the app's saved look before first paint (this file loads in <head>)
(function () {
  const h = document.documentElement, app = h && h.getAttribute('data-mb-app');
  if (!app) return;
  const t = savedTheme(app);
  h.setAttribute('data-theme', t); h.classList.toggle('dark', t === 'dark'); h.style.colorScheme = t;
})();

window.MBUI = { version: VERSION, toast, sheet, whatsNew, search, empty, sample, dateLine, fileName, shortDate, savedTheme };
})();
