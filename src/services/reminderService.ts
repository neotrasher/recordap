import { db } from '../db';
import type {
  RecurrenceKind,
  ReminderType,
  RotationMode,
  RepingEvery,
  MaxPings
} from '../config';
import type { Reminder, ReminderFire, ReminderDm } from '../types';

export interface CreateReminderInput {
  creator_slack_id: string;
  title: string;
  description: string | null;
  channel_id: string;
  assignees: string[];                  // ["U_XXX", ...]
  groups: string[];                     // ["S_XXX", ...]
  rotation_mode: RotationMode;

  timezone: string;
  hour: number;
  minute: number;
  recurrence: RecurrenceKind;
  recurrence_data: string | null;       // already-stringified JSON
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
  snooze_presets: string[];

  next_fire_at: string;                 // UTC ISO
}

const createStmt = db.prepare(`
  INSERT INTO reminders (
    creator_slack_id, title, description, channel_id,
    assignees, groups, rotation_mode,
    timezone, hour, minute, recurrence, recurrence_data,
    ends_mode, ends_data,
    reminder_type, reping_every, max_pings,
    notify_channel, notify_dm, notify_only_turn,
    allow_done, allow_snooze, allow_reassign, snooze_presets,
    next_fire_at
  ) VALUES (
    @creator_slack_id, @title, @description, @channel_id,
    @assignees_json, @groups_json, @rotation_mode,
    @timezone, @hour, @minute, @recurrence, @recurrence_data,
    @ends_mode, @ends_data,
    @reminder_type, @reping_every, @max_pings,
    @notify_channel, @notify_dm, @notify_only_turn,
    @allow_done, @allow_snooze, @allow_reassign, @snooze_presets_json,
    @next_fire_at
  )
`);

const eventStmt = db.prepare(`
  INSERT INTO reminder_events (reminder_id, actor_slack_id, action, detail)
  VALUES (?, ?, ?, ?)
`);

const findStmt = db.prepare<[number], Reminder>(`SELECT * FROM reminders WHERE id = ?`);

const listByCreatorStmt = db.prepare<[string], Reminder>(`
  SELECT * FROM reminders
  WHERE creator_slack_id = ? AND status = 'active'
  ORDER BY next_fire_at ASC
`);

// ── fire-time queries ────────────────────────────────────────────────────────

const getDueStmt = db.prepare<[string], Reminder>(`
  SELECT * FROM reminders
  WHERE status = 'active'
    AND next_fire_at IS NOT NULL
    AND next_fire_at <= ?
  ORDER BY next_fire_at ASC
  LIMIT 50
`);

const recordFireStmt = db.prepare(`
  INSERT INTO reminder_fires (
    reminder_id, scheduled_for, fired_at, status,
    ping_count, next_reping_at,
    channel_id, channel_ts, assigned_to_slack_id
  ) VALUES (
    @reminder_id, @scheduled_for, @fired_at, @status,
    @ping_count, @next_reping_at,
    @channel_id, @channel_ts, @assigned_to_slack_id
  )
`);

const updateFireChannelStmt = db.prepare(`
  UPDATE reminder_fires SET channel_id = ?, channel_ts = ? WHERE id = ?
`);

const recordDmStmt = db.prepare(`
  INSERT INTO reminder_dms (fire_id, slack_user_id, dm_channel, dm_ts)
  VALUES (?, ?, ?, ?)
`);

const updateAfterFireStmt = db.prepare(`
  UPDATE reminders
  SET fires_count   = fires_count + 1,
      rotation_index = ?,
      next_fire_at  = ?,
      status        = ?,
      updated_at    = datetime('now')
  WHERE id = ?
`);

// ── per-fire actions (Done / Snooze / Reassign) ─────────────────────────────

const findFireStmt = db.prepare<[number], ReminderFire>(
  `SELECT * FROM reminder_fires WHERE id = ?`
);

const findDmsByFireStmt = db.prepare<[number], ReminderDm>(
  `SELECT * FROM reminder_dms WHERE fire_id = ?`
);

