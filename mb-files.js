/* ==========================================================================================================
   mb-files.js 1.0.0  ·  2026-10-16  ·  SHARED FILE: copy it into every mcbflow.com app UNCHANGED.
   If you ever edit it, raise VERSION (below and on line 2), add a row to "SHARED FILES/SHARED-FILES-VERSIONS.md"
   and copy the new file into every app. No dependencies, no network, nothing leaves the device.
   ----------------------------------------------------------------------------------------------------------
   MBFiles.view(file, opts)   Open a photo or file in the app instead of downloading it.
       file: a File/Blob, or { blob | url | dataUrl, name, type, size }.  opts: { list: [files…], index, onDelete }
       Photos: full-screen viewer (fit / actual size, ← → between photos, swipe, Esc).
       PDF, video, audio, text, CSV, JSON: shown inside the viewer.  Anything else: name, size, Open in new tab, Download.
       Needs CSP: img-src blob: data:  ·  media-src blob:  ·  frame-src blob:  (for PDFs)
   MBFiles.bind(root)         Any element inside root with [data-mbf-view] opens the viewer on click/Enter
                              (the app sets el._mbfFile = File/Blob/{…} or data-mbf-src / data-mbf-name / data-mbf-type).
   MBFiles.zip(entries)       → Promise<Blob>. entries: [{ name: 'photos/a.jpg', data: Blob|ArrayBuffer|Uint8Array|string }]
                              Compressed with the browser's own deflate when available, else stored.
   MBFiles.unzip(blob)        → Promise<[{ name, blob() , text() }]>  (reads stored + deflate zips)
   MBFiles.csv(rows, cols)    → string with a UTF-8 BOM, CRLF lines, quotes, and the spreadsheet formula guard.
   MBFiles.download(blob, name)  Plain download (the app's own "Save backup now" keeps its folder logic).
   MBFiles.size(bytes)        "1.2 MB"
   ========================================================================================================== */
