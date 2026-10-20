import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

function sameKey(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

async function listKeys(store, prefix) {
  const out = [];
  const res = await store.list({ prefix });
  for (const b of res.blobs) out.push(b.key);
  return out;
}

async function updateBoard(store, mutate) {
  for (let i = 0; i < 12; i++) {
    const r = await store.getWithMetadata('board', { type: 'json' });
    const data = (r && r.data) || { players: {} };
    mutate(data);
    const res = r
      ? await store.setJSON('board', data, { onlyIfMatch: r.etag })
      : await store.setJSON('board', data, { onlyIfNew: true });
    if (res && res.modified) return;
    await new Promise(t => setTimeout(t, 20 + Math.random() * 80));
  }
  throw new Error('board-busy');
}

export default async (req) => {
  const secret = process.env.ADMIN_KEY;
  if (!secret) return json({ ok: false, error: 'disabled' }, 503);
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  const sent = req.headers.get('x-admin-key') || '';
  if (!sameKey(sent, secret)) {
    await new Promise(t => setTimeout(t, 800));
    return json({ ok: false, error: 'auth' }, 401);
  }

  let body = {};
  try { body = await req.json(); } catch (e) { body = {}; }
  const store = getStore('feliza');

  try {
    if (body.action === 'list') {
      const board = await store.get('board', { type: 'json' });
      const players = (board && board.players) || {};
      const regs = await listKeys(store, 'reg:');
      const rows = {};
      for (const k of regs) {
        const [, net, ...h] = k.split(':');
        const id = net + ':' + h.join(':');
        rows[id] = { id, net, h: h.join(':'), total: 0, runs: 0, last: null };
      }
      for (const [id, p] of Object.entries(players)) {
        rows[id] = { id, net: p.net, h: p.h, total: p.total, runs: p.runs, last: p.at };
      }
      const list = Object.values(rows).sort((a, b) => b.total - a.total || a.h.localeCompare(b.h));
      return json({ ok: true, players: list });
    }

    if (body.action === 'delete') {
      const id = String(body.id || '');
      const m = id.match(/^(ig|x):([a-z0-9._]{1,30})$/);
      if (!m) return json({ ok: false, error: 'invalid' }, 400);
      const net = m[1], h = m[2];
      await updateBoard(store, (b) => { delete b.players[id]; });
      await store.delete(`reg:${net}:${h}`);
      const uids = await listKeys(store, 'uid:');
      let removed = 0;
      for (const k of uids) {
        const rec = await store.get(k, { type: 'json' });
        if (rec && rec.net === net && rec.h === h) { await store.delete(k); removed++; }
      }
      return json({ ok: true, uidsRemoved: removed });
    }

    if (body.action === 'adjust') {
      const id = String(body.id || '');
      const m = id.match(/^(ig|x):([a-z0-9._]{1,30})$/);
      const delta = Math.trunc(Number(body.delta));
      if (!m || !Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 5000) return json({ ok: false, error: 'invalid' }, 400);
      let total = 0;
      await updateBoard(store, (b) => {
        const cur = b.players[id] || { net: m[1], h: m[2], total: 0, runs: 0, at: Date.now() };
        cur.total = Math.max(0, cur.total + delta);
        if (delta > 0) cur.at = Date.now();
        b.players[id] = cur;
        total = cur.total;
      });
      return json({ ok: true, total });
    }

    if (body.action === 'reset-scores') {
      await store.delete('board');
      for (const k of await listKeys(store, 'run:')) await store.delete(k);
      return json({ ok: true });
    }

    if (body.action === 'reset-all') {
      await store.delete('board');
      for (const prefix of ['run:', 'reg:', 'uid:']) {
        for (const k of await listKeys(store, prefix)) await store.delete(k);
      }
      return json({ ok: true });
    }

    return json({ ok: false, error: 'action' }, 400);
  } catch (e) {
    return json({ ok: false, error: 'server' }, 500);
  }
};
