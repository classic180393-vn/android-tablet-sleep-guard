'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getDataDir, loadConfig } = require('./config');
const {
  readJsonSafe,
  writeJsonAtomic,
  localDateKey,
  sleepSyncMs,
  getAdbDeviceSerial,
  runAdb,
  isValidAndroidPackageName
} = require('./utils');

const MAX_BT_DIFF_SAMPLES = 96;
const MAX_BT_TRANSITIONS = 24;
const MAX_BT_DAYS = 14;
const MAX_HABIT_STEP_GAP_MS = 24 * 60 * 60 * 1000;

function getBtPaths() {
  const dataDir = getDataDir();
  return {
    dataDir,
    habitsFile: path.join(dataDir, 'bt_keyboard_habits.json'),
    lidStateFile: path.join(dataDir, 'lid_sleep_state.json')
  };
}

function createDefaultBtHabits(cfg = loadConfig()) {
  const kbMeta = (cfg.btDevices && cfg.btDevices.keyboard) || {};
  return {
    schemaVersion: 1,
    meta: {
      name: kbMeta.name || 'Wireless Keyboard',
      designMah: Number(kbMeta.designMah || 500),
      observedStepPct: null
    },
    runtime: {
      lastTs: 0,
      lastPct: null,
      lastConn: null,
      lastPlugged: false,
      lastLidAsleep: false,
      lastSrc: '',
      stepTypingHours: 0,
      stepSleepHours: 0
    },
    stats: {
      totalSamples: 0,
      typingHours: 0,
      sleepHours: 0,
      chargingHours: 0,
      dischargingHours: 0,
      totalPctDrop: 0,
      typingPctDrop: 0,
      sleepPctDrop: 0,
      chargingPctGain: 0,
      typingDrainPctPerHr: null,
      sleepDrainPctPerHr: null,
      learnedDrainPctPerDay: null,
      learnedFullHours: null,
      chargingPctPerHr: null,
      confidence: 'measuring',
      dropsObserved: 0
    },
    days: {},
    transitions: [],
    diffSamples: []
  };
}

function coalesceBtDiffSamples(samples, maxItems = MAX_BT_DIFF_SAMPLES) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const valid = samples
    .filter((s) => s && Number(s.ts) > 0 && Number(s.pct) >= 0 && Number(s.pct) <= 100)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const out = [];
  for (const s of valid) {
    const sTs = Number(s.ts);
    const sEnd = Math.max(sTs, Number(s.endTs || sTs));
    const hits = Math.max(1, Number(s.hits || 1));
    if (out.length === 0) {
      out.push({
        ts: sTs,
        endTs: sEnd,
        hits,
        pct: Math.round(Number(s.pct)),
        conn: Boolean(s.conn),
        isPlugged: Boolean(s.isPlugged),
        lidAsleep: Boolean(s.lidAsleep),
        src: String(s.src || 'api')
      });
      continue;
    }
    const prev = out[out.length - 1];
    const prevEnd = Math.max(Number(prev.ts), Number(prev.endTs || prev.ts));
    const sameBucket = (sTs - prevEnd) <= 2 * 3600 * 1000
      && prev.pct === Math.round(Number(s.pct))
      && Boolean(prev.conn) === Boolean(s.conn)
      && Boolean(prev.isPlugged) === Boolean(s.isPlugged)
      && Boolean(prev.lidAsleep) === Boolean(s.lidAsleep);
    if (sameBucket) {
      prev.endTs = Math.max(prevEnd, sEnd);
      prev.hits = (sTs > prevEnd) ? (prev.hits + hits) : Math.max(prev.hits, hits);
      if (s.src) prev.src = String(s.src);
    } else {
      out.push({
        ts: sTs,
        endTs: sEnd,
        hits,
        pct: Math.round(Number(s.pct)),
        conn: Boolean(s.conn),
        isPlugged: Boolean(s.isPlugged),
        lidAsleep: Boolean(s.lidAsleep),
        src: String(s.src || 'api')
      });
    }
  }
  return out.slice(-maxItems);
}

