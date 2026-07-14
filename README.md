# TeraBox Downloader Telegram Bot

A Telegram bot that resolves TeraBox share links and sends files directly into Telegram — videos, images, and documents. Supports multi-file shares, nested folders, and "Download all" mode that delivers every file one by one.

---

## Features

- 🎬 **Direct video upload** into Telegram via MTProto (up to ~1.9 GB)
- 🖼️ **Direct image send** via Bot API
- 📄 **Document delivery** for any other file type
- 📦 **Download all** — processes every file in a share and sends each one individually with a live progress bar
- 🔍 **Cookie health check** — `/status` command tells you instantly if the TeraBox session is valid
- 🔒 **Concurrent download guard** — prevents double-tap race conditions per user
- 🌐 **Multi-domain support** — terabox.com, 1024tera.com, terasharefile.com, teraboxurl.com, and more

---

## Supported TeraBox Domains

| Domain | Alias |
|--------|-------|
| terabox.com | Primary |
| 1024tera.com | Mirror |
| terasharefile.com | Mirror |
| 1024terabox.com | Mirror |
| teraboxurl.com | Mirror |
| 4funbox.com | Mirror |
| momerybox.com | Mirror |
| teraboxapp.com | Mirror |

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message + supported domains |
| `/help` | Full usage guide |
| `/status` | Live check of cookie validity, MTProto config, and uptime |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TERABOX_COOKIE` | ✅ Yes | Your TeraBox session cookie (see below) |
| `TELEGRAM_BOT_TOKEN` | ✅ Yes | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_API_ID` | ✅ Yes | API ID from [my.telegram.org](https://my.telegram.org) |
| `TELEGRAM_API_HASH` | ✅ Yes | API Hash from [my.telegram.org](https://my.telegram.org) |
| `SESSION_SECRET` | ✅ Yes | Any random 32+ character string |
| `PORT` | Auto | Injected by Koyeb/Replit — do NOT set manually |

---

## How to Get TERABOX_COOKIE

1. Open [terabox.com](https://www.terabox.com) in your browser and log in
2. Press `F12` → **Application** tab → **Cookies** → `www.terabox.com`
3. Copy the entire cookie string. The critical token is `ndus`. Your cookie string looks like:
   ```
   ndus=XXXXXXXXXX; csrfToken=YYYYYY; PANWEB=1; ...
   ```
4. Paste the full string as the value of `TERABOX_COOKIE`

> **Cookie expiry**: TeraBox sessions expire after ~30 days or if you log out. Run `/status` in the bot to check. When expired, log in again and update the cookie.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 24 |
| Framework | Express 5 |
| Bot library | grammY |
| MTProto | telegram (gramjs) |
| Browser automation | Playwright (Chromium) |
| Validation | Zod |
| Build | esbuild |
| Package manager | pnpm workspaces |

---

## How to Open Shell in Replit

The Shell is where you run commands directly.

**Steps:**
1. Open your Replit project
2. Look at the bottom panel — click the **"Shell"** tab (next to "Console" and "Output")
3. If you don't see it, click the **`+`** button in the bottom panel to add a new Shell tab
4. You now have a full terminal — type any command and press **Enter**

**Common commands:**
```bash
# Run the push-to-github script
bash push-to-github.sh

# Check server logs
cat /tmp/logs/*.log | tail -50

# Restart the API server
# (use the Replit workflow panel instead — click the ▶️ button)
```

---

## Local Development (on Replit)

The server runs automatically via the **"API Server"** workflow. No manual start needed.

```bash
# Typecheck the whole project
pnpm run typecheck

# Build the API server manually
pnpm --filter @workspace/api-server run build

# Check cookie health
curl http://localhost:80/api/terabox/cookie-status

# Resolve a TeraBox share (replace URL)
curl -s -X POST http://localhost:80/api/terabox/resolve \
  -H "Content-Type: application/json" \
  -d '{"url":"https://terasharefile.com/s/YOUR_SHARE_ID"}'
```

---

## Deploying on Koyeb

Koyeb is the recommended cloud host. It supports Docker and has a free tier.

### Step 1 — Push to GitHub

Open the Replit **Shell** tab and run:
```bash
bash push-to-github.sh
```

### Step 2 — Create a Koyeb account

Sign up at [koyeb.com](https://koyeb.com).

### Step 3 — Create a new App

1. Click **"Create App"**
2. Source: **GitHub** → select your repository
3. Build method: **Dockerfile** (auto-detected from `Dockerfile` in root)
4. Port: **8080**

### Step 4 — Set Environment Variables

In the Koyeb dashboard → your service → **Environment variables**:

| Key | Value |
|-----|-------|
| `TERABOX_COOKIE` | Full cookie string from your browser |
| `TELEGRAM_BOT_TOKEN` | `123456:ABC-DEF...` from @BotFather |
| `TELEGRAM_API_ID` | Numeric ID from my.telegram.org |
| `TELEGRAM_API_HASH` | Hash string from my.telegram.org |
| `SESSION_SECRET` | Any long random string |

> ⚠️ Do NOT add `PORT` — Koyeb sets it automatically.

### Step 5 — Deploy

Click **Deploy**. The first build takes 3–5 minutes (downloads Chromium). When done, logs will show:
```
Server listening  port: 8080
Telegram bot started (long polling)
```

### Keep-alive (free tier)

Koyeb's free tier sleeps after 5 minutes of no traffic. To keep the bot always awake, use [cron-job.org](https://cron-job.org) (free):
1. Create a new cron job
2. URL: `https://your-app.koyeb.app/api/healthz`
3. Interval: **every 5 minutes**

---

## Deploying on Other Platforms

The `Dockerfile` at the project root works on any Docker-compatible platform:

### Railway
1. Connect GitHub repo → Railway detects the Dockerfile automatically
2. Set the same 5 environment variables above
3. Deploy

### Render
1. New Web Service → Docker → connect GitHub repo
2. Set environment variables
3. Deploy (free tier available)

### VPS (any Linux server)
```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
docker build -t terabox-bot .
docker run -d \
  -e TERABOX_COOKIE="your_cookie" \
  -e TELEGRAM_BOT_TOKEN="your_token" \
  -e TELEGRAM_API_ID="your_api_id" \
  -e TELEGRAM_API_HASH="your_api_hash" \
  -e SESSION_SECRET="your_secret" \
  -e PORT=8080 \
  -p 8080:8080 \
  terabox-bot
```

---

## Architecture

```
pnpm monorepo
├── artifacts/
│   └── api-server/          # Main Express server + Telegram bot
│       └── src/
│           ├── lib/
│           │   ├── terabox.ts        # Playwright-based share resolver & dlink generator
│           │   ├── videoDownload.ts  # File download + ffmpeg thumbnail
│           │   ├── telegramClient.ts # MTProto direct-send (gramjs)
│           │   └── logger.ts         # Pino logger
│           ├── routes/
│           │   ├── terabox.ts        # REST API: /resolve, /download-link, /cookie-status
│           │   └── health.ts         # GET /healthz
│           └── telegram/
│               └── bot.ts            # grammY bot (commands + download flow)
├── lib/
│   ├── api-zod/             # Zod schemas for API validation
│   ├── api-client-react/    # Generated React Query hooks (Orval)
│   └── db/                  # Drizzle ORM schema
├── Dockerfile               # Production Docker image (Playwright base)
└── .dockerignore
```

### How a download works

```
User sends link
      │
      ▼
resolveShare()          — Playwright opens TeraBox, walks the file tree
      │
      ▼
[User picks file]
      │
      ▼
resolveDownload()       — Playwright selects file, clicks Download, captures signed dlink
      │
      ▼
downloadDlinkViaBrowser() — Playwright navigates to dlink URL (Chromium TLS fingerprint
      │                       bypasses CDN bot-detection), saves file to /tmp
      ▼
sendVideoDirect()       — gramjs MTProto uploads to Telegram (up to 1.9 GB)
  or Bot API send       — grammY sendVideo/sendPhoto/sendDocument (up to 50 MB)
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/healthz` | Health check (returns `{"status":"ok"}`) |
| `POST` | `/api/terabox/resolve` | Resolve a share link → file tree |
| `POST` | `/api/terabox/download-link` | Generate a signed dlink for file(s) |
| `GET` | `/api/terabox/cookie-status` | Check if TERABOX_COOKIE is still valid |

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Bot doesn't respond | TELEGRAM_BOT_TOKEN wrong | Check token in @BotFather |
| All links return 31045 | TERABOX_COOKIE expired | Get fresh cookie from browser, update env var |
| `/status` shows cookie invalid | Session logged out or expired | Log into terabox.com again, copy new cookie |
| Downloads time out | Share is too large / private | Try smaller shares; private shares aren't supported |
| "No download link" on ZIP | File batch exceeds account quota | Try fewer files at once |
| OOM crash on Koyeb free tier | 512 MB RAM too tight for Chromium | Upgrade to Eco plan ($3/mo, 2 GB RAM) |

---

## License

MIT — use freely, modify as needed.
