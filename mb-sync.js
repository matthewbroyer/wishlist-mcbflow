/* ==========================================================================================================
   mb-sync.js 1.1.1  ·  2026-10-17  ·  SHARED FILE: copy it into every mcbflow.com app UNCHANGED.
   If you ever edit this file, raise VERSION (below and on line 2), add a row to the version table in
   "SHARED FILES/SHARED-FILES-VERSIONS.md" (9-step package) and copy the new file into EVERY app.
   The release checker FAILs any app whose mb-sync.js is older than, or different from, the kit copy.
   ----------------------------------------------------------------------------------------------------------
   What changed in 1.1.1 (layout only; no data or behaviour change):
     · Account dialog: space between the buttons and the divider line under them (the line touched the buttons),
       "Edit profile" stays on one line, long names/emails shorten with …, buttons share the row on phones,
       dialog never wider than the screen.
   What changed in 1.1.0 (from 1.0.2):
     · "Keep me signed in on this device" (on by default). Off = the sign-in lasts until the browser closes.
     · sync.button(el): standard top-bar account button ("Sign in" / avatar with a sync-status dot).
     · sync.card(el):   standard "Account & sync" card for the Settings page.
     · status().quietBackups: true while signed in and syncing fine, so apps tone down backup reminders.
     · Profile: a screen name and one of 28 paper-cutout profile pictures, chosen in the account dialog (Edit profile) or on
       mcbflow.com/account.html, saved on the account so every app shows the same picture and name.
     · sync.greet(el, {name}): "Good morning, Matthew" (screen name when signed in; the app's own local name or
       no name when signed out). Updates itself when the person signs in/out or edits the profile.
     · window event "mbsync:status" on every status change; MBSync.hasSavedSignIn() before create().
   Sync engine, records, merge rules and storage keys are unchanged from 1.0.2 (data-compatible).
   ==========================================================================================================

   Optional account sync for mcbflow.com apps.
   Local-first: the app always saves to the device first; this file mirrors its records to the account
   database when the person is signed in. Signed out, it loads nothing extra and contacts no server.

   Usage (in the app):
     const sync = MBSync.create({
       app: 'payday',                      // app name, as allowed by the database
       label: 'Payday',
       what: 'your shifts and paystubs',   // optional: shown on the Settings card ("Keeps … the same on …")
       note: 'Photos stay on each device.',// optional: one short line about what doesn't sync
       toRecords()      { return { key: data, ... } },   // the app's data as independent records
       fromRecords(map) { ... },                          // rebuild app state from records, save locally, re-render
       hasData()        { return true/false },            // does this device hold the person's own data?
       onStatus(s)      { ... }                           // optional: show sync state in the app's UI
     });
     sync.changed();          // call after every local save
     sync.open();             // open the account dialog (sign in, or status + sign out)
     sync.button(el);         // top bar: <button class="tb tb-acct" type="button"></button>
     sync.card(el);           // Settings page: <div class="mbs-card-host"></div>
     sync.greet(el, {name});  // start view greeting line, e.g. <p class="mb-greet"></p>

   Merge rule: each record keeps the time it was last edited; the newest edit wins (the database enforces it too). */
