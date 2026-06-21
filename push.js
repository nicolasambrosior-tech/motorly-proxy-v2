/**
 * Motorly Push Notifications
 * - Stores user push tokens + vehicle expiry dates in SQLite
 * - Runs daily cron at 9:00 AM Chile time
 * - Sends push notifications via Expo Push API (free)
 */

const Database = require('better-sqlite3');
const cron = require('node-cron');

// ─── Database setup ───────────────────────────────────────────
const db = new Database('./motorly.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    token       TEXT PRIMARY KEY,
    plate       TEXT,
    name        TEXT,
    inspection_expiry TEXT,
    soap_expiry       TEXT,
    permiso_expiry    TEXT,
    multas_count      INTEGER DEFAULT 0,
    updated_at  TEXT DEFAULT (datetime('now'))
  );
`);

// Migración: agrega multas_count si la tabla ya existía sin esa columna
try {
  db.exec(`ALTER TABLE registrations ADD COLUMN multas_count INTEGER DEFAULT 0`);
} catch {} // ya existe — ignorar

// ─── Register / update a user ────────────────────────────────
function upsertRegistration({ token, plate, name, inspectionExpiry, soapExpiry, permisoExpiry }) {
  db.prepare(`
    INSERT INTO registrations (token, plate, name, inspection_expiry, soap_expiry, permiso_expiry, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(token) DO UPDATE SET
      plate = excluded.plate,
      name = excluded.name,
      inspection_expiry = excluded.inspection_expiry,
      soap_expiry = excluded.soap_expiry,
      permiso_expiry = excluded.permiso_expiry,
      updated_at = datetime('now')
  `).run(token, plate, name, inspectionExpiry, soapExpiry, permisoExpiry);
}

// ─── Send push via Expo Push API ─────────────────────────────
async function sendPush(messages) {
  if (!messages.length) return;

  // Expo allows batches of up to 100
  const chunks = [];
  for (let i = 0; i < messages.length; i += 100) {
    chunks.push(messages.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const json = await res.json();
      console.log('[push] sent:', chunk.length, 'messages, response:', JSON.stringify(json).slice(0, 200));
    } catch (e) {
      console.error('[push] error sending batch:', e.message);
    }
  }
}

// ─── Days until expiry ────────────────────────────────────────
function daysUntil(isoDate) {
  if (!isoDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(isoDate + 'T00:00:00');
  const diff = Math.round((expiry - today) / (1000 * 60 * 60 * 24));
  return diff;
}

function notifMessage(docName, days) {
  if (days < 0)  return { title: `⚠️ ${docName} VENCIDO`, body: `Tu ${docName} venció hace ${Math.abs(days)} días. Renuévalo ahora.` };
  if (days === 0) return { title: `🚨 ${docName} vence HOY`, body: `Tienes que renovar tu ${docName} hoy mismo.` };
  if (days === 1) return { title: `⏰ ${docName} vence mañana`, body: `Tu ${docName} vence mañana. ¡No lo dejes para después!` };
  return { title: `📅 ${docName} vence en ${days} días`, body: `Recuerda renovar tu ${docName} antes del vencimiento.` };
}

// Notify at these thresholds (days before expiry)
const NOTIFY_AT = [30, 15, 7, 3, 1, 0, -1];

// Inyectado desde server.js — consulta Boostr traffic_tickets sin duplicar la API key acá
let _fetchFines = null;
function setFetchFines(fn) { _fetchFines = fn; }

// ─── Daily check job ─────────────────────────────────────────
async function runDailyCheck() {
  console.log('[cron] running daily notification check...');
  const rows = db.prepare('SELECT * FROM registrations').all();
  console.log(`[cron] ${rows.length} registered users`);

  const messages = [];

  for (const row of rows) {
    const docs = [
      { name: 'Revisión técnica', expiry: row.inspection_expiry },
      { name: 'SOAP',             expiry: row.soap_expiry },
      { name: 'Permiso de circulación', expiry: row.permiso_expiry },
    ];

    for (const doc of docs) {
      const days = daysUntil(doc.expiry);
      if (days === null) continue;
      if (!NOTIFY_AT.includes(days)) continue;

      const { title, body } = notifMessage(doc.name, days);
      messages.push({
        to: row.token,
        title,
        body,
        sound: 'default',
        data: { plate: row.plate, doc: doc.name, days },
        channelId: 'motorly-alerts',
      });

      console.log(`[cron] queuing push for ${row.plate} — ${doc.name} in ${days} days`);
    }

    // ── Multas: detecta multas nuevas comparando contra el último conteo guardado ──
    if (_fetchFines && row.plate) {
      try {
        const res = await _fetchFines(row.plate);
        const newCount = res?.data?.tickets?.length ?? 0;
        const oldCount = row.multas_count ?? 0;
        if (newCount > oldCount) {
          messages.push({
            to: row.token,
            title: '🚔 Nueva multa de tránsito',
            body: `Tu vehículo ${row.plate} registra ${newCount} multa${newCount === 1 ? '' : 's'} en el sistema.`,
            sound: 'default',
            data: { plate: row.plate, doc: 'Multas' },
            channelId: 'motorly-alerts',
          });
          console.log(`[cron] queuing push for ${row.plate} — multas ${oldCount} → ${newCount}`);
        }
        db.prepare('UPDATE registrations SET multas_count = ? WHERE token = ?').run(newCount, row.token);
      } catch (e) {
        console.error(`[cron] multas check failed for ${row.plate}:`, e.message);
      }
    }
  }

  await sendPush(messages);
  console.log(`[cron] done. Sent ${messages.length} notifications.`);
}

// ─── Schedule: every day at 9:00 AM Chile time (UTC-3 = 12:00 UTC) ──
cron.schedule('0 12 * * *', () => {
  runDailyCheck().catch(e => console.error('[cron] error:', e.message));
}, { timezone: 'America/Santiago' });

console.log('[push] cron scheduled — daily at 9:00 AM Santiago');

module.exports = { upsertRegistration, runDailyCheck, setFetchFines };
