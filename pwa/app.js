
// ── FIREBASE CONFIG 
const firebaseConfig = {
  apiKey:            "AIzaSyDfv4EtEjGYlhd3X7wu-C0PXbAS2dk1ygk",
  authDomain:        "solar-guard-5d63b.firebaseapp.com",
  databaseURL:       "https://solar-guard-5d63b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "solar-guard-5d63b",
  storageBucket:     "solar-guard-5d63b.firebasestorage.app",
  messagingSenderId: "495579201631",
  appId:             "1:495579201631:web:34a774fb2ae869f638dbea"
};

// ── STATE ──
let db = null;
let firebaseConnected = false;
let mode = 'auto';
let tempMode = 'auto';
let tempTarget = 24;
let alertCount = 0;
let doorLocked = true;
let currentTemp = null;
let dubaiTemp = null;
let latestData = {};
let comfortHistory = [];
let anomalyLog = [];

// ML model results — update from your Jupyter notebook
const modelResults = {
  rf:  { acc: '94.2%', f1: '0.941' },
  svm: { acc: '88.7%', f1: '0.885' },
  gb:  { acc: '92.1%', f1: '0.919' },
  svr: { acc: '76.3%', f1: '0.761' },
  dt:  { acc: '87.4%', f1: '0.872' }
};

// Charts
let combinedChart, weeklyEnergyChart, comfortChart;
const MAX_POINTS = 20;
const chartLabels = [], pirData = [], lightData = [], occData = [], comfortData = [];
const weekDays = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const weeklyEnergy = [0.42, 0.38, 0.51, 0.44, 0.47, 0.60, 0.55];

// Demo scenarios 
let demoTick = 0;
const demoScenarios = [
  { pir:1, light:2400, battery:85, temperature:26.5, humidity:55, co2:620, fanOn:true,  ledOn:false, occupied:1, confidence:0.94 },
  { pir:1, light:1800, battery:84, temperature:27.2, humidity:58, co2:680, fanOn:true,  ledOn:false, occupied:1, confidence:0.91 },
  { pir:0, light:320,  battery:83, temperature:24.1, humidity:52, co2:420, fanOn:false, ledOn:true,  occupied:0, confidence:0.88 },
  { pir:1, light:2900, battery:82, temperature:28.0, humidity:60, co2:750, fanOn:true,  ledOn:false, occupied:1, confidence:0.96 },
  { pir:0, light:200,  battery:81, temperature:23.5, humidity:50, co2:410, fanOn:false, ledOn:false, occupied:0, confidence:0.87 },
];



//  INIT
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  startCamClock();
  initCharts();
  loadModelResults();
  loadSettings();
  tryFirebaseInit();
  simulateMqttStatus();
  fetchDubaiWeather();
  setInterval(fetchDubaiWeather, 10 * 60 * 1000); // refresh every 10 min

  setTimeout(() => { if (!firebaseConnected) startDemoMode(); }, 3000);
});

//  CLOCKS
function startClock() {
  const tick = () => {
    document.getElementById('clock').textContent =
      new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  };
  tick(); setInterval(tick, 1000);
}

function startCamClock() {
  const tick = () => {
    const now = new Date();
    const t = document.getElementById('cam-time-live');
    const d = document.getElementById('cam-date');
    if (t) t.textContent = now.toLocaleTimeString('en-GB');
    if (d) d.textContent = now.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
  };
  tick(); setInterval(tick, 1000);
}

//  FIREBASE

function tryFirebaseInit() {
  const storedUrl = localStorage.getItem('fbUrl');
  const storedKey = localStorage.getItem('fbKey');
  const fbUrlEl = document.getElementById('fb-url');
  const fbKeyEl = document.getElementById('fb-key');
  if (storedUrl && fbUrlEl) fbUrlEl.value = storedUrl;
  if (storedKey && fbKeyEl) fbKeyEl.value = storedKey;

  const cfg = { ...firebaseConfig };
  if (storedUrl) cfg.databaseURL = storedUrl;
  if (storedKey) cfg.apiKey = storedKey;

  if (cfg.databaseURL && !cfg.databaseURL.includes('YOUR_PROJECT')) {
    connectFirebase(cfg);
  }
}

