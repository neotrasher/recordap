import type { View } from '@slack/web-api';
import { DateTime } from 'luxon';

/**
 * Modal abierto cuando el usuario elige "Fecha personalizada" en el overflow
 * de snooze de un mensaje de recordatorio. Permite escoger un día y hora
 * exactos para postergar el próximo re-ping.
 *
 * El `private_metadata` lleva el `fire_id` para que el view_submission sepa
 * qué fire postergar. Los campos los valida el handler (no acá): tiene que
 * ser una fecha-hora futura en la zona del reminder.
 */
export function buildCustomSnoozeModal(fireId: number, reminderTz: string): View {
  const tomorrow = DateTime.now().setZone(reminderTz).plus({ days: 1 });
  const initialDate = tomorrow.toFormat('yyyy-LL-dd');

  return {
    type: 'modal',
    callback_id: 'custom_snooze_modal',
    private_metadata: String(fireId),
    title: { type: 'plain_text', text: 'Aplazar hasta…' },
    submit: { type: 'plain_text', text: 'Aplazar' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '_El reminder no volverá a pinguear hasta el momento que elijas._'
        }
      },
      {
        type: 'input',
        block_id: 'date_block',
        label: { type: 'plain_text', text: 'Fecha' },
        element: {
          type: 'datepicker',
          action_id: 'date',
          initial_date: initialDate
        }
      },
      {
        type: 'input',
        block_id: 'time_block',
        label: { type: 'plain_text', text: 'Hora' },
        hint: { type: 'plain_text', text: `Interpretado en zona ${reminderTz}.` },
        element: {
          type: 'timepicker',
          action_id: 'time',
          initial_time: '09:00'
        }
      }
    ]
  };
}
