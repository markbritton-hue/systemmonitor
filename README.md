# System Monitor

A network equipment monitoring app with a local agent and a cloud dashboard.

## What It Does

- **Pings and checks** network devices (ICMP ping, HTTP, service/API checks) on configurable intervals
- **Sends push notifications** to Android via [ntfy.sh](https://ntfy.sh) when a device goes down or recovers
- **Syncs status to Supabase** so a cloud dashboard can show live equipment status from anywhere
- **GitHub Pages dashboard** at https://markbritton-hue.github.io/systemmonitor/ with agent heartbeat monitoring

---

## Architecture

```
Local Machine (Windows)
└── node server.js  (Express on port 3000)
    ├── Checks devices via ping / HTTP / axios
    ├── Stores device list in data/equipment.json
    ├── Sends ntfy.sh push notifications
    └── Syncs status → Supabase REST API

Cloud
├── Supabase (cdahcsbixbeicbkedvrf.supabase.co)
│   └── devices table — holds latest status per device
└── GitHub Pages (markbritton-hue.github.io/systemmonitor)
    └── docs/index.html — polls Supabase every 15s
```

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

The dashboard is available at http://localhost:3000

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
```

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

## Notifications

Push notifications are sent via [ntfy.sh](https://ntfy.sh). Install the ntfy app on Android and subscribe to your topic.

Each device supports:
- **Global topic** — set in Settings
- **Per-device topic override**
- **Notify only after X minutes offline** — avoids alerts for brief outages

---

## Cloud Dashboard Features

- Polls Supabase every 15 seconds
- **Agent heartbeat** badge — green (<3 min), yellow (<10 min), red (>10 min stale)
- Warning banner when local agent hasn't reported in
- Devices sorted: down → unknown → up

---

## Files

```
C:\systemmonitor\
├── server.js               # Express app + monitoring engine
├── package.json
├── README.md
├── .gitignore
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