const markFireDoneStmt = db.prepare(`
  UPDATE reminder_fires
  SET status           = 'done',
      done_by_slack_id = ?,
      done_at          = ?,
      next_reping_at   = NULL
  WHERE id = ? AND status = 'pending'
`);

const snoozeFireStmt = db.prepare(`
  UPDATE reminder_fires
  SET next_reping_at = ?
  WHERE id = ? AND status = 'pending'
`);

const ackDmStmt = db.prepare(`
  UPDATE reminder_dms
  SET acked_at = ?, ack_action = ?
  WHERE fire_id = ? AND slack_user_id = ?
`);

const updateReminderAssigneesStmt = db.prepare(`
  UPDATE reminders
  SET assignees = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const cancelReminderStmt = db.prepare(`
  UPDATE reminders
  SET status = 'cancelled', next_fire_at = NULL, updated_at = datetime('now')
  WHERE id = ?
`);

const pauseReminderStmt = db.prepare(`
  UPDATE reminders
  SET status = 'paused', updated_at = datetime('now')
  WHERE id = ? AND status = 'active'
`);

const resumeReminderStmt = db.prepare(`
  UPDATE reminders
  SET status = ?, next_fire_at = ?, updated_at = datetime('now')
  WHERE id = ? AND status = 'paused'
`);

const listMineManageableStmt = db.prepare<[string], Reminder>(`
  SELECT * FROM reminders
  WHERE creator_slack_id = ? AND status IN ('active', 'paused')
  ORDER BY
    CASE status WHEN 'active' THEN 0 ELSE 1 END,
    COALESCE(next_fire_at, '9999-12-31') ASC
`);

/**
 * Variante de listMineManageable que también incluye recordatorios completed
 * o cancelled actualizados en las últimas 24h. Sirve para que el usuario vea
 * "qué pasó con eso que acabo de crear" cuando los one-shot disparan rápido.
 */
const hasPendingFiresStmt = db.prepare<[number], { cnt: number }>(`
  SELECT COUNT(*) AS cnt FROM reminder_fires WHERE reminder_id = ? AND status = 'pending'
`);

const markRuleCompletedStmt = db.prepare(`
  UPDATE reminders
  SET status = 'completed', updated_at = datetime('now')
  WHERE id = ? AND status = 'active' AND next_fire_at IS NULL
`);

const listMineCurrentStmt = db.prepare<[string, string], Reminder>(`
  SELECT * FROM reminders
  WHERE creator_slack_id = ?
    AND (
      status IN ('active', 'paused')
      OR (status IN ('completed', 'cancelled') AND updated_at >= ?)
    )
  ORDER BY
    CASE status
      WHEN 'active'    THEN 0
      WHEN 'paused'    THEN 1
      WHEN 'completed' THEN 2
      WHEN 'cancelled' THEN 3
      ELSE 4
    END,
    COALESCE(next_fire_at, '9999-12-31') ASC,
    updated_at DESC
`);

// ── re-ping queries ─────────────────────────────────────────────────────────

const getDueRepingsStmt = db.prepare<[string], ReminderFire>(`
  SELECT * FROM reminder_fires
  WHERE status = 'pending'
    AND next_reping_at IS NOT NULL
    AND next_reping_at <= ?
  ORDER BY next_reping_at ASC
  LIMIT 50
`);

const bumpFireRepingStmt = db.prepare(`
  UPDATE reminder_fires
  SET ping_count     = ?,
      next_reping_at = ?
  WHERE id = ? AND status = 'pending'
`);

const expireFireStmt = db.prepare(`
  UPDATE reminder_fires
  SET status = 'expired', next_reping_at = NULL
  WHERE id = ? AND status = 'pending'
`);

interface RecordFireInput {
  reminder_id: number;
  scheduled_for: string;
  fired_at: string;
  status: 'pending' | 'done' | 'expired' | 'cancelled';
  ping_count: number;
  next_reping_at: string | null;
  channel_id: string | null;
  channel_ts: string | null;
  assigned_to_slack_id: string | null;
}

export const reminderService = {
  create(input: CreateReminderInput): number {
    const info = createStmt.run({
      ...input,
      assignees_json: JSON.stringify(input.assignees),
      groups_json: JSON.stringify(input.groups),
      snooze_presets_json: JSON.stringify(input.snooze_presets)
    });
    return info.lastInsertRowid as number;
  },

  find(id: number): Reminder | undefined {
    return findStmt.get(id);
  },

  listByCreator(slackId: string): Reminder[] {
    return listByCreatorStmt.all(slackId);
  },

  getDue(nowIso: string): Reminder[] {
    return getDueStmt.all(nowIso);
  },

  recordFire(input: RecordFireInput): number {
    const info = recordFireStmt.run(input);
    return info.lastInsertRowid as number;
  },

  updateFireChannel(fireId: number, channel: string, ts: string) {
    updateFireChannelStmt.run(channel, ts, fireId);
  },

  recordDm(input: { fire_id: number; slack_user_id: string; dm_channel: string; dm_ts: string }) {
    recordDmStmt.run(input.fire_id, input.slack_user_id, input.dm_channel, input.dm_ts);
  },

  updateAfterFire(id: number, rotationIndex: number, nextFireAt: string | null, status: 'active' | 'completed') {
    updateAfterFireStmt.run(rotationIndex, nextFireAt, status, id);
  },

  findFire(id: number): ReminderFire | undefined {
    return findFireStmt.get(id);
  },

  findDmsByFire(fireId: number): ReminderDm[] {
    return findDmsByFireStmt.all(fireId);
  },

  markFireDone(fireId: number, userSlackId: string, nowIso: string): boolean {
    return markFireDoneStmt.run(userSlackId, nowIso, fireId).changes > 0;
  },

  snoozeFire(fireId: number, newRepingIso: string): boolean {
    return snoozeFireStmt.run(newRepingIso, fireId).changes > 0;
  },

  ackDm(fireId: number, userSlackId: string, action: 'done' | 'snooze' | 'reassign', nowIso: string) {
    ackDmStmt.run(nowIso, action, fireId, userSlackId);
  },

  updateAssignees(reminderId: number, assignees: string[]) {
    updateReminderAssigneesStmt.run(JSON.stringify(assignees), reminderId);
  },

  cancelReminder(reminderId: number) {
    cancelReminderStmt.run(reminderId);
  },

  pauseReminder(reminderId: number): boolean {
    return pauseReminderStmt.run(reminderId).changes > 0;
  },

  resumeReminder(reminderId: number, newStatus: 'active' | 'completed', nextFireAt: string | null): boolean {
    return resumeReminderStmt.run(newStatus, nextFireAt, reminderId).changes > 0;
  },

  listMineManageable(slackId: string): Reminder[] {
    return listMineManageableStmt.all(slackId);
  },

  listMineCurrent(slackId: string, sinceIso: string): Reminder[] {
    return listMineCurrentStmt.all(slackId, sinceIso);
  },

  /**
   * Cierra automáticamente una regla `active` cuando ya no tiene próximos
   * disparos programados y no quedan fires en estado `pending`. Idempotente.
   * Llamar después de cerrar un fire (Done o expiración).
   */
  maybeCompleteRule(reminderId: number): boolean {
    const r = hasPendingFiresStmt.get(reminderId);
    if (r && r.cnt > 0) return false;
    return markRuleCompletedStmt.run(reminderId).changes > 0;
  },

  hasPendingFires(reminderId: number): boolean {
    const r = hasPendingFiresStmt.get(reminderId);
    return !!(r && r.cnt > 0);
  },

  getDueRepings(nowIso: string): ReminderFire[] {
    return getDueRepingsStmt.all(nowIso);
  },

  bumpFireReping(fireId: number, newPingCount: number, newRepingIso: string | null): boolean {
    return bumpFireRepingStmt.run(newPingCount, newRepingIso, fireId).changes > 0;
  },

  expireFire(fireId: number): boolean {
    return expireFireStmt.run(fireId).changes > 0;
  },

  logEvent(reminderId: number, actorSlackId: string, action: string, detail?: unknown) {
    eventStmt.run(
      reminderId,
      actorSlackId,
      action,
      detail === undefined ? null : JSON.stringify(detail)
    );
  }
};
