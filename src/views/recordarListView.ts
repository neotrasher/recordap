import { DateTime } from 'luxon';
import type { Reminder } from '../types';
import { json } from '../types';
import { slackDate } from '../services/tzService';
import { recurrenceLabel } from './reminderMessage';

/**
 * Vista efímera para `/recordap-list`. Lista los recordatorios del usuario:
 *   • `active`     — con botones Pausar / Cancelar
 *   • `paused`     — con botones Reanudar / Cancelar
 *   • `completed`  — solo info (últimas 24h)
 *   • `cancelled`  — solo info (últimas 24h)
 *
 * Se reutiliza tanto en el primer render del slash command como en los
 * `respond({ replace_original: true })` de los action handlers para que la
 * misma UI sea consistente después de cada acción.
 */
export function buildRecordarListView(reminders: Reminder[], totalCount?: number): { text: string; blocks: any[] } {
  if (reminders.length === 0) {
    return {
      text: 'No tienes recordatorios.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '_No tienes recordatorios activos, pausados ni completados en las últimas 24h. Crea uno con `/recordap`._'
          }
        }
      ]
    };
  }

  const counts = {
    active:    reminders.filter(r => r.status === 'active').length,
    paused:    reminders.filter(r => r.status === 'paused').length,
    completed: reminders.filter(r => r.status === 'completed').length,
    cancelled: reminders.filter(r => r.status === 'cancelled').length
  };
  const headerSummary = [
    counts.active    ? `${counts.active} activo${counts.active === 1 ? '' : 's'}` : null,
    counts.paused    ? `${counts.paused} pausado${counts.paused === 1 ? '' : 's'}` : null,
    counts.completed ? `${counts.completed} completado${counts.completed === 1 ? '' : 's'}` : null,
    counts.cancelled ? `${counts.cancelled} cancelado${counts.cancelled === 1 ? '' : 's'}` : null
  ].filter(Boolean).join(' · ');

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Tus recordatorios — ${headerSummary}` }
    }
  ];

  // Separador entre manejables y "ya cerrados" si hay de ambos
  let separatorShown = false;
  for (const r of reminders) {
    const isClosed = r.status === 'completed' || r.status === 'cancelled';
    if (isClosed && !separatorShown) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: '*Recientes (últimas 24h)* — solo lectura' }
        ]
      });
      separatorShown = true;
    }

    blocks.push({ type: 'divider' });
    blocks.push(reminderSection(r));
    if (!isClosed) blocks.push(reminderActions(r));
  }

  // Footer cuando hay más recordatorios que el LIMIT del query.
  if (totalCount !== undefined && totalCount > reminders.length) {
    const hidden = totalCount - reminders.length;
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_+${hidden} recordatorio${hidden === 1 ? '' : 's'} no mostrado${hidden === 1 ? '' : 's'} (límite de Slack). Cancela los que ya no uses para liberar espacio en la lista._`
      }]
    });
  }

  return { text: `${reminders.length} recordatorios.`, blocks };
}

function reminderSection(r: Reminder) {
  const assignees = json.parse<string[]>(r.assignees, []);
  const groups = json.parse<string[]>(r.groups, []);
  const targets = [
    ...assignees.map(u => `<@${u}>`),
    ...groups.map(g => `<!subteam^${g}>`)
  ];
  const targetsStr = targets.length ? targets.join(' ') : '_@here_';

  const statusTag = statusBadge(r.status);
  const nextLine = nextLineFor(r);

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*${mdEscape(r.title)}*${statusTag} · \`#${r.id}\``,
        `<#${r.channel_id}>  ·  🔁 ${recurrenceLabel(r)}`,
        nextLine,
        `👥 ${targetsStr}`
      ].join('\n')
    }
  };
}

function statusBadge(status: Reminder['status']): string {
  switch (status) {
    case 'active':    return '';
    case 'paused':    return ' `PAUSADO`';
    case 'completed': return ' `COMPLETADO`';
    case 'cancelled': return ' `CANCELADO`';
  }
}

function nextLineFor(r: Reminder): string {
  // updated_at se almacena vía datetime('now') de SQLite → formato 'YYYY-MM-DD HH:MM:SS',
  // NO ISO 8601. Hay que parsearlo con fromSQL, no fromISO.
  const updatedAt = DateTime.fromSQL(r.updated_at, { zone: 'utc' });

  switch (r.status) {
    case 'paused':
      return '⏸️ _Pausado — no dispara hasta que lo reanudes_';
    case 'completed':
      return `✅ Completado · ${slackDate(updatedAt)}`;
    case 'cancelled':
      return `🗑️ Cancelado · ${slackDate(updatedAt)}`;
    case 'active':
      return r.next_fire_at
        ? `📅 ${slackDate(DateTime.fromISO(r.next_fire_at, { zone: 'utc' }))}`
        : '⏳ _Esperando Done de un disparo previo (sin más disparos programados)_';
  }
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
