import type { App } from '@slack/bolt';
import type { WebClient, ChatUpdateArguments } from '@slack/web-api';
import { DateTime } from 'luxon';
import { reminderService } from '../services/reminderService';
import { buildDoneMessage, buildReminderMessage } from '../views/reminderMessage';
import { buildReassignModal } from '../views/reassignModal';
import { computeSnoozeTarget, snoozeLabel } from '../services/snoozeService';
import { slackDate } from '../services/tzService';

/**
 * Handlers de los botones del mensaje de recordatorio:
 *  - `done`     → marca el fire como completado, edita canal + todos los DMs hermanos.
 *  - `snooze`   → posterga el próximo re-ping de este fire (overflow menu con presets).
 *  - `reassign` → abre un modal con `multi_users_select`.
 */
export function registerFireActions(app: App) {
  // ── DONE ────────────────────────────────────────────────────────────────────
  app.action('done', async ({ ack, body, action, client, logger }) => {
    await ack();
    if (action.type !== 'button') return;

    const fireId = parseInt((action as any).value, 10);
    if (!Number.isFinite(fireId)) return;
    const userId = (body as any).user.id as string;
    const now = DateTime.utc();

    const fire = reminderService.findFire(fireId);
    if (!fire) {
      logger.warn(`done: fire ${fireId} not found`);
      return;
    }

    const wasPending = reminderService.markFireDone(fireId, userId, now.toISO()!);
    reminderService.ackDm(fireId, userId, 'done', now.toISO()!);

    if (!wasPending) {
      // Alguien lo marcó antes — igual sincronizamos el mensaje desde el que
      // se hizo click, por si quedó desincronizado.
      logger.info(`done: fire ${fireId} was already not-pending`);
    }

    const rem = reminderService.find(fire.reminder_id);
    if (!rem) return;

    const doneMsg = buildDoneMessage({ rem, doneByUserId: userId, doneAt: now });
    await updateAllCopies(client, fire.channel_id, fire.channel_ts, fireId, doneMsg, logger);

    reminderService.logEvent(rem.id, userId, 'done', { fire_id: fireId });
  });

  // ── SNOOZE ──────────────────────────────────────────────────────────────────
  app.action('snooze', async ({ ack, body, action, client, logger }) => {
    await ack();
    if (action.type !== 'overflow') return;

    const value = (action as any).selected_option?.value as string | undefined;
    if (!value) return;
    const [fireIdStr, preset] = value.split(':');
    const fireId = parseInt(fireIdStr, 10);
    if (!Number.isFinite(fireId) || !preset) return;
    const userId = (body as any).user.id as string;
    const now = DateTime.utc();

    const fire = reminderService.findFire(fireId);
    if (!fire || fire.status !== 'pending') {
      logger.info(`snooze: fire ${fireId} not pending, ignoring`);
      return;
    }

    const rem = reminderService.find(fire.reminder_id);
    if (!rem) return;

    const target = computeSnoozeTarget(preset, rem.timezone);
    if (!target) {
      logger.warn(`snooze: unknown preset ${preset}`);
      return;
    }

    reminderService.snoozeFire(fireId, target.toUTC().toISO()!);
    reminderService.ackDm(fireId, userId, 'snooze', now.toISO()!);

    const note = `💤 Aplazado por <@${userId}> hasta ${slackDate(target)} (${snoozeLabel(preset)})`;
    const updated = buildReminderMessage({
      rem,
      fireId,
      pingCount: fire.ping_count,
      scheduledFor: DateTime.fromISO(fire.scheduled_for),
      assignedTo: fire.assigned_to_slack_id,
      note
    });
    await updateAllCopies(client, fire.channel_id, fire.channel_ts, fireId, updated, logger);

    reminderService.logEvent(rem.id, userId, 'snoozed', {
      fire_id: fireId,
      preset,
      until: target.toUTC().toISO()
    });
  });

  // ── REASSIGN ────────────────────────────────────────────────────────────────
  app.action('reassign', async ({ ack, body, action, client, logger }) => {
    await ack();
    if (action.type !== 'button') return;

    const fireId = parseInt((action as any).value, 10);
    if (!Number.isFinite(fireId)) return;

    const fire = reminderService.findFire(fireId);
    if (!fire) return;
    const rem = reminderService.find(fire.reminder_id);
    if (!rem) return;

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildReassignModal(fireId, rem.title)
      });
    } catch (err) {
      logger.error({ err }, 'reassign: failed to open modal');
    }
  });

  // ── REASSIGN SUBMIT ─────────────────────────────────────────────────────────
  app.view('reminder_reassign_modal', async ({ ack, view, body, client, logger }) => {
    const fireId = parseInt(view.private_metadata || '0', 10);
    const values = view.state.values as Record<string, Record<string, any>>;
    const newUsers: string[] = values.new_assignees_block?.new_assignees?.selected_users ?? [];

    if (newUsers.length === 0) {
      await ack({
        response_action: 'errors',
        errors: { new_assignees_block: 'Selecciona al menos una persona.' }
      });
      return;
    }

    await ack();

    const fire = reminderService.findFire(fireId);
    if (!fire) return;
    const rem = reminderService.find(fire.reminder_id);
    if (!rem) return;

    const userId = (body as any).user.id as string;
    reminderService.updateAssignees(rem.id, newUsers);
    reminderService.logEvent(rem.id, userId, 'reassigned', {
      fire_id: fireId,
      new_assignees: newUsers
    });

    // Followup en el canal (en hilo si tenemos channel_ts) confirmando el cambio
    if (fire.channel_id && fire.channel_ts) {
      try {
        await client.chat.postMessage({
          channel: fire.channel_id,
          thread_ts: fire.channel_ts,
          text: `↻ Reasignado a ${newUsers.map(u => `<@${u}>`).join(' ')} por <@${userId}>. Los próximos disparos van a ir a esas personas.`
        });
      } catch (err) {
        logger.error({ err }, 'reassign: failed to post followup');
      }
    }
  });
}

/**
 * Aplica el mismo `chat.update` al mensaje del canal y a cada DM hermano del fire.
 * Best-effort: errores individuales se loguean pero no abortan el resto.
 */
async function updateAllCopies(
  client: WebClient,
  channelId: string | null,
  channelTs: string | null,
  fireId: number,
  payload: { text: string; blocks: any[] },
  logger: { error: (...args: any[]) => void }
): Promise<void> {
  const update = async (channel: string, ts: string) => {
    const args: ChatUpdateArguments = {
      channel,
      ts,
      text: payload.text,
      blocks: payload.blocks
    };
    await client.chat.update(args);
  };

  if (channelId && channelTs) {
    try { await update(channelId, channelTs); }
    catch (err) { logger.error({ err }, `updateAllCopies: channel update failed (fire ${fireId})`); }
  }

  const dms = reminderService.findDmsByFire(fireId);
  for (const dm of dms) {
    try { await update(dm.dm_channel, dm.dm_ts); }
    catch (err) {
      logger.error({ err }, `updateAllCopies: DM update failed for ${dm.slack_user_id} (fire ${fireId})`);
    }
  }
}
