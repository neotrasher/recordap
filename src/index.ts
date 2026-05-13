import { App, LogLevel } from '@slack/bolt';
import cron from 'node-cron';
import { config } from './config';
import { migrate } from './db';
import { registerRecordar } from './commands/recordar';
import { registerRecordarList } from './commands/recordarList';
import { registerReminderCreate } from './actions/reminderCreate';
import { registerGroupsLookup } from './actions/groupsLookup';
import { registerFireActions } from './actions/fireActions';
import { fireTick } from './jobs/fireTick';
import { repingTick } from './jobs/repingTick';

async function main() {
  migrate();

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
    logLevel: config.logLevel === 'debug' ? LogLevel.DEBUG : LogLevel.INFO
  });

  // Slash commands
  registerRecordar(app);
  registerRecordarList(app);

  // View submissions (modal of /recordap)
  registerReminderCreate(app);

  // External-select lookups
  registerGroupsLookup(app);

  // Botones del mensaje del recordatorio: Done / Snooze / Reasignar
  registerFireActions(app);

  // Block actions
  // TODO: app.action({ action_id: /^done(?:_\d+)?$/ }, ...)
  // TODO: app.action({ action_id: /^snooze:/ }, ...)
  // TODO: app.action({ action_id: 'reassign' }, ...)

  // Health DM (mention the bot anywhere)
  app.event('app_mention', async ({ event, say }) => {
    await say({ text: `👋 Hola <@${event.user}>, recordatorios online. Prueba \`/recordap\`.` });
  });

  await app.start();
  console.log('⚡ recordap running (Socket Mode)');

  // Schedulers — two parallel ticks
  if (config.cronDisabled) {
    console.log('⏸️  Scheduler DISABLED (CRON_DISABLED=true). Reminders will NOT fire.');
    return;
  }
  const tickExpr = `*/${config.schedulerTickSeconds} * * * * *`; // 6-field cron (incl. seconds)
  cron.schedule(tickExpr, () => {
    fireTick(app).catch(e => console.error('[fireTick] error:', e));
    repingTick(app).catch(e => console.error('[repingTick] error:', e));
  });
  console.log(`⏰ scheduler armed (tick every ${config.schedulerTickSeconds}s)`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
