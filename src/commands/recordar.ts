import type { App } from '@slack/bolt';
import { createModalView } from '../views/createModal';
import { fetchUserTz } from '../services/tzService';
import { config } from '../config';

/**
 * /recordap  → abre el modal de creación de un nuevo recordatorio.
 *
 * Nota: usamos `/recordap` (no `/recordar`) porque Slack reserva `/recordar`
 * como la versión localizada en español de su comando nativo `/remind`.
 *
 * El channel y la timezone se preseleccionan a partir del contexto:
 *  - channel_id del comando → preseleccionado en `channel_block`
 *  - users.info(user_id).tz → preseleccionado en `timezone_block`
 */
export function registerRecordar(app: App) {
  app.command('/recordap', async ({ ack, body, client, logger }) => {
    await ack();

    const userId = body.user_id;
    // Sólo preseleccionar como "canal" si realmente es un canal (public/private).
    // Los IDs que empiezan con D = IM (DM); no son válidos como destino.
    const cid = body.channel_id;
    const triggerChannelId = cid && (cid.startsWith('C') || cid.startsWith('G'))
      ? cid
      : undefined;

    const tz = await fetchUserTz(client, userId, config.defaultTimezone);

    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: createModalView({ defaultTimezone: tz, triggerChannelId })
      });
    } catch (err) {
      logger.error({ err }, 'failed to open /recordap modal');
    }
  });
}
