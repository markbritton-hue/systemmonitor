const express = require('express');
const axios = require('axios');
const ping = require('ping');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const EQUIPMENT_FILE = path.join(DATA_DIR, 'equipment.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const OUTAGES_FILE = path.join(DATA_DIR, 'outages.json');
const LOCKED_FILE = path.join(DATA_DIR, 'locked-accounts.json');
const DEFAULT_LOCKED_OU = 'OU=Centreville Users,OU=StJoeCMH,DC=stjoecmh,DC=org';
// ── Supabase sync ─────────────────────────────────────────────────────────────

async function syncToSupabase(deviceId) {
  const settings = loadSettings();
  const { supabaseUrl, supabaseKey } = settings;
  if (!supabaseUrl || !supabaseKey) return;

  const equipment = loadEquipment();
  const device = equipment.find(e => e.id === deviceId);
  const status = getStatus(deviceId);
  if (!device) return;

  const row = {
    id: deviceId,
    name: device.name,
    host: device.host || device.url,
    type: device.type,
    enabled: device.enabled,
    status: status.status,
    response_time: status.responseTime,
    last_check: status.lastCheck,
    last_change: status.lastChange,
    message: status.message,
    history: status.history || [],
    notify_after_minutes: device.notifyAfterMinutes || 0,
    notify_down_sent: status.notifyDownSent || false,
    slow_response: status.slowResponse || false,
    agent_heartbeat: new Date().toISOString(),
  };

  try {
    await axios.post(
      `${supabaseUrl}/rest/v1/devices`,
      row,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
      }
    );
  } catch (err) {
    console.error('Supabase sync error:', err.response?.data?.message || err.message);
  }
}

async function syncDeviceConfig(device) {
  const settings = loadSettings();
  const { supabaseUrl, supabaseKey } = settings;
  if (!supabaseUrl || !supabaseKey) return;
  const row = {
    id: device.id,
    name: device.name,
    host: device.host || device.url,
    type: device.type,
    enabled: device.enabled,
    ping_source: device.pingSource || 'local',
    agent_heartbeat: new Date().toISOString(),
  };
  try {
    await axios.post(`${supabaseUrl}/rest/v1/devices`, row, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
    });
  } catch (err) {
    console.error('Supabase config sync error:', err.message);
  }
}

