import { getStore } from '@netlify/blobs';

const YEAR = 2026;
const WIN_PROB = 0.05;
const TOTAL = 5;
const TZ = 'America/Argentina/Buenos_Aires';
const CLOSED_WEEKS = [1];
const NEXT_DAY = { 1: 8, 3: 22, 4: null };
function weekOf(day) {
  if (day <= 7) return 1;
  if (day <= 21) return 3;
  return 4;
}

function arNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => +parts.find(p => p.type === t).value;
  const y = get('year'), m = get('month'), d = get('day');
  return { y, m, d, date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

function readCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function makeCode() {
  return 'CHAPPELLWEEN-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

export default async (req) => {
  const store = getStore('feliza');
  const now = arNow();
  const baseHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' };

  let uid = readCookie(req.headers.get('cookie'), 'fz_uid');
  const setCookie = [];
  if (!uid) {
    uid = (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now() + '-' + Math.random().toString(36).slice(2));
    setCookie.push(`fz_uid=${uid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  const respond = (obj) => new Response(JSON.stringify(obj), {
    headers: setCookie.length ? { ...baseHeaders, 'set-cookie': setCookie.join(', ') } : baseHeaders
  });

  if (!(now.y === YEAR && now.m === 10)) {
    return respond({ closed: true });
  }

  const week = weekOf(now.d);
  const weekKey = `week:${YEAR}-W${week}`;
  const userKey = `user:${uid}`;
  const nextDay = NEXT_DAY[week];

  const weekRec = await store.get(weekKey, { type: 'json' });
  const weekTaken = CLOSED_WEEKS.includes(week) || !!(weekRec && weekRec.claimed);

  if (req.method !== 'POST') {
    return respond({ ok: true, week, weekTaken, nextDay });
  }

  let body = {};
  try { body = await req.json(); } catch (e) { body = {}; }
  const action = body && body.action;

  const userRec = await store.get(userKey, { type: 'json' });
  const playedToday = !!(userRec && userRec.date === now.date);

  if (action === 'start') {
    if (playedToday) {
      return respond({
        alreadyToday: true,
        result: userRec.status === 'done' ? userRec.result : 'none',
        code: userRec.code || null, week
      });
    }
    if (weekTaken) {
      return respond({ weekTaken: true, week, nextDay });
    }
    const win = Math.random() < WIN_PROB;
    await store.setJSON(userKey, { date: now.date, status: 'started', win, result: 'none', code: null });
    return respond({ ok: true, win, total: TOTAL, week });
  }

  if (action === 'finish') {
    if (!userRec || userRec.date !== now.date) {
      return respond({ error: 'no-game' });
    }
    if (userRec.status === 'done') {
      return respond({ result: userRec.result, code: userRec.code || null, week });
    }

    let result = 'none';
    let wonCode = null;
    let taken = false;

    if (userRec.win && Number(body.hits) === TOTAL) {
      if (weekTaken) {
        taken = true;
      } else {
        const code = makeCode();
        const claim = { claimed: true, code, uid, at: new Date().toISOString() };
        let ok = true;
        try {
          const res = await store.setJSON(weekKey, claim, { onlyIfNew: true });
          if (res && res.modified === false) ok = false;
        } catch (e) {
          ok = false;
        }
        if (ok) { result = 'ticket'; wonCode = code; } else { taken = true; }
      }
    }

    await store.setJSON(userKey, { date: now.date, status: 'done', win: userRec.win, result, code: wonCode });
    return respond({ result, code: wonCode, taken, week, nextDay });
  }

  return respond({ error: 'bad-request' });
};
