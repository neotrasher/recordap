import { DateTime } from 'luxon';
import type { Reminder } from '../types';
import { json } from '../types';
import { slackDate } from '../services/tzService';

/**
 * Build the Slack message (text + blocks) for a reminder fire, both for the
 * channel post and for the DM copy.
 *
 * Returns `{ text, blocks }` ready to spread into `client.chat.postMessage`.
 */
export function buildReminderMessage(args: {
  rem: Reminder;
  fireId: number;
  pingCount: number;
  scheduledFor: DateTime;
  assignedTo: string | null;   // for rotation: the picked user this turn
  forDm?: boolean;             // tweak phrasing & remove redundant mentions
  note?: string;               // extra context line (e.g. snooze, reassigned)
}): { text: string; blocks: any[] } {
  const { rem, fireId, pingCount, scheduledFor, assignedTo, forDm, note } = args;
  const assignees = json.parse<string[]>(rem.assignees, []);
  const groups    = json.parse<string[]>(rem.groups, []);

  // Effective mention targets — rotation collapses to a single user
  const effectiveAssignees = rem.rotation_mode === 'rotate' && assignedTo
    ? [assignedTo]
    : assignees;

  const mentions = buildMentionLine(effectiveAssignees, groups);
  const blocks: any[] = [];

  // ── Lead line: mentions + title ───────────────────────────────────────────
  const leadIcon = '📌';
  const leadMention = forDm ? '*Te toca:*' : mentions;
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${leadMention} ${leadIcon} *${mdEscape(rem.title)}*`
    }
  });

  // ── Description (optional) ────────────────────────────────────────────────
  if (rem.description) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: mdEscape(rem.description) }
    });
  }

  // ── Context: scheduled time + ping count (for tasks) ──────────────────────
  const ctxElems: any[] = [
    { type: 'mrkdwn', text: `🕐 ${slackDate(scheduledFor)}` }
  ];
  if (rem.reminder_type === 'task') {
    const cap = rem.max_pings === 'inf' ? '' : `/${rem.max_pings}`;
    ctxElems.push({ type: 'mrkdwn', text: `🔔 Recordatorio ${pingCount}${cap}` });
  }
  if (rem.recurrence !== 'none') {
    ctxElems.push({ type: 'mrkdwn', text: `🔁 ${recurrenceLabel(rem)}` });
  }
  if (note) {
    ctxElems.push({ type: 'mrkdwn', text: note });
  }
  blocks.push({ type: 'context', elements: ctxElems });

  // ── Action buttons (only for tasks; ping mode has no follow-up) ───────────
  if (rem.reminder_type === 'task') {
    const elements: any[] = [];

    if (rem.allow_done) {
      elements.push({
        type: 'button',
        action_id: 'done',
        value: String(fireId),
        style: 'primary',
        text: { type: 'plain_text', text: '✓ Hecho' }
      });
    }

    if (rem.allow_snooze) {
      const presets = json.parse<string[]>(rem.snooze_presets, ['15m', '1h', 'tomorrow_9']);
      if (presets.length > 0) {
        elements.push({
          type: 'overflow',
          action_id: 'snooze',
          options: presets.map(p => ({
            text: { type: 'plain_text', text: snoozeLabel(p) },
            value: `${fireId}:${p}`
          }))
        });
      }
    }

    if (rem.allow_reassign) {
      elements.push({
        type: 'button',
        action_id: 'reassign',
        value: String(fireId),
        text: { type: 'plain_text', text: '↻ Reasignar' }
      });
    }

    if (elements.length > 0) {
      blocks.push({
        type: 'actions',
        block_id: `fire_actions_${fireId}`,
        elements
      });
    }
  }

  // Fallback text for notifications
  const fallback = forDm
    ? `Recordatorio: ${rem.title}`
    : `${stripMentions(mentions)} ${rem.title}`;

  return { text: fallback, blocks };
}

/**
 * Mensaje "✓ Hecho" — reemplaza el render del recordatorio una vez que alguien
 * lo marca como completado. Sin botones, título tachado.
 */
export function buildDoneMessage(args: {
  rem: Reminder;
  doneByUserId: string;
  doneAt: DateTime;
}): { text: string; blocks: any[] } {
  const { rem, doneByUserId, doneAt } = args;
  return {
    text: `✓ Hecho por <@${doneByUserId}>: ${rem.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `~📌 *${mdEscape(rem.title)}*~` }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `✓ Hecho por <@${doneByUserId}> · ${slackDate(doneAt)}` }
        ]
      }
    ]
  };
}

