import type { WebClient } from '@slack/web-api';
import { DateTime } from 'luxon';
import type { Reminder } from '../types';
import { json } from '../types';
import { reminderService } from './reminderService';
import { nextFire, nextReping } from './recurrenceService';
import { buildReminderMessage } from '../views/reminderMessage';

/**
 * Disparar un recordatorio:
 *  1. Resuelve quién recibe DM (personas individuales, no miembros de grupos).
 *  2. Inserta la fila `reminder_fires` (necesitamos su id para los botones).
 *  3. Postea al canal y guarda channel_ts.
 *  4. Postea DMs y guarda en reminder_dms.
 *  5. Recomputa el próximo next_fire_at de la regla (o la marca completed).
 *  6. Loguea evento de auditoría 'fired'.
 *
 * Si falla el post al canal o los DMs, el error se loguea pero el flujo continúa —
 * el `next_fire_at` igualmente avanza para no quedarse atrancado.
 */
export async function fire(rem: Reminder, client: WebClient): Promise<void> {
  const now = DateTime.utc();
  const scheduledFor = rem.next_fire_at
    ? DateTime.fromISO(rem.next_fire_at, { zone: 'utc' })
    : now;

  const assignees: string[] = json.parse(rem.assignees, []);

  // ── decide quién va a DM (rotación opcional) ──────────────────────────────
  let assignedTo: string | null = null;
  let dmTargets: string[] = [];

  if (rem.rotation_mode === 'rotate' && assignees.length > 0) {
    assignedTo = assignees[rem.rotation_index % assignees.length];
    if (rem.notify_dm) {
      dmTargets = rem.notify_only_turn ? [assignedTo] : assignees.slice();
    }
  } else if (rem.notify_dm) {
    dmTargets = assignees.slice();
  }

  // ── insertar fire row primero (para tener fire_id en los botones) ─────────
  const isTask = rem.reminder_type === 'task';
  const repingAt = isTask && rem.reping_every !== 'off'
    ? nextReping(rem.reping_every, now)?.toUTC().toISO() ?? null
    : null;

  const fireId = reminderService.recordFire({
    reminder_id: rem.id,
    scheduled_for: scheduledFor.toISO()!,
    fired_at: now.toISO()!,
    status: isTask ? 'pending' : 'done',
    ping_count: 1,
    next_reping_at: repingAt,
    channel_id: null,
    channel_ts: null,
    assigned_to_slack_id: assignedTo
  });

  // ── canal ─────────────────────────────────────────────────────────────────
  if (rem.notify_channel) {
    try {
      const msg = buildReminderMessage({
        rem, fireId, pingCount: 1, scheduledFor, assignedTo
      });
      const res = await client.chat.postMessage({
        channel: rem.channel_id,
        text: msg.text,
        blocks: msg.blocks,
        unfurl_links: false
      });
      if (res.ts) {
        reminderService.updateFireChannel(fireId, rem.channel_id, res.ts);
      }
    } catch (err) {
      console.error(`[fire #${fireId}] channel post failed for reminder ${rem.id}:`, (err as Error).message);
      // Notificar al creator en DM. Una sola vez por fire — no se reintenta
      // en re-pings (el problema es estructural: hay que invitar al bot al
      // canal o corregir el reminder).
      notifyCreatorOfChannelError(client, rem, fireId, err).catch(e => {
        console.error(`[fire #${fireId}] failed to DM creator about channel error:`, (e as Error).message);
      });
    }
  }

  // ── DMs ───────────────────────────────────────────────────────────────────
  for (const uid of dmTargets) {
    try {
      const msg = buildReminderMessage({
        rem, fireId, pingCount: 1, scheduledFor,
        assignedTo: uid, forDm: true
      });
      const conv = await client.conversations.open({ users: uid });
      const dmChannel = conv.channel?.id;
      if (!dmChannel) continue;

      const dmRes = await client.chat.postMessage({
        channel: dmChannel,
        text: msg.text,
        blocks: msg.blocks
      });
      if (dmRes.ts) {
        reminderService.recordDm({
          fire_id: fireId,
          slack_user_id: uid,
          dm_channel: dmChannel,
          dm_ts: dmRes.ts
        });
      }
    } catch (err) {
      console.error(`[fire #${fireId}] DM to ${uid} failed for reminder ${rem.id}:`, (err as Error).message);
    }
  }

  // ── recomputar next_fire_at de la regla ───────────────────────────────────
  let newNextFireAt: string | null = null;
  let newStatus: 'active' | 'completed' = 'active';

  if (rem.recurrence !== 'none') {
    // pasamos un stub con fires_count incrementado para que endsReached('after_n')
    // lo evalúe contra el conteo POST-fire
    const stub: Reminder = { ...rem, fires_count: rem.fires_count + 1 };
    const nxt = nextFire(stub, now);
    if (nxt) newNextFireAt = nxt.toISO();
  }

  // Decisión de status:
  //   - Si hay próximos disparos      → active.
  //   - Si NO hay próximos disparos:
  //       - 'ping'  (sin Done)        → completed (no hay nada más por hacer).
  //       - 'task'  (con Done)        → active todavía. El fire que acabamos de
  //         crear está pending; la regla cierra cuando ese fire cierre (Done o
  //         expiración). Esto evita que un one-shot "desaparezca" de la lista
  //         mientras el usuario todavía tiene un botón Done por pulsar.
  if (newNextFireAt) {
    newStatus = 'active';
  } else if (rem.reminder_type === 'ping') {
    newStatus = 'completed';
  } else {
    newStatus = 'active';
  }

  const newRotationIndex = rem.rotation_mode === 'rotate' && assignees.length > 0
    ? (rem.rotation_index + 1) % assignees.length
    : rem.rotation_index;

  reminderService.updateAfterFire(rem.id, newRotationIndex, newNextFireAt, newStatus);

  reminderService.logEvent(rem.id, 'system', 'fired', {
    fire_id: fireId,
    scheduled_for: scheduledFor.toISO(),
    next_fire_at: newNextFireAt,
    new_status: newStatus,
    dm_recipients: dmTargets.length
  });
}

