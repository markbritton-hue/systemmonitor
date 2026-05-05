const express = require('express');
const axios = require('axios');
const ping = require('ping');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const EQUIPMENT_FILE = path.join(DATA_DIR, 'equipment.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'serviceAccountKey.json');

// ── Firebase Admin ────────────────────────────────────────────────────────────
let db = null;
try {
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    const admin = require('firebase-admin');
    const serviceAccount = require(SERVICE_ACCOUNT_FILE);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: 'systemmonitor-66641',
    });
    db = admin.firestore();
    console.log('Firebase connected — syncing to Firestore');
  } else {
    console.log('No serviceAccountKey.json found — running without Firebase sync');
  }
} catch (err) {
  console.error('Firebase init failed:', err.message);
}

async function syncToFirestore(deviceId) {
  if (!db) return;
  try {
    const equipment = loadEquipment();
    const device = equipment.find(e => e.id === deviceId);
    const status = getStatus(deviceId);
    if (!device) return;
    await db.collection('devices').doc(deviceId).set({
      id: deviceId,
      name: device.name,
      host: device.host || device.url,
      type: device.type,
      enabled: device.enabled,
      status: status.status,
      responseTime: status.responseTime,
      lastCheck: status.lastCheck,
      lastChange: status.lastChange,
      message: status.message,
      history: status.history || [],
      notifyAfterMinutes: device.notifyAfterMinutes || 0,
      notifyDownSent: status.notifyDownSent || false,
      agentHeartbeat: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Firestore sync error:', err.message);
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
    return { ntfyTopic: '', ntfyServer: 'https://ntfy.sh', defaultInterval: 60 };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
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
  history.push(newStatus === 'up');
  if (history.length > 10) history.shift();

  const equipment = loadEquipment();
  const device = equipment.find(e => e.id === id);
  const thresholdMs = ((device && device.notifyAfterMinutes) || 0) * 60 * 1000;

  // Track when the device first went down this outage
  let downSince = prev ? prev.downSince : null;
  let notifyDownSent = prev ? prev.notifyDownSent : false;

  if (newStatus === 'down') {
    if (prevStatus !== 'down') {
      // Freshly went down — start the clock
      downSince = now;
      notifyDownSent = false;
    }
    // Send alert only once the threshold is exceeded (0 = immediately)
    if (!notifyDownSent && prevStatus !== 'unknown' && (now - downSince) >= thresholdMs) {
      notifyDownSent = true;
      sendNtfy(id, 'down');
    }
  } else if (newStatus === 'up') {
    if (prevStatus === 'down' && notifyDownSent) {
      // Only send recovery if we actually sent a down alert
      sendNtfy(id, 'up');
    }
    downSince = null;
    notifyDownSent = false;
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

  const server = settings.ntfyServer || 'https://ntfy.sh';
  const emoji = newStatus === 'up' ? '✅' : '🔴';
  const title = `${emoji} ${device.name} is ${newStatus.toUpperCase()}`;
  const body = `Host: ${device.host || device.url}\nTime: ${new Date().toLocaleString()}`;

  try {
    await axios.post(`${server}/${topic}`, body, {
      headers: {
        Title: title,
        Priority: newStatus === 'down' ? 'urgent' : 'default',
        Tags: newStatus === 'down' ? 'rotating_light' : 'white_check_mark',
      },
    });
  } catch (err) {
    console.error(`ntfy send failed for ${device.name}:`, err.message);
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

async function checkDevice(device) {
  if (!device.enabled) return;
  switch (device.type) {
    case 'ping':    await checkPing(device);    break;
    case 'http':    await checkHttp(device);    break;
    case 'service': await checkService(device); break;
  }
  await syncToFirestore(device.id);
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
  timers[device.id] = setInterval(() => checkDevice(device), (device.intervalSeconds || 60) * 1000);
}

function startMonitoring() {
  const equipment = loadEquipment();
  equipment.forEach(scheduleDevice);
  console.log(`Monitoring ${equipment.length} device(s)`);
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
    intervalSeconds: Number(req.body.intervalSeconds) || settings.defaultInterval || 60,
    notifyAfterMinutes: Number(req.body.notifyAfterMinutes) || 0,
    ntfyTopic: req.body.ntfyTopic || '',
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
  // Remove from Firestore
  if (db) {
    try { await db.collection('devices').doc(req.params.id).delete(); } catch {}
  }
  res.json({ ok: true });
});

// Status
app.get('/api/status', (req, res) => {
  const equipment = loadEquipment();
  const result = equipment.map(e => ({ ...e, ...getStatus(e.id) }));
  res.json(result);
});

// Immediate check
app.post('/api/check/:id', async (req, res) => {
  const list = loadEquipment();
  const device = list.find(e => e.id === req.params.id);
  if (!device) return res.status(404).json({ error: 'Not found' });
  await checkDevice(device);
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

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`System Monitor running at http://localhost:${PORT}`);
  startMonitoring();
});
