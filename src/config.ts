import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    signingSecret: required('SLACK_SIGNING_SECRET')
  },
  dbPath: process.env.DB_PATH || './data/reminders.db',
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'America/Bogota',
  schedulerTickSeconds: parseInt(process.env.SCHEDULER_TICK_SECONDS || '30', 10),
  cronDisabled: (process.env.CRON_DISABLED || '').toLowerCase() === 'true',
  logLevel: process.env.LOG_LEVEL || 'info'
};

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekdayKey = typeof WEEKDAY_KEYS[number];

// Luxon weekday: 1=Mon..7=Sun. Map both directions.
export const LUXON_TO_KEY: Record<number, WeekdayKey> = {
  1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat', 7: 'sun'
};

export type RecurrenceKind =
  | 'none'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'biweekly'
  | 'monthly_day'
  | 'monthly_last_business'
  | 'custom';

export type ReminderType = 'ping' | 'task';
export type RotationMode = 'all' | 'rotate' | 'first_taker';
export type ReminderStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type FireStatus = 'pending' | 'done' | 'expired' | 'cancelled';
export type RepingEvery = 'off' | '15m' | '30m' | '1h' | '2h' | '1d';
export type MaxPings = '3' | '5' | '10' | 'inf';
