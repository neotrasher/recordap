import type { View } from '@slack/web-api';
import { COMMON_TIMEZONES } from '../services/tzService';
import { DateTime } from 'luxon';
import type { RecurrenceKind, ReminderType, RotationMode, RepingEvery, MaxPings } from '../config';

interface CreateModalOpts {
  /** IANA tz to preselect (creator's tz from Slack profile). */
  defaultTimezone: string;
  /** Channel from which the slash command was invoked, if any (preselect). */
  triggerChannelId?: string;
  /** Current recurrence selection — drives mostrar/ocultar weekdays. */
  recurrence?: RecurrenceKind;
  /** Current reminder type — drives mostrar/ocultar reping + max_pings. */
  reminderType?: ReminderType;
  /** Acciones marcadas — driver mostrar/ocultar snooze_presets. */
  actionsSelected?: string[];
  /** Si está set, el modal está editando este reminder (no creando uno nuevo). */
  editingReminderId?: number;
  /** Valores iniciales para todos los campos (precarga al editar). */
  initial?: {
    title?: string;
    description?: string | null;
    assignees?: string[];
    groupOptions?: { value: string; label: string }[];
    rotationMode?: RotationMode;
    date?: string;
    time?: string;
    weekdays?: string[];
    endsMode?: 'never' | 'on_date' | 'after_n';
    notify?: string[];
    repingEvery?: RepingEvery;
    maxPings?: MaxPings;
    snoozePresets?: string[];
    escalateTo?: string | null;
  };
}

/**
 * Build the Block Kit `view` payload for the reminder creation modal.
 *
 * Los bloques condicionales (weekdays, cron, reping/max_pings, snooze_presets)
 * solo se incluyen cuando los campos que los gatillan están en el valor
 * apropiado. Los inputs gatillo tienen `dispatch_action: true` para que un
 * cambio de selección reactive `views.update` con la nueva forma del modal.
 *
 * Nota: este es el source canónico — el JSON en `slack-reminder-modal.json`
 * (en la raíz del repo) es su gemelo preview-ready. Si lo tocas acá, refrescá
 * el JSON también.
 */
export function createModalView(opts: CreateModalOpts): View {
  const today = DateTime.now().setZone(opts.defaultTimezone).toFormat('yyyy-LL-dd');
  const recurrence     = opts.recurrence ?? 'none';
  const reminderType   = opts.reminderType ?? 'ping';
  const actionsSelected = opts.actionsSelected ?? ['done', 'snooze', 'reassign'];
  const init = opts.initial ?? {};
  const isEditing = typeof opts.editingReminderId === 'number';

  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: '📝 ¿Qué quieres recordar?' } },
    titleInput(init.title),
    descInput(init.description ?? undefined),

    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '📍 Destino' } },
    channelInput(opts.triggerChannelId),
    assigneesInput(init.assignees),
    groupsInput(init.groupOptions),
    emptyAssignmentContext(),
    rotationInput(init.rotationMode),

    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '⏰ Cuándo' } },
    dateInput(init.date ?? today),
    timeInput(init.time),
    recurrenceInput(recurrence)
  ];

  if (recurrence === 'weekly') blocks.push(weekdaysInput(init.weekdays));

  blocks.push(endsInput(init.endsMode));
  blocks.push(timezoneInput(opts.defaultTimezone));

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '🔔 Notificaciones' } });
  blocks.push(notifyInput(init.notify));

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'header', text: { type: 'plain_text', text: '✅ Tipo de recordatorio' } });
  blocks.push(typeInput(reminderType));

  if (reminderType === 'task') {
    blocks.push(repingInput(init.repingEvery));
    blocks.push(maxPingsInput(init.maxPings));
    blocks.push(escalateInput(init.escalateTo));
  }

  // Sección de botones — sólo aplica a tipo 'task' (un 'ping' no tiene botones).
  // Cuando type='ping', ocultamos la sección entera para no forzar al usuario a
  // marcar checkboxes que no se usan en su flujo.
  if (reminderType === 'task') {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'header', text: { type: 'plain_text', text: '🎯 Botones del recordatorio' } });
    blocks.push(actionsInput(actionsSelected));

    if (actionsSelected.includes('snooze')) {
      blocks.push(snoozePresetsInput(init.snoozePresets));
    }
  }

  return {
    type: 'modal',
    callback_id: 'reminder_create_modal',
    private_metadata: isEditing ? String(opts.editingReminderId) : undefined,
    title:  { type: 'plain_text', text: isEditing ? `Editar recordatorio #${opts.editingReminderId}` : 'Nuevo recordatorio' },
    submit: { type: 'plain_text', text: isEditing ? 'Guardar cambios' : 'Crear' },
    close:  { type: 'plain_text', text: 'Cancelar' },
    blocks
  };
}

