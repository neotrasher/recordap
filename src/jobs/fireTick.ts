import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { reminderService } from '../services/reminderService';
import { fire } from '../services/fireService';

/**
 * Tick: busca recordatorios cuya hora ya llegó (`next_fire_at <= now()`) y los
 * dispara secuencialmente. Si algo falla, sigue con el siguiente para no perder
 * el resto del lote.
 */
export async function fireTick(app: App): Promise<void> {
  const due = reminderService.getDue(DateTime.utc().toISO()!);
  if (due.length === 0) return;

  for (const r of due) {
    try {
      await fire(r, app.client);
    } catch (err) {
      console.error(`[fireTick] reminder #${r.id} threw:`, (err as Error).message);
    }
  }
}