/**
 * Avisa al creator vía DM cuando el post al canal falló. La causa más común
 * es `channel_not_found` (bot no invitado al canal). Mensaje accionable para
 * que sepa exactamente qué hacer.
 */
async function notifyCreatorOfChannelError(
  client: WebClient,
  rem: Reminder,
  fireId: number,
  err: unknown
): Promise<void> {
  const code = (err as any)?.data?.error ?? 'unknown';

  let helpMsg: string;
  switch (code) {
    case 'channel_not_found':
    case 'not_in_channel':
      helpMsg = `El bot no tiene acceso a <#${rem.channel_id}>. Ve a ese canal y ejecuta \`/invite @Recordap\` para que pueda postear.`;
      break;
    case 'is_archived':
      helpMsg = `El canal <#${rem.channel_id}> está archivado. Edita el recordatorio con \`/recordap-list\` y elige otro canal.`;
      break;
    case 'restricted_action':
    case 'msg_too_long':
      helpMsg = `Slack rechazó el mensaje: \`${code}\`. Probablemente la descripción es muy larga o el canal tiene restricciones.`;
      break;
    default:
      helpMsg = `Slack devolvió un error: \`${code}\`. Revisa la configuración del canal.`;
  }

  await client.chat.postMessage({
    channel: rem.creator_slack_id,
    text: `⚠️ "${rem.title}" no se pudo publicar: ${code}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `⚠️ *Recordatorio sin entregar*\n*${rem.title}*` }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: helpMsg },
          { type: 'mrkdwn', text: `Reminder \`#${rem.id}\` · Fire \`#${fireId}\` · Gestiónalo con \`/recordap-list\`` }
        ]
      }
    ]
  });
}
