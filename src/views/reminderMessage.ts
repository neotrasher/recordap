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

  // ── Lead: status pill + título ───────────────────────────────────────────
  const pill = firePill(rem, pingCount, !!forDm);
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${pill}  ·  📌 *${mdEscape(rem.title)}*`
    }
  });

  // ── Línea de menciones (solo en canal — en DM el destinatario ya sabe) ───
  if (!forDm) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: mentions }
    });
  }

  // ── Descripción opcional en blockquote ────────────────────────────────────
  if (rem.description) {
    // El blockquote de Slack se aplica con "> " al inicio de cada línea.
    const quoted = mdEscape(rem.description)
      .split('\n')
      .map(l => `> ${l}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: quoted }
    });
  }

  // ── Context línea 1: timing ──────────────────────────────────────────────
  const timingElems: any[] = [
    { type: 'mrkdwn', text: `⏰ Vence ${slackDate(scheduledFor)}` }
  ];
  if (rem.reminder_type === 'task') {
    const cap = rem.max_pings === 'inf' ? '' : ` de ${rem.max_pings}`;
    timingElems.push({ type: 'mrkdwn', text: `🔔 Recordatorio ${pingCount}${cap}` });
  }
  if (forDm) {
    timingElems.push({ type: 'mrkdwn', text: `📍 En <#${rem.channel_id}>` });
  }
  blocks.push({ type: 'context', elements: timingElems });

  // ── Context línea 2: recurrencia + creador + nota opcional ───────────────
  // El "Creado por" deja claro a quién pedirle cambios de configuración
  // (p.ej. habilitar Snooze si no está). Pedido por el equipo.
  const recurNoteElems: any[] = [];
  if (rem.recurrence !== 'none') {
    recurNoteElems.push({ type: 'mrkdwn', text: `🔁 ${recurrenceLabel(rem)}` });
  }
  recurNoteElems.push({ type: 'mrkdwn', text: `👤 Creado por <@${rem.creator_slack_id}>` });
  if (rem.reminder_type === 'task' && rem.escalate_to) {
    recurNoteElems.push({ type: 'mrkdwn', text: `🚨 Escala a <@${rem.escalate_to}> si no se completa` });
  }
  if (note) {
    recurNoteElems.push({ type: 'mrkdwn', text: note });
  }
  blocks.push({ type: 'context', elements: recurNoteElems });

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

/**
 * Pill de estado que aparece arriba del mensaje. Slack no permite colores
 * custom, así que usamos un emoji de color + `código` para que el texto
 * salga en monospace gris (la pill nativa más cerca de un badge).
 *
 *   🟡 `PENDIENTE`     task activo con menos de la mitad de pings consumidos
 *   🔴 `ATRASADO`      task activo con más de la mitad consumidos
 *   📢 `AVISO`         ping (one-shot informativo, sin Hecho)
 *   🟡 `TE TOCA A TI`  task en DM (más personal que el del canal)
 */
function firePill(rem: Reminder, pingCount: number, forDm: boolean): string {
  if (rem.reminder_type === 'ping') return '📢 `AVISO`';
  if (forDm) return '🟡 `TE TOCA A TI`';
  if (rem.max_pings === 'inf') return '🟡 `PENDIENTE`';
  const cap = parseInt(rem.max_pings, 10);
  const overdue = pingCount > Math.ceil(cap / 2);
  return overdue ? '🔴 `ATRASADO`' : '🟡 `PENDIENTE`';
}

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
    case '30m':            return '⏱️ 30 minutos';
    case '1h':             return '⏱️ 1 hora';
    case '2h':             return '⏱️ 2 horas';
    case '3h':             return '⏱️ 3 horas';
    case '6h':             return '⏱️ 6 horas';
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
    case 'none':                   return 'Único';
  }
}

function mdEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
