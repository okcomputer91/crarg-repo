// Netlify Function: Ruleta Feliza — 1 entrada por semana de octubre (4 en total).
// Coloca este archivo en:  netlify/functions/spin.mjs
//
// Requiere el paquete @netlify/blobs (ver package.json).
// Netlify provee el almacenamiento "Blobs" automáticamente a las Functions en el sitio publicado.

import { getStore } from '@netlify/blobs';

// ─── Configuración ───────────────────────────────────────────────
const YEAR = 2026;   // Año de la campaña (solo se puede ganar en octubre de este año)
const WIN_PROB = 0.20; // Probabilidad de que un giro gane, mientras la entrada de esa semana siga libre
const TZ = 'America/Argentina/Buenos_Aires';
// Semanas de octubre:  Sem1: 1–7 · Sem2: 8–14 · Sem3: 15–21 · Sem4: 22–31
function weekOf(day) {
  if (day <= 7) return 1;
  if (day <= 14) return 2;
  if (day <= 21) return 3;
  return 4;
}
// ─────────────────────────────────────────────────────────────────

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
  return 'FELIZA-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

export default async (req) => {
  const store = getStore('feliza');
  const now = arNow();
  const baseHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' };

  // Identificar al visitante con una cookie (anti-spam del giro diario)
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

  // Solo se gira/gana con POST (evita giros accidentales por prefetch)
  if (req.method !== 'POST') {
    return respond({ ok: true, hint: 'POST para girar' });
  }

  // La campaña solo está activa en octubre del año configurado
  if (!(now.y === YEAR && now.m === 10)) {
    return respond({ closed: true });
  }

  const week = weekOf(now.d);
  const weekKey = `week:${YEAR}-W${week}`;
  const userKey = `user:${uid}`;

  // Límite: 1 giro por día por usuario
  const userRec = await store.get(userKey, { type: 'json' });
  if (userRec && userRec.date === now.date) {
    return respond({ alreadyToday: true, result: userRec.result, code: userRec.code || null, week });
  }

  // Decidir resultado
  let result = 'none';
  let wonCode = null;

  const weekRec = await store.get(weekKey, { type: 'json' });
  const claimed = !!(weekRec && weekRec.claimed);

  if (!claimed && Math.random() < WIN_PROB) {
    wonCode = makeCode();
    const claim = { claimed: true, code: wonCode, uid, at: new Date().toISOString() };
    let ok = true;
    try {
      // Escritura condicional: solo si NADIE reclamó aún esta semana (garantiza 1 sola entrada/semana)
      const res = await store.setJSON(weekKey, claim, { onlyIfNew: true });
      if (res && res.modified === false) ok = false;
    } catch (e) {
      ok = false; // otro giro la reclamó primero
    }
    if (ok) { result = 'ticket'; } else { result = 'none'; wonCode = null; }
  }

  // Registrar el giro del día de este usuario
  await store.setJSON(userKey, { date: now.date, result, code: wonCode });

  return respond({ result, code: wonCode, week });
};