// ── individual blocks ──────────────────────────────────────────────────────

function titleInput(initial?: string) {
  return {
    type: 'input',
    block_id: 'title_block',
    label: { type: 'plain_text', text: 'Título' },
    element: {
      type: 'plain_text_input',
      action_id: 'title',
      placeholder: { type: 'plain_text', text: 'Ej: Enviar reporte semanal' },
      max_length: 120,
      ...(initial !== undefined ? { initial_value: initial } : {})
    }
  } as const;
}

function descInput(initial?: string) {
  return {
    type: 'input',
    block_id: 'desc_block',
    optional: true,
    label: { type: 'plain_text', text: 'Descripción' },
    hint: { type: 'plain_text', text: 'Agrega contexto, link a doc o el criterio para marcar Done.' },
    element: {
      type: 'plain_text_input',
      action_id: 'description',
      multiline: true,
      max_length: 500,
      ...(initial !== undefined ? { initial_value: initial } : {})
    }
  } as const;
}

function channelInput(initialChannel?: string) {
  return {
    type: 'input',
    block_id: 'channel_block',
    label: { type: 'plain_text', text: 'Canal donde publicar' },
    hint: { type: 'plain_text', text: 'IMPORTANTE: el bot debe estar invitado al canal. Si no, ejecuta /invite @Recordap desde ahí antes de crear el recordatorio.' },
    element: {
      type: 'conversations_select',
      action_id: 'channel',
      placeholder: { type: 'plain_text', text: 'Selecciona un canal' },
      ...(initialChannel
        ? { initial_conversation: initialChannel }
        : { default_to_current_conversation: true }),
      filter: { include: ['public', 'private'], exclude_bot_users: true }
    }
  } as const;
}

function assigneesInput(initial?: string[]) {
  return {
    type: 'input',
    block_id: 'assignees_block',
    optional: true,
    label: { type: 'plain_text', text: 'Personas asignadas' },
    hint: { type: 'plain_text', text: 'Usuarios individuales. Combinable con grupos.' },
    element: {
      type: 'multi_users_select',
      action_id: 'assignees',
      placeholder: { type: 'plain_text', text: 'Selecciona personas' },
      ...(initial && initial.length > 0 ? { initial_users: initial } : {})
    }
  } as const;
}

function groupsInput(initialOptions?: { value: string; label: string }[]) {
  return {
    type: 'input',
    block_id: 'groups_block',
    optional: true,
    label: { type: 'plain_text', text: 'Grupos asignados' },
    hint: { type: 'plain_text', text: 'User groups del workspace (ej. @engineering). Se mencionan en canal pero no se expanden para DM.' },
    element: {
      type: 'multi_external_select',
      action_id: 'groups',
      placeholder: { type: 'plain_text', text: 'Selecciona uno o más grupos' },
      min_query_length: 0,
      ...(initialOptions && initialOptions.length > 0
        ? {
            initial_options: initialOptions.map(o => ({
              text: { type: 'plain_text' as const, text: o.label },
              value: o.value
            }))
          }
        : {})
    }
  } as const;
}

