import type { App } from '@slack/bolt';
import { reminderService } from '../services/reminderService';
import { buildRecordarListView } from '../views/recordarListView';

/**
 * /recordap-list  → lista efímera de los recordatorios `active` y `paused` del
 * usuario. Cada item tiene botones para Pausar / Reanudar / Cancelar.
 *
 * La construcción de la vista vive en `views/recordarListView.ts` para que los
 * action handlers (pause/resume/cancel) la puedan reutilizar al hacer
 * `respond({ replace_original: true })` después de cada cambio.
 */
export function registerRecordarList(app: App) {
  app.command('/recordap-list', async ({ ack, body, respond, logger }) => {
    await ack();

    try {
      const reminders = reminderService.listMineManageable(body.user_id);
      await respond({
        response_type: 'ephemeral',
        ...buildRecordarListView(reminders)
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
