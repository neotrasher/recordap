import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { reminderService } from '../services/reminderService';
import { buildRecordarListView } from '../views/recordarListView';

const RECENT_WINDOW_HOURS = 24;

/**
 * /recordap-list  → lista efímera de los recordatorios del usuario.
 *   • active / paused: con botones (Pausar / Reanudar / Cancelar).
 *   • completed / cancelled de las últimas 24h: solo lectura, para que el
 *     usuario vea qué pasó con los one-shot que dispararon rápido.
 *
 * La construcción de la vista vive en `views/recordarListView.ts` para que los
 * action handlers (pause/resume/cancel) la puedan reutilizar al hacer
 * `respond({ replace_original: true })` después de cada cambio.
 */
export function registerRecordarList(app: App) {
  app.command('/recordap-list', async ({ ack, body, respond, logger }) => {
    await ack();

    try {
      const since = DateTime.utc().minus({ hours: RECENT_WINDOW_HOURS }).toISO()!;
      const reminders = reminderService.listMineCurrent(body.user_id, since);
      const total = reminderService.countMineCurrent(body.user_id, since);
      await respond({
        response_type: 'ephemeral',
        ...buildRecordarListView(reminders, total)
      });
    } catch (err) {
      logger.error({ err }, '/recordap-list failed');
      await respond({
        response_type: 'ephemeral',
        text: `❌ Error listando recordatorios: \`${(err as Error).message}\``
      });
    }
  });
}