function recomputeKbStats(habits) {
  const st = habits.stats;
  if (st.dischargingHours >= 0.5 && st.totalPctDrop > 0) {
    const rateHr = st.totalPctDrop / st.dischargingHours;
    st.learnedDrainPctPerDay = Number((rateHr * 24).toFixed(2));
    st.learnedFullHours = Number(Math.max(12, Math.min(240, 100 / rateHr)).toFixed(1));
  }
  if (st.typingHours >= 0.3 && st.typingPctDrop > 0) {
    st.typingDrainPctPerHr = Number((st.typingPctDrop / st.typingHours).toFixed(2));
  }
  if (st.sleepHours >= 1.0 && st.sleepPctDrop >= 0 && st.dropsObserved > 0) {
    st.sleepDrainPctPerHr = Number((st.sleepPctDrop / st.sleepHours).toFixed(2));
  }
  if (st.chargingHours >= 0.08 && st.chargingPctGain > 0) {
    st.chargingPctPerHr = Number((st.chargingPctGain / st.chargingHours).toFixed(1));
  }
  st.confidence = (st.dropsObserved >= 2 || st.totalPctDrop >= 5)
    ? 'calibrated'
    : (st.dropsObserved >= 1 ? 'preliminary' : 'measuring');
}

function loadBtHabits() {
  const { habitsFile } = getBtPaths();
  const def = createDefaultBtHabits();
  const loaded = readJsonSafe(habitsFile, def);
  return {
    ...def,
    ...loaded,
    meta: { ...def.meta, ...(loaded.meta || {}) },
    runtime: { ...def.runtime, ...(loaded.runtime || {}) },
    stats: { ...def.stats, ...(loaded.stats || {}) },
    diffSamples: coalesceBtDiffSamples(loaded.diffSamples),
    transitions: Array.isArray(loaded.transitions) ? loaded.transitions.slice(-MAX_BT_TRANSITIONS) : []
  };
}