function emptyAssignmentContext() {
  return {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '_Si dejas vacío personas y grupos, el recordatorio menciona `@here` (solo gente conectada — nunca `@channel`)._'
    }]
  } as const;
}

function rotationInput(initial: RotationMode = 'all') {
  const all = rotationOption('all', 'Todos a la vez', 'Pinguea a todos los asignados en cada disparo.');
  const rotate = rotationOption('rotate', 'Rotación (round-robin)', 'Cada disparo le toca a una persona distinta.');
  const firstTaker = rotationOption('first_taker', 'Primero disponible', 'Pinguea al grupo y queda dueño quien toque Done o Tomar primero.');
  const initialOpt = initial === 'rotate' ? rotate : initial === 'first_taker' ? firstTaker : all;
  return {
    type: 'input',
    block_id: 'rotation_block',
    optional: true,
    label: { type: 'plain_text', text: 'Modo de asignación' },
    hint: { type: 'plain_text', text: 'Los grupos se expanden a sus miembros antes de rotar.' },
    element: {
      type: 'radio_buttons',
      action_id: 'rotation',
      initial_option: initialOpt,
      options: [all, rotate, firstTaker]
    }
  } as const;
}
function rotationOption(value: string, text: string, desc: string) {
  return {
    text: { type: 'plain_text', text },
    description: { type: 'plain_text', text: desc },
    value
  } as const;
}

function dateInput(initialDate: string) {
  return {
    type: 'input',
    block_id: 'date_block',
    label: { type: 'plain_text', text: 'Fecha del primer disparo' },
    element: { type: 'datepicker', action_id: 'date', initial_date: initialDate }
  } as const;
}
function timeInput(initial?: string) {
  return {
    type: 'input',
    block_id: 'time_block',
    label: { type: 'plain_text', text: 'Hora' },
    element: { type: 'timepicker', action_id: 'time', initial_time: initial ?? '09:00' }
  } as const;
}

function recurrenceInput(initialValue: RecurrenceKind = 'none') {
  const opt = (v: string, t: string) => ({ text: { type: 'plain_text' as const, text: t }, value: v });
  const options = [
    opt('none', 'No repetir'),
    opt('daily', 'Cada día'),
    opt('weekdays', 'Días hábiles (L–V)'),
    opt('weekly', 'Semanal (elegir días)'),
    opt('biweekly', 'Quincenal'),
    opt('monthly_day', 'Mensual (mismo día del mes)'),
    opt('monthly_last_business', 'Último día hábil del mes')
  ];
  const initial = options.find(o => o.value === initialValue) ?? options[0];
  return {
    type: 'input',
    block_id: 'recurrence_block',
    dispatch_action: true,    // ← cambiar = re-renderizar modal con campos condicionales
    label: { type: 'plain_text', text: 'Repetir' },
    element: {
      type: 'static_select',
      action_id: 'recurrence',
      initial_option: initial,
      options
    }
  } as const;
}

function weekdaysInput(initial?: string[]) {
  const opt = (v: string, t: string) => ({ text: { type: 'plain_text' as const, text: t }, value: v });
  const options = [
    opt('mon', 'Lun'), opt('tue', 'Mar'), opt('wed', 'Mié'),
    opt('thu', 'Jue'), opt('fri', 'Vie'), opt('sat', 'Sáb'), opt('sun', 'Dom')
  ];
  const initialOptions = initial && initial.length > 0
    ? options.filter(o => initial.includes(o.value))
    : [];
  return {
    type: 'input',
    block_id: 'weekdays_block',
    optional: true,
    label: { type: 'plain_text', text: 'Días (solo si elegiste «Semanal»)' },
    element: {
      type: 'checkboxes',
      action_id: 'weekdays',
      ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
      options
    }
  } as const;
}