/**
 * Mensaje "❌ Sin respuesta" — reemplaza el render una vez que un fire agota
 * sus max_pings sin que nadie marque Done. Sin botones.
 */
export function buildExpiredMessage(args: {
  rem: Reminder;
  totalPings: number;
  expiredAt: DateTime;
}): { text: string; blocks: any[] } {
  const { rem, totalPings, expiredAt } = args;
  return {
    text: `❌ Sin respuesta: ${rem.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `~📌 *${mdEscape(rem.title)}*~` }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `❌ Sin respuesta tras ${totalPings} recordatorio${totalPings === 1 ? '' : 's'} · ${slackDate(expiredAt)}`
          }
        ]
      }
    ]
  };
}

/**
 * Texto compacto del nudge que se postea como nuevo mensaje cuando hay re-ping.
 * No tiene bloques ni botones — sólo es la notificación para que la gente
 * reciba un push. Los botones siguen en el mensaje original (editado).
 */
export function buildRepingNudge(args: {
  rem: Reminder;
  pingCount: number;
  channelTs: string | null;
  assignedTo: string | null;
  forDm?: boolean;
}): string {
  const { rem, pingCount, channelTs, assignedTo, forDm } = args;
  const assignees = json.parse<string[]>(rem.assignees, []);
  const groups = json.parse<string[]>(rem.groups, []);
  const effective = rem.rotation_mode === 'rotate' && assignedTo ? [assignedTo] : assignees;
  const mentions = forDm ? '' : buildMentionLineLocal(effective, groups) + ' ';
  const cap = rem.max_pings === 'inf' ? '' : `/${rem.max_pings}`;
  return `🔔 ${mentions}*${rem.title}* sigue pendiente — Recordatorio ${pingCount}${cap}`;
}

function buildMentionLineLocal(users: string[], groups: string[]): string {
  if (users.length === 0 && groups.length === 0) return '<!here>';
  return [
    ...users.map(u => `<@${u}>`),
    ...groups.map(g => `<!subteam^${g}>`)
  ].join(' ');
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildMentionLine(users: string[], groups: string[]): string {
  if (users.length === 0 && groups.length === 0) return '<!here>';
  return [
    ...users.map(u => `<@${u}>`),
    ...groups.map(g => `<!subteam^${g}>`)
  ].join(' ');
}

function stripMentions(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

function snoozeLabel(preset: string): string {
  switch (preset) {
    case '15m':            return '⏱️ 15 minutos';
    case '1h':             return '⏱️ 1 hora';
    case 'today_16':       return '☕ Esta tarde 4pm';
    case 'tomorrow_9':     return '🌅 Mañana 9am';
    case 'next_monday_9':  return '📅 Próximo lunes 9am';
    case 'custom':         return '📝 Fecha personalizada';
    default:               return preset;
  }
}

export function recurrenceLabel(rem: Reminder): string {
  switch (rem.recurrence) {
    case 'daily':                  return 'Cada día';
    case 'weekdays':               return 'Días hábiles';
    case 'weekly': {
      const days = json.parse<{ weekdays: string[] }>(rem.recurrence_data, { weekdays: [] }).weekdays;
      const map: Record<string, string> = {
        mon: 'L', tue: 'M', wed: 'X', thu: 'J', fri: 'V', sat: 'S', sun: 'D'
      };
      return `Semanal · ${days.map(d => map[d] || d).join(' ')}`;
    }
    case 'biweekly':               return 'Quincenal';
    case 'monthly_day':            return `Día ${json.parse<{ day: number }>(rem.recurrence_data, { day: 1 }).day} de cada mes`;
    case 'monthly_last_business':  return 'Último día hábil del mes';
    case 'custom':                 return `Cron · ${json.parse<{ cron: string }>(rem.recurrence_data, { cron: '?' }).cron}`;
    case 'none':                   return 'Único';
  }
}

function mdEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