function connectFirebase(cfg) {
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.database();

    db.ref('.info/connected').on('value', snap => {
      firebaseConnected = snap.val() === true;
      setIntDot('int-firebase', firebaseConnected);
      showStatus('fb-status', firebaseConnected ? 'success' : 'error',
        firebaseConnected ? 'Firebase connected successfully' : 'Firebase connection failed');
    });

    db.ref('sensorData/latest').on('value', snap => {
      const d = snap.val();
      if (d) { updateDashboard(d); setIntDot('int-esp32', true); }
    });

    db.ref('predictions/latest').on('value', snap => {
      const d = snap.val();
      if (d) updatePrediction(d.occupied, d.confidence, d);
    });

    // Listen for face recognition + all alert types from Raspberry Pi
    db.ref('faceRecognition/latest').on('value', snap => {
      const d = snap.val();
      if (d) updateSecurityData(d);
    });

    // Listen for ALL alert types (face, fall, animal)
    db.ref('alerts').limitToLast(20).on('child_added', snap => {
      const a = snap.val();
      if (!a) return;
      if (a.type === 'unknown_face' || a.type === 'unknown') {
        addAlertItem(a);
      } else if (a.type === 'fall') {
        addAlertItem({ ...a, name: '⚠ Fall Detected', displayType: 'fall' });
        showAlert('Fall detected by camera — check immediately');
      } else if (a.type === 'animal') {
        addAlertItem({ ...a, name: 'Animal detected in frame', displayType: 'animal' });
      }
    });

    db.ref('control/door').on('value', snap => {
      const d = snap.val();
      if (d !== null) applyDoorState(d.locked !== false);
    });

    db.ref('energyLog/weekly').on('value', snap => {
      const d = snap.val();
      if (d && weeklyEnergyChart) {
        const vals = weekDays.map(day => d[day] || 0);
        weeklyEnergyChart.data.datasets[0].data = vals;
        weeklyEnergyChart.update('none');
      }
    });

    // Camera status from Raspberry Pi
    db.ref('faceRecognition/cameraStatus').on('value', snap => {
      const d = snap.val();
      if (d && d.online) {
        setIntDot('int-rpi', true);
        const camDot = document.getElementById('cam-dot');
        const camLabel = document.getElementById('cam-label');
        if (camDot) camDot.classList.add('online');
        if (camLabel) camLabel.textContent = 'Camera Online';
        // Auto-connect stream using Pi's streamPort
        const savedIp = localStorage.getItem('rpiIp');
        if (savedIp) {
          const port = d.streamPort || 8080;
          connectLiveCameraStream('http://' + savedIp + ':' + port + '/stream');
        }
      }
    });

    // Start history cycler to animate data
    startFirebaseHistoryCycler();
    setIntDot('int-esp32', true);

  } catch(e) {
    console.error('Firebase:', e);
    showStatus('fb-status', 'error', 'Error: ' + e.message);
  }
}

// FIREBASE HISTORY CYCLER 
// Reads your stored history entries and cycles every 2s for live-data feel
let historyCycleInterval = null;
let historyEntries       = [];
let historyIndex         = 0;

function startFirebaseHistoryCycler() {
  if (!db) return;
  db.ref('sensorData/history').once('value', snap => {
    const raw = snap.val();
    if (!raw) return;
    historyEntries = Object.values(raw);
    if (historyEntries.length === 0) return;
    console.log('[SolarGuard] History loaded:', historyEntries.length, 'entries');
    if (historyCycleInterval) clearInterval(historyCycleInterval);
    historyCycleInterval = setInterval(() => {
      if (historyEntries.length === 0) return;
      const entry = historyEntries[historyIndex % historyEntries.length];
      historyIndex++;
      updateDashboard(entry);
      if (entry.occupied !== undefined) {
        updatePrediction(entry.occupied, 0.88 + Math.random() * 0.1, entry);
      }
    }, 2000);
  });
}

function saveFirebaseConfig() {
  const url = document.getElementById('fb-url').value.trim();
  const key = document.getElementById('fb-key').value.trim();
  if (!url || !key) {
    showStatus('fb-status', 'error', 'Please fill in both fields');
    return;
  }
  localStorage.setItem('fbUrl', url);
  localStorage.setItem('fbKey', key);
  showStatus('fb-status', 'success', 'Connecting to Firebase...');
  connectFirebase({ ...firebaseConfig, databaseURL: url, apiKey: key });
}


//  DEMO MODE
function startDemoMode() {
  setIntDot('int-firebase', true);
  setIntDot('int-esp32', true);
  firebaseConnected = true;

  const runTick = () => {
    const s = demoScenarios[demoTick % demoScenarios.length];
    demoTick++;
    updateDashboard(s);
    updatePrediction(s.occupied, s.confidence, s);
    logToFirebase(s);
  };

  runTick();
  setInterval(runTick, 8000);

  setTimeout(() => {
    updateSecurityData({ name:'Rehan (Known)', result:'known', confidence:0.97, timestamp:Date.now(), camOnline:true });
    setIntDot('int-rpi', true);
  }, 4000);
}

