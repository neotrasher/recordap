/**
 * Quick smoke test — validates that:
 *   1. createModalView() returns a well-formed Slack modal
 *   2. radio_buttons initial_option matches an entry in options exactly
 *      (Slack's silent-fail trap)
 *   3. recurrenceService.nextFire() advances correctly across recurrence kinds
 *
 * Run with:
 *   SLACK_BOT_TOKEN=x SLACK_APP_TOKEN=x SLACK_SIGNING_SECRET=x \
 *   npx ts-node scripts/smoke.ts
 */
import { DateTime } from 'luxon';
import { createModalView } from '../src/views/createModal';
import { nextFire } from '../src/services/recurrenceService';

const TZ = 'America/Argentina/Buenos_Aires';

function header(label: string) {
  console.log(`\n── ${label} ──────────────────────────────────────────`);
}

header('Modal view');
const modal = createModalView({ defaultTimezone: TZ, triggerChannelId: 'C0123' });
console.log('blocks:', modal.blocks.length, '· callback_id:', modal.callback_id);

header('radio_buttons initial_option matches options (exact JSON)');
const radios = modal.blocks.filter((b: any) => b.element?.type === 'radio_buttons');
let allOk = true;
for (const r of radios) {
  const e = (r as any).element;
  const match = e.options.find((o: any) => o.value === e.initial_option.value);
  const same = match && JSON.stringify(match) === JSON.stringify(e.initial_option);
  console.log(`  ${e.action_id.padEnd(12)} → ${same ? 'OK' : 'FAIL'}`);
  if (!same) allOk = false;
}
if (!allOk) process.exitCode = 1;

header('recurrenceService.nextFire()');
function fmt(dt: DateTime | null) {
  return dt ? dt.setZone(TZ).toFormat('EEE yyyy-LL-dd HH:mm ZZZZ') : '(null)';
}

const base: any = {
  timezone: TZ,
  hour: 9,
  minute: 0,
  recurrence: 'weekly',
  recurrence_data: JSON.stringify({ weekdays: ['mon', 'wed', 'fri'] }),
  ends_mode: 'never',
  ends_data: null,
  fires_count: 0
};

// 1) weekly L/M/V — sunday → expect next monday 09:00
const sun = DateTime.fromISO('2026-05-10T10:00', { zone: TZ }).toUTC();
console.log('  weekly L/M/V — sun 10 may 10:00 →', fmt(nextFire(base, sun)));

// 2) daily — should land on next day
const daily = { ...base, recurrence: 'daily', recurrence_data: null };
const wed10am = DateTime.fromISO('2026-05-13T10:00', { zone: TZ }).toUTC();
console.log('  daily — wed 13 may 10:00 →', fmt(nextFire(daily, wed10am)));

// 3) weekdays (L-V) — friday eve → expect next monday
const wkd = { ...base, recurrence: 'weekdays', recurrence_data: null };
const fri = DateTime.fromISO('2026-05-15T18:00', { zone: TZ }).toUTC();
console.log('  weekdays — fri 15 may 18:00 →', fmt(nextFire(wkd, fri)));

// 4) monthly last business day
const lastBiz = { ...base, recurrence: 'monthly_last_business', recurrence_data: null };
const may1 = DateTime.fromISO('2026-05-01T08:00', { zone: TZ }).toUTC();
console.log('  last biz day of May 2026 →', fmt(nextFire(lastBiz, may1)));

// 5) custom cron — weekdays 9am from saturday
const cron = { ...base, recurrence: 'custom', recurrence_data: JSON.stringify({ cron: '0 9 * * 1-5' }) };
const sat = DateTime.fromISO('2026-05-09T12:00', { zone: TZ }).toUTC();
console.log('  cron 0 9 * * 1-5 — sat 9 may 12:00 →', fmt(nextFire(cron, sat)));

// 6) biweekly — anchor wed 13 may → next wed 27 may
const biw = {
  ...base,
  recurrence: 'biweekly',
  recurrence_data: JSON.stringify({ anchor: '2026-05-13T09:00:00.000-03:00' })
};
const wedAfter = DateTime.fromISO('2026-05-13T10:00', { zone: TZ }).toUTC();
console.log('  biweekly anchored wed 13 may — from same day 10:00 →', fmt(nextFire(biw, wedAfter)));

// 7) monthly_day=5
const monD = { ...base, recurrence: 'monthly_day', recurrence_data: JSON.stringify({ day: 5 }) };
const may1b = DateTime.fromISO('2026-05-01T08:00', { zone: TZ }).toUTC();
console.log('  monthly day=5 from 1 may →', fmt(nextFire(monD, may1b)));

header('Done');
