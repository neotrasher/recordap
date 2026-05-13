import { DateTime } from 'luxon';
import type { Reminder } from '../types';
import { json } from '../types';
import { slackDate } from '../services/tzService';
import { recurrenceLabel } from './reminderMessage';

/**
 * Vista efímera para `/recordap-list`. Lista los recordatorios `active` o
 * `paused` del usuario con botones para Pausar / Reanudar / Cancelar.
 *
 * Se reutiliza tanto en el primer render del slash command como en los
 * `respond({ replace_original: true })` de los action handlers para que la
 * misma UI sea consistente después de cada acción.
 */
export function buildRecordarListView(reminders: Reminder[]): { text: string; blocks: any[] } {
  if (reminders.length === 0) {
    return {
      text: 'No tienes recordatorios.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '_No tienes recordatorios activos ni pausados. Crea uno con `/recordap`._' }
        }
      ]
    };
  }

  const activeCount = reminders.filter(r => r.status === 'active').length;
  const pausedCount = reminders.filter(r => r.status === 'paused').length;
  const headerSummary = [
    activeCount ? `${activeCount} activo${activeCount === 1 ? '' : 's'}` : null,
    pausedCount ? `${pausedCount} pausado${pausedCount === 1 ? '' : 's'}` : null
  ].filter(Boolean).join(' · ');

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Tus recordatorios — ${headerSummary}` }
    }
  ];

  for (const r of reminders) {
    blocks.push({ type: 'divider' });
    blocks.push(reminderSection(r));
    blocks.push(reminderActions(r));
  }

  return { text: `${reminders.length} recordatorios.`, blocks };
}

function reminderSection(r: Reminder) {
  const isPaused = r.status === 'paused';
  const assignees = json.parse<string[]>(r.assignees, []);
  const groups = json.parse<string[]>(r.groups, []);
  const targets = [
    ...assignees.map(u => `<@${u}>`),
    ...groups.map(g => `<!subteam^${g}>`)
  ];
  const targetsStr = targets.length ? targets.join(' ') : '_@here_';

  const status = isPaused ? ' `PAUSADO`' : '';
  const nextLine = isPaused
    ? '⏸️ _Pausado — no dispara hasta que lo reanudes_'
    : r.next_fire_at
      ? `📅 ${slackDate(DateTime.fromISO(r.next_fire_at, { zone: 'utc' }))}`
      : '— sin próximo disparo';

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*${mdEscape(r.title)}*${status} · \`#${r.id}\``,
        `<#${r.channel_id}>  ·  🔁 ${recurrenceLabel(r)}`,
        nextLine,
        `👥 ${targetsStr}`
      ].join('\n')
    }
  };
}

function reminderActions(r: Reminder) {
  const isPaused = r.status === 'paused';
  const elements: any[] = [];

  if (isPaused) {
    elements.push({
      type: 'button',
      action_id: 'resume_reminder',
      value: String(r.id),
      style: 'primary',
      text: { type: 'plain_text', text: '▶️ Reanudar' }
    });
  } else {
    elements.push({
      type: 'button',
      action_id: 'pause_reminder',
      value: String(r.id),
      text: { type: 'plain_text', text: '⏸️ Pausar' }
    });
  }

  elements.push({
    type: 'button',
    action_id: 'cancel_reminder',
    value: String(r.id),
    style: 'danger',
    text: { type: 'plain_text', text: '🗑️ Cancelar' },
    confirm: {
      title: { type: 'plain_text', text: '¿Cancelar recordatorio?' },
      text: {
        type: 'mrkdwn',
        text: `Vas a cancelar *${mdEscape(r.title)}*. Va a dejar de dispararse permanentemente. Esta acción no se puede deshacer.`
      },
      confirm: { type: 'plain_text', text: 'Sí, cancelar' },
      deny: { type: 'plain_text', text: 'No' },
      style: 'danger'
    }
  });

  return {
    type: 'actions',
    block_id: `list_actions_${r.id}`,
    elements
  };
}

function mdEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
