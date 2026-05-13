import type { App } from '@slack/bolt';
import { reminderService } from '../services/reminderService';
import { slackDate } from '../services/tzService';
import { DateTime } from 'luxon';
import { json } from '../types';

/**
 * /recordap-list  → lista efímera de los recordatorios activos del usuario.
 *
 * MVP: muestra hasta 10 recordatorios activos del creador con título, canal,
 * próxima fecha de disparo y un ID. Sin acciones todavía (Pausar / Editar / Cancelar
 * llegarán cuando implementemos los block_actions).
 */
export function registerRecordarList(app: App) {
  app.command('/recordap-list', async ({ ack, body, respond, logger }) => {
    await ack();

    try {
      const reminders = reminderService.listByCreator(body.user_id).slice(0, 10);

      if (reminders.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: 'No tienes recordatorios activos. Crea uno con `/recordap`.'
        });
        return;
      }

      const items = reminders.map(r => {
        const next = r.next_fire_at
          ? slackDate(DateTime.fromISO(r.next_fire_at))
          : '—';
        const assignees = json.parse<string[]>(r.assignees, []);
        const groups = json.parse<string[]>(r.groups, []);
        const targets = [
          ...assignees.map(u => `<@${u}>`),
          ...groups.map(g => `<!subteam^${g}>`)
        ];
        const targetsStr = targets.length ? targets.join(' ') : '_(@here)_';

        return [
          `*${r.title}*  \`#${r.id}\``,
          `<#${r.channel_id}>  ·  próximo: ${next}  ·  ${r.recurrence}`,
          `Para: ${targetsStr}`
        ].join('\n');
      });

      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `Tus recordatorios activos (${reminders.length})` }
          },
          ...items.flatMap(text => [
            { type: 'divider' as const },
            { type: 'section' as const, text: { type: 'mrkdwn' as const, text } }
          ])
        ],
        text: `Tienes ${reminders.length} recordatorios activos.`
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
