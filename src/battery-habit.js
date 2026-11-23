'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getDataDir, loadConfig } = require('./config');
const {
  ensureDir,
  writeJsonAtomic,
  runExec,
  getAdbDeviceSerial,
  runAdb,
  getAllCpuCoresRange,
  appendRotatedLog,
  localDateKey,
  localHourKey,
  readLivePid,
  removeOwnPidFile,
  stopPidAndWait
} = require('./utils');

const MAX_LOCAL_SAMPLES = 96;
const MAX_LOCAL_DAYS = 14;
const MAX_LOCAL_OPTS = 24;

function getHabitPaths() {
  const dataDir = getDataDir();
  return {
    dataDir,
    stateFile: path.join(dataDir, 'battery_habits.json'),
    pidFile: path.join(dataDir, 'battery_habit.pid'),
    logFile: path.join(dataDir, 'battery_habit.log')
  };
}

function createDefaultState(cfg = loadConfig()) {
  const hours = {};
  for (let h = 0; h < 24; h++) {
    hours[String(h).padStart(2, '0')] = {
      samples: 0,
      unpluggedMin: 0,
      chargingMin: 0,
      sumCpuPct: 0,
      sumCurrentMa: 0,
      currentSamples: 0,
      sumTempC: 0,
      pctDropSum: 0,
      pctDropHours: 0
    };
  }
  return {
    schemaVersion: 2,
    settings: {
      intervalSec: Number(cfg.sampleIntervalSec || 60),
      flushHeartbeatMin: Number(cfg.flushHeartbeatMin || 5),
      idleWakeUnlockMin: Number(cfg.idleWakeUnlockMin || 5),
      autoOptimize: Boolean(cfg.autoOptimize !== false)
    },
    runtime: {
      lastSampleTs: 0,
      lastPct: null,
      lastPlugged: 'UNKNOWN',
      sessionStartTs: 0,
      sessionStartPct: null,
      idleStreakMin: 0
    },
    totals: {
      samples: 0,
      unpluggedMin: 0,
      chargingMin: 0,
      idleWakeLockWasteMin: 0,
      autoOptimizations: 0,
      diskWrites: 0,
      skippedDiskWrites: 0
    },
    hours,
    days: {},
    recentSamples: [],
    optimizations: []
  };
}

/**
 * Coalesce consecutive telemetry points via RLE Diff when battery %, charge state,
 * wakeLock, current (±350mA), temperature (±0.8C) and CPU (±25%) remain stable within 15m.
 */
function coalesceSamplesDiff(samples, maxItems = MAX_LOCAL_SAMPLES) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const valid = samples
    .filter((s) => s && Number(s.ts) > 0 && s.pct != null && Number.isFinite(Number(s.pct)) && Number(s.pct) >= 0)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const out = [];
  for (const s of valid) {
    if (out.length === 0) {
      out.push({ ...s, endTs: Number(s.endTs || s.ts), hits: Math.max(1, Number(s.hits || 1)) });
      continue;
    }
    const prev = out[out.length - 1];
    const prevEnd = Number(prev.endTs || prev.ts);
    const sStart = Number(s.ts);
    const sEnd = Math.max(sStart, Number(s.endTs || sStart));
    const sameDiff = (sStart - prevEnd) <= 15 * 60000
      && s.pct === prev.pct
      && Boolean(s.isCharging) === Boolean(prev.isCharging)
      && Boolean(s.wakeLock) === Boolean(prev.wakeLock)
      && Math.abs(Number(s.currentMa || 0) - Number(prev.currentMa || 0)) < 350
      && Math.abs(Number(s.tempC || 0) - Number(prev.tempC || 0)) < 0.8
      && Math.abs(Number(s.cpu || 0) - Number(prev.cpu || 0)) < 25;
    if (sameDiff) {
      prev.endTs = Math.max(prevEnd, sEnd);
      prev.hits = (sStart > prevEnd)
        ? ((prev.hits || 1) + Math.max(1, Number(s.hits || 1)))
        : Math.max(prev.hits || 1, Number(s.hits || 1));
      if (sEnd >= prevEnd) {
        prev.currentMa = s.currentMa;
        prev.powerW = s.powerW;
        prev.tempC = s.tempC;
        prev.cpu = s.cpu;
      }
    } else {
      out.push({ ...s, endTs: sEnd, hits: Math.max(1, Number(s.hits || 1)) });
    }
  }
  return out.slice(-maxItems);
}

