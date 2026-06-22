/**
 * Waitlist — captura de correos desde la landing carz.cl
 * Misma base SQLite que push.js, tabla separada.
 */
const Database = require('better-sqlite3');

const db = new Database('./motorly.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist (
    email      TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function addToWaitlist(email) {
  db.prepare(`
    INSERT INTO waitlist (email) VALUES (?)
    ON CONFLICT(email) DO NOTHING
  `).run(email.trim().toLowerCase());
}

function waitlistCount() {
  return db.prepare('SELECT COUNT(*) as n FROM waitlist').get().n;
}

module.exports = { addToWaitlist, waitlistCount };
