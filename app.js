/* Dvoje · اتنين — a two-person, mirrored Bosnian <-> Arabic learning game.
   Everything that happens is an event in one append-only log (Store). The screen is
   derived from that log, so swapping local storage for a shared online table later
   only means replacing Store. */

// ---------- Store: the shared event log ----------
// With config.js filled in, events sync through two Supabase functions keyed by the
// invite code ("room"). Without it, everything stays on this device.
const CFG = window.DVOJE_CONFIG || {};
const ONLINE = !!(CFG.url && CFG.key);
const Store = (() => {
  let events = [], cursor = 0, syncing = false;
  let room = ONLINE ? localStorage.getItem('dvoje.room') : 'local';
  let status = ONLINE ? 'connecting' : 'local';
  const subs = [], emit = mine => subs.forEach(f => f(mine));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
  const db = new Promise((res, rej) => {
    const r = indexedDB.open('dvoje', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idb = async (mode, fn) => { const d = await db; return new Promise((res, rej) => { const tx = d.transaction('kv', mode), rq = fn(tx.objectStore('kv')); tx.oncomplete = () => res(rq.result); tx.onerror = () => rej(tx.error); }); };
  const save = () => room && idb('readwrite', s => s.put({ events, cursor }, room)).catch(() => {});
  async function load() {
    events = []; cursor = 0;
    if (!room) return;
    try { const v = await idb('readonly', s => s.get(room)); if (v) { events = v.events || []; cursor = v.cursor || 0; } } catch {}
  }
  async function rpc(fn, body) {
    let r;
    try { r = await fetch(`${CFG.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: CFG.key, Authorization: 'Bearer ' + CFG.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }); } catch (err) { err.network = true; throw err; }
    if (!r.ok) { const err = new Error(fn + ' ' + r.status); err.status = r.status; throw err; }
    return r.status === 204 ? null : r.json();
  }
  async function sync() {
    if (!ONLINE || !room || syncing) return;
    syncing = true; let changed = false; const forRoom = room;
    try {
      for (const e of events.filter(e => !e.synced)) {
        try { await rpc('add_event', { p_room: forRoom, p_id: e.id, p_author: e.author, p_type: e.type, p_payload: e.payload, p_at: e.at }); }
        catch (err) {
          // The server refused this one event (e.g. a recording that is too big). Keep it on this
          // phone but stop retrying, so it never holds up the messages and lessons behind it.
          if (err.network || !(err.status >= 400 && err.status < 500)) throw err;
          e.rejected = true; console.warn('Not synced:', e.type, err.message);
        }
        e.synced = true; changed = true;
      }
      for (;;) {
        const rows = await rpc('get_events', { p_room: forRoom, p_after: cursor });
        if (room !== forRoom) break;
        const have = new Set(events.map(e => e.id));
        for (const r of rows) {
          cursor = Math.max(cursor, Number(r.seq));
          if (!have.has(r.id)) { events.push({ id: r.id, author: r.author, type: r.type, payload: r.payload, at: Number(r.at), synced: true }); changed = true; }
        }
        if (rows.length) changed = true;
        if (rows.length < 200) break;
      }
      if (status !== 'online') { status = 'online'; changed = true; }
    } catch { if (status !== 'offline') { status = 'offline'; changed = true; } }
    syncing = false;
    if (changed && room === forRoom) { events.sort((a, b) => a.at - b.at); save(); emit(); }
  }
  return {
    all: () => events,
    room: () => room,
    status: () => status,
    add(author, type, payload) {
      const ev = { id: uid(), author, type, payload, at: Date.now(), synced: !ONLINE };
      events.push(ev); save(); emit(true); sync();
      return ev;
    },
    async setRoom(code) { room = code; localStorage.setItem('dvoje.room', code); localStorage.setItem('dvoje.lastRoom', code); status = 'connecting'; await load(); emit(); await sync(); },
    unsynced: () => events.filter(e => !e.synced).length,
    async reset() {
      if (ONLINE) {
        // Signing out only forgets which space this device is in. Everything already lives
        // online; the local copy is kept so coming back with the same code is instant.
        await sync();
        room = null; events = []; cursor = 0; localStorage.removeItem('dvoje.room');
      } else {
        await idb('readwrite', s => s.delete(room)).catch(() => {});
        events = []; cursor = 0;
      }
      emit();
    },
    async init() {
      await load();
      if (ONLINE) {
        setInterval(() => { if (!document.hidden) sync(); }, 4000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
        window.addEventListener('online', sync);
        await sync();
      }
    },
    sync, onChange: f => subs.push(f),
  };
})();

// ---------- Basics ----------
const LANG = {
  bs: { name: 'Bosnian', own: 'Bosanski', dir: 'ltr', tts: ['bs', 'hr', 'sr'] },
  ar: { name: 'Arabic', own: 'عربي', dir: 'rtl', tts: ['ar'] },
};
const other = r => (r === 'bs' ? 'ar' : 'bs');
const ITEMS = {};
const LESSON_OF = {};
LESSONS.forEach(l => l.items.forEach(it => { ITEMS[it.id] = it; LESSON_OF[it.id] = l; }));
const REACTIONS = ['❤️', '😂', '👏', '🔥'];

let me = localStorage.getItem('dvoje.me');      // 'bs' or 'ar' = my native language
let tab = 'home';
let S = null;                                   // running lesson session
let D = null;                                   // derived state
let ui = { pendingRole: null, editing: null, teachOpen: null, recording: null };

const $app = document.getElementById('app');
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
const ago = t => { const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago'; };

// ---------- Derive everything from the event log ----------
function derive() {
  const recLast = {};
  const d = { names: {}, fixes: {}, audio: {}, done: { bs: {}, ar: {} }, xp: { bs: 0, ar: 0 }, days: { bs: new Set(), ar: new Set() }, reacts: {}, feed: [] };
  for (const e of Store.all()) {
    const p = e.payload || {};
    if (e.type === 'profile') d.names[e.author] = p.name;
    else if (e.type === 'fix') d.fixes[p.item + ':' + e.author] = p;
    else if (e.type === 'audio') {
      d.audio[p.item + ':' + e.author] = p.data;
      // Group a burst of recordings for one lesson into a single post in the Us feed.
      const l = LESSON_OF[p.item]; if (!l) continue;
      const last = recLast[e.author];
      if (last && last.payload.lesson === l.id && e.at - last.at < 3 * 3600000) { if (!last.payload.items.includes(p.item)) last.payload.items.push(p.item); last.at = e.at; }
      else { recLast[e.author] = { id: e.id, type: 'rec', author: e.author, at: e.at, payload: { lesson: l.id, items: [p.item] } }; d.feed.push(recLast[e.author]); }
    }
    else if (e.type === 'done') {
      const prev = d.done[e.author][p.lesson];
      if (!prev || p.score / p.total >= prev.score / prev.total) d.done[e.author][p.lesson] = p;
      d.xp[e.author] += p.xp; d.days[e.author].add(dayKey(e.at)); d.feed.push(e);
    } else if (e.type === 'note') d.feed.push(e);
    else if (e.type === 'react') { const r = (d.reacts[p.target] ||= {}); (r[p.emoji] ||= new Set()).add(e.author); }
  }
  d.feed.sort((a, b) => a.at - b.at);
  d.streak = r => streak(t => d.days[r].has(t));
  d.together = streak(t => d.days.bs.has(t) && d.days.ar.has(t));
  return d;
}
function streak(has) {
  let n = 0; const day = 86400000; let t = Date.now();
  if (!has(dayKey(t))) t -= day;            // today not done yet does not break the streak
  while (has(dayKey(t))) { n++; t -= day; }
  return n;
}
const nameOf = r => D.names[r] || (r === 'bs' ? 'Bosnian speaker' : 'Arabic speaker');
function word(item, lang) { const f = D.fixes[item.id + ':' + lang]; return (f && f.text) || item[lang]; }
function translit(item) { const f = D.fixes[item.id + ':ar']; return f && f.text ? (f.tr || '') : item.tr; }
function W(item, lang, cls) { return h('span', { class: 'w ' + lang + ' ' + (cls || ''), lang, dir: LANG[lang].dir }, word(item, lang)); }

// ---------- Sound: partner's recording first, phone voice as a fallback ----------
function speak(item, lang) {
  const rec = D.audio[item.id + ':' + lang];
  if (rec) { new Audio(rec).play().catch(() => robot(item, lang)); return; }
  robot(item, lang);
}
function robot(item, lang) {
  if (!('speechSynthesis' in window)) return;
  const voice = speechSynthesis.getVoices().find(v => LANG[lang].tts.some(p => v.lang.toLowerCase().startsWith(p)));
  const u = new SpeechSynthesisUtterance(word(item, lang));
  if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang === 'ar' ? 'ar-EG' : 'hr-HR';
  u.rate = 0.85; speechSynthesis.cancel(); speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();
const soundBtn = (item, lang) => h('button', { class: 'sound', 'aria-label': 'Listen', onclick: e => { e.stopPropagation(); speak(item, lang); } },
  D.audio[item.id + ':' + lang] ? '🗣️' : '🔊');

async function toggleRecord(item) {
  if (ui.recording) { ui.recording.rec.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { alert('Recording is not available in this browser.'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert('The microphone was not allowed.'); return; }
  const type = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'].find(t => window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  const rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream); const chunks = [];
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop()); clearTimeout(ui.recording.timer); ui.recording = null;
    const fr = new FileReader();
    fr.onload = () => { Store.add(me, 'audio', { item: item.id, data: fr.result }); };
    fr.readAsDataURL(new Blob(chunks, { type: rec.mimeType }));
    render();
  };
  ui.recording = { item: item.id, rec, timer: setTimeout(() => rec.state === 'recording' && rec.stop(), 6000) };
  rec.start(); render();
}

// ---------- Lesson session ----------
const clean = s => s.replace(/[ً-ْـ؟?!.,،]/g, '').trim();
function tilesFor(text) {
  const words = clean(text).split(/\s+/);
  return words.length >= 3 ? words : Array.from(words.join(''));
}
function startLesson(lesson) {
  const its = lesson.items, steps = [];
  const mcq = (it, dir) => ({ type: 'mcq', item: it, dir, options: shuffle([it, ...shuffle(its.filter(x => x !== it)).slice(0, 3)]) });
  for (let i = 0; i < its.length; i += 4) {
    const chunk = its.slice(i, i + 4);
    chunk.forEach(it => steps.push({ type: 'intro', item: it }));
    shuffle(chunk).forEach(it => steps.push(mcq(it, 'toNative')));
  }
  const pairs = shuffle(its).slice(0, 4);
  steps.push({ type: 'match', left: shuffle(pairs), right: shuffle(pairs), sel: null, matched: [], wrong: null });
  shuffle(its).slice(0, 4).forEach(it => steps.push(mcq(it, 'toTarget')));
  shuffle(its.filter(it => tilesFor(it[other(me)]).length <= 9)).slice(0, 3).forEach(it => steps.push({ type: 'build', item: it }));
  S = { lesson, steps, i: 0, correct: 0, graded: 0, bloopers: [], finished: false, note: '' };
  render();
}
function next() {
  S.i++;
  if (S.i >= S.steps.length) finish(); else render();
}
function grade(step, ok, pickedId) {
  if (!step.retry) { S.graded++; if (ok) S.correct++; }
  if (!ok) {
    if (pickedId && !step.retry) S.bloopers.push({ item: step.item.id, picked: pickedId });
    if (!step.retry) S.steps.push({ ...step, retry: true, picked: undefined, answer: undefined, checked: undefined, tiles: undefined });
  }
}
function finish() {
  S.finished = true;
  S.xp = S.correct * 10 + (S.correct === S.graded ? 30 : 10);
  Store.add(me, 'done', { lesson: S.lesson.id, score: S.correct, total: S.graded, xp: S.xp, bloopers: S.bloopers.slice(0, 4) });
  render();
}

function viewSession() {
  const target = other(me);
  if (S.finished) {
    const perfect = S.correct === S.graded;
    return h('div', { class: 'session done' },
      h('div', { class: 'big-emoji' }, perfect ? '🏆' : '🎉'),
      h('h1', {}, perfect ? 'Perfect!' : 'Lesson done!'),
      h('p', { class: 'muted' }, `${S.lesson.emoji} ${S.lesson.title} · ${S.correct}/${S.graded} right`),
      h('div', { class: 'xp-pill' }, `+${S.xp} XP`),
      S.bloopers.length ? h('p', { class: 'muted' }, `Your ${S.bloopers.length} mix-up${S.bloopers.length > 1 ? 's' : ''} went to the shared feed 😅`) : null,
      h('textarea', { class: 'note-input', placeholder: `Leave a note for ${nameOf(other(me))}…`, rows: 2, oninput: e => { S.note = e.target.value; } }),
      h('button', { class: 'btn primary', onclick: () => {
        if (S.note.trim()) Store.add(me, 'note', { text: S.note.trim(), lesson: S.lesson.id });
        S = null; tab = 'home'; render();
      } }, 'Done'));
  }
  const step = S.steps[S.i];
  const bar = h('div', { class: 'session-top' },
    h('button', { class: 'x', 'aria-label': 'Quit lesson', onclick: () => { if (confirm('Quit this lesson? Progress in it is lost.')) { S = null; render(); } } }, '✕'),
    h('div', { class: 'bar' }, h('div', { class: 'fill', style: `width:${Math.round(S.i / S.steps.length * 100)}%` })));
  let body;
  if (step.type === 'intro') body = stepIntro(step, target);
  else if (step.type === 'mcq') body = stepMcq(step, target);
  else if (step.type === 'match') body = stepMatch(step, target);
  else body = stepBuild(step, target);
  return h('div', { class: 'session' }, bar, body);
}
const meaning = it => [W(it, me, 'mean'), h('div', { class: 'en' }, it.en)];
const cont = (label) => h('button', { class: 'btn primary bottom', onclick: next }, label || 'Continue');

function stepIntro(step, target) {
  const it = step.item;
  return h('div', { class: 'step' },
    h('div', { class: 'tag' }, 'New'),
    h('div', { class: 'card intro', onclick: () => speak(it, target) },
      W(it, target, 'huge'),
      target === 'ar' && translit(it) ? h('div', { class: 'tr' }, translit(it)) : null,
      soundBtn(it, target),
      h('hr'), meaning(it)),
    cont('Got it'));
}
function stepMcq(step, target) {
  const it = step.item, toNative = step.dir === 'toNative';
  const answered = step.picked != null;
  const pick = o => { if (answered) return; step.picked = o.id; grade(step, o === it, o.id); if (!toNative) speak(o, target); render(); };
  return h('div', { class: 'step' },
    h('div', { class: 'tag' }, toNative ? 'What does this mean?' : `Say it in ${LANG[target].name}`),
    h('div', { class: 'card prompt', onclick: toNative ? () => speak(it, target) : null },
      toNative ? [W(it, target, 'huge'), target === 'ar' && translit(it) ? h('div', { class: 'tr' }, translit(it)) : null, soundBtn(it, target)] : meaning(it)),
    h('div', { class: 'options' }, step.options.map(o => h('button', {
      class: 'opt' + (answered && o === it ? ' right' : '') + (answered && step.picked === o.id && o !== it ? ' wrong' : ''),
      onclick: () => pick(o),
    }, toNative ? [W(o, me), h('small', {}, o.en)] : W(o, target, 'big')))),
    answered ? h('div', { class: 'verdict ' + (step.picked === it.id ? 'ok' : 'bad') }, step.picked === it.id ? 'Correct! ✨' : 'Not quite — it comes back later.') : null,
    answered ? cont() : null);
}
function stepMatch(step, target) {
  const done = step.matched.length === step.left.length;
  const tapL = it => { if (!step.matched.includes(it.id)) { step.sel = it.id; speak(it, target); render(); } };
  const tapR = it => {
    if (!step.sel || step.matched.includes(it.id)) return;
    if (it.id === step.sel) { step.matched.push(it.id); step.sel = null; render(); }
    else { step.wrong = it.id; render(); setTimeout(() => { step.wrong = null; if (S && S.steps[S.i] === step) render(); }, 450); }
  };
  return h('div', { class: 'step' },
    h('div', { class: 'tag' }, 'Match the pairs'),
    h('div', { class: 'match' },
      h('div', { class: 'col' }, step.left.map(it => h('button', { class: 'opt' + (step.matched.includes(it.id) ? ' gone' : '') + (step.sel === it.id ? ' sel' : ''), onclick: () => tapL(it) }, W(it, target, 'big')))),
      h('div', { class: 'col' }, step.right.map(it => h('button', { class: 'opt' + (step.matched.includes(it.id) ? ' gone' : '') + (step.wrong === it.id ? ' wrong' : ''), onclick: () => tapR(it) }, W(it, me))))),
    done ? cont() : null);
}
function stepBuild(step, target) {
  const it = step.item;
  if (!step.tiles) { step.tiles = shuffle(tilesFor(word(it, target)).map((t, idx) => ({ t, idx }))); step.answer = []; }
  const byWords = clean(word(it, target)).split(/\s+/).length >= 3;
  const built = step.answer.map(i => step.tiles[i].t).join(byWords ? ' ' : '');
  const goal = byWords ? clean(word(it, target)) : clean(word(it, target)).replace(/\s+/g, '');
  const checked = step.checked != null;
  // Letter tiles carry no spaces, so show the answer with the phrase's word breaks put back.
  let shown = built;
  if (!byWords) { shown = ''; let pos = 0; for (const wd of clean(word(it, target)).split(/\s+/)) { const n = Array.from(wd).length, part = step.answer.slice(pos, pos + n).map(i => step.tiles[i].t).join(''); if (part) shown += (shown ? ' ' : '') + part; pos += n; } }
  const check = () => { step.checked = built === goal; grade(step, step.checked); speak(it, target); render(); };
  return h('div', { class: 'step' },
    h('div', { class: 'tag' }, `Build it in ${LANG[target].name}`),
    h('div', { class: 'card prompt' }, meaning(it)),
    h('div', { class: 'answer ' + target, dir: LANG[target].dir, lang: target, onclick: () => { if (!checked && step.answer.length) { step.answer.pop(); render(); } } },
      shown || h('span', { class: 'ph' }, 'Tap the tiles…')),
    h('div', { class: 'tiles', dir: LANG[target].dir }, step.tiles.map((tile, i) => h('button', {
      class: 'tile ' + target + (step.answer.includes(i) ? ' used' : ''), lang: target,
      onclick: () => { if (!checked && !step.answer.includes(i)) { step.answer.push(i); render(); } },
    }, tile.t))),
    checked ? h('div', { class: 'verdict ' + (step.checked ? 'ok' : 'bad') }, step.checked ? 'Correct! ✨' : ['It is: ', W(it, target)]) : null,
    checked ? cont() : h('button', { class: 'btn primary bottom', disabled: step.answer.length === 0, onclick: check }, 'Check'));
}

// ---------- Screens ----------
function newCode() { const abc = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => abc[b % abc.length]).join(''); }
const inviteLink = () => location.origin + location.pathname + '#join=' + Store.room();
// Codes are stored as plain lowercase letters/digits and shown in groups of four.
const normCode = s => { s = String(s || '').trim(); const m = s.match(/#join=([a-z0-9-]+)/i); return (m ? m[1] : s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
const showCode = c => ((c || '').match(/.{1,4}/g) || []).join('-');
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const codeBox = () => h('div', { class: 'code-box' }, h('div', { class: 'muted small' }, 'Your space code'), h('b', { class: 'code' }, showCode(Store.room())));
const shareBtn = (label = 'Share invite link') => h('button', { class: 'btn', onclick: async e => {
  const url = inviteLink(), btn = e.currentTarget;
  try { if (navigator.share) await navigator.share({ title: 'Dvoje · اتنين', text: 'Join our Dvoje space (code ' + showCode(Store.room()) + '):', url }); else { await navigator.clipboard.writeText(url); btn.textContent = 'Link copied ✓'; } }
  catch (err) { if (err && err.name !== 'AbortError') prompt('Copy this link and send it:', url); }
} }, label);
function iosHint(where) {
  if (!isIOS || standalone) return null;
  if (where === 'home' && localStorage.getItem('dvoje.iosHint') === 'hide') return null;
  return h('div', { class: 'card hint' },
    h('h3', {}, '📲 Put Dvoje on your Home Screen'),
    h('ol', {},
      h('li', {}, 'Open this page in ', h('b', {}, 'Safari'), ' (in WhatsApp, tap ··· → Open in Safari).'),
      h('li', {}, 'Tap the Share button ', h('b', {}, '⬆️'), ' at the bottom.'),
      h('li', {}, 'Scroll and tap ', h('b', {}, 'Add to Home Screen'), ', then ', h('b', {}, 'Add'), '.'),
      Store.room() ? h('li', {}, 'Open the new icon. It starts fresh, so tap ', h('b', {}, 'Join'), ' and enter the code ', h('b', { class: 'code' }, showCode(Store.room())), ', then ', h('b', {}, 'Continue as ' + (D.names[me] || 'you')), '.') : null),
    where === 'home' ? h('button', { class: 'btn ghost small', onclick: () => { localStorage.setItem('dvoje.iosHint', 'hide'); render(); } }, 'Hide') : null);
}
function viewOnboard() {
  const role = ui.pendingRole;
  const top = [h('div', { class: 'logo' }, h('img', { src: 'icon.svg', alt: '' })),
    h('h1', {}, 'Dvoje · ', h('span', { lang: 'ar' }, 'اتنين')),
    h('p', { class: 'muted' }, 'Two people, two languages, one place.')];
  if (ONLINE && !Store.room()) {
    let code = '';
    const last = localStorage.getItem('dvoje.lastRoom');
    const join = () => { const c = normCode(code); if (c.length >= 12) Store.setRoom(c); else alert('That code looks too short. It has 16 letters and numbers, like abcd-efgh-jkmn-pqrs.'); };
    const create = () => { if (confirm('Only ONE of you creates the space. If your partner already made one, press Cancel and join with their link or code instead.\n\nCreate a brand-new, empty space?')) Store.setRoom(newCode()); };
    return h('div', { class: 'onboard' }, top,
      last ? h('button', { class: 'btn primary', onclick: () => Store.setRoom(last) }, 'Go back to our space', h('div', { class: 'small', style: 'font-weight:400' }, showCode(last))) : null,
      h('p', { class: 'muted small' }, 'Joining your partner? Open their invite link on this phone, or type the code here:'),
      h('input', { class: 'text', placeholder: 'Invite link or code', autocapitalize: 'off', autocomplete: 'off', oninput: e => { code = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') join(); } }),
      h('button', { class: last ? 'btn' : 'btn primary', onclick: join }, 'Join'),
      h('p', { class: 'muted small' }, 'First time for both of you?'),
      h('button', { class: 'btn ghost', onclick: create }, 'Create a new space'));
  }
  if (ONLINE && Store.status() === 'connecting' && !Store.all().length) {
    return h('div', { class: 'onboard' }, top, h('p', { class: 'muted' }, 'Opening your space…'));
  }
  if (!role) {
    const choose = r => { if (D.names[r]) { me = r; localStorage.setItem('dvoje.me', me); tab = 'home'; } else ui.pendingRole = r; render(); };
    return h('div', { class: 'onboard' }, top,
      Store.status() === 'offline' ? h('p', { class: 'verdict bad' }, 'Could not reach the server. Check the connection and the setup.') : null,
      h('p', {}, 'Which language is yours?'),
      ['bs', 'ar'].map(r => h('button', { class: 'btn choice', onclick: () => choose(r) },
        h('b', { lang: r }, LANG[r].own), h('span', {}, D.names[r] ? `Continue as ${D.names[r]}` : `I speak ${LANG[r].name} and I'm learning ${LANG[other(r)].name}`))));
  }
  let name = '';
  const go = () => { if (!name.trim()) return; Store.add(role, 'profile', { name: name.trim() }); me = role; localStorage.setItem('dvoje.me', me); ui.pendingRole = null; tab = 'home'; render(); };
  return h('div', { class: 'onboard' },
    h('div', { class: 'big-emoji' }, '👋'),
    h('h1', {}, 'What should we call you?'),
    h('p', { class: 'muted' }, `You'll learn ${LANG[other(role)].name} and teach ${LANG[role].name}.`),
    h('input', { class: 'text', placeholder: 'Your name', maxlength: 20, autofocus: true, oninput: e => { name = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') go(); } }),
    h('button', { class: 'btn primary', onclick: go }, 'Start'),
    h('button', { class: 'btn ghost', onclick: () => { ui.pendingRole = null; render(); } }, 'Back'));
}
const avatar = r => h('div', { class: 'avatar ' + r }, (nameOf(r)[0] || '?').toUpperCase());

const voiced = l => l.items.filter(it => D.audio[it.id + ':' + other(me)]).length;
function viewHome() {
  const them = other(me);
  const nextLesson = LESSONS.find(l => !D.done[me][l.id]);
  const doneToday = D.days[me].has(dayKey(Date.now()));
  const person = r => h('div', { class: 'person' }, avatar(r),
    h('div', {}, h('b', {}, nameOf(r) + (r === me ? ' (you)' : '')), h('div', { class: 'muted small' }, `${D.xp[r]} XP · 🔥 ${D.streak(r)} · ${Object.keys(D.done[r]).length}/${LESSONS.length} lessons`)));
  const out = [
    h('div', { class: 'card duo' }, person(me), person(them),
      h('div', { class: 'together' }, D.together ? `💞 ${D.together}-day streak together` : '💞 Both finish a lesson on the same day to start a streak together')),
    ONLINE && !D.names[them] ? h('div', { class: 'card hint' },
      h('h3', {}, `Waiting for the ${LANG[them].name} speaker`),
      h('p', { class: 'muted' }, 'Nobody else is in this space yet. Send this link to your partner. They should open it (or tap Join and type the code), not create a new space.'),
      codeBox(), shareBtn()) : null,
    nextLesson ? h('div', { class: 'card hero' },
      h('div', { class: 'small' }, doneToday ? 'Today is done — want one more?' : "Today's lesson"),
      h('h2', {}, `${nextLesson.emoji} ${nextLesson.title}`),
      h('button', { class: 'btn light', onclick: () => startLesson(nextLesson) }, 'Start'))
      : h('div', { class: 'card hero' }, h('h2', {}, '🏁 You finished every lesson'), h('div', { class: 'small' }, 'Replay any lesson below to keep your streak.')),
    iosHint('home'),
  ];
  let level = 0;
  LESSONS.forEach((l, i) => {
    if (l.level !== level) { level = l.level; out.push(h('h3', { class: 'level' }, 'Level ' + level)); }
    const mine = D.done[me][l.id], theirs = D.done[them][l.id];
    const open = i === 0 || D.done[me][LESSONS[i - 1].id];
    out.push(h('button', { class: 'lesson' + (open ? '' : ' locked') + (mine ? ' finished' : ''), disabled: !open, onclick: () => startLesson(l) },
      h('span', { class: 'emoji' }, open ? l.emoji : '🔒'),
      h('span', { class: 'grow' }, h('b', {}, l.title), h('small', {}, mine ? `Your best: ${mine.score}/${mine.total}` : open ? `${l.items.length} words` : 'Finish the lesson before this one'),
        voiced(l) ? h('small', { class: 'voiced' }, `🗣️ ${voiced(l)}/${l.items.length} in ${nameOf(them)}'s voice`) : null),
      theirs ? h('span', { class: 'badge', title: nameOf(them) + ' finished this' }, avatar(them), '✓') : null,
      mine ? h('span', { class: 'tick' }, '✓') : null));
  });
  return out;
}

function viewFeed() {
  let text = '';
  const post = () => { if (text.trim()) Store.add(me, 'note', { text: text.trim() }); };
  const lessonOf = id => LESSONS.find(l => l.id === id);
  const entry = e => {
    const p = e.payload, r = D.reacts[e.id] || {}, l = p.lesson && lessonOf(p.lesson), target = other(e.author);
    return h('div', { class: 'card post ' + (e.author === me ? 'mine' : '') },
      h('div', { class: 'post-head' }, avatar(e.author), h('b', {}, nameOf(e.author)), h('span', { class: 'muted small' }, ago(e.at))),
      e.type === 'rec'
        ? [h('p', {}, `recorded ${p.items.length} ${l.emoji} ${l.title} word${p.items.length === 1 ? '' : 's'} for you 🎙️`),
          h('div', { class: 'rec-list' }, p.items.filter(id => ITEMS[id]).map(id => { const it = ITEMS[id], mine = other(e.author);
            // The recorded word, then how it sounds (Arabic only), the word in the other language and the English.
            return h('button', { class: 'rec-row', onclick: () => speak(it, e.author) }, h('span', { class: 'rec-play' }, '▶️'),
              h('span', { class: 'grow' }, W(it, e.author, 'big'),
                h('small', {}, e.author === 'ar' && translit(it) ? h('i', { class: 'tr-inline' }, translit(it) + ' · ') : null, W(it, mine), ' · ' + it.en))); }))]
        : e.type === 'note'
        ? [l ? h('div', { class: 'muted small' }, `after ${l.emoji} ${l.title}`) : null, h('p', { class: 'note', dir: 'auto' }, p.text)]
        : [h('p', {}, `finished ${l ? l.emoji + ' ' + l.title : 'a lesson'} — ${p.score}/${p.total} · +${p.xp} XP`),
          (p.bloopers || []).filter(b => ITEMS[b.item] && ITEMS[b.picked]).map(b => h('div', { class: 'blooper' }, 'mixed up ', W(ITEMS[b.item], target), ` (${ITEMS[b.item].en}) with `, W(ITEMS[b.picked], target), ` (${ITEMS[b.picked].en}) 😅`))],
      h('div', { class: 'reacts' }, REACTIONS.map(em => h('button', {
        class: 'react' + (r[em] && r[em].has(me) ? ' on' : ''), onclick: () => { if (!(r[em] && r[em].has(me))) Store.add(me, 'react', { target: e.id, emoji: em }); },
      }, em, r[em] ? ' ' + r[em].size : ''))));
  };
  return [
    h('div', { class: 'card compose' },
      h('textarea', { rows: 2, dir: 'auto', placeholder: `Write something to ${nameOf(other(me))}…`, oninput: e => { text = e.target.value; } }),
      h('button', { class: 'btn primary', onclick: post }, 'Send')),
    D.feed.length ? D.feed.slice().reverse().map(entry) : h('p', { class: 'muted center' }, 'Nothing here yet. Finish a lesson or write the first note.'),
  ];
}

function viewTeach() {
  const them = other(me);
  const row = it => {
    const editing = ui.editing === it.id, recording = ui.recording && ui.recording.item === it.id;
    if (editing) {
      let text = word(it, me), tr = me === 'ar' ? translit(it) : '';
      const save = () => { if (text.trim()) Store.add(me, 'fix', { item: it.id, text: text.trim(), tr: tr.trim() }); ui.editing = null; render(); };
      return h('div', { class: 'teach-row editing' },
        h('div', { class: 'muted small' }, `“${it.en}” — how do you really say it?`),
        h('input', { class: 'text ' + me, dir: LANG[me].dir, lang: me, value: text, oninput: e => { text = e.target.value; } }),
        me === 'ar' ? h('input', { class: 'text', placeholder: 'How it sounds, in Latin letters', value: tr, oninput: e => { tr = e.target.value; } }) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: save }, 'Save'), h('button', { class: 'btn ghost small', onclick: () => { ui.editing = null; render(); } }, 'Cancel')));
    }
    return h('div', { class: 'teach-row' },
      h('div', { class: 'grow' }, W(it, me, 'big'), h('div', { class: 'muted small' }, it.en + (D.fixes[it.id + ':' + me] ? ' · corrected by you' : ''))),
      D.audio[it.id + ':' + me] ? h('button', { class: 'icon', 'aria-label': 'Play your recording', onclick: () => speak(it, me) }, '▶️') : null,
      h('button', { class: 'icon' + (recording ? ' rec' : ''), 'aria-label': recording ? 'Stop recording' : 'Record your voice', onclick: () => toggleRecord(it) }, recording ? '⏹️' : '🎙️'),
      h('button', { class: 'icon', 'aria-label': 'Correct this word', onclick: () => { ui.editing = it.id; render(); } }, '✏️'));
  };
  return [
    h('div', { class: 'card' }, h('h2', {}, `You're ${nameOf(them)}'s teacher`),
      h('p', { class: 'muted' }, `These are the ${LANG[me].name} words ${nameOf(them)} is learning. Record them in your voice 🎙️ and fix anything you'd say differently ✏️. ${nameOf(them)} hears your voice in their lessons.`),
      (() => { const n = Object.keys(D.audio).filter(k => k.endsWith(':' + them)).length;
        return h('p', { class: 'small voiced' }, n ? `🗣️ ${nameOf(them)} has recorded ${n} ${LANG[them].name} word${n === 1 ? '' : 's'} for you. Find them in the Us tab, or tap 🗣️ during your lessons.` : `${nameOf(them)} hasn't recorded any ${LANG[them].name} words for you yet.`); })()),
    LESSONS.map(l => {
      const recorded = l.items.filter(it => D.audio[it.id + ':' + me]).length, open = ui.teachOpen === l.id;
      return h('div', { class: 'card teach' },
        h('button', { class: 'teach-head', onclick: () => { ui.teachOpen = open ? null : l.id; ui.editing = null; render(); } },
          h('span', { class: 'emoji' }, l.emoji), h('b', { class: 'grow' }, l.title), h('span', { class: 'muted small' }, `${recorded}/${l.items.length} recorded`), h('span', {}, open ? '▾' : '▸')),
        open ? l.items.map(row) : null);
    }),
  ];
}

function viewMe() {
  const them = other(me);
  return [
    h('div', { class: 'card center' }, avatar(me), h('h2', {}, nameOf(me)),
      h('p', { class: 'muted' }, `Speaks ${LANG[me].name} · learning ${LANG[them].name}`),
      h('div', { class: 'stats' }, h('div', {}, h('b', {}, D.xp[me]), 'XP'), h('div', {}, h('b', {}, '🔥 ' + D.streak(me)), 'day streak'), h('div', {}, h('b', {}, Object.keys(D.done[me]).length), 'lessons'))),
    ONLINE
      ? h('div', { class: 'card' }, h('h3', {}, D.names[them] ? `${nameOf(them)} is here 💞` : 'Invite your partner'),
          h('p', { class: 'muted' }, Store.status() === 'online' ? 'Synced ✓' : Store.status() === 'offline' ? 'Offline — changes are saved here and sync when you are back.' : 'Connecting…'),
          codeBox(),
          h('p', { class: 'muted small' }, 'This code is the key to your space. Use it to come back on any phone or browser, and share it only with each other.'),
          shareBtn())
      : h('div', { class: 'card' }, h('h3', {}, 'Trying it on one device'),
          h('p', { class: 'muted' }, 'Until the app is online, both of you can use this device. Switch sides to play as the other person.'),
          h('button', { class: 'btn', onclick: () => { if (D.names[them]) { me = them; localStorage.setItem('dvoje.me', me); tab = 'home'; } else ui.pendingRole = them; render(); } },
            D.names[them] ? `Switch to ${nameOf(them)}` : `Add the ${LANG[them].name} speaker`)),
    iosHint('me'),
    h('div', { class: 'card' }, h('h3', {}, ONLINE ? 'This device' : 'Start over'),
      h('button', { class: 'btn danger', onclick: () => {
        if (confirm(ONLINE ? `Sign this device out? Your progress stays safe online. To come back, tap "Go back to our space" or enter the code ${showCode(Store.room())}.` : 'Delete all progress, notes and recordings on this device? This cannot be undone.')) { localStorage.removeItem('dvoje.me'); me = null; tab = 'home'; Store.reset(); }
      } }, ONLINE ? 'Sign out on this device' : 'Erase everything on this device')),
  ];
}

function render() {
  D = derive();
  let view;
  if (!me || ui.pendingRole) view = viewOnboard();
  else if (S) view = viewSession();
  else {
    const tabs = [['home', '🏠', 'Learn'], ['feed', '💬', 'Us'], ['teach', '🎙️', 'Teach'], ['me', '🙂', 'Me']];
    const body = tab === 'home' ? viewHome() : tab === 'feed' ? viewFeed() : tab === 'teach' ? viewTeach() : viewMe();
    view = h('div', { class: 'shell' },
      h('header', {}, h('b', {}, 'Dvoje · ', h('span', { lang: 'ar' }, 'اتنين')), Store.status() === 'offline' ? h('span', { class: 'chip', title: 'Offline' }, '☁️✕') : null, h('span', { class: 'chip' }, `🔥 ${D.streak(me)}`), h('span', { class: 'chip' }, `${D.xp[me]} XP`)),
      h('main', {}, body),
      h('nav', {}, tabs.map(([id, icon, label]) => h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; render(); } }, h('span', {}, icon), label))));
  }
  const keep = document.querySelector('main') ? document.querySelector('main').scrollTop : 0;
  $app.replaceChildren(view);
  const m = document.querySelector('main'); if (m) m.scrollTop = keep;
}
// Re-render on changes, but never wipe what someone is typing because the partner did something.
Store.onChange(mine => { if (S && !S.finished) return; const el = document.activeElement; if (!mine && el && /INPUT|TEXTAREA/.test(el.tagName) && el.value) return; render(); });
(async () => {
  await Store.init();
  const m = location.hash.match(/#join=([a-z0-9-]{12,})/i), code = m && normCode(m[1]);
  if (code && ONLINE) {
    history.replaceState(null, '', location.pathname);
    if (code !== Store.room() && (!Store.room() || confirm('Switch to the space from this invite link? This phone leaves the space it is in now (nothing is deleted).'))) {
      localStorage.removeItem('dvoje.me'); me = null; await Store.setRoom(code);
    }
  }
  render();
})();
