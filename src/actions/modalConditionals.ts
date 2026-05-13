import type { App } from '@slack/bolt';
import { createModalView } from '../views/createModal';
import { config } from '../config';
import type { RecurrenceKind, ReminderType } from '../config';

type Values = Record<string, Record<string, any>>;

const opt    = (v: Values, b: string, a: string): string | undefined => v?.[b]?.[a]?.selected_option?.value;
const optMul = (v: Values, b: string, a: string): string[] => (v?.[b]?.[a]?.selected_options ?? []).map((x: { value: string }) => x.value);
const conv   = (v: Values, b: string, a: string): string | undefined => v?.[b]?.[a]?.selected_conversation;

/**
 * Handlers de cambio en los campos "trigger" del modal de creación:
 *  - recurrence_block → re-renderiza con/sin weekdays_block y cron_block.
 *  - type_block        → re-renderiza con/sin reping_block y max_pings_block.
 *  - actions_block     → re-renderiza con/sin snooze_presets_block.
 *
 * Slack preserva el estado de cada input por `block_id`, así que los valores
 * ya escritos por el usuario sobreviven el `views.update` (excepto los
 * bloques que se quitan — esos pierden su valor; si reaparecen, vuelven a
 * sus defaults).
 */
export function registerModalConditionals(app: App) {
  const handler = async ({ ack, body, client, logger }: any) => {
    await ack();

    const view = body.view;
    if (!view) return;
    const v = view.state.values as Values;

    const recurrence      = (opt(v, 'recurrence_block', 'recurrence') as RecurrenceKind) ?? 'none';
    const reminderType    = (opt(v, 'type_block', 'type') as ReminderType) ?? 'ping';
    const actionsSelected = optMul(v, 'actions_block', 'actions');
    const timezone        = opt(v, 'timezone_block', 'timezone') ?? config.defaultTimezone;
    const channel         = conv(v, 'channel_block', 'channel') || undefined;

    try {
      await client.views.update({
        view_id: view.id,
        hash: view.hash, // si quedó desactualizado, Slack rechaza y evitamos pisar otra edición concurrente
        view: createModalView({
          defaultTimezone: timezone,
          triggerChannelId: channel,
          recurrence,
          reminderType,
          actionsSelected
        })
      });
    } catch (err) {
      logger.error({ err }, 'modal conditionals: views.update failed');
    }
  };

  app.action('recurrence', handler);
  app.action('type', handler);
  app.action('actions', handler);
}