function parseBatteryStatusJson(rawJson) {
  if (!rawJson) return null;
  try {
    const b = JSON.parse(rawJson);
    const pct = Number.isFinite(b.percentage) ? b.percentage : Number(b.level ?? 0);
    const plugged = String(b.plugged || 'UNPLUGGED');
    const status = String(b.status || 'UNKNOWN');
    const isCharging = plugged !== 'UNPLUGGED' && status !== 'DISCHARGING';
    const currentUa = Math.abs(Number(b.current || 0));
    const currentMa = Math.round(currentUa / 1000);
    const voltageMv = Number(b.voltage || 0);
    const powerW = voltageMv > 0 && currentMa > 0 ? Number(((voltageMv * currentMa) / 1e6).toFixed(2)) : 0;
    const tempC = Number(Number(b.temperature || 0).toFixed(1));
    const chargeCounterMah = Number(b.charge_counter || 0) > 0 ? Math.round(Number(b.charge_counter) / 1000) : 0;
    return {
      ok: true,
      source: 'termux-api',
      pct,
      level: Number(b.level ?? pct),
      plugged,
      status,
      isCharging,
      currentMa,
      voltageMv,
      powerW,
      tempC,
      chargeCounterMah,
      cycle: Number(b.cycle || 0),
      health: String(b.health || 'UNKNOWN')
    };
  } catch {
    return null;
  }
}

function parseAdbBatteryDump(dump) {
  if (!dump) return null;
  const getNum = (re) => {
    const m = dump.match(re);
    return m ? Number(m[1]) : 0;
  };
  const levelMatch = dump.match(/level:\s*(\d+)/i);
  if (!levelMatch) return null;
  const pct = Number(levelMatch[1]);
  const ac = /AC powered:\s*true/i.test(dump);
  const usb = /USB powered:\s*true/i.test(dump);
  const wl = /Wireless powered:\s*true/i.test(dump);
  const isCharging = ac || usb || wl;
  const plugged = ac ? 'PLUGGED_AC' : usb ? 'PLUGGED_USB' : wl ? 'PLUGGED_WIRELESS' : 'UNPLUGGED';
  const voltageMv = getNum(/voltage:\s*(\d+)/i);
  const tempC = Number((getNum(/temperature:\s*(\d+)/i) / 10).toFixed(1));
  const chargeCounterMah = Math.round(getNum(/Charge counter:\s*(\d+)/i) / 1000);
  return {
    ok: true,
    source: 'adb-dumpsys',
    pct,
    level: pct,
    plugged,
    status: isCharging ? 'CHARGING' : 'DISCHARGING',
    isCharging,
    currentMa: 0,
    voltageMv,
    powerW: 0,
    tempC,
    chargeCounterMah,
    cycle: 0,
    health: 'UNKNOWN'
  };
}

function readBatterySnapshot(adbSerial = '') {
  const raw = runExec('termux-battery-status', [], 2200);
  const parsed = parseBatteryStatusJson(raw);
  if (parsed) return parsed;
  if (adbSerial) {
    const dump = runAdb(adbSerial, ['shell', 'dumpsys', 'battery'], 2000);
    const adbParsed = parseAdbBatteryDump(dump);
    if (adbParsed) return adbParsed;
  }
  return { ok: false, source: 'unavailable', pct: 0, isCharging: false, plugged: 'UNKNOWN', status: 'UNKNOWN', currentMa: 0, voltageMv: 0, powerW: 0, tempC: 0, chargeCounterMah: 0, cycle: 0, health: 'UNKNOWN' };
}

function readCpuWorkloads(adbSerial = '') {
  const psOut = runExec('ps', ['-eo', 'pid,%cpu,args'], 1800);
  let totalCpu = 0;
  let termuxWakeLockHeld = false;
  for (const line of psOut.split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || /\bps -eo\b/.test(m[3])) continue;
    totalCpu += Number(m[2]);
  }
  if (adbSerial) {
    const pwrOut = runAdb(adbSerial, ['shell', 'dumpsys', 'power'], 1500);
    termuxWakeLockHeld = /PARTIAL_WAKE_LOCK.*termux|termux:service-wakelock/i.test(pwrOut);
  }
  return { totalCpu: Number(totalCpu.toFixed(1)), wakeLockHeld: termuxWakeLockHeld };
}