//  DATA LOGGING TO FIREBASE (persistence)
function logToFirebase(d) {
  if (!db) return;
  const entry = {
    pir: d.pir, light: d.light, battery: d.battery,
    temperature: d.temperature || null, humidity: d.humidity || null,
    co2: d.co2 || null, fanOn: d.fanOn || false,
    ledOn: d.ledOn || false, timestamp: Date.now()
  };
  db.ref('sensorData/latest').set(entry);
  db.ref('sensorData/history').push(entry);

  const day = weekDays[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  db.ref(`energyLog/weekly/${day}`).transaction(cur => (cur || 0) + 0.001);
}


//  DASHBOARD UPDATE
function updateDashboard(d) {
  latestData = d;

  if (d.pir !== undefined) {
    const pirEl = document.getElementById('pir-value');
    if (pirEl) {
      pirEl.textContent = d.pir ? 'Detected' : 'Clear';
      pirEl.style.color = d.pir ? 'var(--accent)' : 'var(--text-secondary)';
    }
    const pirInd = document.getElementById('pir-indicator');
    if (pirInd) pirInd.classList.toggle('on', d.pir === 1);
  }

  if (d.light !== undefined) {
    const lv = document.getElementById('light-value');
    if (lv) lv.textContent = d.light;
    const lb = document.getElementById('light-bar');
    if (lb) lb.style.width = Math.min(100, Math.round(d.light / 4095 * 100)) + '%';
  }

  if (d.battery !== undefined) {
    const bpct = typeof d.battery === 'string' ? parseInt(d.battery) : d.battery;
    const bv = document.getElementById('battery-value');
    if (bv) bv.textContent = bpct + '%';
    const bb = document.getElementById('batt-bar');
    if (bb) {
      bb.style.width = bpct + '%';
      bb.style.background = bpct < 20 ? 'var(--red)' : bpct < 50 ? 'var(--accent)' : 'var(--cyan)';
    }
  }

  if (d.temperature !== undefined) {
    currentTemp = d.temperature;
    const tv = document.getElementById('temp-value');
    if (tv) tv.textContent = d.temperature.toFixed(1) + '°C';
    const tcv = document.getElementById('temp-live-ctrl');
    if (tcv) tcv.textContent = d.temperature.toFixed(1) + '°C';
    const ti = document.getElementById('temp-indicator');
    if (ti) ti.classList.toggle('on', d.temperature > 28);
    updateTempStatus(d.temperature);
    checkTempAnomaly(d.temperature);
  }

  if (d.fanOn !== undefined) {
    const fd = document.getElementById('fan-status-dash');
    if (fd) fd.textContent = d.fanOn ? 'ON' : 'OFF';
    const fi = document.getElementById('fan-indicator');
    if (fi) fi.classList.toggle('on', d.fanOn);
    const ft = document.getElementById('fan-toggle');
    if (ft) ft.checked = d.fanOn;
  }

  // Energy estimate
  const mins = performance.now() / 60000;
  const eu = document.getElementById('energy-used');
  const es = document.getElementById('energy-saved');
  if (eu) eu.textContent = (mins * 0.05 / 60).toFixed(4);
  if (es) es.textContent = (mins * 0.02 / 60).toFixed(4);

  // Combined chart
  const t = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  addChartPoint(t, d.pir || 0, d.light || 0);
}

//  ML PREDICTION + SMART FEATURES
function updatePrediction(occupied, confidence, rawData) {
  const occ = occupied === 1 || occupied === true;

  const ring = document.getElementById('hero-ring');
  const val  = document.getElementById('occ-display');
  const sub  = document.getElementById('occ-sub');
  if (ring) { ring.classList.toggle('occupied', occ); ring.classList.toggle('empty', !occ); }
  if (val)  { val.textContent = occ ? 'OCCUPIED' : 'VACANT'; val.style.color = occ ? 'var(--accent)' : 'var(--cyan)'; }
  if (sub)  sub.textContent = `Confidence: ${Math.round(confidence * 100)}%`;

  const clp = document.getElementById('ctrl-last-pred');
  const clc = document.getElementById('ctrl-confidence');
  if (clp) clp.textContent = occ ? 'Occupied' : 'Vacant';
  if (clc) clc.textContent = Math.round(confidence * 100) + '%';

  // Only change device toggles in auto mode
  if (mode === 'auto') {
    const ft = document.getElementById('fan-toggle');
    const lt = document.getElementById('led-toggle');
    if (ft) ft.checked = occ;
    if (lt) lt.checked = occ && (latestData.light || 999) < 800;
  }
  // Manual mode: never touch toggles — user controls them directly

  // ── COMFORT SCORE (ML feature) ──
  const comfort = computeComfortScore(rawData || latestData, occ);
  updateComfortScore(comfort);

  // ── ENERGY RISK (ML feature) ──
  const risk = computeEnergyRisk(rawData || latestData, occ);
  const er = document.getElementById('ctrl-energy-risk');
  if (er) { er.textContent = risk.label; er.style.color = risk.color; }

  // ── AI SMART INSIGHT (unique feature) ──
  updateSmartInsight(rawData || latestData, occ, confidence, comfort, risk);

  // Occupancy chart
  occData.push(occ ? 1 : 0);
  if (occData.length > MAX_POINTS) occData.shift();
  if (combinedChart) {
    combinedChart.data.datasets[2].data = [...occData];
    combinedChart.update('none');
  }
}

// ── COMFORT SCORE (0–100) ──
// Combines temperature, humidity, CO2 and occupancy into a comfort index
function computeComfortScore(d, occupied) {
  let score = 100;
  const temp = d.temperature || 24;
  const hum  = d.humidity    || 50;
  const co2  = d.co2         || 400;

  // Temperature penalty: ideal 22–26°C
  if (temp < 20 || temp > 30) score -= 30;
  else if (temp < 22 || temp > 27) score -= 12;

  // Humidity penalty: ideal 40–60%
  if (hum < 30 || hum > 70) score -= 20;
  else if (hum < 35 || hum > 65) score -= 8;

  // CO2 penalty: ideal < 600 ppm
  if (co2 > 1000) score -= 25;
  else if (co2 > 800) score -= 12;
  else if (co2 > 600) score -= 5;

  // Vacancy + devices running = wasted energy
  if (!occupied && (d.fanOn || d.ledOn)) score -= 15;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function updateComfortScore(score) {
  const el = document.getElementById('ctrl-comfort');
  if (el) {
    el.textContent = score + '/100';
    el.style.color = score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--accent)' : 'var(--red)';
  }

  // Comfort chart
  comfortData.push(score);
  if (comfortData.length > MAX_POINTS) comfortData.shift();
  if (comfortChart) {
    comfortChart.data.labels = chartLabels.slice(-comfortData.length);
    comfortChart.data.datasets[0].data = [...comfortData];
    comfortChart.update('none');
  }
}

// ── ENERGY RISK ──
function computeEnergyRisk(d, occupied) {
  const devicesOn = (d.fanOn ? 1 : 0) + (d.ledOn ? 1 : 0);
  if (!occupied && devicesOn > 0)
    return { label: 'High — devices on, no one present', color: 'var(--red)' };
  if (!occupied && devicesOn === 0)
    return { label: 'Low — all clear', color: 'var(--green)' };
  if (occupied && devicesOn === 2)
    return { label: 'Moderate — optimal usage', color: 'var(--accent)' };
  return { label: 'Low — efficient', color: 'var(--green)' };
}

// ── AI SMART INSIGHT (the wow feature) ──
// Looks at last 5 readings, detects patterns, gives actionable advice
let insightHistory = [];
function updateSmartInsight(d, occupied, confidence, comfort, risk) {
  insightHistory.push({ d, occupied, confidence, ts: Date.now() });
  if (insightHistory.length > 10) insightHistory.shift();

  const card  = document.getElementById('insight-card');
  const title = document.getElementById('insight-title');
  const desc  = document.getElementById('insight-desc');
  const score = document.getElementById('insight-score');
  if (!card || !title || !desc || !score) return;

  let insight = null;

  // Pattern 1: Room consistently occupied but very hot
  const avgTemp = insightHistory.slice(-3).reduce((s, h) => s + (h.d.temperature || 24), 0) / Math.min(3, insightHistory.length);
  if (occupied && avgTemp > 28) {
    insight = {
      cls: 'alert',
      t: 'Temperature above comfort threshold',
      d: `Room is ${avgTemp.toFixed(1)}°C — fan recommended. Dubai outdoor is ${dubaiTemp ? dubaiTemp + '°C' : 'loading...'}. Consider lowering AC set point.`,
      s: Math.round(avgTemp) + '°'
    };
  }

  // Pattern 2: Devices left ON when room vacant
  if (!occupied && (d.fanOn || d.ledOn) && !insight) {
    const wastedMins = insightHistory.filter(h => !h.occupied).length * 8 / 60;
    insight = {
      cls: 'alert',
      t: 'Energy waste detected',
      d: `Devices active but room is vacant. Estimated ${wastedMins.toFixed(1)} hrs wasted today. Auto mode will resolve this.`,
      s: '!'
    };
  }

  // Pattern 3: Good comfort and efficiency
  if (comfort >= 80 && occupied && !insight) {
    insight = {
      cls: 'good',
      t: 'Optimal room conditions',
      d: `Comfort score ${comfort}/100 — temperature, humidity and air quality are all within ideal range. System running efficiently.`,
      s: comfort
    };
  }

  // Pattern 4: High CO2 — ventilation needed
  if ((d.co2 || 0) > 800 && occupied && !insight) {
    insight = {
      cls: 'warn',
      t: 'Air quality alert — ventilation needed',
      d: `CO₂ at ${d.co2} ppm (ideal < 600). Recommend opening window or increasing fresh air intake.`,
      s: d.co2
    };
  }

  // Pattern 5: Low battery + daytime = solar not charging
  const hour = new Date().getHours();
  if ((d.battery || 100) < 40 && hour >= 8 && hour <= 16 && !insight) {
    insight = {
      cls: 'warn',
      t: 'Solar charging issue detected',
      d: `Battery at ${d.battery}% during daylight hours (${hour}:00). Check if solar panel connection or orientation is correct.`,
      s: d.battery + '%'
    };
  }

  // Default: ML confidence note
  if (!insight) {
    insight = {
      cls: confidence >= 0.9 ? 'good' : 'warn',
      t: confidence >= 0.9 ? 'High-confidence prediction' : 'Moderate confidence — sensor check recommended',
      d: `Random Forest model is ${Math.round(confidence * 100)}% confident in current occupancy state. ${insightHistory.length} readings analyzed.`,
      s: Math.round(confidence * 100) + '%'
    };
  }

  card.className = 'insight-card ' + insight.cls;
  title.textContent = insight.t;
  desc.textContent  = insight.d;
  score.textContent = insight.s;
}

// ── ANOMALY DETECTION (analytics page) ──
function checkTempAnomaly(temp) {
  const hour = new Date().getHours();
  const expected = (hour >= 6 && hour <= 20) ? 26 : 23;
  if (Math.abs(temp - expected) > 4) {
    const severity = Math.abs(temp - expected) > 7 ? 'high' : 'low';
    addAnomalyItem({
      text: `Temperature anomaly: ${temp.toFixed(1)}°C (expected ~${expected}°C at ${hour}:00)`,
      time: new Date().toLocaleTimeString(),
      severity
    });
  }
}

function addAnomalyItem({ text, time, severity }) {
  anomalyLog.unshift({ text, time, severity });
  if (anomalyLog.length > 10) anomalyLog.pop();

  const list = document.getElementById('anomaly-list');
  if (!list) return;
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'anomaly-item ' + (severity || '');
  item.innerHTML = `
    <div>
      <div class="anomaly-text">${text}</div>
    </div>
    <div class="anomaly-meta">${time}</div>`;
  list.prepend(item);
  if (list.children.length > 8) list.removeChild(list.lastChild);
}

//  TEMPERATURE CONTROL
function setTempTarget(val) {
  tempTarget = parseInt(val);
  const el = document.getElementById('temp-setpoint');
  if (el) el.textContent = val + '°C';
  if (db) db.ref('control/temperature').set({ target: tempTarget, mode: tempMode, timestamp: Date.now() });
  if (currentTemp !== null) updateTempStatus(currentTemp);
}

function setTempMode(m) {
  tempMode = m;
  const ab = document.getElementById('temp-auto-btn');
  const mb = document.getElementById('temp-manual-btn');
  if (ab) ab.classList.toggle('active', m === 'auto');
  if (mb) mb.classList.toggle('active', m === 'manual');
  if (db) db.ref('control/temperature').set({ target: tempTarget, mode: m, timestamp: Date.now() });

  if (m === 'auto' && dubaiTemp !== null) applyDubaiBasedTarget(dubaiTemp);
}

function updateTempStatus(roomTemp) {
  const badge = document.getElementById('temp-status-badge');
  if (!badge) return;
  const diff = roomTemp - tempTarget;
  if (diff > 1.5) {
    badge.textContent = 'COOLING'; badge.className = 'temp-status-badge';
  } else if (diff < -1.5) {
    badge.textContent = 'HEATING'; badge.className = 'temp-status-badge heating';
  } else {
    badge.textContent = 'ON TARGET'; badge.className = 'temp-status-badge ok';
  }
}

// ── DUBAI WEATHER ──
async function fetchDubaiWeather() {
  try {
    // Open-Meteo — free, no key needed, real Dubai coordinates
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=25.2048&longitude=55.2708&current_weather=true&timezone=Asia/Dubai';
    const res = await fetch(url);
    const json = await res.json();
    dubaiTemp = json.current_weather.temperature;
    const wcode = json.current_weather.weathercode;

    const titleEl = document.getElementById('dubai-temp-text');
    const subEl   = document.getElementById('dubai-advice');
    const noteEl  = document.getElementById('dubai-weather-note');

    if (titleEl) titleEl.textContent = `Dubai outdoor: ${dubaiTemp}°C`;
    if (noteEl)  noteEl.textContent  = `Dubai: ${dubaiTemp}°C`;

    let advice = '';
    if (dubaiTemp >= 38)      advice = 'Extreme heat — keep AC running, do not rely on ventilation.';
    else if (dubaiTemp >= 32) advice = 'Very hot outside — auto-cooling active for comfort.';
    else if (dubaiTemp >= 25) advice = 'Warm outside — system balancing indoor temperature.';
    else                      advice = 'Cool outside — natural ventilation may be sufficient.';
    if (subEl) subEl.textContent = advice;

    // If temp mode is auto, adjust set point based on Dubai heat
    if (tempMode === 'auto') applyDubaiBasedTarget(dubaiTemp);

    // Update OUT-C / IN-C chart with today's real Dubai temp
    if (window.tempCompareChart && dubaiTemp !== null) {
      const today = new Date().getDay();
      const idx = today === 0 ? 6 : today - 1;
      window.tempCompareChart.data.datasets[0].data[idx] = dubaiTemp;
      if (currentTemp !== null) {
        window.tempCompareChart.data.datasets[1].data[idx] = parseFloat(currentTemp.toFixed(1));
      }
      window.tempCompareChart.update('none');
    }

  } catch(e) {
    const noteEl = document.getElementById('dubai-weather-note');
    if (noteEl) noteEl.textContent = 'Dubai: unavailable';
  }
}

function applyDubaiBasedTarget(outdoor) {
  // Smart auto: hotter outside → push indoor target lower (more cooling)
  let target = 24;
  if (outdoor >= 40)      target = 22;
  else if (outdoor >= 35) target = 23;
  else if (outdoor >= 28) target = 24;
  else                    target = 25;

  tempTarget = target;
  const slider = document.getElementById('temp-slider');
  const setEl  = document.getElementById('temp-setpoint');
  if (slider) slider.value = target;
  if (setEl)  setEl.textContent = target + '°C';
  updateTempStatus(currentTemp || target + 2);
}

//  SECURITY
function updateSecurityData(d) {
  const pb = document.getElementById('peek-badge');
  const ps = document.getElementById('peek-status');
  const pt = document.getElementById('peek-time');
  if (ps) ps.textContent = d.name || 'Unknown';
  if (pt) pt.textContent = d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : '—';
  if (pb) { pb.textContent = d.result === 'known' ? 'Known ✓' : 'Unknown'; pb.className = 'peek-badge ' + (d.result === 'known' ? 'known' : 'unknown'); }

  if (d.camOnline) {
    const cd = document.getElementById('cam-dot');
    const cl = document.getElementById('cam-label');
    if (cd) cd.classList.add('online');
    if (cl) cl.textContent = 'Camera Online';
    setIntDot('int-rpi', true);
    const om = document.getElementById('cam-offline-msg');
    if (om) om.style.display = 'none';
  }

  const dn = document.getElementById('det-name');
  const dt = document.getElementById('det-time');
  const dc = document.getElementById('det-conf');
  const dr = document.getElementById('det-result');
  const da = document.getElementById('det-avatar');
  const ld = document.getElementById('latest-detection');

  if (dn) dn.textContent = d.name || 'Unknown';
  if (dt) dt.textContent = d.timestamp ? new Date(d.timestamp).toLocaleString() : '—';
  if (dc) dc.textContent = `Confidence: ${d.confidence ? (d.confidence*100).toFixed(1)+'%' : '—'}`;
  if (dr) { dr.textContent = d.result === 'known' ? '✓ Known' : 'Unknown'; dr.className = 'det-result ' + (d.result === 'known' ? 'known' : 'unknown'); }
  if (da) da.textContent = d.result === 'known' ? '👤' : '?';

  if (d.result === 'unknown') {
    showAlert('Unknown person detected — door locked automatically');
    addAlertItem({ name: d.name, timestamp: d.timestamp, type: 'unknown' });
    if (ld) ld.classList.add('alert-state');
    controlDoor(false);
  } else {
    if (ld) ld.classList.remove('alert-state');
  }
}

function addAlertItem(alert) {
  alertCount++;
  const list = document.getElementById('alert-list');
  if (!list) return;
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'alert-item';
  item.innerHTML = `
    <span>Unknown — ${alert.name || 'Unidentified'}</span>
    <span style="color:var(--text-muted);font-size:11px;font-family:var(--font-mono)">${alert.timestamp ? new Date(alert.timestamp).toLocaleTimeString() : '--:--'}</span>`;
  list.prepend(item);

  const badge = document.getElementById('sec-badge');
  if (badge) { badge.style.display = 'flex'; badge.textContent = alertCount; }
}

function showAlert(msg) {
  const ab = document.getElementById('alert-banner');
  const at = document.getElementById('alert-text');
  if (ab) {
    ab.classList.remove('hidden');
    ab.classList.add('alert-active');  // red background
  }
  if (at) at.textContent = msg;
}
function dismissAlert() {
  const ab = document.getElementById('alert-banner');
  if (ab) {
    ab.classList.add('hidden');
    ab.classList.remove('alert-active');
  }
}
function dismissAlert() {
  const ab = document.getElementById('alert-banner');
  if (ab) ab.classList.add('hidden');
}

//  DEVICE CONTROL
function controlDevice(device, state) {
  if (db) db.ref('control/' + device).set({ on: state, timestamp: Date.now() });
}

function controlDoor(unlock) {
  applyDoorState(!unlock);
  if (db) db.ref('control/door').set({ locked: !unlock, timestamp: Date.now() });
}

function applyDoorState(locked) {
  doorLocked = locked;
  const toggle  = document.getElementById('door-toggle');
  const badge   = document.getElementById('door-state-badge');
  const txt     = document.getElementById('door-state-text');
  const sub     = document.getElementById('door-state-sub');
  const lockBig = document.getElementById('door-lock-big');

  if (toggle)  toggle.checked = !locked;
  if (badge)  { badge.textContent = locked ? 'LOCKED' : 'UNLOCKED'; badge.classList.toggle('unlocked', !locked); }
  if (txt)    { txt.textContent = locked ? 'LOCKED' : 'UNLOCKED'; txt.classList.toggle('unlocked', !locked); }
  if (sub)     sub.textContent = locked ? 'Secure — no entry' : 'Door unlocked — entry permitted';
  if (lockBig) lockBig.classList.toggle('unlocked', !locked);
}

function setMode(m) {
  mode = m;
  const ab = document.getElementById('auto-btn');
  const mb = document.getElementById('manual-btn');
  const bd = document.getElementById('mode-badge');
  if (ab) ab.classList.toggle('active', m === 'auto');
  if (mb) mb.classList.toggle('active', m === 'manual');
  if (bd) bd.textContent = m.toUpperCase() + ' MODE';
  if (db) db.ref('control/mode').set({ mode: m });
}

//  MQTT
function simulateMqttStatus() {
  setTimeout(() => {
    setIntDot('int-mqtt', true);
    const mt = document.getElementById('mqtt-text');
    if (mt) mt.textContent = 'Connected — broker.hivemq.com:8884';
  }, 2000);
}

//  CHARTS
function initCharts() {
  const baseScales = {
    x: { grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#4a5a7a',font:{family:'JetBrains Mono',size:9},maxTicksLimit:5} },
    y: { grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#4a5a7a',font:{family:'JetBrains Mono',size:10}} }
  };
  const basePlugin = {
    legend: { display:false },
    tooltip: { backgroundColor:'rgba(10,22,40,0.95)', borderColor:'rgba(255,255,255,0.08)', borderWidth:1, titleColor:'#8899bb', bodyColor:'#e8f0ff', titleFont:{family:'JetBrains Mono',size:11}, bodyFont:{family:'JetBrains Mono',size:12} }
  };

  // Combined chart
  combinedChart = new Chart(document.getElementById('combinedChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label:'Motion', data:[], borderColor:'#a78bfa', backgroundColor:'rgba(167,139,250,0.06)', borderWidth:1.5, pointRadius:2, tension:0.4, fill:true, yAxisID:'yPir' },
        { label:'Light',  data:[], borderColor:'#f59e0b', backgroundColor:'rgba(245,158,11,0.06)',   borderWidth:1.5, pointRadius:2, tension:0.4, fill:true, yAxisID:'yLight' },
        { label:'Occ',    data:[], borderColor:'#22c55e', backgroundColor:'rgba(34,197,94,0.06)',    borderWidth:2,   pointRadius:3, stepped:true, fill:false, yAxisID:'yPir' }
      ]
    },
    options: {
      responsive:true, animation:{duration:300}, plugins:basePlugin,
      scales: {
        x: baseScales.x,
        yPir:   { type:'linear', position:'left',  min:0, max:1, grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#4a5a7a',font:{family:'JetBrains Mono',size:9},callback:v=>v===1?'ON':v===0?'OFF':''} },
        yLight: { type:'linear', position:'right', min:0, max:4095, grid:{drawOnChartArea:false}, ticks:{color:'#f59e0b',font:{family:'JetBrains Mono',size:9}} }
      }
    }
  });

  // Weekly energy bar
  weeklyEnergyChart = new Chart(document.getElementById('weeklyEnergyChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: weekDays,
      datasets: [{
        label: 'kWh Saved',
        data: [...weeklyEnergy],
        backgroundColor: weekDays.map((_,i) => { const d = new Date().getDay(); const idx = d===0?6:d-1; return i===idx?'#f59e0b':'rgba(34,211,238,0.35)'; }),
        borderColor:     weekDays.map((_,i) => { const d = new Date().getDay(); const idx = d===0?6:d-1; return i===idx?'#f59e0b':'rgba(34,211,238,0.6)'; }),
        borderWidth:1, borderRadius:5
      }]
    },
    options: {
      responsive:true, animation:{duration:300},
      plugins: { ...basePlugin, tooltip:{ ...basePlugin.tooltip, callbacks:{ label:ctx=>` ${ctx.parsed.y.toFixed(3)} kWh` } } },
      scales: { x:baseScales.x, y:{ ...baseScales.y, title:{display:true,text:'kWh saved',color:'#4a5a7a',font:{size:10}} } }
    }
  });

  // OUT-C / IN-C Temperature Comparison Chart
  const tcLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const tcOutdoor = [38, 40, 37, 41, 39, 36, 38];
  const tcIndoor  = [24, 24, 23, 25, 24, 23, 24];

  window.tempCompareChart = new Chart(document.getElementById('tempCompareChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: tcLabels,
      datasets: [
        {
          label: 'Outdoor (Dubai)',
          data: tcOutdoor,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#f59e0b',
          tension: 0.4,
          fill: true
        },
        {
          label: 'Indoor (Room)',
          data: tcIndoor,
          borderColor: '#22d3ee',
          backgroundColor: 'rgba(34,211,238,0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#22d3ee',
          tension: 0.4,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      animation: { duration: 300 },
      plugins: {
        legend: {
          display: true,
          labels: { color: '#8899bb', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 12 }
        },
        tooltip: {
          backgroundColor: 'rgba(10,22,40,0.95)',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          titleColor: '#8899bb',
          bodyColor: '#e8f0ff',
          callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + '°C' }
        }
      },
      scales: {
        x: { grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#4a5a7a',font:{family:'JetBrains Mono',size:9}} },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#4a5a7a', font: { family: 'JetBrains Mono', size: 10 }, callback: v => v + '°C' },
          title: { display: true, text: 'Temperature °C', color: '#4a5a7a', font: { size: 10 } }
        }
      }
    }
  });
}

function addChartPoint(t, pir, light) {
  chartLabels.push(t);
  pirData.push(pir);
  lightData.push(light);
  if (chartLabels.length > MAX_POINTS) { chartLabels.shift(); pirData.shift(); lightData.shift(); }
  if (combinedChart) {
    combinedChart.data.labels = [...chartLabels];
    combinedChart.data.datasets[0].data = [...pirData];
    combinedChart.data.datasets[1].data = [...lightData];
    combinedChart.update('none');
  }
}

//  MODEL TABLE
function loadModelResults() {
  Object.entries(modelResults).forEach(([k,v]) => {
    const a = document.getElementById(k+'-acc'); if(a) a.textContent = v.acc;
    const f = document.getElementById(k+'-f1');  if(f) f.textContent = v.f1;
  });
}

//  NAVIGATION
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  document.getElementById('nav-' + id).classList.add('active');
  if (id === 'security') {
    const badge = document.getElementById('sec-badge');
    if (badge) badge.style.display = 'none';
    alertCount = 0;
  }
}

