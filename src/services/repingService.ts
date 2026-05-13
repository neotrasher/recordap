import type { WebClient, ChatUpdateArguments } from '@slack/web-api';
import { DateTime } from 'luxon';
import type { ReminderFire } from '../types';
import { reminderService } from './reminderService';
import { nextReping } from './recurrenceService';
import {
  buildReminderMessage,
  buildExpiredMessage,
  buildRepingNudge
} from '../views/reminderMessage';

/**
 * Re-ping de un fire pendiente:
 *  - Si ya alcanzó `max_pings`, lo marca expired y edita el mensaje original.
 *  - Si no, edita el mensaje original con el nuevo ping_count, postea un nudge
 *    follow-up en el canal y DMs, y agenda el próximo re-ping.
 *
 * El "main message" del canal (channel_ts) y los DMs registrados conservan los
 * botones; los nudges follow-up son sólo notificaciones (sin botones).
 */
export async function reping(fire: ReminderFire, client: WebClient): Promise<void> {
  const now = DateTime.utc();

  const rem = reminderService.find(fire.reminder_id);
  if (!rem) {
    console.warn(`[reping] reminder ${fire.reminder_id} not found, expiring fire ${fire.id}`);
    reminderService.expireFire(fire.id);
    return;
  }

  const nextCount = fire.ping_count + 1;
  const cap = rem.max_pings === 'inf' ? Infinity : parseInt(rem.max_pings, 10);
  const reachedCap = nextCount > cap;

  if (reachedCap) {
    // ── expirar: editar todas las copias con el mensaje de "sin respuesta"
    reminderService.expireFire(fire.id);
    const expired = buildExpiredMessage({
      rem,
      totalPings: fire.ping_count,
      expiredAt: now
    });
    await updateAllCopies(client, fire.channel_id, fire.channel_ts, fire.id, expired);
    reminderService.logEvent(rem.id, 'system', 'expired', {
      fire_id: fire.id,
      total_pings: fire.ping_count
    });
    // Si la regla está active sin más disparos y este era el último pending, completa.
    if (reminderService.maybeCompleteRule(rem.id)) {
      reminderService.logEvent(rem.id, 'system', 'auto_completed', { trigger: 'last_fire_expired' });
    }
    return;
  }

  // ── seguir pingueando: editar mensaje principal con ping_count actualizado
  const updatedMain = buildReminderMessage({
    rem,
    fireId: fire.id,
    pingCount: nextCount,
    scheduledFor: DateTime.fromISO(fire.scheduled_for, { zone: 'utc' }),
    assignedTo: fire.assigned_to_slack_id
  });
  await updateAllCopies(client, fire.channel_id, fire.channel_ts, fire.id, updatedMain);

  // ── postear nudge nuevo (notifica) en el canal en hilo del original
  if (fire.channel_id && fire.channel_ts) {
    try {
      await client.chat.postMessage({
        channel: fire.channel_id,
        thread_ts: fire.channel_ts,
        reply_broadcast: true,   // también lo muestra en el canal, no solo en hilo
        text: buildRepingNudge({
          rem,
          pingCount: nextCount,
          channelTs: fire.channel_ts,
          assignedTo: fire.assigned_to_slack_id
        })
      });
    } catch (err) {
      console.error(`[reping] channel nudge failed (fire ${fire.id}):`, (err as Error).message);
    }
  }

  // ── nudge en cada DM hermano
  const dms = reminderService.findDmsByFire(fire.id);
  for (const dm of dms) {
    try {
      await client.chat.postMessage({
        channel: dm.dm_channel,
        text: buildRepingNudge({
          rem,
          pingCount: nextCount,
          channelTs: fire.channel_ts,
          assignedTo: dm.slack_user_id,
          forDm: true
        })
      });
    } catch (err) {
      console.error(`[reping] DM nudge failed for ${dm.slack_user_id} (fire ${fire.id}):`, (err as Error).message);
    }
  }

  // ── agendar próximo re-ping (basado en reping_every de la regla)
  const nxt = nextReping(rem.reping_every, now);
  const nxtIso = nxt ? nxt.toUTC().toISO() : null;
  reminderService.bumpFireReping(fire.id, nextCount, nxtIso);

  reminderService.logEvent(rem.id, 'system', 'repinged', {
    fire_id: fire.id,
    new_ping_count: nextCount,
    next_reping_at: nxtIso
  });
}

async function updateAllCopies(
  client: WebClient,
  channelId: string | null,
  channelTs: string | null,
  fireId: number,
  payload: { text: string; blocks: any[] }
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
    catch (err) { console.error(`[reping] channel update failed (fire ${fireId}):`, (err as Error).message); }
  }

  const dms = reminderService.findDmsByFire(fireId);
  for (const dm of dms) {
    try { await update(dm.dm_channel, dm.dm_ts); }
    catch (err) { console.error(`[reping] DM update failed for ${dm.slack_user_id} (fire ${fireId}):`, (err as Error).message); }
  }
}
