import type { View } from '@slack/web-api';

/**
 * Modal de reasignación — abierto al pulsar el botón "Reasignar" en un mensaje
 * de recordatorio. El `fire_id` viaja en `private_metadata`.
 */
export function buildReassignModal(fireId: number, currentTitle: string): View {
  return {
    type: 'modal',
    callback_id: 'reminder_reassign_modal',
    private_metadata: String(fireId),
    title: { type: 'plain_text', text: 'Reasignar' },
    submit: { type: 'plain_text', text: 'Reasignar' },
    close: { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${currentTitle}*` }
      },
      {
        type: 'input',
        block_id: 'new_assignees_block',
        label: { type: 'plain_text', text: 'Nuevos asignados' },
        hint: { type: 'plain_text', text: 'Reemplaza la lista de personas asignadas en la regla.' },
        element: {
          type: 'multi_users_select',
          action_id: 'new_assignees',
          placeholder: { type: 'plain_text', text: 'Selecciona personas' }
        }
      }
    ]
  };
}
