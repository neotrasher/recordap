import type {
  RecurrenceKind,
  ReminderType,
  RotationMode,
  ReminderStatus,
  FireStatus,
  RepingEvery,
  MaxPings
} from './config';

export interface Reminder {
  id: number;
  creator_slack_id: string;
  title: string;
  description: string | null;
  channel_id: string;
  assignees: string;          // JSON ["U_XXX",...]
  groups: string;             // JSON ["S_XXX",...]
  rotation_mode: RotationMode;
  rotation_index: number;

  timezone: string;           // IANA
  hour: number;
  minute: number;
  recurrence: RecurrenceKind;
  recurrence_data: string | null;
  ends_mode: 'never' | 'on_date' | 'after_n';
  ends_data: string | null;

  reminder_type: ReminderType;
  reping_every: RepingEvery;
  max_pings: MaxPings;

  notify_channel: 0 | 1;
  notify_dm: 0 | 1;
  notify_only_turn: 0 | 1;

  allow_done: 0 | 1;
  allow_snooze: 0 | 1;
  allow_reassign: 0 | 1;
  snooze_presets: string;     // JSON ["15m","1h","tomorrow_9"]

  status: ReminderStatus;
  next_fire_at: string | null;
  fires_count: number;

  escalate_to: string | null;   // slack user id a avisar si el fire expira sin Done

  created_at: string;
  updated_at: string;
}

export interface ReminderFire {
  id: number;
  reminder_id: number;
  scheduled_for: string;      // UTC ISO
  fired_at: string;
  status: FireStatus;
  done_by_slack_id: string | null;
  done_at: string | null;
  ping_count: number;
  next_reping_at: string | null;
  channel_id: string | null;
  channel_ts: string | null;
  assigned_to_slack_id: string | null;
}

export interface ReminderDm {
  id: number;
  fire_id: number;
  slack_user_id: string;
  dm_channel: string;
  dm_ts: string;
  acked_at: string | null;
  ack_action: 'done' | 'snooze' | 'reassign' | null;
}

// Helpers to (de)serialize JSON columns
export const json = {
  parse<T>(s: string | null, fallback: T): T {
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  },
  stringify<T>(v: T): string { return JSON.stringify(v); }
};
