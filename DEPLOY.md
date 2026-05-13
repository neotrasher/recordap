# Deploy de recordap al VPS

Guía para correr el bot 24/7 en el VPS Ubuntu que ya hospeda `horarios-bot`. Usa PM2 como manager de proceso, igual que tu otro bot.

**Ubicación elegida:** `/root/recordap`.

---

## 1. Primer deploy (one-time setup)

### 1.1. Clonar el repo

```bash
ssh root@TU-VPS
cd /root
git clone https://github.com/neotrasher/recordap.git
cd recordap
```

### 1.2. Instalar dependencias de producción

```bash
npm install --omit=dev
```

> `--omit=dev` ahorra `ts-node-dev` y los `@types/*` que solo se usan en local. El build ya está hecho con `npm run build`.

### 1.3. Configurar `.env`

```bash
cp .env.example .env
nano .env   # o vim
```

Pega los tres tokens reales (los mismos que tienes en local):

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

DB_PATH=./data/reminders.db
DEFAULT_TIMEZONE=America/Bogota
SCHEDULER_TICK_SECONDS=30
CRON_DISABLED=false
LOG_LEVEL=info
```

> El `.env` está en `.gitignore`, **nunca** se va a subir al repo aunque hagas commit por error.

### 1.4. Crear la base de datos

```bash
npm run migrate
```

Genera `./data/reminders.db` con todas las tablas (`reminders`, `reminder_fires`, `reminder_dms`, `reminder_events`).

### 1.5. Build TypeScript

```bash
npm run build
```

Genera `./dist/index.js` y todos los `.js` que va a correr PM2.

### 1.6. Arrancar con PM2

```bash
pm2 start ecosystem.config.js
pm2 save
```

- `pm2 start ecosystem.config.js` registra y arranca el proceso con la config de `ecosystem.config.js` (nombre `recordap`, autorestart, TZ=UTC, max_memory_restart 300M, logs en `./logs/`).
- `pm2 save` graba el estado actual para que sobreviva reboots.

Si es la **primera vez** que usas PM2 en este VPS (o si nunca configuraste el startup script):

```bash
pm2 startup
# Copia el comando que te imprime y lo ejecuta — registra PM2 como servicio de systemd.
pm2 save
```

### 1.7. Verificar

```bash
pm2 status
```

Deberías ver:

```
┌─────┬────────────┬─────────┬─────────┬─────────┬──────────┬─────────┐
│ id  │ name       │ mode    │ status  │ cpu     │ memory   │ restart │
├─────┼────────────┼─────────┼─────────┼─────────┼──────────┼─────────┤
│ 0   │ horarios…  │ fork    │ online  │ 0%      │ ~80mb    │ 0       │
│ 1   │ recordap   │ fork    │ online  │ 0%      │ ~80mb    │ 0       │
└─────┴────────────┴─────────┴─────────┴─────────┴──────────┴─────────┘
```

Logs en vivo:

```bash
pm2 logs recordap --lines 30
```

Tienes que ver:
```
⚡ recordap running (Socket Mode)
⏰ scheduler armed (tick every 30s)
[INFO]  socket-mode:SocketModeClient:0 Now connected to Slack
```

Desde Slack, probá `/recordap` en cualquier canal — debe abrir el modal en menos de 1 segundo.

---

## 2. Updates posteriores

Cada vez que hagas `git push` desde tu máquina con cambios:

```bash
ssh root@TU-VPS
cd /root/recordap
./scripts/update.sh
```

El script `scripts/update.sh` hace `git pull` + `npm install` (si cambió `package-lock.json`) + `npm run build` + `pm2 restart recordap --update-env`. Es seguro correrlo varias veces.

Si prefieres hacerlo a mano:

```bash
cd /root/recordap
git pull
npm install --omit=dev   # solo si cambió package-lock
npm run build
pm2 restart recordap --update-env
```

> `--update-env` fuerza a PM2 a releer `ecosystem.config.js` y el `.env`. Sin esa flag, los cambios en variables de entorno no toman efecto.

---

## 3. Comandos útiles de PM2

| Necesito… | Comando |
|---|---|
| Ver estado de los bots | `pm2 status` |
| Ver logs en vivo | `pm2 logs recordap` |
| Últimas 100 líneas | `pm2 logs recordap --lines 100` |
| Dashboard interactivo | `pm2 monit` |
| Restart manual | `pm2 restart recordap` |
| Stop temporal | `pm2 stop recordap` |
| Eliminar de PM2 | `pm2 delete recordap` |
| Guardar estado actual | `pm2 save` |

Logs en disco (rotación los maneja PM2):

```
/root/recordap/logs/out.log    # stdout
/root/recordap/logs/err.log    # stderr
```

---

## 4. Rotar tokens o cambiar configuración

1. `nano /root/recordap/.env`
2. Editar el valor.
3. `pm2 restart recordap --update-env`

Es importante usar `--update-env` para que PM2 cargue el nuevo `.env`; sin esa flag se queda con los valores viejos.

---

## 5. Backup de la base

La DB SQLite vive en `/root/recordap/data/reminders.db`. Si quieres backup:

```bash
# Backup atómico (WAL safe)
sqlite3 /root/recordap/data/reminders.db ".backup /root/backups/recordap-$(date +%F).db"
```

Programable con `crontab -e`:

```
0 3 * * * sqlite3 /root/recordap/data/reminders.db ".backup /root/backups/recordap-$(date +\%F).db"
```

---

## 6. Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| `pm2 status` muestra `errored` | Falta `.env` o tokens inválidos | `pm2 logs recordap --lines 50` muestra el stack. Revisar `.env`. |
| `Missing env var: SLACK_BOT_TOKEN` | `.env` no está en `/root/recordap/` | Crearlo como en paso 1.3. |
| `pm2 logs recordap` repite "Now connected to Slack" cada minuto | Socket reconecta — normal cada cierto tiempo, NO es error. |
| Bot no responde a `/recordap` | Token revocado, scopes faltantes, o app desinstalada | Revisar `pm2 logs recordap`. Reinstalar la app desde api.slack.com si hace falta. |
| `SQLITE_BUSY` o `database is locked` | Dos procesos del bot corriendo | `pm2 list`, eliminar duplicados con `pm2 delete <id>`. |
| Memoria > 300M y se reinicia solo | Esperable. PM2 reinicia limpio. Subir el cap en `ecosystem.config.js` si es legítimo (≥1k recordatorios activos). |

---

## 7. Sobre Caddy / HTTPS

**No necesitas Caddy para recordap.** El bot usa **Socket Mode** que conecta a Slack vía WebSocket saliente — no expone ningún puerto entrante, no recibe webhooks. Caddy solo es relevante para horarios-bot porque ese sí tiene un dashboard web.

---

## 8. Sobre el timezone del proceso

`ecosystem.config.js` arranca el proceso con `TZ=UTC`. **No lo cambies.** Internamente luxon usa zonas IANA explícitas (`America/Bogota`, etc.); que el proceso corra en UTC garantiza que ningún `new Date()` ambiguo genere bugs.