(function () {
'use strict';
const VERSION = '1.0.0';

/* ---------- small helpers ---------- */
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
function size(n) {
  n = +n || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function extOf(name) { const m = /\.([a-z0-9]{1,6})$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
const EXT_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html' };
function kindOf(type, name) {
  type = (type || EXT_TYPE[extOf(name)] || '').toLowerCase();
  if (/^image\/(heic|heif)/.test(type)) return 'other';          // most browsers can't draw HEIC
  if (type === 'image/svg+xml') return 'image';
  if (/^image\//.test(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (/^video\//.test(type)) return 'video';
  if (/^audio\//.test(type)) return 'audio';
  if (/^text\/(plain|markdown|csv)|application\/json/.test(type)) return 'text';
  return 'other';
}
function norm(f) {
  if (!f) return null;
  if (typeof Blob !== 'undefined' && f instanceof Blob) return { blob: f, name: f.name || 'file', type: f.type, size: f.size };
  const o = Object.assign({}, f);
  if (!o.blob && o.dataUrl) o.url = o.dataUrl;
  if (o.blob) { o.type = o.type || o.blob.type; o.size = o.size != null ? o.size : o.blob.size; }
  o.name = o.name || 'file';
  return o;
}
function crc32Table() { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; }
let CRC; function crc32(u8) { CRC = CRC || crc32Table(); let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function toU8(d) {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (typeof Blob !== 'undefined' && d instanceof Blob) return new Uint8Array(await d.arrayBuffer());
  return new TextEncoder().encode(String(d == null ? '' : d));
}
async function deflate(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  try { const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw')); return new Uint8Array(await new Response(s).arrayBuffer()); } catch (e) { return null; }
}
async function inflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/* ---------- ZIP (write) ---------- */
async function zip(entries) {
  const parts = [], central = []; let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = new TextEncoder().encode(String(e.name).replace(/^\/+/, ''));
    const raw = await toU8(e.data);
    const crc = crc32(raw);
    let body = raw, method = 0;
    if (raw.length > 64 && !/\.(jpe?g|png|gif|webp|avif|heic|mp4|mov|webm|mp3|m4a|zip|pdf|epub)$/i.test(e.name)) {
      const z = await deflate(raw); if (z && z.length < raw.length) { body = z; method = 8; }
    }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, raw.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ---------- ZIP (read) ---------- */
async function unzip(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(u8.buffer);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('That file isn’t a readable .zip.');
  const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const out = [], dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('That .zip is damaged.');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (/\/$/.test(name)) continue;
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const data = u8.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error('That .zip uses a compression this browser can’t read.');
    let cache = null;
    const bytes = async () => cache || (cache = method === 8 ? await inflate(data) : data);
    out.push({ name, blob: async (type) => new Blob([await bytes()], { type: type || EXT_TYPE[extOf(name)] || '' }), text: async () => dec.decode(await bytes()) });
  }
  return out;
}

/* ---------- CSV ---------- */
function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // spreadsheet formula guard
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csv(rows, cols) {
  if (!rows || !rows.length) return '\uFEFF' + (cols ? cols.map(c => csvCell(c.label || c)).join(',') : '') + '\r\n';
  cols = cols || Object.keys(rows[0]).map(k => ({ key: k, label: k }));
  cols = cols.map(c => typeof c === 'string' ? { key: c, label: c } : c);
  const lines = [cols.map(c => csvCell(c.label)).join(',')];
  for (const r of rows) lines.push(cols.map(c => csvCell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------- viewer ---------- */
const CSS = `
.mbf{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:rgba(10,12,16,.92);color:#fff;
  font:14px/1.45 var(--font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);border:0;padding:0;margin:0;width:100%;height:100%;max-width:none;max-height:none}
.mbf:not([open]){display:none}
.mbf::backdrop{background:rgba(10,12,16,.92)}
.mbf-top{display:flex;align-items:center;gap:8px;min-height:56px;padding:8px 12px;padding-top:max(8px,env(safe-area-inset-top));background:rgba(0,0,0,.35)}
.mbf-name{flex:1;min-width:0}
.mbf-name b{display:block;font-size:14.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mbf-name small{display:block;font-size:12px;color:rgba(255,255,255,.7)}
.mbf-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;min-width:40px;padding:0 12px;border:1px solid rgba(255,255,255,.28);
  border-radius:var(--r-sm,6px);background:rgba(255,255,255,.08);color:#fff;font-family:inherit;font-weight:500;font-size:13.5px;line-height:1;cursor:pointer;text-decoration:none;white-space:nowrap}
.mbf-b:hover{background:rgba(255,255,255,.18)}
.mbf-b:focus-visible{outline:2px solid #fff;outline-offset:2px}
.mbf-b svg{width:18px;height:18px;flex:none}
.mbf-b.ic{padding:0;width:40px}
.mbf-b[hidden]{display:none}
.mbf-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:12px;touch-action:pan-y pinch-zoom}
.mbf-stage img{max-width:100%;max-height:100%;object-fit:contain;border-radius:2px;background:repeating-conic-gradient(#ffffff14 0 25%,#0000 0 50%) 0 0/16px 16px;cursor:zoom-in;user-select:none}
.mbf-stage.full{align-items:flex-start;justify-content:flex-start}
.mbf-stage.full img{max-width:none;max-height:none;cursor:zoom-out}
.mbf-stage video,.mbf-stage audio{max-width:100%;max-height:100%}
.mbf-stage iframe{width:100%;height:100%;border:0;background:#fff;border-radius:2px}
.mbf-stage pre{margin:0;width:100%;max-width:960px;height:100%;overflow:auto;padding:16px;background:var(--surface,#fff);color:var(--ink,#1b1f24);border-radius:var(--r,6px);
  font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.mbf-card{max-width:420px;padding:24px;border-radius:var(--r-lg,8px);background:var(--surface,#fff);color:var(--ink,#1b1f24);text-align:center}
.mbf-card .ext{display:inline-flex;align-items:center;justify-content:center;width:56px;height:64px;margin:0 auto 12px;border-radius:6px;background:var(--accent-soft,#eef0f3);color:var(--accent,#333);font-weight:700;font-size:13px;text-transform:uppercase}
.mbf-card b{display:block;font-size:15px;overflow-wrap:anywhere}
.mbf-card p{margin:6px 0 16px;color:var(--muted,#5f6773);font-size:13.5px}
.mbf-card .mbf-b{color:var(--ink,#1b1f24);border-color:var(--border-strong,#c6cbd3);background:var(--surface,#fff)}
.mbf-card .mbf-b.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,#fff)}
.mbf-card .row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.mbf-nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;padding:0;border-radius:50%;border:0;background:rgba(0,0,0,.45);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}
.mbf-nav:hover{background:rgba(0,0,0,.7)}.mbf-nav:focus-visible{outline:2px solid #fff}
.mbf-nav svg{width:22px;height:22px}
.mbf-nav.prev{left:12px}.mbf-nav.next{right:12px}
.mbf-count{font-size:12px;color:rgba(255,255,255,.75);padding:0 8px;white-space:nowrap}
@media (max-width:600px){ .mbf-b .lbl{display:none} .mbf-b{padding:0;width:40px} .mbf-nav{width:40px;height:40px} }
@media (prefers-reduced-motion:no-preference){ .mbf{animation:mbf-in .14s ease-out} @keyframes mbf-in{from{opacity:0}to{opacity:1}} }
[data-mbf-view]{cursor:zoom-in}`;
const I = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3M11 8v6M8 11h6"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>'
};
let styled = false, dlg = null, cur = null;
function ensureStyle() { if (!styled) { styled = true; const st = document.createElement('style'); st.setAttribute('data-mb-files', VERSION); st.textContent = CSS; document.head.appendChild(st); } }
function ensure() {
  ensureStyle();
  if (dlg) return dlg;
  dlg = document.createElement('dialog'); dlg.className = 'mbf'; dlg.setAttribute('aria-label', 'File viewer');
  dlg.innerHTML = `<div class="mbf-top"><div class="mbf-name"><b id="mbfName"></b><small id="mbfMeta"></small></div>
    <span class="mbf-count" id="mbfCount"></span>
    <button class="mbf-b" type="button" id="mbfZoom" aria-label="Actual size">${I.zoom}<span class="lbl">Actual size</span></button>
    <button class="mbf-b" type="button" id="mbfOpen" aria-label="Open in new tab">${I.ext}<span class="lbl">New tab</span></button>
    <button class="mbf-b" type="button" id="mbfDl" aria-label="Download">${I.dl}<span class="lbl">Download</span></button>
    <button class="mbf-b ic" type="button" id="mbfDel" aria-label="Delete" hidden>${I.del}</button>
    <button class="mbf-b ic" type="button" id="mbfX" aria-label="Close viewer">${I.x}</button></div>
    <div class="mbf-stage" id="mbfStage"></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector('#mbfX').onclick = close;
  dlg.querySelector('#mbfDl').onclick = () => { const f = cur && cur.list[cur.i]; if (f) getBlob(f).then(b => download(b, f.name)).catch(() => { if (f.url) window.open(f.url, '_blank', 'noopener'); }); };
  dlg.querySelector('#mbfOpen').onclick = () => { if (cur && cur.url) window.open(cur.url, '_blank', 'noopener'); };
  dlg.querySelector('#mbfZoom').onclick = () => { const s = dlg.querySelector('#mbfStage'); s.classList.toggle('full'); dlg.querySelector('#mbfZoom').setAttribute('aria-pressed', s.classList.contains('full')); };
  dlg.querySelector('#mbfDel').onclick = () => { if (cur && cur.onDelete) { const f = cur.list[cur.i]; close(); cur_onDelete(f); } };
  dlg.addEventListener('close', cleanup);
  dlg.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
  let sx = null;
  dlg.addEventListener('touchstart', e => { if (e.touches.length === 1) sx = e.touches[0].clientX; }, { passive: true });
  dlg.addEventListener('touchend', e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 60 && !dlg.querySelector('.mbf-stage.full')) step(dx < 0 ? 1 : -1); }, { passive: true });
  return dlg;
}
let pendingDelete = null;
function cur_onDelete(f) { if (pendingDelete) try { pendingDelete(f); } catch (e) {} }
async function getBlob(f) {
  if (f.blob) return f.blob;
  if (f.url) { const r = await fetch(f.url); return await r.blob(); }
  throw new Error('no data');
}
function cleanup() { if (cur && cur.url && cur.owned) URL.revokeObjectURL(cur.url); if (cur) cur.url = null; const s = dlg && dlg.querySelector('#mbfStage'); if (s) s.innerHTML = ''; if (cur && cur.opener && cur.opener.focus) try { cur.opener.focus(); } catch (e) {} }
function close() { if (dlg && dlg.open) dlg.close(); }
function step(d) { if (!cur || cur.list.length < 2) return; cur.i = (cur.i + d + cur.list.length) % cur.list.length; render(); }
async function render() {
  const f = cur.list[cur.i], stage = dlg.querySelector('#mbfStage');
  if (cur.url && cur.owned) URL.revokeObjectURL(cur.url);
  cur.owned = !!f.blob; cur.url = f.blob ? URL.createObjectURL(f.blob) : f.url || null;
  const kind = kindOf(f.type, f.name);
  dlg.querySelector('#mbfName').textContent = f.name;
  dlg.querySelector('#mbfMeta').textContent = [f.size ? size(f.size) : '', (extOf(f.name) || (f.type || '').split('/')[1] || '').toUpperCase()].filter(Boolean).join(' · ');
  dlg.querySelector('#mbfCount').textContent = cur.list.length > 1 ? `${cur.i + 1} of ${cur.list.length}` : '';
  dlg.querySelector('#mbfZoom').hidden = kind !== 'image';
  dlg.querySelector('#mbfOpen').hidden = !cur.url || kind === 'image';
  dlg.querySelector('#mbfDel').hidden = !cur.onDelete;
  stage.classList.remove('full');
  const nav = cur.list.length > 1 ? `<button class="mbf-nav prev" type="button" aria-label="Previous">${I.prev}</button><button class="mbf-nav next" type="button" aria-label="Next">${I.next}</button>` : '';
  if (!cur.url) { stage.innerHTML = card(f, 'This file isn’t on this device.', 'It was added on another device. Export a backup there and import it here to bring the file over.', false); return; }
  if (kind === 'image') {
    stage.innerHTML = `<img alt="${esc(f.alt || f.name)}" src="${esc(cur.url)}">` + nav;
    const img = stage.querySelector('img');
    img.onclick = () => dlg.querySelector('#mbfZoom').click();
    img.onerror = () => { stage.innerHTML = card(f, 'This photo can’t be shown in this browser.', 'Download it to open it in another app.', true) + nav; wireNav(stage); };
  } else if (kind === 'pdf') {
    stage.innerHTML = `<iframe title="${esc(f.name)}" src="${esc(cur.url)}"></iframe>`;
  } else if (kind === 'video') {
    stage.innerHTML = `<video controls playsinline preload="metadata" src="${esc(cur.url)}"></video>` + nav;
  } else if (kind === 'audio') {
    stage.innerHTML = `<audio controls preload="metadata" src="${esc(cur.url)}"></audio>` + nav;
  } else if (kind === 'text') {
    stage.innerHTML = '<pre>Loading…</pre>' + nav;
    try { const b = await getBlob(f); const t = await b.slice(0, 400000).text(); stage.querySelector('pre').textContent = t + (b.size > 400000 ? '\n\n… (showing the first 400 KB; download for the whole file)' : ''); }
    catch (e) { stage.innerHTML = card(f, 'This file couldn’t be read.', 'Try downloading it instead.', true) + nav; }
  } else {
    stage.innerHTML = card(f, 'No preview for this kind of file.', 'Your browser can’t show it here. Open it in a new tab or download it to open it in another app.', true) + nav;
  }
  wireNav(stage);
}
function wireNav(stage) {
  const p = stage.querySelector('.mbf-nav.prev'), n = stage.querySelector('.mbf-nav.next');
  if (p) p.onclick = () => step(-1); if (n) n.onclick = () => step(1);
  stage.querySelectorAll('.mbf-card [data-a]').forEach(b => b.onclick = () => dlg.querySelector(b.dataset.a === 'dl' ? '#mbfDl' : '#mbfOpen').click());
}
function card(f, title, text, actions) {
  const ext = extOf(f.name) || 'file';
  return `<div class="mbf-card"><span class="ext" aria-hidden="true">${esc(ext.slice(0, 4))}</span><b>${esc(f.name)}</b><p>${esc(title)} ${esc(text)}</p>` +
    (actions ? `<div class="row"><button class="mbf-b" type="button" data-a="open">${I.ext}<span>Open in new tab</span></button><button class="mbf-b pri" type="button" data-a="dl">${I.dl}<span>Download</span></button></div>` : '') + '</div>';
}
function view(file, opts) {
  opts = opts || {};
  const list = (opts.list && opts.list.length ? opts.list : [file]).map(norm).filter(Boolean);
  let i = opts.list ? Math.max(0, Math.min(list.length - 1, opts.index != null ? opts.index : opts.list.indexOf(file))) : 0;
  if (i < 0) i = 0;
  ensure();
  if (cur && cur.url && cur.owned) URL.revokeObjectURL(cur.url);
  cur = { list, i, url: null, owned: false, onDelete: opts.onDelete || null, opener: document.activeElement };
  pendingDelete = opts.onDelete || null;
  if (!dlg.open) dlg.showModal();
  render();
  setTimeout(() => { const x = dlg.querySelector('#mbfX'); if (x) x.focus(); }, 0);
}
function fileFromEl(el) {
  if (el._mbfFile) return el._mbfFile;
  const src = el.getAttribute('data-mbf-src') || (el.tagName === 'IMG' ? el.currentSrc || el.src : el.getAttribute('href'));
  return { url: src, name: el.getAttribute('data-mbf-name') || el.getAttribute('alt') || el.getAttribute('download') || 'file', type: el.getAttribute('data-mbf-type') || '' };
}
function bind(root) {
  root = root || document; ensureStyle();
  if (root._mbfBound) return; root._mbfBound = true;
  root.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('[data-mbf-view]'); if (!el || !root.contains(el)) return;
    e.preventDefault(); e.stopPropagation();
    const group = el.getAttribute('data-mbf-view');
    if (group) {
      const els = [...root.querySelectorAll(`[data-mbf-view="${CSS_ESC(group)}"]`)];
      view(null, { list: els.map(fileFromEl), index: els.indexOf(el) });
    } else view(fileFromEl(el));
  }, true);
  root.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-mbf-view]:not(button):not(a)')) { e.preventDefault(); e.target.click(); }
  });
}
function CSS_ESC(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

window.MBFiles = { version: VERSION, view, close, bind, zip, unzip, csv, download, size, kindOf };
})();
