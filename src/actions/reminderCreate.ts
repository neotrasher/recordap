import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { reminderService } from '../services/reminderService';
import { nextFire } from '../services/recurrenceService';
import { slackDate } from '../services/tzService';
import type {
  RecurrenceKind,
  ReminderType,
  RotationMode,
  RepingEvery,
  MaxPings
} from '../config';
import type { Reminder } from '../types';

type Values = Record<string, Record<string, any>>;

// ── view.state.values accessors ─────────────────────────────────────────────
const s   = (v: Values, b: string, a: string): string | undefined => v?.[b]?.[a]?.value;
const d   = (v: Values, b: string, a: string): string | undefined => v?.[b]?.[a]?.selected_date;
const t   = (v: Values, b: string, a: string): string | undefined => v?.[b]?.[a]?.selected_time;
const conv= (v: Values, b: string, a: string): string | undefined => v?.[b]?.[a]?.selected_conversation;
const us  = (v: Values, b: string, a: string): string[] => v?.[b]?.[a]?.selected_users ?? [];
const opt = (v: Values, b: string, a: string): string | undefined => v?.[b]?.[a]?.selected_option?.value;
const opts= (v: Values, b: string, a: string): string[] =>
  (v?.[b]?.[a]?.selected_options ?? []).map((x: { value: string }) => x.value);

/**
 * Handler de `view_submission` para el modal de creación de recordatorios.
 * - Valida los inputs y devuelve errores por block_id si algo falla.
 * - Computa el primer `next_fire_at` usando luxon + recurrenceService.
 * - INSERT en `reminders`, audit log en `reminder_events`, DM de confirmación al creador.
 */