function recordPeripheralSample({ ts, pct, conn, isPlugged = false, lidAsleep = null, src = 'api', forceRecord = false }) {
  if (pct == null || isNaN(Number(pct))) return null;
  const cleanPct = Math.max(0, Math.min(100, Math.round(Number(pct))));
  const cleanTs = Number(ts) > 0 ? Number(ts) : Date.now();
  const cleanConn = Boolean(conn);
  const cleanPlugged = Boolean(isPlugged);
  const { habitsFile, lidStateFile } = getBtPaths();
  const effLidAsleep = lidAsleep !== null ? Boolean(lidAsleep) : Boolean(readJsonSafe(lidStateFile, {}).asleep);

  const habits = loadBtHabits();
  const rt = habits.runtime;
  const st = habits.stats;

  if (!forceRecord && rt.lastTs > 0 && cleanTs <= rt.lastTs && rt.lastPct === cleanPct && rt.lastPlugged === cleanPlugged && rt.lastConn === cleanConn) {
    return habits;
  }

  const dayKey = localDateKey(cleanTs);
  if (!habits.days[dayKey]) {
    habits.days[dayKey] = { samples: 0, minPct: cleanPct, maxPct: cleanPct, typingMin: 0, sleepMin: 0, chargingMin: 0, pctDrop: 0, pctGain: 0 };
  }
  const day = habits.days[dayKey];
  day.samples += 1;
  day.minPct = Math.min(day.minPct, cleanPct);
  day.maxPct = Math.max(day.maxPct, cleanPct);

  if (rt.lastTs > 0 && cleanTs > rt.lastTs) {
    const dtMs = Math.min(MAX_HABIT_STEP_GAP_MS, cleanTs - rt.lastTs);
    const dtHours = dtMs / 3600000;
    const dtMin = dtMs / 60000;

    if (rt.lastPlugged && cleanPlugged) {
      st.chargingHours = Number((st.chargingHours + dtHours).toFixed(3));
      day.chargingMin = Number((day.chargingMin + dtMin).toFixed(1));
    } else if (rt.lastConn || cleanConn) {
      st.dischargingHours = Number((st.dischargingHours + dtHours).toFixed(3));
      if (rt.lastLidAsleep && effLidAsleep) {
        st.sleepHours = Number((st.sleepHours + dtHours).toFixed(3));
        rt.stepSleepHours = Number(((rt.stepSleepHours || 0) + dtHours).toFixed(3));
        day.sleepMin = Number((day.sleepMin + dtMin).toFixed(1));
      } else {
        st.typingHours = Number((st.typingHours + dtHours).toFixed(3));
        rt.stepTypingHours = Number(((rt.stepTypingHours || 0) + dtHours).toFixed(3));
        day.typingMin = Number((day.typingMin + dtMin).toFixed(1));
      }
    }

    if (rt.lastPct != null && cleanPct !== rt.lastPct) {
      const delta = rt.lastPct - cleanPct;
      if (!rt.lastPlugged && !cleanPlugged && delta > 0 && delta <= 40) {
        const typH = Number(rt.stepTypingHours || 0);
        const slpH = Number(rt.stepSleepHours || 0);
        const totH = Math.max(0.01, typH + slpH);
        st.totalPctDrop += delta;
        st.dropsObserved += 1;
        day.pctDrop += delta;
        st.typingPctDrop += Number((delta * (typH / totH)).toFixed(2));
        st.sleepPctDrop += Number((delta * (slpH / totH)).toFixed(2));
        if (habits.meta.observedStepPct == null || delta < habits.meta.observedStepPct) {
          habits.meta.observedStepPct = delta;
        }
        habits.transitions.push({
          ts: cleanTs,
          fromPct: rt.lastPct,
          toPct: cleanPct,
          dPct: delta,
          elapsedMin: Math.round(totH * 60),
          typingMin: Math.round(typH * 60),
          sleepMin: Math.round(slpH * 60),
          ratePctPerHr: Number((delta / totH).toFixed(2)),
          src
        });
        habits.transitions = habits.transitions.slice(-MAX_BT_TRANSITIONS);
        rt.stepTypingHours = 0;
        rt.stepSleepHours = 0;
      } else if ((rt.lastPlugged || cleanPlugged) && delta < 0 && (-delta) <= 95) {
        const gain = -delta;
        st.chargingPctGain += gain;
        day.pctGain += gain;
        rt.stepTypingHours = 0;
        rt.stepSleepHours = 0;
      }
    }
  }

  st.totalSamples += 1;
  rt.lastTs = cleanTs;
  rt.lastPct = cleanPct;
  rt.lastConn = cleanConn;
  rt.lastPlugged = cleanPlugged;
  rt.lastLidAsleep = effLidAsleep;
  rt.lastSrc = String(src || 'api');

  habits.diffSamples.push({
    ts: cleanTs,
    endTs: cleanTs,
    hits: 1,
    pct: cleanPct,
    conn: cleanConn,
    isPlugged: cleanPlugged,
    lidAsleep: effLidAsleep,
    src: rt.lastSrc
  });
  habits.diffSamples = coalesceBtDiffSamples(habits.diffSamples);

  const dayKeys = Object.keys(habits.days).sort();
  if (dayKeys.length > MAX_BT_DAYS) {
    for (const oldKey of dayKeys.slice(0, dayKeys.length - MAX_BT_DAYS)) delete habits.days[oldKey];
  }

  recomputeKbStats(habits);
  writeJsonAtomic(habitsFile, habits, true);
  return habits;
}

function findSnapshotPath(cfg = loadConfig()) {
  if (process.env.ATSG_BT_SNAPSHOT) {
    return process.env.ATSG_BT_SNAPSHOT;
  }
  return cfg.btSnapshotPath || '/storage/emulated/0/Download/.atsg_bt_battery.json';
}

function matchBtDevice(devices, patternStr) {
  if (!Array.isArray(devices) || !patternStr) return null;
  const re = new RegExp(patternStr, 'i');
  const matches = devices.filter((d) => d && re.test(`${d.name || ''} ${d.addr || ''}`));
  return matches.find((d) => d.conn && d.bat != null && Number(d.bat) >= 0)
    || matches.find((d) => d.conn)
    || matches.find((d) => d.bat != null && Number(d.bat) >= 0)
    || matches[0]
    || null;
}

