import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { reminderService } from '../services/reminderService';
import { reping } from '../services/repingService';

/**
 * Tick: busca fires en estado `pending` cuyo `next_reping_at` ya pasó y los
 * re-pinguea (o expira si llegaron a `max_pings`).
 */
export async function repingTick(app: App): Promise<void> {
  const due = reminderService.getDueRepings(DateTime.utc().toISO()!);
  if (due.length === 0) return;

  for (const f of due) {
    try {
      await reping(f, app.client);
    } catch (err) {
      console.error(`[repingTick] fire #${f.id} threw:`, (err as Error).message);
    }
  }
}