function endsInput(initial?: string) {
  const opt = (v: string, t: string) => ({ text: { type: 'plain_text' as const, text: t }, value: v });
  const options = [opt('never', 'Nunca'), opt('on_date', 'En fecha específica'), opt('after_n', 'Después de N ocurrencias')];
  const initialOpt = options.find(o => o.value === initial) ?? options[0];
  return {
    type: 'input',
    block_id: 'ends_block',
    optional: true,
    label: { type: 'plain_text', text: 'Termina' },
    element: {
      type: 'static_select',
      action_id: 'ends',
      initial_option: initialOpt,
      options
    }
  } as const;
}

function timezoneInput(defaultTz: string) {
  const opts = COMMON_TIMEZONES.map(t => ({
    text: { type: 'plain_text' as const, text: t.label },
    value: t.value
  }));
  // Ensure defaultTz is in the list; if not, prepend.
  if (!opts.find(o => o.value === defaultTz)) {
    opts.unshift({ text: { type: 'plain_text', text: defaultTz }, value: defaultTz });
  }
  const initial = opts.find(o => o.value === defaultTz)!;
  return {
    type: 'input',
    block_id: 'timezone_block',
    label: { type: 'plain_text', text: 'Zona horaria' },
    hint: { type: 'plain_text', text: 'El disparo se ancla a esta zona. Cada destinatario ve la hora convertida a la suya.' },
    element: {
      type: 'static_select',
      action_id: 'timezone',
      initial_option: initial,
      options: opts
    }
  } as const;
}

function notifyInput(initial?: string[]) {
  const opt = (v: string, t: string) => ({ text: { type: 'plain_text' as const, text: t }, value: v });
  const channel = opt('channel', 'Publicar en el canal seleccionado');
  const dm = opt('dm_assignees', 'DM a cada persona asignada (no a miembros de grupos)');
  const onlyTurn = opt('dm_only_turn', 'DM solo al de turno (cuando hay rotación)');
  const all = [channel, dm, onlyTurn];
  const initialOptions = initial
    ? all.filter(o => initial.includes(o.value))
    : [channel, dm];
  return {
    type: 'input',
    block_id: 'notify_block',
    optional: true,
    label: { type: 'plain_text', text: 'Canales de aviso' },
    element: {
      type: 'checkboxes',
      action_id: 'notify',
      ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
      options: all
    }
  } as const;
}

function typeInput(initialValue: ReminderType = 'ping') {
  const ping = {
    text: { type: 'plain_text' as const, text: 'Aviso simple (sin Done)' },
    description: { type: 'plain_text' as const, text: 'Pinguea una vez. Sin estado.' },
    value: 'ping'
  };
  const task = {
    text: { type: 'plain_text' as const, text: 'Actividad — requiere Done' },
    description: { type: 'plain_text' as const, text: 'Si nadie marca Done, el bot vuelve a pinguear hasta que se cierre.' },
    value: 'task'
  };
  const initial = initialValue === 'task' ? task : ping;
  return {
    type: 'input',
    block_id: 'type_block',
    dispatch_action: true,    // ← cambiar = mostrar/ocultar reping + max_pings
    label: { type: 'plain_text', text: 'Modo' },
    element: {
      type: 'radio_buttons',
      action_id: 'type',
      initial_option: initial,
      options: [ping, task]
    }
  } as const;
}

function repingInput(initial?: RepingEvery) {
  const opt = (v: string, t: string) => ({ text: { type: 'plain_text' as const, text: t }, value: v });
  const options = [
    opt('off', 'No re-pinguear'),
    opt('15m', '15 minutos'),
    opt('30m', '30 minutos'),
    opt('1h', '1 hora'),
    opt('2h', '2 horas'),
    opt('1d', 'Al día siguiente, misma hora')
  ];
  const initialOpt = options.find(o => o.value === initial) ?? options.find(o => o.value === '30m')!;
  return {
    type: 'input',
    block_id: 'reping_block',
    optional: true,
    label: { type: 'plain_text', text: 'Si no se marca Done, recordar de nuevo cada…' },
    hint: { type: 'plain_text', text: 'Solo aplica en modo «Actividad».' },
    element: {
      type: 'static_select',
      action_id: 'reping',
      initial_option: initialOpt,
      options
    }
  } as const;
}