function loadHabitState() {
  const { stateFile } = getHabitPaths();
  const def = createDefaultState();
  try {
    if (!fs.existsSync(stateFile)) return def;
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!raw || typeof raw !== 'object') return def;
    const rawDays = { ...(raw.days || {}) };
    const dayKeys = Object.keys(rawDays).sort();
    if (dayKeys.length > MAX_LOCAL_DAYS) {
      for (const k of dayKeys.slice(0, dayKeys.length - MAX_LOCAL_DAYS)) delete rawDays[k];
    }
    return {
      ...def,
      ...raw,
      settings: { ...def.settings, ...(raw.settings || {}) },
      runtime: { ...def.runtime, ...(raw.runtime || {}) },
      totals: { ...def.totals, ...(raw.totals || {}) },
      hours: { ...def.hours, ...(raw.hours || {}) },
      days: rawDays,
      recentSamples: coalesceSamplesDiff(raw.recentSamples),
      optimizations: Array.isArray(raw.optimizations) ? raw.optimizations.slice(-MAX_LOCAL_OPTS) : []
    };
  } catch {
    return def;
  }
}

function recordSample(state, snap, elapsedMin = 1, now = Date.now()) {
  const { battery, workloads } = snap;
  if (!battery.ok) return { state, significantDiff: false };

  const mins = Math.max(0.05, Math.min(10, elapsedMin));
  const dKey = localDateKey(now);
  const hKey = localHourKey(now);

  if (!state.days[dKey]) {
    state.days[dKey] = {
      samples: 0,
      unpluggedMin: 0,
      chargingMin: 0,
      pctLost: 0,
      minPct: battery.pct,
      maxPct: battery.pct,
      maxTempC: battery.tempC,
      avgCurrentSumMa: 0,
      avgCurrentCount: 0,
      idleWakeLockWasteMin: 0
    };
  }
  const day = state.days[dKey];
  const hour = state.hours[hKey];

  state.totals.samples += 1;
  day.samples += 1;
  day.minPct = Math.min(day.minPct, battery.pct);
  day.maxPct = Math.max(day.maxPct, battery.pct);
  day.maxTempC = Math.max(day.maxTempC, battery.tempC);

  if (battery.isCharging) {
    state.totals.chargingMin += mins;
    day.chargingMin += mins;
    hour.chargingMin += mins;
  } else {
    state.totals.unpluggedMin += mins;
    day.unpluggedMin += mins;
    hour.unpluggedMin += mins;
    if (battery.currentMa > 0) {
      day.avgCurrentSumMa += battery.currentMa;
      day.avgCurrentCount += 1;
    }
  }

  hour.samples += 1;
  hour.sumCpuPct += workloads.totalCpu;
  hour.sumTempC += battery.tempC;
  if (!battery.isCharging && battery.currentMa > 0) {
    hour.sumCurrentMa += battery.currentMa;
    hour.currentSamples += 1;
  }

  const prevPct = state.runtime.lastPct;
  const prevTs = state.runtime.lastSampleTs;
  const isIdle = workloads.totalCpu < 2.0;

  if (!battery.isCharging && isIdle) {
    state.runtime.idleStreakMin = (state.runtime.idleStreakMin || 0) + mins;
    if (workloads.wakeLockHeld) {
      state.totals.idleWakeLockWasteMin += mins;
      day.idleWakeLockWasteMin += mins;
    }
  } else {
    state.runtime.idleStreakMin = 0;
  }

  if (!battery.isCharging && prevPct !== null && prevTs > 0 && state.runtime.lastPlugged === 'UNPLUGGED') {
    const dtHr = (now - prevTs) / 3600000;
    const dPct = prevPct - battery.pct;
    if (dtHr > 0 && dtHr <= 0.5 && dPct >= 0 && dPct <= 10) {
      hour.pctDropHours += dtHr;
      hour.pctDropSum += dPct;
      if (dPct > 0) day.pctLost += dPct;
    }
  }

  const prevLatest = state.recentSamples.length > 0 ? state.recentSamples[state.recentSamples.length - 1] : null;
  const prevLatestEnd = prevLatest ? Number(prevLatest.endTs || prevLatest.ts) : 0;
  const significantDiff = !prevLatest
    || battery.pct !== prevLatest.pct
    || Boolean(battery.isCharging) !== Boolean(prevLatest.isCharging)
    || Boolean(workloads.wakeLockHeld) !== Boolean(prevLatest.wakeLock)
    || Math.abs((battery.currentMa || 0) - (prevLatest.currentMa || 0)) >= 350
    || Math.abs((battery.tempC || 0) - (prevLatest.tempC || 0)) >= 0.8
    || Math.abs((workloads.totalCpu || 0) - (prevLatest.cpu || 0)) >= 25
    || (now - prevLatestEnd) > 15 * 60000;

  state.recentSamples.push({
    ts: now,
    endTs: now,
    hits: 1,
    pct: battery.pct,
    isCharging: battery.isCharging,
    currentMa: battery.currentMa,
    powerW: battery.powerW,
    tempC: battery.tempC,
    cpu: workloads.totalCpu,
    wakeLock: workloads.wakeLockHeld
  });
  state.recentSamples = coalesceSamplesDiff(state.recentSamples, MAX_LOCAL_SAMPLES);

  state.runtime.lastSampleTs = now;
  state.runtime.lastPct = battery.pct;
  state.runtime.lastPlugged = battery.plugged;
  if (state.runtime.sessionStartTs === 0) {
    state.runtime.sessionStartTs = now;
    state.runtime.sessionStartPct = battery.pct;
  }

  const dayKeys = Object.keys(state.days).sort();
  if (dayKeys.length > MAX_LOCAL_DAYS) {
    for (const oldKey of dayKeys.slice(0, dayKeys.length - MAX_LOCAL_DAYS)) {
      delete state.days[oldKey];
    }
  }
  return { state, significantDiff };
}