function syncFromSnapshotFile(cfg = loadConfig()) {
  const snapFile = findSnapshotPath(cfg);
  if (!snapFile || !fs.existsSync(snapFile)) return null;
  try {
    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    if (!snap || !snap.ok || !Array.isArray(snap.devices)) return null;
    const kbCfg = (cfg.btDevices && cfg.btDevices.keyboard) || {};
    const dev = matchBtDevice(snap.devices, kbCfg.pattern || 'Keyboard');
    if (!dev || dev.bat == null || Number(dev.bat) < 0) return { ts: snap.ts, keyboard: null, raw: snap };
    const habits = recordPeripheralSample({
      ts: Number(snap.ts) || Date.now(),
      pct: Number(dev.bat),
      conn: Boolean(dev.conn),
      isPlugged: false,
      src: dev.src || 'api'
    });
    return { ts: snap.ts, keyboard: dev, habits, raw: snap };
  } catch {
    return null;
  }
}

function triggerAndroidBtSync(cfg = loadConfig()) {
  const rawPkg = String(cfg.btHelperPackage || 'com.atsg.btbattery').trim();
  const pkg = isValidAndroidPackageName(rawPkg) ? rawPkg : 'com.atsg.btbattery';
  const snapFile = findSnapshotPath(cfg);
  let prevTs = 0;
  try {
    if (snapFile && fs.existsSync(snapFile)) {
      prevTs = Number(JSON.parse(fs.readFileSync(snapFile, 'utf8')).ts) || 0;
    }
  } catch {}

  let triggered = false;
  const serial = getAdbDeviceSerial();
  if (serial) {
    const out = runAdb(serial, ['shell', 'cmd', 'jobscheduler', 'run', '-f', pkg, '101'], 2500);
    if (/Running job/i.test(out)) triggered = true;
  }
  if (!triggered) {
    try {
      const amRes = spawnSync('am', ['start', '-W', '-n', `${pkg}/.SyncActivity`], {
        stdio: 'ignore',
        timeout: 3000,
        killSignal: 'SIGKILL'
      });
      if (!amRes.error && amRes.status === 0) triggered = true;
    } catch {}
  }

  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try {
      const target = findSnapshotPath(cfg);
      if (target && fs.existsSync(target)) {
        const cur = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (cur && cur.ok && Number(cur.ts) > prevTs) break;
      }
    } catch {}
    sleepSyncMs(120);
  }
  return syncFromSnapshotFile(cfg);
}

function formatBtReport() {
  const h = loadBtHabits();
  const rt = h.runtime || {};
  const st = h.stats || {};
  const pct = rt.lastPct != null ? `${rt.lastPct}%` : '--%';
  const mah = rt.lastPct != null ? Math.round((rt.lastPct / 100) * (h.meta.designMah || 500)) : 0;
  const rateTxt = st.learnedDrainPctPerDay != null
    ? `${st.learnedDrainPctPerDay}%/day (~${(st.learnedDrainPctPerDay / 24).toFixed(2)}%/h | est full ~${st.learnedFullHours}h)`
    : 'Collecting baseline samples (awaiting first % drop step)';
  return [
    `=== Bluetooth Peripheral Battery Tracker (${h.meta.name}) ===`,
    `  • Battery Level   : ${pct} (${mah}/${h.meta.designMah} mAh)`,
    `  • Connection      : ${rt.lastPlugged ? 'Charging' : (rt.lastConn ? 'Connected (BT)' : 'Disconnected')}`,
    `  • Firmware Step   : ${h.meta.observedStepPct ? `${h.meta.observedStepPct}% step` : 'Pending first transition'}`,
    `  • Confidence      : ${st.confidence} (${st.dropsObserved} drop transitions)`,
    `  • Measured Time   : Total ${st.dischargingHours}h unplugged (Active: ${st.typingHours}h | Sleep: ${st.sleepHours}h)`,
    `  • Drain Rate      : ${rateTxt}`,
    `  • RLE Diff Points : ${(h.diffSamples || []).length}/${MAX_BT_DIFF_SAMPLES}`
  ].join('\n');
}

module.exports = {
  MAX_BT_DIFF_SAMPLES,
  MAX_BT_TRANSITIONS,
  MAX_BT_DAYS,
  getBtPaths,
  createDefaultBtHabits,
  coalesceBtDiffSamples,
  loadBtHabits,
  recordPeripheralSample,
  syncFromSnapshotFile,
  triggerAndroidBtSync,
  formatBtReport
};
