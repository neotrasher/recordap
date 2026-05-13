# recordap

Bot de Slack para recordatorios ricos por canal con done / snooze / reasignar, re-pings configurables, rotación round-robin y DM directo a personas asignadas.

Stack: Node 20+ · TypeScript · @slack/bolt (Socket Mode) · better-sqlite3 · node-cron · luxon · cron-parser.

## Setup local

```bash
cd recordap
npm install
cp .env.example .env
# editar .env con SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
npm run dev
```

### Crear la app de Slack

1. https://api.slack.com/apps → **Create New App** → from manifest, o:
2. Habilitar **Socket Mode** y crear un **App-Level Token** con `connections:write` (ese va a `SLACK_APP_TOKEN`).
3. **OAuth & Permissions** → scopes del bot:
   - `chat:write`, `chat:write.public` (postear en canales)
   - `commands` (slash commands)
   - `im:write` (mandar DMs)
   - `users:read` (leer timezones)
   - `usergroups:read` (popular el `multi_external_select` de grupos)
4. **Slash Commands** → crear:
   - `/recordap` — Crear un recordatorio (no usar `/recordar`: Slack lo reserva como alias localizado de `/remind`)
   - `/recordap-list` — Ver mis recordatorios
5. **Event Subscriptions** → enable + suscribir a `app_mention`.
6. **Interactivity** → enable (sin URL porque es socket mode).
7. Instalar al workspace y copiar `SLACK_BOT_TOKEN` (xoxb-) y `SLACK_SIGNING_SECRET` al `.env`.

## Build & deploy

Para correrlo 24/7 en VPS, ver [DEPLOY.md](DEPLOY.md) — guía completa de setup inicial, updates posteriores y troubleshooting.

Resumen rápido:

```bash
# primer deploy en el VPS
ssh root@TU-VPS
cd /root && git clone https://github.com/neotrasher/recordap.git
cd recordap
npm install
cp .env.example .env && nano .env    # pegar tokens
npm run migrate
npm run build
pm2 start ecosystem.config.js
pm2 save

# updates posteriores
./scripts/update.sh
```

## Estructura

```
src/
├── index.ts                # Bolt boot + cron ticks
├── config.ts               # env + tipos compartidos
├── db.ts                   # schema + migrate()
├── types.ts                # Reminder, ReminderFire, ReminderDm
├── commands/
│   └── recordar.ts         # /recordap → modal
├── views/
│   └── createModal.ts      # Block Kit del modal
├── services/
│   ├── recurrenceService.ts # next fire & next reping con luxon
│   └── tzService.ts         # <!date^...> + users.info tz
├── actions/                # (TODO) done / snooze / reassign handlers
└── jobs/                   # (TODO) fireTick.ts, repingTick.ts
```

## Datamodel

Tres tablas en SQLite:

- **`reminders`** — la regla (recurrencia + configuración + estado).
- **`reminder_fires`** — cada disparo concreto (status, ping_count, message ts).
- **`reminder_dms`** — copias DM por persona asignada (ack por separado).
- **`reminder_events`** — audit log (creado / pausado / done / reasignado / etc).

Ver el schema completo en [`src/db.ts`](src/db.ts).

## Reglas de notificación

- Si no hay personas ni grupos asignados → mención `@here` (nunca `@channel`).
- DM se manda **solo a los usuarios individuales** del campo *Personas asignadas*. Los grupos se mencionan en el canal pero **no se expanden** para DMs.
- En modo `rotate` con `notify_only_turn=true`, solo la persona del turno actual recibe DM.

## Timezones

- El disparo se ancla a la zona del campo `timezone_block` del modal (default = tz del creador desde `users.info`).
- En los mensajes a canal/DM, las horas se muestran con `<!date^epoch^...>` para que cada destinatario las vea en su zona.
- El proceso del bot corre con `TZ=UTC` en PM2 (ecosystem.config.js) — todos los cálculos de luxon usan tz explícitas.

## Estado actual del scaffolding

Implementado:
- ✅ Schema DB completo (reminders, fires, dms, events)
- ✅ Slash command `/recordap` que abre el modal
- ✅ Block Kit del modal de creación
- ✅ Service de recurrencia con luxon + cron-parser
- ✅ `reminderService` (create / find / listByCreator / logEvent)
- ✅ `view_submission` del modal: parsea valores, valida (errores por block_id), calcula `next_fire_at` respetando timezone + recurrencia, INSERT en `reminders` + audit log, DM de confirmación al creador

Pendiente (próximo PR):
- ⬜ `fireTick` job → scan reminders due → post canal + post DMs → insertar `reminder_fires` y `reminder_dms`
- ⬜ `repingTick` job → re-ping de fires pendientes con `ping_count++` o expirar
- ⬜ Botones Done / Snooze / Reasignar
- ⬜ Modal de reasignar
- ⬜ Conditional fields del modal (mostrar weekdays solo si recurrence=weekly) vía `views.update`
- ⬜ `/recordap-list`
- ⬜ `block_suggestion` para `multi_external_select` de grupos
- ⬜ Inputs faltantes para `ends_mode=on_date` (datepicker) y `ends_mode=after_n` (number_input)