function computeAnalytics(state, battery) {
  let empiricalPctPerHour = null;
  const recent = (state.recentSamples || []).filter((s) => !s.isCharging && s.pct > 0);
  if (recent.length >= 2) {
    const oldest = recent[0];
    const newest = recent[recent.length - 1];
    const dtHours = ((newest.endTs || newest.ts) - oldest.ts) / 3600000;
    const dPct = oldest.pct - newest.pct;
    if (dtHours >= 0.08 && dPct > 0) {
      empiricalPctPerHour = Number((dPct / dtHours).toFixed(2));
    }
  }
  let estRemainHours = null;
  if (battery && !battery.isCharging) {
    if (battery.currentMa > 80 && battery.chargeCounterMah > 0) {
      estRemainHours = Number((battery.chargeCounterMah / battery.currentMa).toFixed(1));
    } else if (empiricalPctPerHour && empiricalPctPerHour > 0) {
      estRemainHours = Number((battery.pct / empiricalPctPerHour).toFixed(1));
    }
  }
  return { empiricalPctPerHour, estRemainHours };
}

function pinHelpersToEcoCores(cfg = loadConfig(), restore = false) {
  const cores = restore ? getAllCpuCoresRange() : String(cfg.ecoCpuCores || '0,1');
  const niceVal = restore ? '0' : String(cfg.ecoNice || 10);
  let pinRe;
  try {
    pinRe = new RegExp(cfg.autoPinHelperRegex || 'lid-guard|battery-habit|tablet-guard');
  } catch {
    return [];
  }
  const psOut = runExec('ps', ['-eo', 'pid,ppid,args'], 1500);
  if (!psOut) return [];
  const rows = [];
  const prootPids = new Set();
  for (const line of psOut.split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const row = { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] };
    rows.push(row);
    if (/(^|\/)proot\b/.test(row.args)) prootPids.add(row.pid);
  }
  const pinned = [];
  for (const r of rows) {
    if (r.pid === process.pid || r.pid === process.ppid) continue;
    if (prootPids.has(r.ppid)) continue;
    if (pinRe.test(r.args)) {
      const tsRes = spawnSync('taskset', ['-pc', cores, String(r.pid)], { stdio: 'ignore' });
      const rnRes = spawnSync('renice', ['-n', niceVal, '-p', String(r.pid)], { stdio: 'ignore' });
      const tsOk = !tsRes.error && tsRes.status === 0;
      const rnOk = !rnRes.error && rnRes.status === 0;
      if (tsOk || rnOk) pinned.push(r.pid);
    }
  }
  return pinned;
}

