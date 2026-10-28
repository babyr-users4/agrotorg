// Агроторг: отправка уведомлений. Запускается GitHub Actions каждые ~5 минут.
// Читает новые записи в Firestore и рассылает push на телефоны сотрудников (Firebase Cloud Messaging).
const TZ = process.env.TZ_NAME || 'Asia/Krasnoyarsk';
const DEP_HOUR = Number(process.env.DEP_HOUR || 20);   // во сколько напомнить об отметках «уехало»
const EXP_HOUR = Number(process.env.EXP_HOUR || 8);    // во сколько проверять сроки годности

/* ---------- время ---------- */
function parts(date, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
  return o;
}
export function localDay(date, tz = TZ) { const p = parts(date, tz); return `${p.year}-${p.month}-${p.day}`; }
export function localHour(date, tz = TZ) { return Number(parts(date, tz).hour); }
function tzOffsetMs(date, tz = TZ) { const p = parts(date, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000; }
export function dayStartIso(date, tz = TZ) {
  const day = localDay(date, tz);
  const guess = Date.parse(day + 'T00:00:00Z');
  return new Date(guess - tzOffsetMs(new Date(guess), tz)).toISOString();
}
const fmtD = iso => { if (!iso) return '—'; const p = iso.slice(0, 10).split('-'); return `${p[2]}.${p[1]}.${p[0].slice(2)}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

/* ---------- вспомогательное ---------- */
const kindOf = m => m.type === 'out' ? 'out' : m.type === 'mv' ? 'mv' : m.type === 'adj' ? 'adj' : m.type === 'plan' ? 'plan' : 'in';
const pname = (cfg, id) => ((cfg.products || []).find(p => p.id === id) || {}).name || 'Товар';
function lines(arr, max = 4) { return arr.length > max ? arr.slice(0, max).concat(`…и ещё ${arr.length - max}`) : arr; }
function groupBy(arr, fn) { const g = new Map(); arr.forEach(x => { const k = fn(x); if (!g.has(k)) g.set(k, []); g.get(k).push(x); }); return g; }
const q = m => Number(m.qty) || 0;

/* ---------- события по новым записям ---------- */
// newMoves: записи с ts > lastTs; delMoves: отменённые с delAt > lastDelAt; editMoves: исправленные с editedAt > lastEditAt
export function buildEvents({ newMoves = [], delMoves = [], editMoves = [], cfg = {} }) {
  const out = [];   // {kind, actor, title, body}
  const live = newMoves.filter(m => !m.del);
  const add = (kind, actorUid, actorName, title, body) => out.push({ kind, actor: actorUid || null, actorName, title, body });

  // приходы и отгрузки: по сотруднику
  for (const [kind, label, sign] of [['in', 'Приход', '+'], ['out', 'Отгрузка', '−']]) {
    const arr = live.filter(m => kindOf(m) === kind);
    for (const [uid, g] of groupBy(arr, m => m.by || '')) {
      const total = g.reduce((s, m) => s + q(m), 0), who = g[0].byName || 'Сотрудник';
      const cities = [...new Set(g.map(m => m.city).filter(Boolean))];
      add(kind, uid, who, `${label}: ${sign}${total} кор.${kind === 'out' && cities.length ? ' → ' + cities.join(', ') : ''}`,
        lines(g.map(m => `${pname(cfg, m.product)} · ${m.cell} · ${sign}${q(m)}`)).join('\n') + `\n${who}`);
    }
  }
  // списания (создаются как adj с writeoff)
  for (const [uid, g] of groupBy(live.filter(m => kindOf(m) === 'adj' && m.writeoff), m => m.by || '')) {
    const total = g.reduce((s, m) => s - q(m), 0), who = g[0].byName || 'Сотрудник';
    add('del', uid, who, `Списание: ${total} кор.`, lines(g.map(m => `${pname(cfg, m.product)} · ${m.cell} · −${-q(m)} · ${m.reason || 'без причины'}`)).join('\n') + `\n${who}`);
  }
  // перемещения и пересчёты → «изменения в ячейках»
  for (const [uid, g] of groupBy(live.filter(m => kindOf(m) === 'mv' || (kindOf(m) === 'adj' && !m.writeoff)), m => m.by || '')) {
    const who = g[0].byName || 'Сотрудник';
    add('cell', uid, who, 'Изменения в ячейках', lines(g.map(m => kindOf(m) === 'mv'
      ? `Перемещено ${q(m)} кор.: ${m.cell} → ${m.to}`
      : (q(m) === 0 ? `Пересчёт ${m.cell}: совпало` : `Пересчёт ${m.cell}: ${m.prev} → ${m.now} кор.`))).join('\n') + `\n${who}`);
  }
  // отменённые записи
  for (const [uid, g] of groupBy(delMoves.filter(m => m.del && !(m.writeoff && false)), m => m.delBy || '')) {
    const who = g[0].delByName || 'Сотрудник';
    add('del', uid, who, `Отменено записей: ${g.length}`, lines(g.map(m => `${{ in: 'Приход', out: 'Отгрузка', mv: 'Перемещение', adj: m.writeoff ? 'Списание' : 'Пересчёт', plan: 'Ожидаемый приход' }[kindOf(m)]} ${q(m) ? Math.abs(q(m)) + ' кор. ' : ''}· ${pname(cfg, m.product)} · ${m.cell || ''}`)).join('\n') + `\n${who}`);
  }
  // исправления приходов/ячеек
  for (const [uid, g] of groupBy(editMoves.filter(m => !m.del), m => m.editedBy || '')) {
    const who = g[0].editedByName || 'Сотрудник';
    add('cell', uid, who, `Исправлено записей: ${g.length}`, lines(g.map(m => `${pname(cfg, m.product)} · ${m.cell}${m.to ? ' → ' + m.to : ''} · ${q(m)} кор.`)).join('\n') + `\n${who}`);
  }
  return out;
}

/* ---------- сроки годности ---------- */
export function expiryEvent({ allMoves = [], cfg = {}, now = new Date(), sent = {} }) {
  const lots = new Map();
  allMoves.filter(m => !m.del && m.product && m.exp).forEach(m => {
    const k = `${m.product}|${m.prod}|${m.exp}`, t = kindOf(m);
    let d = 0;
    if (t === 'in') d = q(m); else if (t === 'out') d = -q(m); else if (t === 'adj') d = q(m); else return;
    const l = lots.get(k) || { product: m.product, prod: m.prod, exp: m.exp, qty: 0 };
    l.qty += d; lots.set(k, l);
  });
  const today = localDay(now), warn = Number(cfg.warnPct) || 65, newSent = {}, fresh = [], expired = [];
  for (const [k, l] of lots) {
    if (l.qty <= 0) continue;
    const left = daysBetween(today, l.exp), life = daysBetween(l.prod, l.exp);
    const pct = life > 0 ? Math.max(0, Math.round(left / life * 1000) / 10) : 0;
    const stage = left < 0 ? 'expired' : pct <= warn ? 'warn' : '';
    if (!stage) continue;
    newSent[k] = stage;
    if (sent[k] === stage || (sent[k] === 'expired' && stage === 'warn')) continue;
    (stage === 'expired' ? expired : fresh).push({ ...l, left, pct });
  }
  const ev = [];
  const fmtL = l => `${pname(cfg, l.product)} · до ${fmtD(l.exp)} · ${l.qty} кор.${l.left >= 0 ? ` · осталось ${String(l.pct).replace('.', ',')}% (${l.left} дн.)` : ''}`;
  if (expired.length) ev.push({ kind: 'exp', actor: null, title: `Срок годности истёк: ${expired.length} парт.`, body: lines(expired.map(fmtL)).join('\n') });
  if (fresh.length) ev.push({ kind: 'exp', actor: null, title: `Срок годности ${warn}% и ниже: ${fresh.length} парт.`, body: lines(fresh.map(fmtL)).join('\n') });
  return { events: ev, sent: newSent };
}

/* ---------- минимальный остаток товара ---------- */
export function stockByProduct(allMoves = []) {
  const st = {};
  allMoves.filter(m => !m.del && m.product).forEach(m => {
    const t = kindOf(m); let d = 0;
    if (t === 'in') d = q(m); else if (t === 'out') d = -q(m); else if (t === 'adj') d = q(m); else return;
    st[m.product] = (st[m.product] || 0) + d;
  });
  return st;
}
// Одно уведомление, когда товар опустился ниже минимума; снова — только после того, как поднялся выше и опять упал
export function lowEvent({ allMoves = [], cfg = {}, sent = {} }) {
  const st = stockByProduct(allMoves), newSent = {}, fresh = [];
  for (const p of (cfg.products || [])) {
    const min = Number(p.min) || 0; if (min <= 0) continue;
    const have = st[p.id] || 0; if (have >= min) continue;
    newSent[p.id] = 1;
    if (!sent[p.id]) fresh.push(`${p.name || 'Товар'}: ${have} кор. (минимум ${min})`);
  }
  const ev = fresh.length ? [{ kind: 'low', actor: null, title: `Мало товара: ${fresh.length === 1 ? fresh[0].split(':')[0] : fresh.length + ' тов.'}`, body: lines(fresh).join('\n') }] : [];
  return { events: ev, sent: newSent };
}

/* ---------- отгрузки без отметки «уехало» ---------- */
export function depEvent({ todayOuts = [] }) {
  const outs = todayOuts.filter(m => !m.del && kindOf(m) === 'out');
  const byCity = groupBy(outs, m => m.city || 'без города');
  const bad = [];
  for (const [c, g] of byCity) if (!g.every(m => m.dep === 'ok')) bad.push(`${c} · ${g.reduce((s, m) => s + q(m), 0)} кор.${g.some(m => m.dep === 'bad') ? ' · отмечено «не уехало»' : ''}`);
  if (!bad.length) return [];
  return [{ kind: 'dep', actor: null, title: `Не отмечено «уехало»: ${bad.length} гор.`, body: lines(bad, 6).join('\n') }];
}

/* ---------- запросы между сотрудниками ---------- */
export function reqEvents({ newReqs = [], doneReqs = [] }) {
  const ev = [];
  newReqs.filter(r => r.status === 'open').forEach(r => ev.push({
    kind: 'req', actor: r.from || null, to: r.to || 'all',
    title: `Запрос от ${r.fromName || 'сотрудника'}${r.to && r.to !== 'all' ? '' : ' (всем)'}`,
    body: String(r.text || '')
  }));
  doneReqs.filter(r => r.status === 'done' && r.doneBy && r.doneBy !== r.from).forEach(r => ev.push({
    kind: 'req', actor: r.doneBy, to: r.from,
    title: `Выполнено: ${r.doneByName || 'сотрудник'}`,
    body: String(r.text || '')
  }));
  return ev;
}

// Напоминание: запрос ждёт больше 2 часов (но не старше суток), напоминаем один раз
export function reminderReqs(openReqs, now = new Date(), hours = 2) {
  const t = now.getTime();
  return openReqs.filter(r => r.status === 'open' && !r.remindedAt && t - Date.parse(r.ts) >= hours * 36e5 && t - Date.parse(r.ts) < 24 * 36e5);
}
export function reminderEvents(reqs) {
  return reqs.map(r => ({ kind: 'req', actor: r.from || null, to: r.to || 'all', title: `Напоминание: запрос от ${r.fromName || 'сотрудника'}`, body: String(r.text || '') }));
}

/* ---------- рассылка ---------- */
export function pickTokens(devices, ev) {
  const seen = new Set(), res = [];
  devices.forEach(d => {
    if (!d.token || seen.has(d.token)) return;
    if (d.events && d.events[ev.kind] === false) return;
    if (ev.actor && d.uid === ev.actor) return;
    if (ev.to && ev.to !== 'all' && d.uid !== ev.to) return;
    seen.add(d.token); res.push(d.token);
  });
  return res;
}

async function main() {
  const admin = (await import('firebase-admin')).default;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore(), now = new Date(), nowIso = now.toISOString();
  const stRef = db.doc('push_state/main'), stSnap = await stRef.get();
  let st = stSnap.exists ? stSnap.data() : null;
  const first = !st;
  if (!st) st = { lastTs: nowIso, lastDelAt: nowIso, lastEditAt: nowIso, expDay: '', depDay: '', expSent: {} };

  const cfgSnap = await db.doc('config/main').get(); const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const devices = (await db.collection('devices').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const events = [];
  let allCache = null;
  const getAll = async () => allCache || (allCache = (await db.collection('moves').get()).docs.map(d => ({ id: d.id, ...d.data() })));
  let stockChanged = false;

  if (!first) {
    const get = async (field, since) => (await db.collection('moves').where(field, '>', since).orderBy(field).get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const newMoves = await get('ts', st.lastTs), delMoves = await get('delAt', st.lastDelAt), editMoves = await get('editedAt', st.lastEditAt);
    events.push(...buildEvents({ newMoves, delMoves, editMoves, cfg }));
    stockChanged = newMoves.some(m => !m.del && (kindOf(m) === 'out' || kindOf(m) === 'adj')) || delMoves.length > 0 || editMoves.length > 0; // остаток мог уменьшиться
    const mx = (arr, f, d) => arr.reduce((m, x) => (x[f] && x[f] > m ? x[f] : m), d);
    st.lastTs = mx(newMoves, 'ts', st.lastTs); st.lastDelAt = mx(delMoves, 'delAt', st.lastDelAt); st.lastEditAt = mx(editMoves, 'editedAt', st.lastEditAt);
  }
  if (!first) {
    if (!st.lastReq) { st.lastReq = st.lastTs || nowIso; st.lastReqDone = st.lastReq; }
    const getR = async (field, since) => (await db.collection('requests').where(field, '>', since).orderBy(field).get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const newReqs = await getR('ts', st.lastReq), doneReqs = await getR('doneAt', st.lastReqDone);
    events.push(...reqEvents({ newReqs, doneReqs }));
    const mx2 = (arr, f, d) => arr.reduce((m, x) => (x[f] && x[f] > m ? x[f] : m), d);
    st.lastReq = mx2(newReqs, 'ts', st.lastReq); st.lastReqDone = mx2(doneReqs, 'doneAt', st.lastReqDone);
  }
  if (!first) {
    const openSnap = (await db.collection('requests').where('status', '==', 'open').get()).docs.map(d => ({ id: d.id, ...d.data() }));
    const rem = reminderReqs(openSnap, now);
    events.push(...reminderEvents(rem));
    for (const r of rem) await db.doc('requests/' + r.id).update({ remindedAt: nowIso });
  }
  const today = localDay(now), hour = localHour(now);
  if (hour >= EXP_HOUR && st.expDay !== today) {
    const all = await getAll();
    stockChanged = true;
    const r = expiryEvent({ allMoves: all, cfg, now, sent: st.expSent || {} });
    events.push(...r.events); st.expSent = r.sent; st.expDay = today;
  }
  if (!first && stockChanged && (cfg.products || []).some(p => Number(p.min) > 0)) {
    const r = lowEvent({ allMoves: await getAll(), cfg, sent: st.lowSent || {} });
    events.push(...r.events); st.lowSent = r.sent;
  }
  if (hour >= DEP_HOUR && st.depDay !== today) {
    const outs = (await db.collection('moves').where('ts', '>=', dayStartIso(now)).get()).docs.map(d => ({ id: d.id, ...d.data() }));
    events.push(...depEvent({ todayOuts: outs })); st.depDay = today;
  }

  let sentN = 0; const dead = new Set();
  for (const ev of events) {
    const tokens = pickTokens(devices, ev); if (!tokens.length) continue;
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        data: { title: ev.title, body: ev.body, tag: `${ev.kind}-${Date.now()}`, url: process.env.APP_URL || '' },
        webpush: { headers: { Urgency: 'high', TTL: '3600' } },
        android: { priority: 'high' }
      });
      res.responses.forEach((r, j) => {
        if (r.success) sentN++;
        else if (r.error && /registration-token-not-registered|invalid-argument|invalid-registration-token/.test(r.error.code || '')) dead.add(chunk[j]);
        else console.log('send error', r.error && r.error.code);
      });
    }
  }
  for (const d of devices) if (dead.has(d.token)) await db.doc('devices/' + d.id).delete();
  await stRef.set(st);
  console.log(`ok: событий ${events.length}, отправлено ${sentN}, удалено старых адресов ${dead.size}${first ? ' (первый запуск: только запомнили время)' : ''}`);
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