async function pollCloudDevices() {
  const settings = loadSettings();
  const { supabaseUrl, supabaseKey } = settings;
  if (!supabaseUrl || !supabaseKey) return;
  const equipment = loadEquipment();
  const cloudDevices = equipment.filter(d => d.type === 'ping' && d.pingSource === 'cloud' && d.enabled);
  if (!cloudDevices.length) return;
  try {
    const ids = cloudDevices.map(d => `"${d.id}"`).join(',');
    const res = await axios.get(
      `${supabaseUrl}/rest/v1/devices?id=in.(${ids})&select=id,status,response_time,last_check,last_change,message,history`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    for (const row of res.data) {
      if (!row.status || row.status === 'unknown') continue;
      // Restore history into statusMap before calling updateStatus so it isn't lost
      const prev = statusMap[row.id];
      if (row.history && row.history.length) {
        if (!statusMap[row.id]) statusMap[row.id] = {};
        statusMap[row.id].history = row.history;
      } else if (prev && prev.history) {
        if (!statusMap[row.id]) statusMap[row.id] = {};
        statusMap[row.id].history = prev.history;
      }
      updateStatus(row.id, row.status, row.response_time, row.message || '');
      await syncToSupabase(row.id);
    }
  } catch (err) {
    console.error('Cloud device poll error:', err.message);
  }
}

async function deleteFromSupabase(deviceId) {
  const settings = loadSettings();
  const { supabaseUrl, supabaseKey } = settings;
  if (!supabaseUrl || !supabaseKey) return;
  try {
    await axios.delete(
      `${supabaseUrl}/rest/v1/devices?id=eq.${deviceId}`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
  } catch (err) {
    console.error('Supabase delete error:', err.message);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Data helpers ──────────────────────────────────────────────────────────────

function loadEquipment() {
  try {
    return JSON.parse(fs.readFileSync(EQUIPMENT_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveEquipment(list) {
  fs.writeFileSync(EQUIPMENT_FILE, JSON.stringify(list, null, 2));
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { ntfyTopic: '', ntfyServer: 'https://ntfy.sh', defaultInterval: 15 };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function loadOutages() {
  try {
    return JSON.parse(fs.readFileSync(OUTAGES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function appendOutage(deviceId, start, end) {
  const outages = loadOutages();
  outages.push({ deviceId, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  // Keep only last 90 days
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  fs.writeFileSync(OUTAGES_FILE, JSON.stringify(outages.filter(o => o.end >= cutoff), null, 2));
}

// ── In-memory status store ────────────────────────────────────────────────────

// { [id]: { status, responseTime, lastCheck, lastChange, message, history } }
const statusMap = {};
// { [id]: timerHandle }
const timers = {};

function getStatus(id) {
  return statusMap[id] || {
    id,
    status: 'unknown',
    responseTime: null,
    lastCheck: null,
    lastChange: null,
    message: 'Not checked yet',
    history: [],
  };
}

function updateStatus(id, newStatus, responseTime, message) {
  const prev = statusMap[id];
  const prevStatus = prev ? prev.status : 'unknown';
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const history = prev ? [...prev.history] : [];
  history.push({ ok: newStatus === 'up', ts: nowIso });
  if (history.length > 300) history.shift();

  const equipment = loadEquipment();
  const device = equipment.find(e => e.id === id);
  const thresholdMs = ((device && device.notifyAfterMinutes) || 0) * 60 * 1000;

  // Track when the device first went down this outage
  let downSince = prev ? prev.downSince : null;
  let notifyDownSent = prev ? prev.notifyDownSent : false;

  if (newStatus === 'down') {
    if (prevStatus !== 'down') {
      downSince = now;
      notifyDownSent = false;
    }
    if (!notifyDownSent && prevStatus !== 'unknown' && (now - downSince) >= thresholdMs) {
      notifyDownSent = true;
      sendNtfy(id, 'down');
    }
  } else if (newStatus === 'up') {
    if (prevStatus === 'down') {
      if (notifyDownSent) sendNtfy(id, 'up');
      if (downSince) appendOutage(id, downSince, now);
    }
    downSince = null;
    notifyDownSent = false;
  }

  // Track slow response time
  const rtThresholdMs = (device && device.responseTimeThresholdMs) || 0;
  const rtThresholdDurationMs = ((device && device.responseTimeThresholdMinutes) || 0) * 60 * 1000;
  let slowSince = prev ? prev.slowSince : null;
  let notifySlowSent = prev ? prev.notifySlowSent : false;
  let slowResponse = false;

  if (rtThresholdMs > 0 && newStatus === 'up' && responseTime != null && responseTime > rtThresholdMs) {
    if (!slowSince) {
      slowSince = now;
      notifySlowSent = false;
    }
    if (!notifySlowSent && (now - slowSince) >= rtThresholdDurationMs) {
      notifySlowSent = true;
      sendNtfy(id, 'slow');
    }
    slowResponse = true;
  } else {
    if (slowSince && notifySlowSent) sendNtfy(id, 'fast');
    slowSince = null;
    notifySlowSent = false;
    slowResponse = false;
  }

  statusMap[id] = {
    id,
    status: newStatus,
    responseTime,
    lastCheck: nowIso,
    lastChange: (prevStatus !== newStatus) ? nowIso : (prev ? prev.lastChange : nowIso),
    message,
    history,
    downSince,
    notifyDownSent,
    slowSince,
    notifySlowSent,
    slowResponse,
  };
}

// ── ntfy notifications ────────────────────────────────────────────────────────

async function sendNtfy(deviceId, newStatus) {
  const settings = loadSettings();
  const equipment = loadEquipment();
  const device = equipment.find(e => e.id === deviceId);
  if (!device) return;

  const topic = device.ntfyTopic || settings.ntfyTopic;
  if (!topic) return;

  const title = newStatus === 'up'   ? `${device.name} is BACK ONLINE`
    : newStatus === 'down' ? `${device.name} is OFFLINE`
    : newStatus === 'slow' ? `${device.name} response is SLOW`
    :                        `${device.name} response is BACK TO NORMAL`;
  const body = `Host: ${device.host || device.url}\nTime: ${new Date().toLocaleString()}`;

  await sendNtfyRaw(title, body, {
    topic,
    priority: (newStatus === 'down' || newStatus === 'slow') ? 'high' : 'default',
    tags: newStatus === 'down' ? 'rotating_light' : newStatus === 'slow' ? 'warning' : 'white_check_mark',
  });
}

// Low-level ntfy poster reused for device alerts and directory alerts
async function sendNtfyRaw(title, body, { topic, priority = 'default', tags = '' } = {}) {
  const settings = loadSettings();
  const dest = topic || settings.ntfyTopic;
  if (!dest) return;
  const server = settings.ntfyServer || 'https://ntfy.sh';
  const cloudUrl = 'https://markbritton-hue.github.io/systemmonitor/';
  try {
    await axios.post(`${server}/${dest}`, body, {
      headers: { Title: title, Priority: priority, Tags: tags, Click: cloudUrl },
    });
  } catch (err) {
    console.error(`ntfy send failed (${title}):`, err.message);
  }
}

// ── Locked AD accounts ────────────────────────────────────────────────────────

let lockedCache = { data: null, at: 0 };
const LOCKED_CACHE_MS = 5 * 60 * 1000;

function queryLockedAccounts(ouDn) {
  // Uses .NET DirectoryServices (built into Windows, no RSAT needed).
  // One-level scope: direct children of the OU only.
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ds = New-Object DirectoryServices.DirectorySearcher
  $ds.SearchRoot = [ADSI]("LDAP://" + ${JSON.stringify(ouDn)})
  $ds.SearchScope = 'OneLevel'
  $ds.PageSize = 1000
  $ds.Filter = '(&(objectCategory=person)(objectClass=user))'
  [void]$ds.PropertiesToLoad.AddRange(@('samaccountname','displayname','lockouttime','distinguishedname'))
  $locked = foreach ($r in $ds.FindAll()) {
    $u = $r.GetDirectoryEntry()
    $u.RefreshCache(@('msDS-User-Account-Control-Computed'))
    $c = [int]($u.Properties['msDS-User-Account-Control-Computed'][0])
    if ($c -band 0x10) {
      $lt = $r.Properties['lockouttime']
      $ltIso = $null
      if ($lt.Count -gt 0 -and [int64]$lt[0] -gt 0) { $ltIso = ([datetime]::FromFileTimeUtc([int64]$lt[0])).ToString('o') }
      [pscustomobject]@{
        sam = [string]$r.Properties['samaccountname'][0]
        name = [string]$r.Properties['displayname'][0]
        lockoutTime = $ltIso
      }
    }
  }
  @($locked) | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: err.message });
        const out = (stdout || '').trim();
        if (!out) return resolve({ accounts: [] });
        let parsed;
        try { parsed = JSON.parse(out); } catch { return resolve({ error: 'Could not parse AD query output' }); }
        if (parsed && parsed.error) return resolve({ error: parsed.error });
        const accounts = Array.isArray(parsed) ? parsed : [parsed];
        resolve({ accounts });
      });
  });
}

async function refreshLockedAccounts(force = false) {
  const settings = loadSettings();
  if (settings.lockedAccountsEnabled === false) {
    lockedCache = { data: { enabled: false }, at: Date.now() };
    return lockedCache.data;
  }
  if (!force && lockedCache.data && (Date.now() - lockedCache.at) < LOCKED_CACHE_MS) {
    return lockedCache.data;
  }
  const ou = settings.lockedAccountsOU || DEFAULT_LOCKED_OU;
  const res = await queryLockedAccounts(ou);
  const data = {
    enabled: true,
    ou,
    checkedAt: new Date().toISOString(),
    error: res.error || null,
    accounts: res.accounts || [],
  };
  lockedCache = { data, at: Date.now() };
  if (!res.error) notifyNewLockouts(data.accounts, ou);
  return data;
}

function loadKnownLocked() {
  try {
    return JSON.parse(fs.readFileSync(LOCKED_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function notifyNewLockouts(accounts, ou) {
  const prev = new Set(loadKnownLocked());
  const current = accounts.map(a => a.sam).filter(Boolean);
  for (const acct of accounts) {
    if (!acct.sam || prev.has(acct.sam)) continue;
    const body = `Account: ${acct.name || acct.sam} (${acct.sam})\nOU: ${ou}\nTime: ${new Date().toLocaleString()}`;
    sendNtfyRaw(`AD account LOCKED: ${acct.name || acct.sam}`, body, { priority: 'high', tags: 'lock' });
  }
  try {
    fs.writeFileSync(LOCKED_FILE, JSON.stringify(current, null, 2));
  } catch (err) {
    console.error('Could not write locked-accounts state:', err.message);
  }
}

// ── Cloud heartbeat check ─────────────────────────────────────────────────────

const CLOUD_HB_ID = 'cloud-dashboard';
const CLOUD_HB_MAX_MS = 2 * 60 * 1000; // 2 minutes

async function checkCloudHeartbeat() {
  const settings = loadSettings();
  const { supabaseUrl, supabaseKey } = settings;
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const res = await axios.get(
      `${supabaseUrl}/rest/v1/devices?id=eq.${CLOUD_HB_ID}&select=agent_heartbeat`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    const rows = res.data;
    const prev = statusMap[CLOUD_HB_ID];
    const history = prev ? [...prev.history] : [];
    let newStatus, message;
    if (!rows || !rows.length || !rows[0].agent_heartbeat) {
      newStatus = 'unknown';
      message = 'No heartbeat received yet';
    } else {
      const ageMs = Date.now() - new Date(rows[0].agent_heartbeat).getTime();
      const ageMin = Math.round(ageMs / 60000);
      newStatus = ageMs < CLOUD_HB_MAX_MS ? 'up' : 'down';
      message = newStatus === 'up' ? `Last seen ${ageMin}m ago` : `No heartbeat for ${ageMin}m`;
    }
    history.push({ ok: newStatus === 'up', ts: new Date().toISOString() });
    if (history.length > 300) history.shift();
    const nowIso = new Date().toISOString();
    statusMap[CLOUD_HB_ID] = {
      id: CLOUD_HB_ID,
      status: newStatus,
      responseTime: null,
      lastCheck: nowIso,
      lastChange: (prev && prev.status !== newStatus) ? nowIso : (prev ? prev.lastChange : nowIso),
      message,
      history,
    };
  } catch (err) {
    console.error('Cloud heartbeat check error:', err.message);
  }
}

// ── Check functions ───────────────────────────────────────────────────────────

async function checkPing(device) {
  const start = Date.now();
  try {
    const res = await ping.promise.probe(device.host, { timeout: 10 });
    const ms = res.time !== 'unknown' ? Math.round(res.time) : (Date.now() - start);
    if (res.alive) {
      updateStatus(device.id, 'up', ms, `Ping OK (${ms}ms)`);
    } else {
      updateStatus(device.id, 'down', null, 'Host unreachable');
    }
  } catch (err) {
    updateStatus(device.id, 'down', null, err.message);
  }
}

async function checkHttp(device) {
  const start = Date.now();
  try {
    const res = await axios.get(device.url, { timeout: 10000, validateStatus: s => s < 500 });
    const ms = Date.now() - start;
    if (res.status >= 200 && res.status < 400) {
      updateStatus(device.id, 'up', ms, `HTTP ${res.status} (${ms}ms)`);
    } else {
      updateStatus(device.id, 'down', ms, `HTTP ${res.status}`);
    }
  } catch (err) {
    updateStatus(device.id, 'down', null, err.message);
  }
}

async function checkService(device) {
  const start = Date.now();
  try {
    const res = await axios.get(device.url, { timeout: 10000, validateStatus: () => true });
    const ms = Date.now() - start;
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (res.status >= 200 && res.status < 400) {
      if (device.expectedContent && !body.includes(device.expectedContent)) {
        updateStatus(device.id, 'down', ms, `Response missing expected content`);
      } else {
        updateStatus(device.id, 'up', ms, `Service OK (${ms}ms)`);
      }
    } else {
      updateStatus(device.id, 'down', ms, `HTTP ${res.status}`);
    }
  } catch (err) {
    updateStatus(device.id, 'down', null, err.message);
  }
}

async function checkDevice(device, { forceLocal = false } = {}) {
  if (!device.enabled) return;
  if (device.type === 'ping' && device.pingSource === 'cloud' && !forceLocal) {
    await syncDeviceConfig(device);
    return;
  }
  switch (device.type) {
    case 'ping':    await checkPing(device);    break;
    case 'http':    await checkHttp(device);    break;
    case 'service': await checkService(device); break;
  }
  await syncToSupabase(device.id);
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function scheduleDevice(device) {
  if (timers[device.id]) {
    clearInterval(timers[device.id]);
    delete timers[device.id];
  }
  if (!device.enabled) return;

  // Run immediately then on interval
  checkDevice(device);
  timers[device.id] = setInterval(() => checkDevice(device), (device.intervalSeconds || 15) * 1000);
}

async function restoreDownSince() {
  const settings = loadSettings();
  const { supabaseUrl, supabaseKey } = settings;
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const res = await axios.get(
      `${supabaseUrl}/rest/v1/devices?status=eq.down&select=id,last_change,notify_down_sent`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    for (const row of res.data) {
      if (!row.last_change) continue;
      const downSince = new Date(row.last_change).getTime();
      statusMap[row.id] = {
        id: row.id,
        status: 'down',
        responseTime: null,
        lastCheck: null,
        lastChange: row.last_change,
        message: 'Restored from last known state',
        history: [],
        downSince,
        notifyDownSent: row.notify_down_sent || false,
      };
      console.log(`Restored downSince for ${row.id} from ${row.last_change} (notifyDownSent=${row.notify_down_sent})`);
    }
  } catch (err) {
    console.error('Could not restore down state from Supabase:', err.message);
  }
}

async function startMonitoring() {
  await restoreDownSince();
  const equipment = loadEquipment();
  equipment.forEach(scheduleDevice);
  console.log(`Monitoring ${equipment.length} device(s)`);
  checkCloudHeartbeat();
  setInterval(checkCloudHeartbeat, 20 * 1000);
  pollCloudDevices();
  setInterval(pollCloudDevices, 60 * 1000);
  refreshLockedAccounts(true).catch(err => console.error('Locked account check failed:', err.message));
  setInterval(() => refreshLockedAccounts(true).catch(err => console.error('Locked account check failed:', err.message)), 5 * 60 * 1000);
}

function rescheduleAll() {
  // Clear removed devices
  const equipment = loadEquipment();
  const ids = new Set(equipment.map(e => e.id));
  for (const id of Object.keys(timers)) {
    if (!ids.has(id)) {
      clearInterval(timers[id]);
      delete timers[id];
    }
  }
  equipment.forEach(scheduleDevice);
}

// ── API routes ────────────────────────────────────────────────────────────────

// Equipment CRUD
app.get('/api/equipment', (req, res) => {
  res.json(loadEquipment());
});

app.post('/api/equipment', (req, res) => {
  const list = loadEquipment();
  const settings = loadSettings();
  const device = {
    id: uuidv4(),
    name: req.body.name || 'Unnamed',
    host: req.body.host || '',
    type: req.body.type || 'ping',
    url: req.body.url || '',
    expectedContent: req.body.expectedContent || '',
    intervalSeconds: Number(req.body.intervalSeconds) || settings.defaultInterval || 15,
    notifyAfterMinutes: Number(req.body.notifyAfterMinutes) || 0,
    responseTimeThresholdMs: Number(req.body.responseTimeThresholdMs) || 0,
    responseTimeThresholdMinutes: Number(req.body.responseTimeThresholdMinutes) || 0,
    ntfyTopic: req.body.ntfyTopic || '',
    pingSource: req.body.pingSource || 'local',
    enabled: req.body.enabled !== false,
  };
  list.push(device);
  saveEquipment(list);
  scheduleDevice(device);
  res.json(device);
});

app.put('/api/equipment/:id', (req, res) => {
  const list = loadEquipment();
  const idx = list.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const updated = { ...list[idx], ...req.body, id: req.params.id };
  list[idx] = updated;
  saveEquipment(list);
  scheduleDevice(updated);
  res.json(updated);
});

app.delete('/api/equipment/:id', async (req, res) => {
  let list = loadEquipment();
  const exists = list.find(e => e.id === req.params.id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  list = list.filter(e => e.id !== req.params.id);
  saveEquipment(list);
  if (timers[req.params.id]) {
    clearInterval(timers[req.params.id]);
    delete timers[req.params.id];
  }
  delete statusMap[req.params.id];
  await deleteFromSupabase(req.params.id);
  res.json({ ok: true });
});

// Status
app.get('/api/status', (req, res) => {
  const equipment = loadEquipment();
  const result = equipment.map(e => ({ ...e, ...getStatus(e.id) }));
  // Append virtual cloud dashboard heartbeat device
  if (statusMap[CLOUD_HB_ID]) {
    result.push({
      id: CLOUD_HB_ID,
      name: 'Cloud Dashboard',
      type: 'cloud',
      host: 'GitHub Pages',
      enabled: true,
      ...statusMap[CLOUD_HB_ID],
    });
  }
  res.json(result);
});

// Immediate check
app.post('/api/check/:id', async (req, res) => {
  const list = loadEquipment();
  const device = list.find(e => e.id === req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  await checkDevice(device, { forceLocal: true });
  res.json(getStatus(device.id));
});

// ntfy test
app.post('/api/ntfy-test', async (req, res) => {
  const settings = loadSettings();
  const topic = settings.ntfyTopic;
  if (!topic) return res.status(400).json({ error: 'No ntfy topic configured' });
  const server = settings.ntfyServer || 'https://ntfy.sh';
  try {
    await axios.post(`${server}/${topic}`, `Test notification from System Monitor\nTime: ${new Date().toLocaleString()}`, {
      headers: {
        Title: '🔔 System Monitor — Test',
        Priority: 'default',
        Tags: 'bell',
      },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Settings
app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  const current = loadSettings();
  const updated = { ...current, ...req.body };
  saveSettings(updated);
  res.json(updated);
});

// Locked AD accounts
app.get('/api/locked-accounts', async (req, res) => {
  try {
    const data = await refreshLockedAccounts(req.query.force === '1');
    res.json(data);
  } catch (err) {
    res.status(500).json({ enabled: true, accounts: [], error: err.message });
  }
});

// Outage history
app.get('/api/outages', (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 14, 90);
  const cutoffMs = Date.now() - days * 86400000;

  const outages = loadOutages().filter(o => new Date(o.end).getTime() >= cutoffMs);

  // Include ongoing outages for currently-down devices
  for (const [id, s] of Object.entries(statusMap)) {
    if (s.status === 'down' && s.downSince) {
      outages.push({ deviceId: id, start: new Date(s.downSince).toISOString(), end: new Date().toISOString(), ongoing: true });
    }
  }

  // Aggregate ms-offline per device per local date, splitting outages that span midnight
  const summary = {};
  for (const o of outages) {
    if (!summary[o.deviceId]) summary[o.deviceId] = {};
    let cur = Math.max(new Date(o.start).getTime(), cutoffMs);
    const end = new Date(o.end).getTime();
    while (cur < end) {
      const d = new Date(cur);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const segEnd = Math.min(end, dayEnd);
      summary[o.deviceId][dateKey] = (summary[o.deviceId][dateKey] || 0) + (segEnd - cur);
      cur = dayEnd;
    }
  }

  const equipment = loadEquipment();
  const deviceNames = Object.fromEntries(equipment.map(e => [e.id, e.name]));
  res.json({ summary, deviceNames, days, events: outages });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`System Monitor running at http://localhost:${PORT}`);
  startMonitoring();
});
