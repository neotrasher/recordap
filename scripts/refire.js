#!/usr/bin/env node
/**
 * refire.js — re-disparar manualmente uno o más recordatorios.
 *
 * Útil cuando un fire original falló (p.ej. channel_not_found porque el bot
 * no estaba invitado al canal) y queremos retransmitirlo después de
 * arreglar la causa.
 *
 * Comportamiento por cada reminder_id pasado:
 *   1. Busca fires existentes en estado 'pending' para ese reminder y los
 *      marca como 'cancelled' (evita orfanatos cuando creemos un fire nuevo).
 *   2. Llama fireService.fire() que crea un nuevo fire, postea al canal,
 *      manda los DMs y actualiza el estado del reminder según sus reglas.
 *
 * Uso (desde la raíz del repo, con dist/ ya buildeado):
 *
 *   node scripts/refire.js <reminder_id> [<reminder_id> ...]
 *
 * Ejemplo: re-disparar los reminders 2 y 4
 *
 *   cd /root/recordap
 *   node scripts/refire.js 2 4
 */

require('dotenv').config();
const { WebClient } = require('@slack/web-api');
const Database = require('better-sqlite3');

const args = process.argv.slice(2).map(Number).filter(Number.isInteger);
if (args.length === 0) {
  console.error('Uso: node scripts/refire.js <reminder_id> [<reminder_id> ...]');
  process.exit(1);
}

// Importa código compilado, así reutilizamos exactamente la lógica del bot.
const { fire } = require('../dist/services/fireService');
const { reminderService } = require('../dist/services/reminderService');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const db = new Database(process.env.DB_PATH || './data/reminders.db');
const cancelPendingFiresStmt = db.prepare(
  "UPDATE reminder_fires SET status='cancelled' WHERE reminder_id = ? AND status = 'pending'"
);

(async () => {
  for (const id of args) {
    const rem = reminderService.find(id);
    if (!rem) {
      console.error(`#${id}: no encontrado`);
      continue;
    }
    console.log(`#${id} "${rem.title}" → canal ${rem.channel_id}`);
    const cancelled = cancelPendingFiresStmt.run(id).changes;
    if (cancelled > 0) {
      console.log(`  · ${cancelled} fire(s) pending cancelado(s) por huérfanos`);
    }
    try {
      await fire(rem, client);
      console.log('  ✓ disparado');
    } catch (err) {
      console.error('  ✗ falló:', err.message);
    }
  }
  process.exit(0);
})();
