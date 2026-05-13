import { DateTime } from 'luxon';
import type { WebClient } from '@slack/web-api';

/**
 * Render a Slack <!date> token that each user sees converted to their own
 * timezone. See https://api.slack.com/reference/surfaces/formatting#date-formatting
 *
 * Tokens accepted: {date_num}, {date_short_pretty}, {date_pretty}, {time}, {time_secs}.
 */
export function slackDate(
  whenUtc: DateTime,
  format: string = '{date_short_pretty} a las {time}',
  fallback?: string
): string {
  const epoch = Math.floor(whenUtc.toSeconds());
  const fb = fallback ?? whenUtc.toFormat('yyyy-LL-dd HH:mm');
  return `<!date^${epoch}^${format}|${fb}>`;
}

/**
 * Fetch a user's IANA timezone from Slack. Falls back to the workspace default
 * if the user has no tz set or the call fails (e.g. classic users).
 */
export async function fetchUserTz(
  client: WebClient,
  slackUserId: string,
  fallback: string
): Promise<string> {
  try {
    const res = await client.users.info({ user: slackUserId });
    const tz = res.user?.tz;
    return tz && typeof tz === 'string' ? tz : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Common IANA offerings shown in the modal's timezone picker. Add more as needed.
 */
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: 'America/Bogota',                 label: 'America/Bogota (Colombia)' },
  { value: 'America/Mexico_City',            label: 'America/Mexico_City (México)' },
  { value: 'America/Lima',                   label: 'America/Lima (Perú)' },
  { value: 'America/Santiago',               label: 'America/Santiago (Chile)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'America/Buenos_Aires (Argentina)' },
  { value: 'America/Sao_Paulo',              label: 'America/Sao_Paulo (Brasil)' },
  { value: 'America/New_York',               label: 'America/New_York (US East)' },
  { value: 'America/Los_Angeles',            label: 'America/Los_Angeles (US West)' },
  { value: 'Europe/Madrid',                  label: 'Europe/Madrid (España)' },
  { value: 'Europe/London',                  label: 'Europe/London (UK)' },
  { value: 'UTC',                            label: 'UTC' }
];