function maxPingsInput(initial?: MaxPings) {
  const opt = (v: string, t: string) => ({ text: { type: 'plain_text' as const, text: t }, value: v });
  const options = [opt('3', '3 recordatorios'), opt('5', '5 recordatorios'), opt('10', '10 recordatorios'), opt('inf', 'Sin límite')];
  const initialOpt = options.find(o => o.value === initial) ?? options.find(o => o.value === '5')!;
  return {
    type: 'input',
    block_id: 'max_pings_block',
    optional: true,
    label: { type: 'plain_text', text: 'Cortar después de…' },
    hint: { type: 'plain_text', text: 'Evita spam infinito si nadie marca Done.' },
    element: {
      type: 'static_select',
      action_id: 'max_pings',
      initial_option: initialOpt,
      options
    }
  } as const;
}

function escalateInput(initial?: string | null) {
  return {
    type: 'input',
    block_id: 'escalate_block',
    optional: true,
    label: { type: 'plain_text', text: 'Avisar a un líder si no se completa' },
    hint: { type: 'plain_text', text: 'Si el recordatorio agota sus avisos sin que nadie marque Done, esta persona recibe un DM. Dejá vacío para no escalar.' },
    element: {
      type: 'users_select',
      action_id: 'escalate',
      placeholder: { type: 'plain_text', text: 'Selecciona un líder (opcional)' },
      ...(initial ? { initial_user: initial } : {})
    }
  } as const;
}

function actionsInput(initialSelected: string[] = ['done', 'snooze', 'reassign']) {
  const done = { text: { type: 'plain_text' as const, text: 'Marcar Done' }, value: 'done' };
  const snooze = { text: { type: 'plain_text' as const, text: 'Snooze (posponer)' }, value: 'snooze' };
  const reassign = { text: { type: 'plain_text' as const, text: 'Reasignar' }, value: 'reassign' };
  const all = [done, snooze, reassign];
  const initial = all.filter(o => initialSelected.includes(o.value));
  return {
    type: 'input',
    block_id: 'actions_block',
    dispatch_action: true,    // ← cambiar = mostrar/ocultar snooze_presets
    label: { type: 'plain_text', text: 'Acciones disponibles' },
    element: {
      type: 'checkboxes',
      action_id: 'actions',
      ...(initial.length > 0 ? { initial_options: initial } : {}),
      options: all
    }
  } as const;
}

function snoozePresetsInput(initial?: string[]) {
  const opt = (v: string, t: string) => ({ text: { type: 'plain_text' as const, text: t }, value: v });
  const options = [
    opt('15m', '15 minutos'),
    opt('30m', '30 minutos'),
    opt('1h', '1 hora'),
    opt('2h', '2 horas'),
    opt('3h', '3 horas'),
    opt('6h', '6 horas'),
    opt('today_16', 'Esta tarde 4pm'),
    opt('tomorrow_9', 'Mañana 9am'),
    opt('next_monday_9', 'Próximo lunes 9am'),
    opt('custom', 'Fecha personalizada')
  ];
  const initialOptions = initial
    ? options.filter(o => initial.includes(o.value))
    : options.filter(o => ['15m', '1h', '3h', 'tomorrow_9'].includes(o.value));
  return {
    type: 'input',
    block_id: 'snooze_presets_block',
    optional: true,
    label: { type: 'plain_text', text: 'Opciones rápidas de snooze' },
    hint: { type: 'plain_text', text: 'Solo si tienes «Snooze» activado arriba. Máximo 5 opciones.' },
    element: {
      type: 'checkboxes',
      action_id: 'snooze_presets',
      ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
      options
    }
  } as const;
}
