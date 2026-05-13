import type { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { reminderService } from '../services/reminderService';
import { createModalView } from '../views/createModal';
import { config } from '../config';
import { json } from '../types';
import type { RotationMode, ReminderType, RecurrenceKind, RepingEvery, MaxPings } from '../config';

/**
 * Handler del botón "✏️ Editar" en `/recordap-list`. Abre el modal de
 * creación con todos los valores actuales precargados y un flag en
 * `private_metadata` para que el view_submission sepa que es edición y
 * no creación nueva.
 *
 * Autorización: solo el creador del recordatorio puede editarlo (mismo
 * criterio que pause/cancel).
 */
export function registerEditReminder(app: App) {
  app.action('edit_reminder', async ({ ack, body, action, client, logger }) => {
    await ack();

    const reminderId = parseInt((action as any).value, 10);
    if (!Number.isFinite(reminderId)) return;
    const userId = (body as any).user.id as string;

    const rem = reminderService.find(reminderId);
    if (!rem || rem.creator_slack_id !== userId) {
      logger.warn(`edit_reminder: unauthorized or not found (rem=${reminderId} user=${userId})`);
      return;
    }

    // Estado precargado a partir del row de DB.
    const time = `${String(rem.hour).padStart(2, '0')}:${String(rem.minute).padStart(2, '0')}`;
    // Fecha de primer disparo: si todavía hay next_fire_at futuro, úsalo;
    // si no, usa hoy en la tz del reminder.
    const date = (rem.next_fire_at
      ? DateTime.fromISO(rem.next_fire_at, { zone: 'utc' }).setZone(rem.timezone)
      : DateTime.now().setZone(rem.timezone)
    ).toFormat('yyyy-LL-dd');

    const weekdays = rem.recurrence === 'weekly'
      ? json.parse<{ weekdays: string[] }>(rem.recurrence_data, { weekdays: [] }).weekdays
      : [];

    const notify: string[] = [];
    if (rem.notify_channel)   notify.push('channel');
    if (rem.notify_dm)        notify.push('dm_assignees');
    if (rem.notify_only_turn) notify.push('dm_only_turn');

    const actionsSelected: string[] = [];
    if (rem.allow_done)     actionsSelected.push('done');
    if (rem.allow_snooze)   actionsSelected.push('snooze');
    if (rem.allow_reassign) actionsSelected.push('reassign');

    // Grupos: para precargarlos en multi_external_select necesitamos el
    // label (handle), no solo el id. Llamamos a usergroups.list y resolvemos.
    const groupIds = json.parse<string[]>(rem.groups, []);
    let groupOptions: { value: string; label: string }[] = [];
    if (groupIds.length > 0) {
      try {
        const res = await client.usergroups.list({ include_users: false });
        const map = new Map<string, string>();
        for (const g of (res.usergroups ?? [])) {
          if (g.id && g.handle) map.set(g.id, `@${g.handle}`);
        }
        groupOptions = groupIds.map(id => ({
          value: id,
          label: map.get(id) ?? id
        }));
      } catch (err) {
        logger.error({ err }, 'edit_reminder: usergroups.list failed, falling back to ids');
        groupOptions = groupIds.map(id => ({ value: id, label: id }));
      }
    }

    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: createModalView({
          defaultTimezone: rem.timezone || config.defaultTimezone,
          editingReminderId: reminderId,
          recurrence: rem.recurrence as RecurrenceKind,
          reminderType: rem.reminder_type as ReminderType,
          actionsSelected,
          initial: {
            title: rem.title,
            description: rem.description,
            assignees: json.parse<string[]>(rem.assignees, []),
            groupOptions,
            rotationMode: rem.rotation_mode as RotationMode,
            date,
            time,
            weekdays,
            endsMode: rem.ends_mode,
            notify,
            repingEvery: rem.reping_every as RepingEvery,
            maxPings: rem.max_pings as MaxPings,
            snoozePresets: json.parse<string[]>(rem.snooze_presets, [])
          }
        })
      });
    } catch (err) {
      logger.error({ err }, 'edit_reminder: views.open failed');
    }
  });
}