export function registerReminderCreate(app: App) {
  app.view('reminder_create_modal', async ({ ack, view, body, client, logger }) => {
    const v = view.state.values as Values;

    // ── extract ─────────────────────────────────────────────────────────────
    const title          = (s(v, 'title_block', 'title') ?? '').trim();
    const description    = (s(v, 'desc_block', 'description') ?? '').trim() || null;
    const channel_id     = conv(v, 'channel_block', 'channel');
    const assignees      = us(v, 'assignees_block', 'assignees');
    const groups         = opts(v, 'groups_block', 'groups');
    const rotation_mode  = (opt(v, 'rotation_block', 'rotation') as RotationMode) ?? 'all';
    const dateStr        = d(v, 'date_block', 'date');
    const timeStr        = t(v, 'time_block', 'time');
    const recurrence     = (opt(v, 'recurrence_block', 'recurrence') as RecurrenceKind) ?? 'none';
    const weekdays       = opts(v, 'weekdays_block', 'weekdays');
    const ends_mode      = (opt(v, 'ends_block', 'ends') as 'never' | 'on_date' | 'after_n') ?? 'never';
    const timezone       = opt(v, 'timezone_block', 'timezone');
    const notify         = opts(v, 'notify_block', 'notify');
    const reminder_type  = (opt(v, 'type_block', 'type') as ReminderType) ?? 'ping';
    const reping_every   = (opt(v, 'reping_block', 'reping') as RepingEvery) ?? 'off';
    const max_pings      = (opt(v, 'max_pings_block', 'max_pings') as MaxPings) ?? '5';
    const actions        = opts(v, 'actions_block', 'actions');
    const snooze_presets = opts(v, 'snooze_presets_block', 'snooze_presets');

    // ── validate ────────────────────────────────────────────────────────────
    const errors: Record<string, string> = {};
    if (!title)                                  errors.title_block      = 'El título no puede estar vacío.';
    if (!channel_id)                             errors.channel_block    = 'Selecciona un canal.';
    if (channel_id && channel_id.startsWith('D')) errors.channel_block   = 'Elige un canal público o privado — los DMs no se pueden usar como destino. Si quieres un recordatorio personal, asígnate a ti mismo y elige un canal de pruebas.';
    if (!dateStr)                                errors.date_block       = 'Selecciona una fecha.';
    if (!timeStr)                                errors.time_block       = 'Selecciona una hora.';
    if (!timezone)                               errors.timezone_block   = 'Selecciona una zona horaria.';
    if (recurrence === 'weekly' && !weekdays.length)
                                                 errors.weekdays_block   = 'Elige al menos un día.';
    if (Object.keys(errors).length) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    // ── compute next_fire_at ────────────────────────────────────────────────
    const [hh, mm] = timeStr!.split(':').map(n => parseInt(n, 10));
    const chosen = DateTime.fromObject(
      {
        year:  parseInt(dateStr!.slice(0, 4), 10),
        month: parseInt(dateStr!.slice(5, 7), 10),
        day:   parseInt(dateStr!.slice(8, 10), 10),
        hour:  hh,
        minute: mm
      },
      { zone: timezone }
    );
    if (!chosen.isValid) {
      await ack({
        response_action: 'errors',
        errors: { date_block: `Fecha/hora inválida: ${chosen.invalidReason}` }
      });
      return;
    }

    const recurrence_data = buildRecurrenceData(recurrence, weekdays, chosen);
    const now = DateTime.utc();

    let next_fire_at: string;
    if (chosen.toUTC() > now) {
      next_fire_at = chosen.toUTC().toISO()!;
    } else if (recurrence === 'none') {
      await ack({
        response_action: 'errors',
        errors: { date_block: 'La fecha y hora ya pasaron. Elige un momento futuro.' }
      });
      return;
    } else {
      // Past instant + recurring rule → advance to next future occurrence
      const stub = {
        timezone, hour: hh, minute: mm, recurrence,
        recurrence_data, ends_mode, ends_data: null, fires_count: 0
      } as unknown as Reminder;
      const nxt = nextFire(stub, now);
      if (!nxt) {
        await ack({
          response_action: 'errors',
          errors: { recurrence_block: 'La recurrencia no tiene próximas ocurrencias en el rango.' }
        });
        return;
      }
      next_fire_at = nxt.toISO()!;
    }

    // ── ack first, then do the persistent work ──────────────────────────────
    await ack();

    try {
      const id = reminderService.create({
        creator_slack_id: body.user.id,
        title, description,
        channel_id: channel_id!,
        assignees, groups, rotation_mode,
        timezone: timezone!, hour: hh, minute: mm,
        recurrence, recurrence_data,
        ends_mode, ends_data: null,
        reminder_type, reping_every, max_pings,
        notify_channel:   notify.includes('channel')      ? 1 : 0,
        notify_dm:        notify.includes('dm_assignees') ? 1 : 0,
        notify_only_turn: notify.includes('dm_only_turn') ? 1 : 0,
        allow_done:     actions.includes('done')     ? 1 : 0,
        allow_snooze:   actions.includes('snooze')   ? 1 : 0,
        allow_reassign: actions.includes('reassign') ? 1 : 0,
        snooze_presets: snooze_presets.length ? snooze_presets : ['15m', '1h', 'tomorrow_9'],
        next_fire_at
      });

      reminderService.logEvent(id, body.user.id, 'created', {
        title, channel_id, assignees, groups, recurrence, timezone
      });

      // Confirmation DM
      const firstFire = DateTime.fromISO(next_fire_at);
      await client.chat.postMessage({
        channel: body.user.id,
        text: `✅ Recordatorio creado: ${title}`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `✅ *Recordatorio creado*\n${title}` }
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `*Primer disparo:* ${slackDate(firstFire)}` },
              { type: 'mrkdwn', text: `*Canal:* <#${channel_id}>` },
              { type: 'mrkdwn', text: `*ID:* \`${id}\` · gestiónalo con \`/recordap-list\`` }
            ]
          }
        ]
      });
    } catch (err) {
      logger.error({ err }, 'reminder_create_modal: persist failed');
      try {
        await client.chat.postMessage({
          channel: body.user.id,
          text: `❌ Hubo un error guardando el recordatorio: \`${(err as Error).message}\``
        });
      } catch { /* swallow */ }
    }
  });
}

function buildRecurrenceData(
  recurrence: RecurrenceKind,
  weekdays: string[],
  firstFireLocal: DateTime
): string | null {
  switch (recurrence) {
    case 'weekly':       return JSON.stringify({ weekdays });
    case 'biweekly':     return JSON.stringify({ anchor: firstFireLocal.toISO() });
    case 'monthly_day':  return JSON.stringify({ day: firstFireLocal.day });
    default:             return null;
  }
}
