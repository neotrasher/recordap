import type { WebClient, ChatUpdateArguments } from '@slack/web-api';
import { DateTime } from 'luxon';
import type { Reminder, ReminderFire } from '../types';
import { json } from '../types';
import { reminderService } from './reminderService';
import { nextReping } from './recurrenceService';
import { slackDate } from './tzService';
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

    // ── escalación: si hay un líder configurado, avisarle por DM ─────────────
    if (rem.escalate_to) {
      try {
        await escalateToLead(client, rem, fire);
        reminderService.logEvent(rem.id, 'system', 'escalated', {
          fire_id: fire.id,
          escalated_to: rem.escalate_to
        });
      } catch (err) {
        console.error(`[reping] escalation DM failed for fire ${fire.id}:`, (err as Error).message);
      }
    }

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

  // ── postear nudge nuevo (notifica) SOLO en el hilo del mensaje original
  // Antes usábamos reply_broadcast:true (aparecía también en el canal), pero
  // el equipo pidió que sea thread-only para no spamear. Las personas
  // asignadas siguen recibiendo su DM de re-ping aparte, así que nadie deja
  // de enterarse — el canal solo deja de recibir el eco.
  if (fire.channel_id && fire.channel_ts) {
    try {
      await client.chat.postMessage({
        channel: fire.channel_id,
        thread_ts: fire.channel_ts,
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

/**
 * DM de escalación al líder configurado cuando un recordatorio expira sin que
 * nadie lo marque Hecho. Incluye link al mensaje del canal si existe.
 */
async function escalateToLead(client: WebClient, rem: Reminder, fire: ReminderFire): Promise<void> {
  const assignees = json.parse<string[]>(rem.assignees, []);
  const groups = json.parse<string[]>(rem.groups, []);
  const whoStr = [
    ...assignees.map(u => `<@${u}>`),
    ...groups.map(g => `<!subteam^${g}>`)
  ].join(' ') || '_@here_';

  // Link permanente al mensaje del canal, si lo tenemos.
  let channelLink = '';
  if (fire.channel_id && fire.channel_ts) {
    try {
      const permalink = await client.chat.getPermalink({
        channel: fire.channel_id,
        message_ts: fire.channel_ts
      });
      if (permalink.permalink) channelLink = `<${permalink.permalink}|Ver en el canal>`;
    } catch { /* permalink es best-effort */ }
  }

  const conv = await client.conversations.open({ users: rem.escalate_to! });
  const dmChannel = conv.channel?.id;
  if (!dmChannel) return;

  const contextParts: string[] = [
    `Canal: <#${rem.channel_id}>`,
    `Asignados: ${whoStr}`,
    `Creado por: <@${rem.creator_slack_id}>`
  ];
  if (channelLink) contextParts.push(channelLink);

  await client.chat.postMessage({
    channel: dmChannel,
    text: `🚨 Escalación: "${rem.title}" no se completó`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🚨 *Recordatorio sin completar*\n*${escapeMd(rem.title)}* agotó sus ${fire.ping_count} avisos y nadie marcó Hecho.`
        }
      },
      {
        type: 'context',
        elements: contextParts.map(text => ({ type: 'mrkdwn', text }))
      }
    ]
  });
}

function escapeMd(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