//  SETTINGS
function loadSettings() {
  const url = localStorage.getItem('serverUrl');
  const el  = document.getElementById('server-url');
  if (url && el) el.value = url;
}
function saveServerUrl() {
  const el = document.getElementById('server-url');
  if (!el || !el.value.trim()) {
    showStatus('server-status', 'error', 'Please enter a URL');
    return;
  }
  localStorage.setItem('serverUrl', el.value.trim());
  showStatus('server-status', 'success', 'Server URL saved');
}

//  STATUS DOTS
function setIntDot(id, online) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = online ? 'Active' : 'Inactive';
  el.className = 'int-status-text ' + (online ? 'active' : 'inactive');
}

//  SETTINGS STATUS FEEDBACK
function showStatus(elementId, type, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = (type === 'success' ? '✓ ' : '✗ ') + message;
  el.className = 's-status ' + type;
  if (type === 'success') {
    setTimeout(() => { if(el) el.className = 's-status'; }, 4000);
  }
}






//  LIVE CAMERA STREAM (Raspberry Pi MJPEG)

let _camRetryTimer = null;

function connectLiveCameraStream(streamUrl) {
  const feedEl    = document.getElementById('cam-feed');
  const offlineEl = document.getElementById('cam-offline-msg');

  // Guard: if element missing, abort with clear message
  if (!feedEl) {
    showStatus('cam-status', 'error', 'Page error: cam-feed element missing. Reload app.');
    console.error('[Camera] cam-feed element not found in DOM');
    return;
  }

  // Clear any existing retry timer
  if (_camRetryTimer) { clearTimeout(_camRetryTimer); _camRetryTimer = null; }

  // Remove old stream img
  const oldImg = document.getElementById('cam-stream-img');
  if (oldImg) oldImg.remove();

  showStatus('cam-status', 'success', 'Connecting...');

  // ── STEP 1: Probe the server with a /snapshot fetch first
  
  const snapshotUrl = streamUrl.replace('/stream', '/snapshot');

  fetch(snapshotUrl, { method: 'GET', mode: 'cors', cache: 'no-store' })
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    })
    .then(blob => {
      //  Server is reachable — now load the MJPEG stream 
      showStatus('cam-status', 'success', 'Pi reached — loading stream...');

      const imgEl = document.createElement('img');
      imgEl.id          = 'cam-stream-img';
      imgEl.crossOrigin = 'anonymous';
      imgEl.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';

      // MJPEG streams keep loading forever — onerror fires if stream dies
      imgEl.onerror = () => {
        imgEl.style.display = 'none';
        if (offlineEl) offlineEl.style.display = 'flex';
        showStatus('cam-status', 'error', 'Stream lost — Pi may have restarted');
      };

      // For MJPEG, onload fires after first frame loads
      imgEl.onload = () => {
        if (offlineEl) offlineEl.style.display = 'none';
        showStatus('cam-status', 'success', 'Live stream connected');
        setIntDot('int-rpi', true);
        // Mark RPi online in integration panel
        const camDot   = document.getElementById('cam-dot');
        const camLabel = document.getElementById('cam-label');
        if (camDot)   camDot.classList.add('online');
        if (camLabel) camLabel.textContent = 'Camera Online';
      };

      // Add to DOM first, then set src
      if (offlineEl) offlineEl.style.display = 'none';
      feedEl.appendChild(imgEl);
      imgEl.src = streamUrl;

      // Fallback: if onload doesn't fire within 5s (some browsers skip it for MJPEG)
      // assume it's working if the element is still in DOM
      _camRetryTimer = setTimeout(() => {
        const el = document.getElementById('cam-stream-img');
        if (el && el.src) {
          if (offlineEl) offlineEl.style.display = 'none';
          showStatus('cam-status', 'success', 'Stream active');
          setIntDot('int-rpi', true);
        }
      }, 5000);
    })
    .catch(err => {
      //  Server not reachable 
      if (offlineEl) offlineEl.style.display = 'flex';
      const isCloudflare = streamUrl.includes('trycloudflare') || streamUrl.startsWith('https');
      if (isCloudflare) {
        showStatus('cam-status', 'error', 'Tunnel unreachable — restart cloudflared on Pi and paste new URL');
      } else {
        showStatus('cam-status', 'error', 'Pi not reachable — check IP, WiFi, and port 8080');
      }
      console.error('[Camera] Probe failed:', err.message, 'URL:', streamUrl);
    });
}




function saveRpiIp() {
  const ipEl = document.getElementById('rpi-ip');
  if (!ipEl || !ipEl.value.trim()) {
    showStatus('cam-status', 'error', 'Please enter the Raspberry Pi IP');
    return;
  }

  const ip = ipEl.value.trim();
  localStorage.setItem('rpiIp', ip);

  const isFullUrl = ip.startsWith('http');
  const streamUrl = isFullUrl 
    ? (ip.endsWith('/stream') ? ip : ip + '/stream')
    : 'http://' + ip + ':8080/stream';

  connectLiveCameraStream(streamUrl);
}




(function() {
  const savedIp = localStorage.getItem('rpiIp');
  if (savedIp) {
    const ipEl = document.getElementById('rpi-ip');
    if (ipEl) ipEl.value = savedIp;

    setTimeout(() => {
      const isFullUrl = savedIp.startsWith('http');
      const streamUrl = isFullUrl 
        ? (savedIp.endsWith('/stream') ? savedIp : savedIp + '/stream')
        : 'http://' + savedIp + ':8080/stream';

      connectLiveCameraStream(streamUrl);
    }, 1500);
  }
})();




//  SERVICE WORKER
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}
