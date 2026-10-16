import { getStore } from '@netlify/blobs';

const START = Date.UTC(2026, 9, 17, 3, 0, 0);
const END = Date.UTC(2026, 9, 19, 20, 0, 0);
const GRACE_MS = 180000;
const TOP_N = 10;
const MAX_MEMORIES = 200;
const GOAL = 2000;

const RULES = {
  ig: /^[a-z0-9._]{1,30}$/,
  x: /^[a-z0-9_]{1,15}$/
};

function readCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function maxMeters(seconds) {
  let m = 0;
  const dt = 0.05;
  for (let t = 0; t < seconds; t += dt) {
    const boost = Math.max(0, Math.min(1, (m - 1000) / 600));
    const speed = (80 + 92 * (1 - Math.exp(-m / 650))) * (1 + 0.10 * boost);
    m += (speed / 8) * dt;
    if (m >= GOAL) return GOAL;
  }
  return m;
}

function phaseOf(t) {
  if (t < START) return 'before';
  if (t < END) return 'live';
  return 'ended';
}

function rankBoard(players) {
  return Object.values(players).sort((a, b) => b.total - a.total || a.at - b.at);
}

async function readBoard(store) {
  const r = await store.getWithMetadata('board', { type: 'json' });
  if (!r) return { data: { players: {} }, etag: null };
  return { data: r.data || { players: {} }, etag: r.etag };
}

async function updateBoard(store, mutate) {
  for (let i = 0; i < 12; i++) {
    const { data, etag } = await readBoard(store);
    mutate(data);
    const res = etag
      ? await store.setJSON('board', data, { onlyIfMatch: etag })
      : await store.setJSON('board', data, { onlyIfNew: true });
    if (res && res.modified) return data;
    await new Promise(r => setTimeout(r, 20 + Math.random() * 80));
  }
  throw new Error('board-busy');
}

function view(board, me) {
  const list = rankBoard(board.players);
  const top = list.slice(0, TOP_N).map((p, i) => ({ rank: i + 1, net: p.net, h: p.h, total: p.total }));
  let mine = null;
  if (me) {
    const idx = list.findIndex(p => p.net === me.net && p.h === me.h);
    const p = idx >= 0 ? list[idx] : null;
    mine = { net: me.net, h: me.h, total: p ? p.total : 0, runs: p ? p.runs : 0, rank: p ? idx + 1 : null };
  }
  return { top, me: mine, players: list.length };
}

export default async (req) => {
  const store = getStore('feliza');
  const baseHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' };

  let uid = readCookie(req.headers.get('cookie'), 'fz_uid');
  let setCookie = null;
  if (!uid) {
    uid = (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now() + '-' + Math.random().toString(36).slice(2));
    setCookie = `fz_uid=${uid}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }
  const respond = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: setCookie ? { ...baseHeaders, 'set-cookie': setCookie } : baseHeaders
  });

  const now = Date.now();
  const phase = phaseOf(now);
  const head = { phase, start: START, end: END, now };

  try {
    const meRec = await store.get(`uid:${uid}`, { type: 'json' });

    if (req.method !== 'POST') {
      const { data } = await readBoard(store);
      return respond({ ...head, ...view(data, meRec) });
    }

    let body = {};
    try { body = await req.json(); } catch (e) { body = {}; }
    const action = body.action;

    if (action === 'register') {
      if (meRec) {
        const { data } = await readBoard(store);
        return respond({ ...head, ok: true, ...view(data, meRec) });
      }
      const net = body.net === 'x' ? 'x' : body.net === 'ig' ? 'ig' : null;
      const h = String(body.handle || '').trim().replace(/^@+/, '').toLowerCase();
      if (!net || !RULES[net].test(h)) return respond({ ...head, ok: false, error: 'invalid' });
      const regKey = `reg:${net}:${h}`;
      const claim = await store.setJSON(regKey, { uid, at: now }, { onlyIfNew: true });
      if (!claim || !claim.modified) {
        const existing = await store.get(regKey, { type: 'json' });
        if (!existing || existing.uid !== uid) return respond({ ...head, ok: false, error: 'taken' });
      }
      const rec = { net, h };
      await store.setJSON(`uid:${uid}`, rec);
      const { data } = await readBoard(store);
      return respond({ ...head, ok: true, ...view(data, rec) });
    }

    if (action === 'start') {
      if (phase !== 'live') return respond({ ...head, ok: false, error: phase });
      if (!meRec) return respond({ ...head, ok: false, error: 'register' });
      const id = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now();
      await store.setJSON(`run:${id}`, { uid, t: now, done: false });
      return respond({ ...head, ok: true, runId: id });
    }

    if (action === 'submit') {
      if (!meRec) return respond({ ...head, ok: false, error: 'register' });
      if (now > END + GRACE_MS) return respond({ ...head, ok: false, error: 'ended' });
      const runId = String(body.runId || '');
      if (!/^[\w-]{8,64}$/.test(runId)) return respond({ ...head, ok: false, error: 'run' });
      const got = await store.getWithMetadata(`run:${runId}`, { type: 'json' });
      if (!got || !got.data || got.data.uid !== uid) return respond({ ...head, ok: false, error: 'run' });
      if (got.data.done) return respond({ ...head, ok: false, error: 'done' });

      const memories = Math.floor(Number(body.memories));
      const meters = Math.floor(Number(body.meters));
      if (!Number.isFinite(memories) || !Number.isFinite(meters) || memories < 0 || meters < 0) {
        return respond({ ...head, ok: false, error: 'invalid' });
      }
      const elapsed = (now - got.data.t) / 1000;
      const limit = maxMeters(elapsed) * 1.15 + 10;
      if (meters > GOAL || meters > limit || memories > MAX_MEMORIES || memories > meters / 13 + 2) {
        return respond({ ...head, ok: false, error: 'implausible' });
      }

      const lock = await store.setJSON(`run:${runId}`, { ...got.data, done: true, memories, meters, at: now }, { onlyIfMatch: got.etag });
      if (!lock || !lock.modified) return respond({ ...head, ok: false, error: 'done' });

      const board = await updateBoard(store, (b) => {
        const k = `${meRec.net}:${meRec.h}`;
        const cur = b.players[k] || { net: meRec.net, h: meRec.h, total: 0, runs: 0, at: now };
        cur.total += memories;
        cur.runs += 1;
        if (memories > 0) cur.at = now;
        b.players[k] = cur;
      });
      return respond({ ...head, ok: true, added: memories, ...view(board, meRec) });
    }

    return respond({ ...head, ok: false, error: 'action' }, 400);
  } catch (e) {
    return respond({ ...head, ok: false, error: 'server' }, 500);
  }
};