function runDaemonLoop() {
  const { dataDir, pidFile, logFile } = getHabitPaths();
  const existing = readLivePid(pidFile, /battery-habit|tablet-guard/);
  if (existing && existing !== process.pid) process.exit(0);

  ensureDir(dataDir);
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
  const cfg = loadConfig();
  spawnSync('taskset', ['-pc', String(cfg.ecoCpuCores || '0,1'), String(process.pid)], { stdio: 'ignore' });
  spawnSync('renice', ['-n', String(cfg.ecoNice || 10), '-p', String(process.pid)], { stdio: 'ignore' });
  appendRotatedLog(logFile, `Battery Habit daemon started PID=${process.pid}`);

  let state = loadHabitState();
  let lastTickTs = Date.now();
  let lastFlushTs = Date.now();
  let dirty = false;

  const flushIfDirty = (reason = 'diff') => {
    if (!dirty) return;
    state.totals.diskWrites += 1;
    writeJsonAtomic(getHabitPaths().stateFile, state, true);
    lastFlushTs = Date.now();
    dirty = false;
    if (reason === 'shutdown') appendRotatedLog(logFile, 'State flushed on shutdown');
  };

  const tick = () => {
    const serial = getAdbDeviceSerial();
    const battery = readBatterySnapshot(serial);
    const workloads = readCpuWorkloads(serial);
    const now = Date.now();
    const elapsedMin = (now - lastTickTs) / 60000;
    lastTickTs = now;
    const res = recordSample(state, { battery, workloads }, elapsedMin > 0 ? elapsedMin : 1, now);
    if (battery.ok) dirty = true;
    const hbMs = Math.max(2, Number(state.settings.flushHeartbeatMin || 5)) * 60000;
    if (res.significantDiff || (now - lastFlushTs >= hbMs)) {
      flushIfDirty(res.significantDiff ? 'diff' : 'heartbeat');
    } else {
      state.totals.skippedDiskWrites = (state.totals.skippedDiskWrites || 0) + 1;
    }
  };

  tick();
  const timer = setInterval(tick, Math.max(15000, (state.settings.intervalSec || 60) * 1000));
  const shutdown = () => {
    clearInterval(timer);
    flushIfDirty('shutdown');
    removeOwnPidFile(pidFile, process.pid);
    appendRotatedLog(logFile, `Battery Habit daemon stopped PID=${process.pid}`);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function startDaemon(binPath) {
  const { dataDir, pidFile, logFile } = getHabitPaths();
  const existing = readLivePid(pidFile, /battery-habit|tablet-guard/);
  if (existing) return { started: false, pid: existing };
  ensureDir(dataDir);
  const outFd = fs.openSync(logFile, 'a');
  const ch = spawn(process.execPath, [binPath, 'habit-daemon-loop'], { detached: true, stdio: ['ignore', outFd, outFd] });
  ch.unref();
  fs.writeFileSync(pidFile, `${ch.pid}\n`, 'utf8');
  return { started: true, pid: ch.pid };
}

function stopDaemon() {
  const { pidFile } = getHabitPaths();
  return stopPidAndWait(pidFile, /battery-habit|tablet-guard/, 2000);
}

module.exports = {
  MAX_LOCAL_SAMPLES,
  MAX_LOCAL_DAYS,
  MAX_LOCAL_OPTS,
  getHabitPaths,
  createDefaultState,
  coalesceSamplesDiff,
  parseBatteryStatusJson,
  parseAdbBatteryDump,
  readBatterySnapshot,
  loadHabitState,
  recordSample,
  computeAnalytics,
  pinHelpersToEcoCores,
  startDaemon,
  stopDaemon,
  runDaemonLoop
};
