import { DateTime } from 'luxon';

/**
 * Convierte un preset de snooze a una fecha-hora concreta (en UTC) relativa al
 * timezone del recordatorio.
 *
 * Devuelve null si el preset no es reconocido.
 */
export function computeSnoozeTarget(preset: string, tz: string): DateTime | null {
  const now = DateTime.utc().setZone(tz);

  switch (preset) {
    case '15m':
      return now.plus({ minutes: 15 });

    case '1h':
      return now.plus({ hours: 1 });

    case 'today_16': {
      const target = now.set({ hour: 16, minute: 0, second: 0, millisecond: 0 });
      // si ya pasó las 16, salta a mañana 16:00
      return target > now ? target : target.plus({ days: 1 });
    }

    case 'tomorrow_9':
      return now.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });

    case 'next_monday_9': {
      let next = now.plus({ days: 1 });
      while (next.weekday !== 1) next = next.plus({ days: 1 });
      return next.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    }

    case 'custom':
      // fallback: mañana 9am. Para fecha personalizada de verdad haría falta
      // abrir un datepicker modal, lo dejamos como TODO.
      return now.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });

    default:
      return null;
  }
}

export function snoozeLabel(preset: string): string {
  switch (preset) {
    case '15m':            return '15 minutos';
    case '1h':             return '1 hora';
    case 'today_16':       return 'esta tarde 4pm';
    case 'tomorrow_9':     return 'mañana 9am';
    case 'next_monday_9':  return 'próximo lunes 9am';
    case 'custom':         return 'fecha personalizada';
    default:               return preset;
  }
}
