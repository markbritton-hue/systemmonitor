# System Monitor

A network equipment monitoring app with a local agent and a cloud dashboard.

## What It Does

- **Pings and checks** network devices (ICMP ping, HTTP, service/API checks) on configurable intervals
- **Sends push notifications** to Android via [ntfy.sh](https://ntfy.sh) when a device goes down or recovers
- **Syncs status to Supabase** so a cloud dashboard can show live equipment status from anywhere
- **GitHub Pages dashboard** at https://markbritton-hue.github.io/systemmonitor/ with agent heartbeat monitoring
- **Cloud notifications** via GitHub Actions + cron-job.org when the local agent goes offline

---

## Architecture

```
Local Machine (Windows)
└── node server.js  (Express on port 3000)
    ├── Checks devices via ping / HTTP / axios
    ├── Stores device list in data/equipment.json
    ├── Sends ntfy.sh push notifications (device up/down)
    └── Syncs status → Supabase REST API

Cloud
├── Supabase (cdahcsbixbeicbkedvrf.supabase.co)
│   ├── devices table — latest status per device + agent heartbeat
│   └── meta table    — alert state (pause flag, last alert sent)
├── GitHub Pages (markbritton-hue.github.io/systemmonitor)
│   └── docs/index.html — polls Supabase every 15s, writes cloud heartbeat
├── GitHub Actions (.github/workflows/heartbeat-monitor.yml)
│   └── Checks agent heartbeat, sends ntfy if agent offline/recovered
└── cron-job.org
    └── Triggers GitHub Actions workflow every 5 minutes reliably
```

---

## Notification Flow

| Event | Who Sends It | Delay |
|---|---|---|
| Device down | Local agent (server.js) | After configurable threshold (default 0 min) |
| Device recovered | Local agent (server.js) | Immediate |
| Agent offline | GitHub Actions via cron-job.org | Up to 15 min (10 min stale threshold + 5 min cron gap) |
| Agent recovered | GitHub Actions via cron-job.org | Up to 5 min |

---

## Local Setup

### Prerequisites
- Node.js installed
- Run `npm install` in the project root

### Configuration

Edit `data/settings.json` (created automatically on first run):

```json
{
  "ntfyTopic": "your-ntfy-topic",
  "ntfyServer": "https://ntfy.sh",
  "defaultInterval": 60,
  "supabaseUrl": "https://your-project.supabase.co",
  "supabaseKey": "your-service-role-key"
}
```

Or configure everything through the Settings page in the UI.

### Start the Agent

```bash
node server.js
```

Dashboard available at http://localhost:3000. Accessible from other machines on the same network at `http://<your-ip>:3000`.

### Run on Startup (optional)

```powershell
npm install -g pm2
pm2 start C:\systemmonitor\server.js --name systemmonitor
pm2 startup
pm2 save
```

### Allow Network Access (Windows Firewall)

Run once in PowerShell as Administrator if accessing from other machines:

```powershell
New-NetFirewallRule -DisplayName "System Monitor" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

---

## Supabase Setup

Run this SQL in your Supabase SQL Editor once:

```sql
create table devices (
  id text primary key,
  name text,
  host text,
  type text,
  enabled boolean,
  status text,
  response_time integer,
  last_check timestamptz,
  last_change timestamptz,
  message text,
  history jsonb,
  notify_after_minutes integer default 0,
  notify_down_sent boolean default false,
  agent_heartbeat timestamptz
);

alter table devices enable row level security;
create policy "Public read" on devices for select using (true);
create policy "Service write" on devices for all using (true) with check (true);

create table meta (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

alter table meta enable row level security;
create policy "Service all" on meta for all using (true) with check (true);
```

---

## GitHub Actions Setup

The workflow at `.github/workflows/heartbeat-monitor.yml` checks the agent heartbeat every time it is triggered and sends ntfy alerts if the agent is offline.

### Required GitHub Secrets

Go to **GitHub repo → Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Your Supabase service_role key |
| `NTFY_TOPIC` | Your ntfy topic (e.g. `workassist-mark-2026`) |
| `NTFY_SERVER` | `https://ntfy.sh` |

### Alert Logic

- Agent heartbeat stale **> 10 minutes** → sends offline alert
- Agent comes back → sends recovery alert
- **1 hour cooldown** between repeat offline alerts to avoid spam
- Checks the `meta.monitoring_paused` flag — if `true`, skips all alerts

---

## cron-job.org Setup

GitHub's built-in scheduler is unreliable for frequent jobs. cron-job.org triggers the workflow on a true 5-minute schedule.

### Steps

1. Create a free account at **cron-job.org**
2. Generate a GitHub Personal Access Token:
   - **github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)**
   - Scope: `workflow` only
3. Create a new cronjob at cron-job.org:
   - **URL**: `https://api.github.com/repos/markbritton-hue/systemmonitor/actions/workflows/heartbeat-monitor.yml/dispatches`
   - **Schedule**: Every 5 minutes
   - **Method**: POST
   - **Headers**:
     - `Authorization: Bearer YOUR_GITHUB_TOKEN`
     - `Accept: application/vnd.github+json`
     - `Content-Type: application/json`
   - **Body**: `{"ref":"master"}`

---

## Pages

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Live status grid with sparklines and auto-refresh |
| Manage | `/manage.html` | Add, edit, delete monitored devices |
| Settings | `/settings.html` | ntfy push notification config |
| Cloud Dashboard | GitHub Pages URL | Public dashboard reading from Supabase |

---

## Device Check Types

| Type | How It Works |
|------|-------------|
| **Ping** | ICMP ping via `ping` package |
| **HTTP** | GET request — up if status 200–399 |
| **Service** | GET request + optional expected content string match |

---

## Cloud Dashboard Features

- Polls Supabase every 15 seconds
- **Local Agent panel** — green (online), yellow (late 3–10 min), red (offline >10 min)
- **Pause Alerts** button — stops GitHub Actions notifications without stopping monitoring
- **Test Alert** button — sends live ntfy notification with current equipment status
- Devices sorted: down → unknown → up

---

## Files

```
C:\systemmonitor\
├── server.js               # Express app + monitoring engine
├── package.json
├── README.md
├── .gitignore
├── .github\
│   └── workflows\
│       └── heartbeat-monitor.yml  # Agent offline alerts
├── data\
│   ├── equipment.json      # Device list (gitignored)
│   └── settings.json       # Credentials & config (gitignored)
├── public\
│   ├── index.html          # Local dashboard
│   ├── manage.html         # Equipment management
│   ├── settings.html       # Settings page
│   └── style.css           # Shared CSS design system
└── docs\
    └── index.html          # GitHub Pages cloud dashboard
```

---

## Deployment

The cloud dashboard auto-deploys via GitHub Pages from the `docs/` folder on the `master` branch. Push any change to `docs/index.html` and it goes live within a minute.
