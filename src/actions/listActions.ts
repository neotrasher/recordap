import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { reminderService } from '../services/reminderService';
import { nextFire } from '../services/recurrenceService';
import { buildRecordarListView } from '../views/recordarListView';

/**
 * Handlers de los botones que aparecen en cada item de `/recordap-list`:
 *  - `pause_reminder`   → status='paused' (preserva next_fire_at).
 *  - `resume_reminder`  → recomputa next_fire_at y vuelve a 'active' (o 'completed' si no hay más ocurrencias).
 *  - `cancel_reminder`  → status='cancelled', next_fire_at=NULL. Botón con confirm modal nativo.
 *
 * Después de cada acción, re-renderiza la lista en el mismo mensaje efímero
 * con `respond({ replace_original: true })`.
 *
 * Autorización: cada handler verifica que el usuario que pulsó sea el creator
 * del recordatorio. Si no, no-op silencioso (no leak de info).
 */
export function registerListActions(app: App) {
  // ── PAUSAR ──────────────────────────────────────────────────────────────────
  app.action('pause_reminder', async ({ ack, body, action, respond, logger }) => {
    await ack();
    const reminderId = parseInt((action as any).value, 10);
    if (!Number.isFinite(reminderId)) return;
    const userId = (body as any).user.id as string;

    const rem = reminderService.find(reminderId);
    if (!rem || rem.creator_slack_id !== userId) {
      logger.warn(`pause_reminder: unauthorized or not found (rem=${reminderId} user=${userId})`);
      await refreshList(userId, respond);
      return;
    }

    if (rem.status === 'active') {
      reminderService.pauseReminder(reminderId);
      reminderService.logEvent(reminderId, userId, 'paused');
    } else {
      // Estado cambió desde que se renderizó la lista (p.ej. disparó y pasó a
      // completed). Solo refrescamos para mostrar el estado actual.
      logger.info(`pause_reminder: rem ${reminderId} ya no está active (status=${rem.status})`);
    }

    await refreshList(userId, respond);
  });

  // ── REANUDAR ────────────────────────────────────────────────────────────────
  app.action('resume_reminder', async ({ ack, body, action, respond, logger }) => {
    await ack();
    const reminderId = parseInt((action as any).value, 10);
    if (!Number.isFinite(reminderId)) return;
    const userId = (body as any).user.id as string;

    const rem = reminderService.find(reminderId);
    if (!rem || rem.creator_slack_id !== userId) {
      logger.warn(`resume_reminder: unauthorized or not found (rem=${reminderId} user=${userId})`);
      await refreshList(userId, respond);
      return;
    }

    if (rem.status === 'paused') {
      const now = DateTime.utc();
      let nextFireAt: string | null;
      let newStatus: 'active' | 'completed' = 'active';

      if (rem.recurrence === 'none') {
        // One-shot: si la hora original todavía es futura, restáuralo. Si ya
        // pasó, no hay nada que disparar — pasa a completed.
        const original = rem.next_fire_at
          ? DateTime.fromISO(rem.next_fire_at, { zone: 'utc' })
          : null;
        if (original && original > now) {
          nextFireAt = rem.next_fire_at;
        } else {
          nextFireAt = null;
          newStatus = 'completed';
        }
      } else {
        const nxt = nextFire(rem, now);
        if (nxt) nextFireAt = nxt.toISO();
        else { nextFireAt = null; newStatus = 'completed'; }
      }

      reminderService.resumeReminder(reminderId, newStatus, nextFireAt);
      reminderService.logEvent(reminderId, userId, 'resumed', {
        new_status: newStatus,
        next_fire_at: nextFireAt
      });
    } else {
      logger.info(`resume_reminder: rem ${reminderId} ya no está paused (status=${rem.status})`);
    }

    await refreshList(userId, respond);
  });

  // ── CANCELAR ────────────────────────────────────────────────────────────────
  app.action('cancel_reminder', async ({ ack, body, action, respond, logger }) => {
    await ack();
    const reminderId = parseInt((action as any).value, 10);
    if (!Number.isFinite(reminderId)) return;
    const userId = (body as any).user.id as string;

    const rem = reminderService.find(reminderId);
    if (!rem || rem.creator_slack_id !== userId) {
      logger.warn(`cancel_reminder: unauthorized or not found (rem=${reminderId} user=${userId})`);
      await refreshList(userId, respond);
      return;
    }

    // cancelReminder es idempotente vía SQL (UPDATE sin guard de status), así
    // que llamarlo sobre un completed/cancelled no rompe nada y es coherente
    // con la intención del usuario.
    reminderService.cancelReminder(reminderId);
    reminderService.logEvent(reminderId, userId, 'cancelled');

    await refreshList(userId, respond);
  });
}

async function refreshList(
  userId: string,
  respond: (msg: any) => Promise<unknown>
): Promise<void> {
  const list = reminderService.listMineManageable(userId);
  await respond({
    response_type: 'ephemeral',
    replace_original: true,
    ...buildRecordarListView(list)
  });
}