(function () {
'use strict';

const SUPABASE_URL = 'https://rxvcjdwmvxhwbdwncfhj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_i786YYip9yEZ_KC0CwOcZw_q7yOIoyM';
const SESSION_KEY  = 'sb-rxvcjdwmvxhwbdwncfhj-auth-token';   // where supabase-js keeps the sign-in on this site
const ACCOUNT_URL  = 'https://mcbflow.com/account.html';
const LIB_SRC      = 'vendor/supabase.js';
const VERSION      = '1.1.1';
const PAGE = 1000, BATCH = 500, PUSH_DELAY = 1200, RETRY_MS = 30000;
const MAX_BYTES = 230000, BATCH_BYTES = 1000000;   // one record must fit the database's 256 KB limit; keep each upload request small
const OVERLAP_MS = 120000;   // re-read the last 2 minutes on each pull, so a slow save that lands late is never skipped

/* ---------- small helpers ---------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v); return true; } catch (e) { return false; } }
function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
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
function hasToken(raw) { try { const t = JSON.parse(raw || 'null'); return !!(t && t.refresh_token); } catch (e) { return false; } }
// A sign-in kept on this device (localStorage) or one that lasts until the browser closes (sessionStorage).
function hasSavedSignIn() { return hasToken(lsGet(SESSION_KEY)) || hasToken(ssGet(SESSION_KEY)); }
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

/* ---------- profile pictures: 28 paper-cutout pictures (64×64, original art; preview: SHARED FILES/avatars/avatars-sheet.html),
   the same set in every app and on the account page. Ids are stored on the account — never rename or remove one. ---------- */
const AV = [
  ["sunset", "Sunset hills", "<rect width=\"64\" height=\"64\" fill=\"#FDBA74\"/><g transform=\"translate(0 1.3)\"><circle cx=\"40\" cy=\"26\" r=\"11\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"40\" cy=\"26\" r=\"11\" fill=\"#FFF1C2\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 44 C14 30 30 34 44 42 S60 40 66 36 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 44 C14 30 30 34 44 42 S60 40 66 36 V66 H-2Z\" fill=\"#F97316\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 52 C16 42 34 46 66 54 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 52 C16 42 34 46 66 54 V66 H-2Z\" fill=\"#C2410C\"/>"],
  ["night", "Night peaks", "<rect width=\"64\" height=\"64\" fill=\"#1E293B\"/><g transform=\"translate(0 1.3)\"><path d=\"M46 10a9 9 0 1 0 7 15 7.5 7.5 0 1 1-7-15Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M46 10a9 9 0 1 0 7 15 7.5 7.5 0 1 1-7-15Z\" fill=\"#FDE68A\"/><circle cx=\"16\" cy=\"14\" r=\"1.2\" fill=\"#E2E8F0\"/><circle cx=\"26\" cy=\"22\" r=\"1\" fill=\"#E2E8F0\"/><circle cx=\"10\" cy=\"28\" r=\".9\" fill=\"#E2E8F0\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 50 L18 26 L30 40 L40 30 L66 54 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 50 L18 26 L30 40 L40 30 L66 54 V66 H-2Z\" fill=\"#475569\"/><g transform=\"translate(0 0.8)\"><path d=\"M18 26 L23 32 L19 31 L15 34 Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M18 26 L23 32 L19 31 L15 34 Z\" fill=\"#F1F5F9\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 56 C18 48 40 50 66 58 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 56 C18 48 40 50 66 58 V66 H-2Z\" fill=\"#334155\"/>"],
  ["ocean", "Ocean waves", "<rect width=\"64\" height=\"64\" fill=\"#BAE6FD\"/><g transform=\"translate(0 1.3)\"><circle cx=\"22\" cy=\"22\" r=\"9\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"22\" cy=\"22\" r=\"9\" fill=\"#FDE047\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 38 Q8 32 16 38 T32 38 T48 38 T66 38 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 38 Q8 32 16 38 T32 38 T48 38 T66 38 V66 H-2Z\" fill=\"#38BDF8\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 47 Q8 41 16 47 T32 47 T48 47 T66 47 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 47 Q8 41 16 47 T32 47 T48 47 T66 47 V66 H-2Z\" fill=\"#0284C7\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 56 Q8 50 16 56 T32 56 T48 56 T66 56 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 56 Q8 50 16 56 T32 56 T48 56 T66 56 V66 H-2Z\" fill=\"#075985\"/>"],
  ["forest", "Pine forest", "<rect width=\"64\" height=\"64\" fill=\"#D9F99D\"/><g transform=\"translate(0 1.3)\"><path d=\"M20 14 L32 36 H8Z M20 26 L34 50 H6Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M20 14 L32 36 H8Z M20 26 L34 50 H6Z\" fill=\"#4D7C0F\"/><g transform=\"translate(0 1.3)\"><path d=\"M44 10 L56 34 H32Z M44 22 L59 48 H29Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M44 10 L56 34 H32Z M44 22 L59 48 H29Z\" fill=\"#3F6212\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 52 C20 46 44 46 66 52 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 52 C20 46 44 46 66 52 V66 H-2Z\" fill=\"#65A30D\"/><rect x=\"18.5\" y=\"50\" width=\"3\" height=\"5\" fill=\"#713F12\"/><rect x=\"42.5\" y=\"48\" width=\"3\" height=\"5\" fill=\"#713F12\"/>"],
  ["cactus", "Desert cactus", "<rect width=\"64\" height=\"64\" fill=\"#FED7AA\"/><g transform=\"translate(0 1.3)\"><circle cx=\"46\" cy=\"18\" r=\"8\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"46\" cy=\"18\" r=\"8\" fill=\"#FB923C\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 50 C20 44 44 46 66 50 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 50 C20 44 44 46 66 50 V66 H-2Z\" fill=\"#FDBA74\"/><g transform=\"translate(0 1.3)\"><path d=\"M28 54 V24 a5 5 0 0 1 10 0 V54Z M28 40 h-6 a4 4 0 0 1-4-4 v-8 a3 3 0 0 1 6 0 v6 h4Z M38 36 h5 v-7 a3 3 0 0 1 6 0 v9 a4 4 0 0 1-4 4 h-7Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M28 54 V24 a5 5 0 0 1 10 0 V54Z M28 40 h-6 a4 4 0 0 1-4-4 v-8 a3 3 0 0 1 6 0 v6 h4Z M38 36 h5 v-7 a3 3 0 0 1 6 0 v9 a4 4 0 0 1-4 4 h-7Z\" fill=\"#15803D\"/>"],
  ["fox", "Fox", "<rect width=\"64\" height=\"64\" fill=\"#FFEDD5\"/><g transform=\"translate(0 1.3)\"><path d=\"M12 12 L24 24 L40 24 L52 12 L52 34 L32 54 L12 34Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M12 12 L24 24 L40 24 L52 12 L52 34 L32 54 L12 34Z\" fill=\"#EA580C\"/><g transform=\"translate(0 1)\"><path d=\"M12 34 L32 54 L52 34 L42 32 L32 40 L22 32Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M12 34 L32 54 L52 34 L42 32 L32 40 L22 32Z\" fill=\"#FFF7ED\"/><path d=\"M15 16 L22 23 L16 27Z M49 16 L42 23 L48 27Z\" fill=\"#9A3412\"/><circle cx=\"24\" cy=\"31\" r=\"2.2\" fill=\"#1C1917\"/><circle cx=\"40\" cy=\"31\" r=\"2.2\" fill=\"#1C1917\"/><path d=\"M29.5 44 h5 l-2.5 3Z\" fill=\"#1C1917\"/>"],
  ["cat", "Cat", "<rect width=\"64\" height=\"64\" fill=\"#E9D5FF\"/><g transform=\"translate(0 1.3)\"><path d=\"M14 14 L24 24 Q32 21 40 24 L50 14 L50 38 Q50 54 32 54 Q14 54 14 38Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M14 14 L24 24 Q32 21 40 24 L50 14 L50 38 Q50 54 32 54 Q14 54 14 38Z\" fill=\"#64748B\"/><path d=\"M17 19 L22 24 L17 27Z M47 19 L42 24 L47 27Z\" fill=\"#F9A8D4\"/><ellipse cx=\"25\" cy=\"35\" rx=\"2.4\" ry=\"3.2\" fill=\"#FDE047\"/><ellipse cx=\"39\" cy=\"35\" rx=\"2.4\" ry=\"3.2\" fill=\"#FDE047\"/><ellipse cx=\"25\" cy=\"35\" rx=\".9\" ry=\"2.6\" fill=\"#1C1917\"/><ellipse cx=\"39\" cy=\"35\" rx=\".9\" ry=\"2.6\" fill=\"#1C1917\"/><path d=\"M30 42 h4 l-2 2.4Z\" fill=\"#F9A8D4\"/><path d=\"M20 44 h-8 M20 46.5 h-7 M44 44 h8 M44 46.5 h7\" stroke=\"#F1F5F9\" stroke-width=\"1\" stroke-linecap=\"round\"/>"],
  ["owl", "Owl", "<rect width=\"64\" height=\"64\" fill=\"#134E4A\"/><g transform=\"translate(0 1.3)\"><path d=\"M16 18 L22 24 Q32 18 42 24 L48 18 L48 44 Q48 56 32 56 Q16 56 16 44Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M16 18 L22 24 Q32 18 42 24 L48 18 L48 44 Q48 56 32 56 Q16 56 16 44Z\" fill=\"#A16207\"/><g transform=\"translate(0 0.8)\"><path d=\"M22 44 Q32 36 42 44 Q42 54 32 54 Q22 54 22 44Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M22 44 Q32 36 42 44 Q42 54 32 54 Q22 54 22 44Z\" fill=\"#FDE68A\"/><circle cx=\"25\" cy=\"32\" r=\"6\" fill=\"#FEF3C7\"/><circle cx=\"39\" cy=\"32\" r=\"6\" fill=\"#FEF3C7\"/><circle cx=\"25\" cy=\"32\" r=\"2.6\" fill=\"#1C1917\"/><circle cx=\"39\" cy=\"32\" r=\"2.6\" fill=\"#1C1917\"/><path d=\"M30 37 h4 l-2 4Z\" fill=\"#EA580C\"/><g transform=\"translate(0 0.8)\"><path d=\"M10 58 H54\" stroke=\"rgba(16,24,40,.22)\" stroke-width=\"4\" stroke-linecap=\"round\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M10 58 H54\" stroke=\"#78350F\" stroke-width=\"4\" stroke-linecap=\"round\" fill=\"none\"/>"],
  ["whale", "Whale", "<rect width=\"64\" height=\"64\" fill=\"#E0F2FE\"/><g transform=\"translate(0 1.3)\"><path d=\"M8 40 Q10 24 30 24 Q48 24 50 38 L58 30 L58 46 L50 42 Q46 52 28 52 Q10 52 8 40Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M8 40 Q10 24 30 24 Q48 24 50 38 L58 30 L58 46 L50 42 Q46 52 28 52 Q10 52 8 40Z\" fill=\"#1D4ED8\"/><g transform=\"translate(0 0.6)\"><path d=\"M10 42 Q14 50 28 50 Q42 50 46 44 Q30 46 10 42Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M10 42 Q14 50 28 50 Q42 50 46 44 Q30 46 10 42Z\" fill=\"#BFDBFE\"/><circle cx=\"20\" cy=\"34\" r=\"1.8\" fill=\"#0F172A\"/><path d=\"M28 20 Q26 13 21 12 M28 20 Q30 13 35 12 M28 20 V11\" stroke=\"#38BDF8\" stroke-width=\"2\" stroke-linecap=\"round\" fill=\"none\"/><g transform=\"translate(0 0.8)\"><path d=\"M-2 58 Q8 54 16 58 T32 58 T48 58 T66 58 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 58 Q8 54 16 58 T32 58 T48 58 T66 58 V66 H-2Z\" fill=\"#7DD3FC\"/>"],
  ["mushroom", "Mushroom", "<rect width=\"64\" height=\"64\" fill=\"#BBF7D0\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 54 C20 48 44 50 66 54 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 54 C20 48 44 50 66 54 V66 H-2Z\" fill=\"#4ADE80\"/><g transform=\"translate(0 1.3)\"><path d=\"M26 34 h12 v16 a6 3 0 0 1-12 0Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M26 34 h12 v16 a6 3 0 0 1-12 0Z\" fill=\"#FFF7ED\"/><g transform=\"translate(0 1.3)\"><path d=\"M12 36 Q12 14 32 14 Q52 14 52 36Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M12 36 Q12 14 32 14 Q52 14 52 36Z\" fill=\"#DC2626\"/><circle cx=\"24\" cy=\"25\" r=\"3\" fill=\"#FFF7ED\"/><circle cx=\"36\" cy=\"21\" r=\"2.4\" fill=\"#FFF7ED\"/><circle cx=\"43\" cy=\"30\" r=\"2\" fill=\"#FFF7ED\"/><circle cx=\"30\" cy=\"31\" r=\"1.6\" fill=\"#FFF7ED\"/>"],
  ["balloon", "Hot air balloon", "<rect width=\"64\" height=\"64\" fill=\"#CFFAFE\"/><g transform=\"translate(0 0.8)\"><path d=\"M8 50 Q16 44 24 50 Q30 46 36 50Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M8 50 Q16 44 24 50 Q30 46 36 50Z\" fill=\"#FFFFFF\"/><g transform=\"translate(0 1.3)\"><path d=\"M32 8 C18 8 14 20 18 30 L27 42 H37 L46 30 C50 20 46 8 32 8Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M32 8 C18 8 14 20 18 30 L27 42 H37 L46 30 C50 20 46 8 32 8Z\" fill=\"#E11D48\"/><g transform=\"translate(0 0.6)\"><path d=\"M32 8 C26 8 24 20 26 30 L29 42 H35 L38 30 C40 20 38 8 32 8Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M32 8 C26 8 24 20 26 30 L29 42 H35 L38 30 C40 20 38 8 32 8Z\" fill=\"#FDE047\"/><path d=\"M28 42 L29 47 M36 42 L35 47\" stroke=\"#78350F\" stroke-width=\"1.2\"/><g transform=\"translate(0 0.8)\"><rect x=\"28\" y=\"47\" width=\"8\" height=\"6\" rx=\"1\" fill=\"rgba(16,24,40,.22)\"/></g><rect x=\"28\" y=\"47\" width=\"8\" height=\"6\" rx=\"1\" fill=\"#92400E\"/>"],
  ["sailboat", "Sailboat", "<rect width=\"64\" height=\"64\" fill=\"#FEF9C3\"/><g transform=\"translate(0 1.3)\"><circle cx=\"48\" cy=\"16\" r=\"6\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"48\" cy=\"16\" r=\"6\" fill=\"#FB923C\"/><g transform=\"translate(0 1.3)\"><path d=\"M31 12 V42 H13Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M31 12 V42 H13Z\" fill=\"#FFFFFF\"/><g transform=\"translate(0 1.3)\"><path d=\"M34 18 V42 H48Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M34 18 V42 H48Z\" fill=\"#F87171\"/><g transform=\"translate(0 1.3)\"><path d=\"M12 44 H52 L46 52 H18Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M12 44 H52 L46 52 H18Z\" fill=\"#1E3A8A\"/><g transform=\"translate(0 0.8)\"><path d=\"M-2 56 Q8 52 16 56 T32 56 T48 56 T66 56 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 56 Q8 52 16 56 T32 56 T48 56 T66 56 V66 H-2Z\" fill=\"#0EA5E9\"/>"],
  ["lighthouse", "Lighthouse", "<rect width=\"64\" height=\"64\" fill=\"#1E3A8A\"/><path d=\"M32 16 L64 6 V26Z\" fill=\"#FDE68A\" opacity=\".35\"/><g transform=\"translate(0 1.3)\"><path d=\"M26 18 h12 l3 36 H23Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M26 18 h12 l3 36 H23Z\" fill=\"#F8FAFC\"/><path d=\"M25 28 h14 l.7 7 H24.3Z M24 42 h16 l.6 7 H23.4Z\" fill=\"#DC2626\"/><g transform=\"translate(0 0.8)\"><rect x=\"27\" y=\"12\" width=\"10\" height=\"7\" rx=\"1.5\" fill=\"rgba(16,24,40,.22)\"/></g><rect x=\"27\" y=\"12\" width=\"10\" height=\"7\" rx=\"1.5\" fill=\"#FDE047\"/><path d=\"M25 12 L32 6 L39 12Z\" fill=\"#DC2626\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 54 C14 50 24 52 34 54 S54 50 66 54 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 54 C14 50 24 52 34 54 S54 50 66 54 V66 H-2Z\" fill=\"#334155\"/>"],
  ["planet", "Planet", "<rect width=\"64\" height=\"64\" fill=\"#4C1D95\"/><circle cx=\"12\" cy=\"14\" r=\"1.2\" fill=\"#E9D5FF\"/><circle cx=\"52\" cy=\"50\" r=\"1.2\" fill=\"#E9D5FF\"/><circle cx=\"50\" cy=\"12\" r=\"1\" fill=\"#E9D5FF\"/><circle cx=\"14\" cy=\"50\" r=\".9\" fill=\"#E9D5FF\"/><g transform=\"translate(0 1.3)\"><circle cx=\"32\" cy=\"32\" r=\"14\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"32\" cy=\"32\" r=\"14\" fill=\"#F472B6\"/><path d=\"M19 28 Q32 24 45 30 Q32 34 19 28Z\" fill=\"#DB2777\"/><g transform=\"translate(0 0.8)\"><path d=\"M8 40 Q12 46 32 40 Q52 34 56 26 Q52 22 44 24 Q52 26 46 31 Q36 38 18 40 Q10 41 12 36 Q6 37 8 40Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M8 40 Q12 46 32 40 Q52 34 56 26 Q52 22 44 24 Q52 26 46 31 Q36 38 18 40 Q10 41 12 36 Q6 37 8 40Z\" fill=\"#FDE68A\"/>"],
  ["rocket", "Rocket", "<rect width=\"64\" height=\"64\" fill=\"#0F172A\"/><circle cx=\"12\" cy=\"12\" r=\"1\" fill=\"#CBD5E1\"/><circle cx=\"52\" cy=\"18\" r=\"1.2\" fill=\"#CBD5E1\"/><circle cx=\"48\" cy=\"48\" r=\"1\" fill=\"#CBD5E1\"/><g transform=\"translate(0 1.3)\"><path d=\"M32 8 C40 14 42 26 40 40 H24 C22 26 24 14 32 8Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M32 8 C40 14 42 26 40 40 H24 C22 26 24 14 32 8Z\" fill=\"#F1F5F9\"/><g transform=\"translate(0 0.8)\"><path d=\"M24 34 L16 44 L24 42Z M40 34 L48 44 L40 42Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M24 34 L16 44 L24 42Z M40 34 L48 44 L40 42Z\" fill=\"#EF4444\"/><circle cx=\"32\" cy=\"24\" r=\"4\" fill=\"#38BDF8\" stroke=\"#94A3B8\" stroke-width=\"1.5\"/><g transform=\"translate(0 0.6)\"><path d=\"M27 42 Q32 58 37 42Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M27 42 Q32 58 37 42Z\" fill=\"#F59E0B\"/>"],
  ["daisy", "Daisy", "<rect width=\"64\" height=\"64\" fill=\"#FBCFE8\"/><g transform=\"translate(0 1.3)\"><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(0 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(45 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(90 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(135 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(180 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(225 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(270 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(315 32 30)\"/></g><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"#FFFFFF\" transform=\"rotate(0 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"#FFFFFF\" transform=\"rotate(45 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"#FFFFFF\" transform=\"rotate(90 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"#FFFFFF\" transform=\"rotate(135 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"#FFFFFF\" transform=\"rotate(180 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"#FFFFFF\" transform=\"rotate(225 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"#FFFFFF\" transform=\"rotate(270 32 30)\"/><ellipse cx=\"32\" cy=\"18\" rx=\"5\" ry=\"10\" fill=\"#FFFFFF\" transform=\"rotate(315 32 30)\"/><g transform=\"translate(0 0.8)\"><circle cx=\"32\" cy=\"30\" r=\"7\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"32\" cy=\"30\" r=\"7\" fill=\"#FACC15\"/><g transform=\"translate(0 0.6)\"><path d=\"M31 44 h2 v18 h-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M31 44 h2 v18 h-2Z\" fill=\"#16A34A\"/><g transform=\"translate(0 0.6)\"><path d=\"M33 54 Q42 46 46 50 Q40 56 33 56Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M33 54 Q42 46 46 50 Q40 56 33 56Z\" fill=\"#22C55E\"/>"],
  ["tulips", "Tulips", "<rect width=\"64\" height=\"64\" fill=\"#FCE7F3\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 56 C20 50 44 52 66 56 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 56 C20 50 44 52 66 56 V66 H-2Z\" fill=\"#86EFAC\"/><path d=\"M22 30 V56 M42 26 V56\" stroke=\"#16A34A\" stroke-width=\"2.4\"/><g transform=\"translate(0 1.3)\"><path d=\"M15 20 L18 26 L22 18 L26 26 L29 20 V28 Q29 36 22 36 Q15 36 15 28Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M15 20 L18 26 L22 18 L26 26 L29 20 V28 Q29 36 22 36 Q15 36 15 28Z\" fill=\"#E11D48\"/><g transform=\"translate(0 1.3)\"><path d=\"M35 16 L38 22 L42 14 L46 22 L49 16 V24 Q49 32 42 32 Q35 32 35 24Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M35 16 L38 22 L42 14 L46 22 L49 16 V24 Q49 32 42 32 Q35 32 35 24Z\" fill=\"#F97316\"/><g transform=\"translate(0 0.6)\"><path d=\"M42 50 Q50 40 54 42 Q50 50 42 52Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M42 50 Q50 40 54 42 Q50 50 42 52Z\" fill=\"#22C55E\"/>"],
  ["bird", "Little bird", "<rect width=\"64\" height=\"64\" fill=\"#DBEAFE\"/><g transform=\"translate(0 1.3)\"><path d=\"M4 48 Q30 44 60 50\" stroke=\"rgba(16,24,40,.22)\" stroke-width=\"3.2\" stroke-linecap=\"round\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M4 48 Q30 44 60 50\" stroke=\"#78350F\" stroke-width=\"3.2\" stroke-linecap=\"round\" fill=\"none\"/><g transform=\"translate(0 0.6)\"><path d=\"M50 49 Q54 42 58 44 Q56 50 50 49Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M50 49 Q54 42 58 44 Q56 50 50 49Z\" fill=\"#22C55E\"/><g transform=\"translate(0 1.3)\"><path d=\"M18 40 Q16 24 30 22 Q42 22 42 32 L50 30 L44 38 Q40 46 28 46 Q20 46 18 40Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M18 40 Q16 24 30 22 Q42 22 42 32 L50 30 L44 38 Q40 46 28 46 Q20 46 18 40Z\" fill=\"#2563EB\"/><g transform=\"translate(0 0.6)\"><path d=\"M20 38 Q24 32 32 36 Q30 44 24 44 Q20 43 20 38Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M20 38 Q24 32 32 36 Q30 44 24 44 Q20 43 20 38Z\" fill=\"#F97316\"/><circle cx=\"34\" cy=\"28\" r=\"1.8\" fill=\"#0F172A\"/><path d=\"M41 29 L46 30 L41 32Z\" fill=\"#F59E0B\"/>"],
  ["koi", "Koi fish", "<rect width=\"64\" height=\"64\" fill=\"#14B8A6\"/><circle cx=\"14\" cy=\"16\" r=\"4\" fill=\"#5EEAD4\"/><circle cx=\"50\" cy=\"50\" r=\"5\" fill=\"#5EEAD4\"/><g transform=\"translate(0 1.3)\"><path d=\"M14 34 Q24 20 40 26 Q48 30 50 34 Q48 38 40 42 Q24 48 14 34Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M14 34 Q24 20 40 26 Q48 30 50 34 Q48 38 40 42 Q24 48 14 34Z\" fill=\"#FFFFFF\"/><path d=\"M24 26 Q30 30 28 38 Q22 36 20 30Z M36 28 Q42 30 40 38 Q36 36 34 32Z\" fill=\"#F97316\"/><g transform=\"translate(0 0.8)\"><path d=\"M48 34 L60 24 Q56 34 60 44Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M48 34 L60 24 Q56 34 60 44Z\" fill=\"#F97316\"/><circle cx=\"18\" cy=\"32\" r=\"1.6\" fill=\"#0F172A\"/>"],
  ["peak", "Snowy peak", "<rect width=\"64\" height=\"64\" fill=\"#E0E7FF\"/><g transform=\"translate(0 1.3)\"><circle cx=\"48\" cy=\"16\" r=\"6\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"48\" cy=\"16\" r=\"6\" fill=\"#FFFFFF\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 56 L26 16 L46 42 L52 36 L66 52 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 56 L26 16 L46 42 L52 36 L66 52 V66 H-2Z\" fill=\"#6366F1\"/><g transform=\"translate(0 0.8)\"><path d=\"M26 16 L33 26 L29 25 L25 29 L21 24Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M26 16 L33 26 L29 25 L25 29 L21 24Z\" fill=\"#FFFFFF\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 58 C18 52 40 54 66 60 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 58 C18 52 40 54 66 60 V66 H-2Z\" fill=\"#4338CA\"/>"],
  ["monstera", "Monstera leaf", "<rect width=\"64\" height=\"64\" fill=\"#FEF3C7\"/><g transform=\"translate(0 1.3)\"><path d=\"M32 56 C10 50 8 26 20 14 C28 8 40 8 46 14 C58 26 54 50 32 56Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M32 56 C10 50 8 26 20 14 C28 8 40 8 46 14 C58 26 54 50 32 56Z\" fill=\"#15803D\"/><path d=\"M32 56 V18\" stroke=\"#BBF7D0\" stroke-width=\"1.6\"/><path d=\"M20 24 L28 28 M16 34 L28 36 M18 44 L29 44 M44 24 L36 28 M48 34 L36 36 M46 44 L35 44\" stroke=\"#FEF3C7\" stroke-width=\"2.6\" stroke-linecap=\"round\"/>"],
  ["coffee", "Coffee", "<rect width=\"64\" height=\"64\" fill=\"#FDE68A\"/><path d=\"M26 10 Q22 14 26 18 Q30 22 26 26 M34 10 Q30 14 34 18 Q38 22 34 26\" stroke=\"#FFFFFF\" stroke-width=\"2.2\" stroke-linecap=\"round\" fill=\"none\" opacity=\".9\"/><g transform=\"translate(0 0.8)\"><ellipse cx=\"32\" cy=\"52\" rx=\"20\" ry=\"4\" fill=\"rgba(16,24,40,.22)\"/></g><ellipse cx=\"32\" cy=\"52\" rx=\"20\" ry=\"4\" fill=\"#FFFFFF\"/><g transform=\"translate(0 1.3)\"><path d=\"M16 30 H46 V40 Q46 52 31 52 Q16 52 16 40Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M16 30 H46 V40 Q46 52 31 52 Q16 52 16 40Z\" fill=\"#B45309\"/><g transform=\"translate(0 0.6)\"><path d=\"M46 33 h3 a5 5 0 0 1 0 10 h-4\" stroke=\"rgba(16,24,40,.22)\" stroke-width=\"3\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M46 33 h3 a5 5 0 0 1 0 10 h-4\" stroke=\"#B45309\" stroke-width=\"3\" fill=\"none\"/><ellipse cx=\"31\" cy=\"30\" rx=\"15\" ry=\"2.6\" fill=\"#78350F\"/>"],
  ["lemon", "Lemon slice", "<rect width=\"64\" height=\"64\" fill=\"#FEF08A\"/><g transform=\"translate(0 1.3)\"><circle cx=\"32\" cy=\"32\" r=\"20\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"32\" cy=\"32\" r=\"20\" fill=\"#FACC15\"/><g transform=\"translate(0 0.5)\"><circle cx=\"32\" cy=\"32\" r=\"16.5\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"32\" cy=\"32\" r=\"16.5\" fill=\"#FEF9C3\"/><path d=\"M32 32 L46.5 32.0 A14.5 14.5 0 0 1 43.1 41.3Z\" fill=\"#FDE047\" stroke=\"#FEF9C3\" stroke-width=\"1.6\"/><path d=\"M32 32 L42.3 42.3 A14.5 14.5 0 0 1 33.3 46.4Z\" fill=\"#FDE047\" stroke=\"#FEF9C3\" stroke-width=\"1.6\"/><path d=\"M32 32 L32.0 46.5 A14.5 14.5 0 0 1 22.7 43.1Z\" fill=\"#FDE047\" stroke=\"#FEF9C3\" stroke-width=\"1.6\"/><path d=\"M32 32 L21.7 42.3 A14.5 14.5 0 0 1 17.6 33.3Z\" fill=\"#FDE047\" stroke=\"#FEF9C3\" stroke-width=\"1.6\"/><path d=\"M32 32 L17.5 32.0 A14.5 14.5 0 0 1 20.9 22.7Z\" fill=\"#FDE047\" stroke=\"#FEF9C3\" stroke-width=\"1.6\"/><path d=\"M32 32 L21.7 21.7 A14.5 14.5 0 0 1 30.7 17.6Z\" fill=\"#FDE047\" stroke=\"#FEF9C3\" stroke-width=\"1.6\"/><path d=\"M32 32 L32.0 17.5 A14.5 14.5 0 0 1 41.3 20.9Z\" fill=\"#FDE047\" stroke=\"#FEF9C3\" stroke-width=\"1.6\"/><path d=\"M32 32 L42.3 21.7 A14.5 14.5 0 0 1 46.4 30.7Z\" fill=\"#FDE047\" stroke=\"#FEF9C3\" stroke-width=\"1.6\"/><circle cx=\"32\" cy=\"32\" r=\"2\" fill=\"#FEF9C3\"/>"],
  ["bear", "Bear", "<rect width=\"64\" height=\"64\" fill=\"#FDE68A\"/><g transform=\"translate(0 1.3)\"><circle cx=\"18\" cy=\"20\" r=\"7\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"46\" cy=\"20\" r=\"7\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"18\" cy=\"20\" r=\"7\" fill=\"#92400E\"/><circle cx=\"46\" cy=\"20\" r=\"7\" fill=\"#92400E\"/><circle cx=\"18\" cy=\"20\" r=\"3.5\" fill=\"#D97706\"/><circle cx=\"46\" cy=\"20\" r=\"3.5\" fill=\"#D97706\"/><g transform=\"translate(0 1.3)\"><ellipse cx=\"32\" cy=\"36\" rx=\"19\" ry=\"17\" fill=\"rgba(16,24,40,.22)\"/></g><ellipse cx=\"32\" cy=\"36\" rx=\"19\" ry=\"17\" fill=\"#92400E\"/><g transform=\"translate(0 0.6)\"><ellipse cx=\"32\" cy=\"43\" rx=\"9\" ry=\"7\" fill=\"rgba(16,24,40,.22)\"/></g><ellipse cx=\"32\" cy=\"43\" rx=\"9\" ry=\"7\" fill=\"#FCD34D\"/><circle cx=\"25\" cy=\"33\" r=\"2.2\" fill=\"#1C1917\"/><circle cx=\"39\" cy=\"33\" r=\"2.2\" fill=\"#1C1917\"/><ellipse cx=\"32\" cy=\"40\" rx=\"3.2\" ry=\"2.4\" fill=\"#1C1917\"/>"],
  ["penguin", "Penguin", "<rect width=\"64\" height=\"64\" fill=\"#BAE6FD\"/><g transform=\"translate(0 1.3)\"><path d=\"M-2 56 C20 52 44 52 66 56 V66 H-2Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M-2 56 C20 52 44 52 66 56 V66 H-2Z\" fill=\"#F8FAFC\"/><g transform=\"translate(0 1.3)\"><path d=\"M32 10 Q46 12 46 32 Q46 54 32 54 Q18 54 18 32 Q18 12 32 10Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M32 10 Q46 12 46 32 Q46 54 32 54 Q18 54 18 32 Q18 12 32 10Z\" fill=\"#1E293B\"/><g transform=\"translate(0 0.5)\"><path d=\"M32 22 Q41 24 41 36 Q41 52 32 52 Q23 52 23 36 Q23 24 32 22Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M32 22 Q41 24 41 36 Q41 52 32 52 Q23 52 23 36 Q23 24 32 22Z\" fill=\"#FFFFFF\"/><circle cx=\"27\" cy=\"22\" r=\"1.8\" fill=\"#FFFFFF\"/><circle cx=\"37\" cy=\"22\" r=\"1.8\" fill=\"#FFFFFF\"/><circle cx=\"27\" cy=\"22\" r=\".9\" fill=\"#0F172A\"/><circle cx=\"37\" cy=\"22\" r=\".9\" fill=\"#0F172A\"/><path d=\"M29 27 h6 l-3 3.5Z\" fill=\"#F59E0B\"/><path d=\"M26 54 h5 M33 54 h5\" stroke=\"#F59E0B\" stroke-width=\"2.4\" stroke-linecap=\"round\"/>"],
  ["rainbow", "Rainbow", "<rect width=\"64\" height=\"64\" fill=\"#E0F2FE\"/><g transform=\"translate(0 0.8)\"><path d=\"M8 46 A24 24 0 0 1 56 46\" stroke=\"rgba(16,24,40,.22)\" stroke-width=\"5\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M8 46 A24 24 0 0 1 56 46\" stroke=\"#EF4444\" stroke-width=\"5\" fill=\"none\"/><path d=\"M13 46 A19 19 0 0 1 51 46\" stroke=\"#F59E0B\" stroke-width=\"5\" fill=\"none\"/><path d=\"M18 46 A14 14 0 0 1 46 46\" stroke=\"#22C55E\" stroke-width=\"5\" fill=\"none\"/><path d=\"M23 46 A9 9 0 0 1 41 46\" stroke=\"#3B82F6\" stroke-width=\"5\" fill=\"none\"/><g transform=\"translate(0 1.3)\"><path d=\"M2 50 Q4 42 12 44 Q16 38 22 44 Q28 44 26 50Z M38 50 Q38 42 46 44 Q50 38 56 44 Q64 44 62 50Z\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M2 50 Q4 42 12 44 Q16 38 22 44 Q28 44 26 50Z M38 50 Q38 42 46 44 Q50 38 56 44 Q64 44 62 50Z\" fill=\"#FFFFFF\"/>"],
  ["blossom", "Cherry blossom", "<rect width=\"64\" height=\"64\" fill=\"#1E293B\"/><g transform=\"translate(0 1.3)\"><path d=\"M4 54 Q24 44 30 30 Q36 20 58 12\" stroke=\"rgba(16,24,40,.22)\" stroke-width=\"3\" stroke-linecap=\"round\" fill=\"rgba(16,24,40,.22)\"/></g><path d=\"M4 54 Q24 44 30 30 Q36 20 58 12\" stroke=\"#78350F\" stroke-width=\"3\" stroke-linecap=\"round\" fill=\"none\"/><g transform=\"translate(0 0.8)\"><circle cx=\"22.0\" cy=\"37.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"26.8\" cy=\"40.5\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"24.9\" cy=\"46.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"19.1\" cy=\"46.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"17.2\" cy=\"40.5\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"22\" cy=\"42\" r=\"2\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"22.0\" cy=\"37.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"26.8\" cy=\"40.5\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"24.9\" cy=\"46.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"19.1\" cy=\"46.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"17.2\" cy=\"40.5\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"22\" cy=\"42\" r=\"2\" fill=\"#DB2777\"/><g transform=\"translate(0 0.8)\"><circle cx=\"40.0\" cy=\"19.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"44.8\" cy=\"22.5\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"42.9\" cy=\"28.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"37.1\" cy=\"28.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"35.2\" cy=\"22.5\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"40\" cy=\"24\" r=\"2\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"40.0\" cy=\"19.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"44.8\" cy=\"22.5\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"42.9\" cy=\"28.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"37.1\" cy=\"28.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"35.2\" cy=\"22.5\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"40\" cy=\"24\" r=\"2\" fill=\"#DB2777\"/><g transform=\"translate(0 0.8)\"><circle cx=\"52.0\" cy=\"11.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"56.8\" cy=\"14.5\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"54.9\" cy=\"20.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"49.1\" cy=\"20.0\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"47.2\" cy=\"14.5\" r=\"3.6\" fill=\"rgba(16,24,40,.22)\"/><circle cx=\"52\" cy=\"16\" r=\"2\" fill=\"rgba(16,24,40,.22)\"/></g><circle cx=\"52.0\" cy=\"11.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"56.8\" cy=\"14.5\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"54.9\" cy=\"20.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"49.1\" cy=\"20.0\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"47.2\" cy=\"14.5\" r=\"3.6\" fill=\"#F9A8D4\"/><circle cx=\"52\" cy=\"16\" r=\"2\" fill=\"#DB2777\"/>"],
  ["turtle", "Sea turtle", "<rect width=\"64\" height=\"64\" fill=\"#99F6E4\"/><g transform=\"translate(0 1.3)\"><ellipse cx=\"18\" cy=\"20\" rx=\"7\" ry=\"3.5\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(-35 18 20)\"/><ellipse cx=\"46\" cy=\"20\" rx=\"7\" ry=\"3.5\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(35 46 20)\"/><ellipse cx=\"18\" cy=\"46\" rx=\"6\" ry=\"3\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(35 18 46)\"/><ellipse cx=\"46\" cy=\"46\" rx=\"6\" ry=\"3\" fill=\"rgba(16,24,40,.22)\" transform=\"rotate(-35 46 46)\"/><ellipse cx=\"32\" cy=\"12\" rx=\"5\" ry=\"6\" fill=\"rgba(16,24,40,.22)\"/></g><ellipse cx=\"18\" cy=\"20\" rx=\"7\" ry=\"3.5\" fill=\"#65A30D\" transform=\"rotate(-35 18 20)\"/><ellipse cx=\"46\" cy=\"20\" rx=\"7\" ry=\"3.5\" fill=\"#65A30D\" transform=\"rotate(35 46 20)\"/><ellipse cx=\"18\" cy=\"46\" rx=\"6\" ry=\"3\" fill=\"#65A30D\" transform=\"rotate(35 18 46)\"/><ellipse cx=\"46\" cy=\"46\" rx=\"6\" ry=\"3\" fill=\"#65A30D\" transform=\"rotate(-35 46 46)\"/><ellipse cx=\"32\" cy=\"12\" rx=\"5\" ry=\"6\" fill=\"#65A30D\"/><g transform=\"translate(0 1.3)\"><ellipse cx=\"32\" cy=\"34\" rx=\"15\" ry=\"17\" fill=\"rgba(16,24,40,.22)\"/></g><ellipse cx=\"32\" cy=\"34\" rx=\"15\" ry=\"17\" fill=\"#15803D\"/><path d=\"M32 22 L38 28 L36 38 L28 38 L26 28Z\" fill=\"#4D7C0F\"/><path d=\"M32 22 V17 M38 28 L45 25 M36 38 L41 45 M28 38 L23 45 M26 28 L19 25\" stroke=\"#4D7C0F\" stroke-width=\"2\"/><circle cx=\"30\" cy=\"10\" r=\"1\" fill=\"#0F172A\"/><circle cx=\"34\" cy=\"10\" r=\"1\" fill=\"#0F172A\"/>"]
];
const AV_IDS = AV.map(a => a[0]);
function avatarSVG(id, initialText) {
  const a = AV.find(x => x[0] === id);
  if (!a) return `<span class="mbs-av-l">${esc(initialText || '?')}</span>`;
  return `<span class="mbs-av-img"><svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">${a[2]}</svg></span>`;
}
function avatarLabel(id) { const a = AV.find(x => x[0] === id); return a ? a[1] : 'Your initial'; }
function partOfDay(d) { const h = (d || new Date()).getHours(); return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function greeting(name) { name = String(name || '').trim(); return partOfDay() + (name ? ', ' + name.split(/\s+/)[0].slice(0, 30) : ''); }

/* ---------- dialog (styled with the app's own colour variables) ---------- */
const CSS = `
.mbs-dlg{border:1px solid var(--border,#dfe2e7);border-radius:var(--r-lg,8px);padding:0;width:min(420px,calc(100vw - 24px));max-width:calc(100vw - 24px);box-sizing:border-box;background:var(--surface,#fff);color:var(--ink,#1b1f24);box-shadow:0 18px 50px rgba(0,0,0,.25)}
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
.mbs-in .mbs-links{margin:18px 0 0;padding-top:14px}
.mbs-choice{display:block;width:100%;text-align:left;margin:0 0 8px;padding:10px 12px;border:1px solid var(--border-strong,#c6cbd3);border-radius:var(--r,6px);background:var(--surface,#fff);color:var(--ink,#1b1f24);font:inherit;cursor:pointer}
.mbs-choice:hover{border-color:var(--accent);background:var(--surface-2,#f6f7f9)}
.mbs-choice b{display:block;font-size:14px}.mbs-choice small{display:block;color:var(--muted,#5f6773);font-size:12.5px;margin-top:2px}
.mbs-stat{display:flex;gap:8px;align-items:center;margin:0 0 12px;font-size:13.5px}
.mbs-dot{width:8px;height:8px;border-radius:50%;background:var(--muted,#5f6773);flex:none}
.mbs-dot.on{background:var(--good,#16a34a)}.mbs-dot.warn{background:var(--warn,#e5a100)}.mbs-dot.err{background:var(--crit,#c9302c)}
.mbs-keep{display:flex;gap:10px;align-items:flex-start;margin:2px 0 12px;font-size:13.5px;cursor:pointer}
.mbs-keep input{flex:none;width:18px;height:18px;margin:1px 0 0;accent-color:var(--accent)}
.mbs-keep b{display:block;font-weight:600;color:var(--ink,#1b1f24)}
.mbs-keep small{display:block;color:var(--muted,#5f6773);font-size:12.5px;margin-top:1px}
/* top-bar account button (sync.button) — sizes come from the bar's .tb */
.tb-acct .mbs-i{width:18px;height:18px;flex:none}
.tb-acct .tb-av{position:relative;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;border-radius:var(--r-sm,4px);
  background:var(--accent);color:var(--accent-ink,#fff);font:650 12.5px/1 var(--font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);text-transform:uppercase}
.mbs-av-img{position:absolute;inset:0;border-radius:inherit;overflow:hidden}
.mbs-av-img svg{width:100%!important;height:100%!important;display:block}
.tb-acct .tb-av.pic,.mbs-card-ic.av.pic{background:none}
.mbs-av-l{line-height:1}
.tb-acct.restoring .tb-av{opacity:.75}
.tb-acct .tb-av i{position:absolute;right:-4px;bottom:-4px;width:10px;height:10px;border-radius:50%;background:var(--good,#16a34a);box-shadow:0 0 0 2px var(--surface,#fff)}
.tb-acct .tb-av i.warn{background:var(--warn,#e5a100)}.tb-acct .tb-av i.err{background:var(--crit,#c9302c)}.tb-acct .tb-av i.busy{background:var(--accent)}
.tb-acct.is-in .tb-lbl{display:none}
@media (max-width:1023px){ .tb-acct .tb-lbl{display:none} .page-bar .actions .tb.tb-acct{width:var(--tb-h,36px);padding:0} }
/* Settings page card (sync.card) */
.mbs-card{display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:1.5}
.mbs-card-h{display:flex;gap:12px;align-items:flex-start}
.mbs-card-ic{flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--r-sm,4px);background:var(--accent-soft,var(--surface-2,#f3f4f6));color:var(--accent)}
.mbs-card-ic.av{background:var(--accent);color:var(--accent-ink,#fff);font-weight:650;font-size:15px;text-transform:uppercase;position:relative}
.mbs-card-ic.av i{position:absolute;right:-3px;bottom:-3px;width:11px;height:11px;border-radius:50%;background:var(--good,#16a34a);box-shadow:0 0 0 2px var(--surface,#fff)}
.mbs-card-ic.av i.warn{background:var(--warn,#e5a100)}.mbs-card-ic.av i.err{background:var(--crit,#c9302c)}.mbs-card-ic.av i.busy{background:var(--accent)}
.mbs-card-ic svg{width:20px;height:20px}
.mbs-card-h small{display:block;color:var(--muted,#5f6773);font-size:12.5px;overflow-wrap:anywhere}
/* profile editor (account dialog → Edit profile) */
.mbs-pics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;max-height:min(46vh,340px);overflow-y:auto;padding:4px!important;margin:0 0 12px;padding:0;border:0}
.mbs-pics legend{padding:0;margin:0 0 6px;font-size:13px;font-weight:600;color:var(--ink-2,#48505c)}
.mbs-pic{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:1;min-height:36px;border-radius:var(--r,6px);cursor:pointer;color:#fff;font-weight:650;font-size:15px;box-shadow:0 1px 2px rgba(16,24,40,.18)}
.mbs-pic.ini{background:var(--accent);color:var(--accent-ink,#fff)}
.mbs-pic input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.mbs-pic .mbs-av-img{pointer-events:none}
.mbs-pic:has(input:checked){box-shadow:0 0 0 2px var(--surface,#fff),0 0 0 4px var(--accent)}
.mbs-pic:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:3px}
.mbs-prof{display:flex;align-items:center;gap:10px;margin:0 0 12px}
.mbs-prof .mbs-card-ic{width:40px;height:40px}
.mbs-prof>div{min-width:0;flex:1 1 auto}
.mbs-prof b{display:block;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mbs-prof small{display:block;color:var(--muted,#5f6773);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mbs-prof .mbs-b{flex:none;white-space:nowrap}
@media (max-width:480px){ .mbs-in>.mbs-row .mbs-b{flex:1 1 0;min-height:44px;padding:0 8px} }

.mbs-card-h b{display:block;font-size:14.5px;font-weight:650;color:var(--ink,#1b1f24);overflow-wrap:anywhere}
.mbs-card-h p{margin:2px 0 0;color:var(--ink-2,#48505c);font-size:13.5px}
.mbs-card-h p.st{display:flex;align-items:center;gap:7px;color:var(--muted,#5f6773)}
.mbs-card .mbs-row{justify-content:flex-start;margin:0}
.mbs-card .mbs-keep{margin:0;padding-top:12px;border-top:1px solid var(--border,#dfe2e7)}
.mbs-card .mbs-msg{margin:0}
.mbs-card .mbs-links{margin:0;padding:0;border:0}
@media (max-width:767px){ .mbs-card .mbs-row .mbs-b{flex:1 1 auto;min-height:44px} }`;
let dlg = null, styled = false;
function ensureStyle() {
  if (styled) return; styled = true;
  const st = document.createElement('style'); st.setAttribute('data-mb-sync', VERSION); st.textContent = CSS; document.head.appendChild(st);
}
function ensureDialog() {
  if (dlg) return dlg;
  ensureStyle();
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
  const KEEP_KEY = APP + '.keepSignedIn';          // '0' = sign-in lasts until the browser closes; anything else = kept on this device
  const buttons = new Set(), cards = new Set(), greets = new Set();
  ensureStyle();
  const restoring = () => !user && hasSavedSignIn() && !!meta.uid;   // page just opened with a saved sign-in; the library is still loading
  // profile = { name, avatar } from the account (screen name + picture); cached in meta so it shows before the library loads
  function profile() {
    const md = (user && user.user_metadata) || {};
    const p = meta.profile || {};
    return { name: (p.name != null ? p.name : md.display_name) || '', avatar: (md.avatar != null ? md.avatar : p.avatar) || '' };
  }

  /* -- "Keep me signed in on this device": the sign-in token lives in localStorage (kept) or sessionStorage (until the browser closes) -- */
  function keepSignedIn() { return lsGet(KEEP_KEY) !== '0'; }
  function setKeepSignedIn(on) {
    const raw = lsGet(SESSION_KEY) || ssGet(SESSION_KEY);
    if (on) { lsDel(KEEP_KEY); if (raw) { lsSet(SESSION_KEY, raw); ssDel(SESSION_KEY); } }
    else { lsSet(KEEP_KEY, '0'); if (raw) { ssSet(SESSION_KEY, raw); lsDel(SESSION_KEY); } }
  }
  const authStore = {
    getItem(k) { return keepSignedIn() ? lsGet(k) : (ssGet(k) || null); },
    setItem(k, v) { if (keepSignedIn()) { lsSet(k, v); ssDel(k); } else { ssSet(k, v); lsDel(k); } },
    removeItem(k) { lsDel(k); ssDel(k); }
  };

  function blankMeta() { return { v: 1, uid: null, email: '', cursor: null, h: {}, t: {}, dirty: {}, big: {}, last: 0, profile: null }; }
  function saveMeta() { lsSet(META_KEY, JSON.stringify(meta)); }
  function setState(s, err) {
    state = s; errorText = err || '';
    const info = status();
    if (o.onStatus) try { o.onStatus(info); } catch (e) {}
    if (dlg && dlg.open && dlg.dataset.mbsView === 'status') renderStatus();
    paintButtons(); paintCards(); paintGreets();
    try { window.dispatchEvent(new CustomEvent('mbsync:status', { detail: info })); } catch (e) {}
  }
  function status() {
    return { signedIn: !!user, email: user ? user.email : '', state, error: errorText, lastSync: meta.last,
             pending: Object.keys(meta.dirty).length, tooBig: Object.keys(meta.big || {}).length, label: label(),
             // quietBackups: signed in and syncing fine → apps skip backup nags (banners, toasts, pop-ups) and keep the backup chip neutral
             quietBackups: !!user && state !== 'error', keepSignedIn: keepSignedIn(),
             name: (user || restoring()) ? profile().name : '', avatar: (user || restoring()) ? profile().avatar : '', restoring: restoring() };
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
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: authStore, storageKey: SESSION_KEY }
    });
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { if (user) { user = null; meta = blankMeta(); saveMeta(); setState('off'); } return; }
      if (session && session.user) user = session.user;
    });
    const { data } = await sb.auth.getSession();
    user = data && data.session ? data.session.user : null;
  }
  async function loadProfile() {
    try {
      const { data } = await sb.auth.getUser(); if (data && data.user) user = data.user;
      const md = user.user_metadata || {};
      let name = md.display_name || '';
      const r = await sb.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
      if (r && !r.error && r.data && r.data.display_name != null) name = r.data.display_name || name;
      meta.profile = { name, avatar: md.avatar || '' }; meta.email = user.email || meta.email; saveMeta();
      setState(state, errorText);
    } catch (e) {}
  }
  async function saveProfile(name, avatar) {
    name = String(name || '').trim().slice(0, 60);
    const { data, error } = await sb.auth.updateUser({ data: { display_name: name, avatar: avatar || '' } });
    if (error) throw error;
    if (data && data.user) user = data.user;
    try { await sb.from('profiles').update({ display_name: name || null }).eq('id', user.id); } catch (e) {}
    meta.profile = { name, avatar: avatar || '' }; saveMeta(); setState(state, errorText);
  }
  async function afterSignIn() {
    if (meta.uid !== user.id) await link();
    else await sync(true);
    loadProfile();
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
        <label class="mbs-keep"><input type="checkbox" name="keep" ${keepSignedIn() ? 'checked' : ''}><span><b>Keep me signed in on this device</b><small>Turn off on a shared computer: you’ll be signed out when the browser closes.</small></span></label>
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
          setKeepSignedIn(!!f.keep.checked);
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
    const pr = profile();
    const d = showDialog(`
      <h2 id="mbsTitle">Your account</h2>
      <div class="mbs-prof">${avatarChip(pr, s, 'mbs-card-ic av')}<div><b>${esc(pr.name || s.email)}</b>${pr.name ? `<small>${esc(s.email)}</small>` : ''}</div>
        <button class="mbs-b" type="button" id="mbsProf" style="margin-left:auto">Edit profile</button></div>
      <div class="mbs-stat"><span class="mbs-dot ${dot}"></span><span>${esc(s.label)}${s.pending ? ` · ${s.pending} change${s.pending === 1 ? '' : 's'} waiting` : ''}</span></div>
      ${s.error ? `<p class="mbs-msg err">${esc(s.error)}</p>` : ''}
      ${s.tooBig ? `<p class="mbs-msg err">${s.tooBig === 1 ? 'One item is' : s.tooBig + ' items are'} too large to sync (over about 230 KB, usually from pasted images), so ${s.tooBig === 1 ? 'it stays' : 'they stay'} on this device only. ${s.tooBig === 1 ? 'It syncs' : 'They sync'} again once smaller.</p>` : ''}
      <p>Changes save on this device first and sync when you’re online. Photos and other files aren’t synced.</p>
      <label class="mbs-keep"><input type="checkbox" id="mbsKeep" ${keepSignedIn() ? 'checked' : ''}><span><b>Keep me signed in on this device</b><small>Off: you’ll be signed out when the browser closes.</small></span></label>
      <div class="mbs-row"><button class="mbs-b" type="button" id="mbsOut">Sign out</button><button class="mbs-b" type="button" id="mbsNow">Sync now</button><button class="mbs-b pri" type="button" id="mbsClose">Done</button></div>
      <p class="mbs-links">Manage your account, export or delete synced data: <a href="${ACCOUNT_URL}" target="_blank" rel="noopener">mcbflow.com account page</a>. Signing out keeps this device’s data.</p>`);
    d.dataset.mbsView = 'status';
    d.querySelector('#mbsClose').onclick = () => d.close();
    d.querySelector('#mbsNow').onclick = e => busy(e.currentTarget, () => sync().catch(() => {}));
    d.querySelector('#mbsOut').onclick = e => busy(e.currentTarget, () => signOut());
    d.querySelector('#mbsKeep').onchange = e => { setKeepSignedIn(e.currentTarget.checked); paintCards(); };
    d.querySelector('#mbsProf').onclick = () => renderProfile();
  }
  function renderProfile() {
    if (!user) return renderSignIn();
    const pr = profile(), s = status();
    const pics = [''].concat(AV_IDS).map(id =>
      `<label class="mbs-pic${id ? '' : ' ini'}" title="${esc(avatarLabel(id))}"><input type="radio" name="pic" value="${id}" ${(pr.avatar || '') === id ? 'checked' : ''} aria-label="${esc(avatarLabel(id))}">${avatarSVG(id, initialOf(pr.name || s.email))}</label>`).join('');
    const d = showDialog(`
      <h2 id="mbsTitle">Your profile</h2>
      <p>Shown in every mcbflow.com app you sign in to, so you can tell at a glance it’s your account.</p>
      <form id="mbsPF" novalidate>
        <label class="mbs-f"><span>Screen name</span><input name="name" type="text" maxlength="60" autocomplete="nickname" value="${esc(pr.name)}" placeholder="What should we call you?"></label>
        <fieldset class="mbs-pics"><legend>Profile picture</legend>${pics}</fieldset>
        <p class="mbs-msg" id="mbsMsg" role="alert"></p>
        <div class="mbs-row"><button class="mbs-b" type="button" id="mbsBack">Cancel</button><button class="mbs-b pri" type="submit">Save</button></div>
      </form>`);
    d.dataset.mbsView = 'profile';
    d.querySelector('#mbsBack').onclick = () => renderStatus();
    d.querySelector('#mbsPF').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.currentTarget, out = d.querySelector('#mbsMsg');
      const pic = (f.querySelector('input[name=pic]:checked') || {}).value || '';
      busy(f.querySelector('[type=submit]'), async () => {
        try { await saveProfile(f.name.value, pic); renderStatus(); }
        catch (err) { out.textContent = friendly(err); out.className = 'mbs-msg err'; }
      });
    });
  }
  function open() { if (user) renderStatus(); else renderSignIn(); }

  /* -- standard UI pieces the apps place: top-bar account button and Settings card -- */
  const ICON_USER = '<svg class="mbs-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
  const ICON_SYNC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.7-4.4L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.7 4.4L20 16"/><path d="M20 21v-5h-5"/></svg>';
  function dotClass(s) { return s.state === 'error' ? 'err' : s.state === 'syncing' ? 'busy' : (s.state === 'offline' || s.pending) ? 'warn' : ''; }
  function initialOf(t) { return ((String(t || '?').trim()[0]) || '?').toUpperCase(); }
  function initial(email) { return esc(initialOf(email)); }
  function avatarChip(pr, s, cls) {
    return `<span class="${cls}${AV_IDS.includes(pr.avatar) ? ' pic' : ''}" aria-hidden="true">${avatarSVG(pr.avatar, initialOf(pr.name || s.email || meta.email))}<i class="${dotClass(s)}"></i></span>`;
  }
  function paintButtons() {
    const s = status();
    buttons.forEach(b => {
      if (!b.isConnected) { buttons.delete(b); return; }
      b.classList.add('tb', 'tb-acct'); b.classList.toggle('is-in', s.signedIn || s.restoring); b.classList.toggle('restoring', s.restoring);
      if (s.signedIn || s.restoring) {
        const who = s.name ? `${s.name} (${s.email || meta.email})` : (s.email || meta.email);
        const t = s.restoring ? `Account: ${who}. Connecting…` : `Account: signed in as ${who}. ${s.label}`;
        b.innerHTML = avatarChip(profile(), s.restoring ? { state: 'syncing' } : s, 'tb-av') + '<span class="tb-lbl">Account</span>';
        b.setAttribute('aria-label', t); b.title = t;
      } else {
        b.innerHTML = ICON_USER + '<span class="tb-lbl">Sign in</span>';
        b.setAttribute('aria-label', 'Sign in to sync across devices'); b.title = 'Sign in to sync across devices (optional)';
      }
    });
  }
  function button(el) {
    if (!el || buttons.has(el)) return el;
    buttons.add(el); if (!el.type) el.type = 'button';
    el.addEventListener('click', e => { e.preventDefault(); open(); });
    paintButtons(); return el;
  }
  function paintCards() {
    const s = status();
    cards.forEach(c => {
      if (!c.isConnected) { cards.delete(c); return; }
      c.classList.add('mbs-card');
      if (!s.signedIn) {
        c.innerHTML = `
          <div class="mbs-card-h"><span class="mbs-card-ic">${ICON_SYNC}</span><div><b>Sync across devices</b>
            <p>Optional free mcbflow.com account. Keeps ${esc(o.what || 'your ' + o.label + ' data')} the same on your phone and computer.${o.note ? ' ' + esc(o.note) : ''} Without an account, everything stays in this browser.</p></div></div>
          <div class="mbs-row"><button class="mbs-b pri" type="button" data-mbs-a="in">Sign in</button><a class="mbs-b" href="${ACCOUNT_URL}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;text-decoration:none">Create a free account</a></div>`;
      } else {
        c.innerHTML = `
          <div class="mbs-card-h">${avatarChip(profile(), s, 'mbs-card-ic av')}<div><b>${s.name ? esc(s.name) : 'Signed in as ' + esc(s.email)}</b>${s.name ? `<small>Signed in as ${esc(s.email)}</small>` : ''}
            <p class="st">${esc(s.label)}${s.pending ? ` · ${s.pending} change${s.pending === 1 ? '' : 's'} waiting` : ''}</p></div></div>
          ${s.error ? `<p class="mbs-msg err">${esc(s.error)}</p>` : ''}
          <div class="mbs-row"><button class="mbs-b" type="button" data-mbs-a="now">Sync now</button><button class="mbs-b" type="button" data-mbs-a="prof">Edit profile</button><button class="mbs-b" type="button" data-mbs-a="out">Sign out</button></div>
          <label class="mbs-keep"><input type="checkbox" data-mbs-a="keep" ${keepSignedIn() ? 'checked' : ''}><span><b>Keep me signed in on this device</b><small>Off: you’ll be signed out when the browser closes. This device’s data stays either way.</small></span></label>
          <p class="mbs-links"><a href="${ACCOUNT_URL}" target="_blank" rel="noopener">Manage your mcbflow.com account</a>${o.note ? ' · ' + esc(o.note) : ''}</p>`;
      }
    });
  }
  function card(el) {
    if (!el || cards.has(el)) return el;
    cards.add(el);
    el.addEventListener('click', e => {
      const a = e.target.closest('[data-mbs-a]'); if (!a || a.tagName === 'INPUT') return;
      if (a.dataset.mbsA === 'in') open();
      else if (a.dataset.mbsA === 'now') busy(a, () => sync().catch(() => {}));
      else if (a.dataset.mbsA === 'out') busy(a, () => signOut());
      else if (a.dataset.mbsA === 'prof') renderProfile();
    });
    el.addEventListener('change', e => { if (e.target.matches('[data-mbs-a="keep"]')) setKeepSignedIn(e.target.checked); });
    paintCards(); return el;
  }
  function paintGreets() {
    const s = status();
    greets.forEach(g => {
      if (!g.el.isConnected) { greets.delete(g); return; }
      const name = (s.signedIn || s.restoring) && s.name ? s.name : (typeof g.name === 'function' ? g.name() : g.name);
      g.el.textContent = greeting(name);
    });
  }
  function greet(el, opts) { if (!el) return el; greets.add({ el, name: (opts && opts.name) || '' }); paintGreets(); return el; }
  setInterval(() => { if (buttons.size || cards.size || greets.size) { paintButtons(); paintCards(); paintGreets(); } }, 60000);   // keep "Synced 3 min ago" and the time of day current

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
  } else if (meta.uid && keepSignedIn()) { meta = blankMeta(); saveMeta(); }   // (a sign-in that ended with the browser keeps its progress, so signing in again just syncs)
  setTimeout(() => setState(state), 0);

  return { changed, open, sync: () => sync(), signOut: () => signOut(), status, button, card, greet, editProfile: () => (user ? renderProfile() : renderSignIn()), version: VERSION };
}

window.MBSync = { create, version: VERSION, hasSavedSignIn, greeting, avatars: AV_IDS };
})();
