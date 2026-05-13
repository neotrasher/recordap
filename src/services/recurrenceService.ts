import { DateTime } from 'luxon';
import { LUXON_TO_KEY, WeekdayKey } from '../config';
import type { Reminder } from '../types';

/**
 * Compute the next fire moment (UTC) strictly after `after`, in the reminder's
 * own timezone. Returns null if the recurrence has no more occurrences
 * (e.g. ends_mode='on_date' already passed).
 */
export function nextFire(rem: Reminder, after: DateTime): DateTime | null {
  const tz = rem.timezone;
  // step in 1-minute increments inside the reminder's tz. Cap at 366 days as
  // safety net to avoid infinite loops on misconfigured rules.
  let cur = after.setZone(tz).set({ second: 0, millisecond: 0 }).plus({ minutes: 1 });
  const limit = cur.plus({ days: 366 });

  while (cur < limit) {
    if (timeMatches(rem, cur) && dayMatches(rem, cur) && !endsReached(rem, cur)) {
      return cur.toUTC();
    }
    cur = cur.plus({ minutes: 1 });
  }
  return null;
}

function timeMatches(rem: Reminder, dt: DateTime): boolean {
  return dt.hour === rem.hour && dt.minute === rem.minute;
}

function dayMatches(rem: Reminder, dt: DateTime): boolean {
  switch (rem.recurrence) {
    case 'none':
      return false; // one-shot reminders are handled separately via first_fire_at

    case 'daily':
      return true;

    case 'weekdays':
      return dt.weekday >= 1 && dt.weekday <= 5;

    case 'weekly': {
      const data = rem.recurrence_data ? JSON.parse(rem.recurrence_data) : {};
      const days: WeekdayKey[] = data.weekdays || [];
      return days.includes(LUXON_TO_KEY[dt.weekday]);
    }

    case 'biweekly': {
      // Anchor on the FIRST fire date. Match if (weeksSinceAnchor % 2 === 0) and
      // same weekday. Stored anchor inferred from created_at converted to tz.
      const data = rem.recurrence_data ? JSON.parse(rem.recurrence_data) : {};
      const anchorIso: string | undefined = data.anchor;
      if (!anchorIso) return false;
      const anchor = DateTime.fromISO(anchorIso, { zone: rem.timezone });
      if (dt.weekday !== anchor.weekday) return false;
      const diffDays = Math.floor(dt.diff(anchor, 'days').days);
      return diffDays % 14 === 0;
    }

    case 'monthly_day': {
      const data = rem.recurrence_data ? JSON.parse(rem.recurrence_data) : {};
      return dt.day === Number(data.day);
    }

    case 'monthly_last_business':
      return isLastBusinessDay(dt);
  }
}

function isLastBusinessDay(dt: DateTime): boolean {
  // Last business day = max date in this month with weekday Mon-Fri.
  const lastOfMonth = dt.endOf('month').startOf('day');
  let candidate = lastOfMonth;
  while (candidate.weekday > 5) candidate = candidate.minus({ days: 1 });
  return dt.hasSame(candidate, 'day');
}

function endsReached(rem: Reminder, dt: DateTime): boolean {
  if (rem.ends_mode === 'never') return false;
  const data = rem.ends_data ? JSON.parse(rem.ends_data) : {};

  if (rem.ends_mode === 'on_date') {
    const endDate = DateTime.fromISO(data.date, { zone: rem.timezone }).endOf('day');
    return dt > endDate;
  }

  if (rem.ends_mode === 'after_n') {
    return rem.fires_count >= Number(data.count);
  }

  return false;
}

/**
 * Compute the timestamp at which we should re-ping a still-pending fire, given
 * the reminder's `reping_every`.
 */
export function nextReping(reping: Reminder['reping_every'], from: DateTime): DateTime | null {
  switch (reping) {
    case 'off':  return null;
    case '15m':  return from.plus({ minutes: 15 });
    case '30m':  return from.plus({ minutes: 30 });
    case '1h':   return from.plus({ hours: 1 });
    case '2h':   return from.plus({ hours: 2 });
    case '1d':   return from.plus({ days: 1 });
  }
}
