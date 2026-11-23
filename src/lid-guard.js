'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { getDataDir, loadConfig } = require('./config');
const {
  ensureDir,
  readJsonSafe,
  writeJsonAtomic,
  runExec,
  getAdbDeviceSerial,
  runAdb,
  sleepSyncMs,
  appendRotatedLog,
  readLivePid,
  removeOwnPidFile,
  stopPidAndWait
} = require('./utils');

function getLidPaths() {
  const dataDir = getDataDir();
  return {
    dataDir,
    stateFile: path.join(dataDir, 'lid_sleep_state.json'),
    pidFile: path.join(dataDir, 'lid_guard.pid'),
    logFile: path.join(dataDir, 'lid_guard.log')
  };
}

const DEFAULT_LID_STATE = {
  asleep: false,
  reason: '',
  triggerSource: '',
  enteredAt: 0,
  wokeAt: 0,
  frozenPids: [],
  wakeLockHeld: false,
  hallOpen: true,
  lux: null,
  screenState: 'Awake',
  lastSleepReason: '',
  isCharging: false,
  batteryPct: -1,
  tempC: 0,
  relockCount: 0,
  updatedAt: ''
};

function readLidSleepState() {
  const { stateFile } = getLidPaths();
  return readJsonSafe(stateFile, DEFAULT_LID_STATE);
}

function writeLidSleepState(patch = {}) {
  const { stateFile } = getLidPaths();
  const next = {
    ...readLidSleepState(),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(stateFile, next);
  return next;
}

function parseAdbPowerOutput(out, serial = '') {
  if (!out || typeof out !== 'string') {
    return {
      connected: false,
      serial,
      wakefulness: 'unknown',
      isPowered: null,
      plugType: -1,
      batteryPct: -1,
      lastSleepReason: '',
      lastWakeReason: '',
      termuxWakeLockHeld: null,
      rawWakeLocks: []
    };
  }
  const mWake = out.match(/mWakefulness=([^\s]+)/);
  const mPow = out.match(/mIsPowered=(true|false)/);
  const mPlug = out.match(/mPlugType=(\d+)/);
  const mBat = out.match(/mBatteryLevel=(\d+)/);
  const mSleep = out.match(/mLastSleepReason=([^\s]+)/);
  const mWakeReason = out.match(/mLastWakeReason=([^\r\n]+)/);
  const wakeLines = out.split(/\r?\n/).filter((l) => l.includes('PARTIAL_WAKE_LOCK'));
  const termuxWakeLockHeld = wakeLines.some((l) => /termux:service-wakelock|com\.termux/i.test(l));

  return {
    connected: true,
    serial,
    wakefulness: mWake ? mWake[1] : 'unknown',
    isPowered: mPow ? (mPow[1] === 'true') : null,
    plugType: mPlug ? Number(mPlug[1]) : -1,
    batteryPct: mBat ? Number(mBat[1]) : -1,
    lastSleepReason: mSleep ? mSleep[1] : '',
    lastWakeReason: mWakeReason ? mWakeReason[1].trim() : '',
    termuxWakeLockHeld,
    rawWakeLocks: wakeLines.map((s) => s.trim())
  };
}

function readAdbPowerSnapshot(serial = '') {
  const adbSerial = serial || getAdbDeviceSerial();
  if (!adbSerial) return parseAdbPowerOutput('', '');
  const out = runAdb(adbSerial, ['shell', 'dumpsys', 'power'], 2200);
  return parseAdbPowerOutput(out, adbSerial);
}

function readTermuxBatteryLight() {
  const raw = runExec('termux-battery-status', [], 1800);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    const plugged = String(b.plugged || 'UNPLUGGED');
    const status = String(b.status || 'UNKNOWN');
    return {
      pct: Number.isFinite(b.percentage) ? b.percentage : Number(b.level ?? -1),
      isCharging: plugged !== 'UNPLUGGED' && status !== 'DISCHARGING',
      plugged,
      status,
      tempC: Number(Number(b.temperature || 0).toFixed(1)),
      currentMa: Math.round(Math.abs(Number(b.current || 0)) / 1000)
    };
  } catch {
    return null;
  }
}

function parseSensorPayload(rawJson, hallPattern = 'hall|magnetic|lid', lightPattern = 'light|als|lux') {
  if (!rawJson || typeof rawJson !== 'string') return null;
  try {
    const parsed = JSON.parse(rawJson);
    const hallRe = new RegExp(hallPattern, 'i');
    const lightRe = new RegExp(lightPattern, 'i');
    const keys = Object.keys(parsed);
    const hallKey = keys.find((k) => hallRe.test(k));
    const lightKey = keys.find((k) => lightRe.test(k));

    let hallOpen = null;
    let hallVal = null;
    if (hallKey && Array.isArray(parsed[hallKey].values)) {
      const v = Number(parsed[hallKey].values[0]);
      if (Number.isFinite(v)) {
        hallVal = v;
        hallOpen = v >= 0.5;
      }
    }

    let lux = null;
    if (lightKey && Array.isArray(parsed[lightKey].values)) {
      const lv = Number(parsed[lightKey].values[0]);
      if (Number.isFinite(lv)) lux = lv;
    }

    if (hallVal === null && lux === null) return null;
    return { value: hallVal, hallOpen, lux };
  } catch {
    return null;
  }
}

function runTermuxSensorCmd(args, timeoutMs) {
  const direct = runExec('termux-sensor', args, timeoutMs);
  if (direct) return direct;
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  return runExec('timeout', ['-k', '0.5', String(sec), 'termux-sensor', ...args], timeoutMs + 500);
}

function discoverSensorNames(cfg) {
  const listRaw = runTermuxSensorCmd(['-l'], 2200);
  const hallRe = new RegExp(cfg.hallSensorPattern || 'hall|magnetic|lid', 'i');
  const lightRe = new RegExp(cfg.lightSensorPattern || 'light|als|lux', 'i');
  let hallName = '';
  let lightName = '';
  if (listRaw) {
    try {
      const parsed = JSON.parse(listRaw);
      const sensors = Array.isArray(parsed.sensors) ? parsed.sensors : [];
      hallName = sensors.find((s) => hallRe.test(s)) || '';
      lightName = sensors.find((s) => lightRe.test(s)) || '';
    } catch {}
  }
  return { hallName, lightName };
}

function readSensorsTermux(cfg, includeLight = false) {
  const names = discoverSensorNames(cfg);
  const requested = [];
  if (names.hallName) requested.push(names.hallName);
  if (includeLight && names.lightName) requested.push(names.lightName);
  if (requested.length === 0) return null;
  const out = runTermuxSensorCmd(['-s', requested.join(','), '-n', '1'], 2800);
  return parseSensorPayload(out, cfg.hallSensorPattern, cfg.lightSensorPattern);
}

/**
 * Pure dark-bag false-wake guard decision helper.
 * Prevents keyboard wobble inside a dark backpack (lux < darkLuxThreshold) from waking the tablet.
 */
function evaluateDarkBagWakeGuard({ curAsleep, hallOpen, lux, charging, activeWork, cfg }) {
  const threshold = Number.isFinite(Number(cfg.darkLuxThreshold)) ? Number(cfg.darkLuxThreshold) : 0.8;
  if (!curAsleep) return { action: 'none', reason: 'already_awake' };
  if (!hallOpen) return { action: 'stay_asleep', reason: 'hall_closed' };
  if (cfg.darkBagGuardNoAdb && !charging && !activeWork && lux !== null && Number.isFinite(lux) && lux < threshold) {
    return { action: 'stay_asleep', reason: 'dark_bag_lux_guard', lux, threshold };
  }
  return { action: 'wake', reason: 'hall_sensor_open', lux };
}

function releaseWakeLockVerified(serial = '', dryRun = false) {
  if (dryRun) return { released: true, verified: true, heldAfter: false, dryRun: true };
  runExec('termux-wake-unlock', [], 1600);
  const adbSerial = serial || getAdbDeviceSerial();
  if (!adbSerial) {
    writeLidSleepState({ wakeLockHeld: false });
    return { released: true, verified: false, heldAfter: false };
  }
  sleepSyncMs(120);
  let pwr = readAdbPowerSnapshot(adbSerial);
  if (pwr.connected && pwr.termuxWakeLockHeld) {
    runExec('termux-wake-unlock', [], 1600);
    sleepSyncMs(180);
    pwr = readAdbPowerSnapshot(adbSerial);
  }
  const heldAfter = Boolean(pwr.termuxWakeLockHeld);
  writeLidSleepState({ wakeLockHeld: heldAfter });
  return { released: !heldAfter, verified: pwr.connected, heldAfter };
}

function findFreezableWorkers(cfg) {
  if (!cfg.freezeNativeWorkerRegex) return [];
  let workerRe;
  try {
    workerRe = new RegExp(cfg.freezeNativeWorkerRegex);
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
  const targets = [];
  for (const r of rows) {
    if (r.pid === process.pid || r.pid === process.ppid) continue;
    if (prootPids.has(r.ppid)) continue; // Never SIGSTOP proot children (ptrace risk)
    if (workerRe.test(r.args)) targets.push(r.pid);
  }
  return targets;
}

function shouldUseOemSoftSleep(cfg) {
  return cfg.oemSoftSleepPreset === 'lenovo-zui'
    || (Array.isArray(cfg.oemStoppablePackages) && cfg.oemStoppablePackages.length > 0);
}

function applyOemSoftSleep(action, cfg, dryRun = false) {
  if (!shouldUseOemSoftSleep(cfg)) return false;
  const oemScript = path.resolve(__dirname, '..', 'scripts', 'oem-soft-sleep.sh');
  if (!dryRun) {
    spawnSync('bash', [oemScript, action], { encoding: 'utf8', timeout: 7000, killSignal: 'SIGKILL' });
  }
  return true;
}

function enterSleepFreeze(reason = 'manual_sleep', meta = {}) {
  const cfg = loadConfig();
  const { logFile } = getLidPaths();
  const dryRun = Boolean(meta.dryRun);
  const cur = readLidSleepState();
  const serial = meta.serial !== undefined ? meta.serial : getAdbDeviceSerial();
  const bat = meta.battery || readTermuxBatteryLight();
  const actions = [];

  const workerPids = findFreezableWorkers(cfg);
  const frozenPids = [];
  if (workerPids.length > 0 && !dryRun) {
    for (const pid of workerPids) {
      try {
        process.kill(pid, 'SIGSTOP');
        frozenPids.push(pid);
      } catch {}
    }
    if (frozenPids.length > 0) actions.push(`SIGSTOP workers (${frozenPids.join(',')})`);
  }

  const wlRes = releaseWakeLockVerified(serial, dryRun);
  actions.push(wlRes.verified ? 'Wake-Lock released [ADB verified]' : 'Wake-Lock released');

  if (applyOemSoftSleep('sleep', cfg, dryRun)) {
    actions.push('OEM Soft-Sleep applied');
  }

  if (serial && cfg.forceDeviceIdleOnFreeze) {
    if (!dryRun) {
      runAdb(serial, ['shell', 'dumpsys', 'deviceidle', 'force-idle'], 2000);
    }
    actions.push('Android Deep Doze (force-idle)');
  }

  const nextState = dryRun ? cur : writeLidSleepState({
    asleep: true,
    reason,
    triggerSource: meta.triggerSource || reason,
    enteredAt: cur.asleep && cur.enteredAt ? cur.enteredAt : Date.now(),
    frozenPids: [...new Set([...(cur.frozenPids || []), ...frozenPids])],
    wakeLockHeld: false,
    hallOpen: meta.hallOpen !== undefined ? Boolean(meta.hallOpen) : false,
    lux: meta.lux !== undefined ? meta.lux : cur.lux,
    screenState: meta.screenState || (serial ? 'Asleep' : 'Dark/Lid'),
    isCharging: Boolean(bat && bat.isCharging),
    batteryPct: bat ? bat.pct : cur.batteryPct,
    tempC: bat ? bat.tempC : cur.tempC
  });

  if (!dryRun) {
    appendRotatedLog(
      logFile,
      `[FREEZE] reason=${reason} src=${nextState.triggerSource} bat=${nextState.batteryPct}% temp=${nextState.tempC}C actions=${actions.join(' | ')}`
    );
  }
  return { state: nextState, actions, dryRun };
}

function exitSleepFreeze(reason = 'manual_wake', meta = {}) {
  const cfg = loadConfig();
  const { logFile } = getLidPaths();
  const dryRun = Boolean(meta.dryRun);
  const cur = readLidSleepState();
  const serial = meta.serial !== undefined ? meta.serial : getAdbDeviceSerial();
  const actions = [];

  const toResume = [...new Set(cur.frozenPids || [])];
  if (toResume.length > 0 && !dryRun) {
    for (const pid of toResume) {
      try {
        process.kill(pid, 'SIGCONT');
      } catch {}
    }
    actions.push(`SIGCONT workers (${toResume.join(',')})`);
  }

  if (serial) {
    if (!dryRun) {
      runAdb(serial, ['shell', 'dumpsys', 'deviceidle', 'unforce'], 1800);
    }
    actions.push('Doze unforce');
  }

  if (applyOemSoftSleep('wake', cfg, dryRun)) {
    actions.push('OEM Soft-Sleep restored');
  }

  const sleptSec = cur.enteredAt ? Math.round((Date.now() - cur.enteredAt) / 1000) : 0;
  const nextState = dryRun ? cur : writeLidSleepState({
    asleep: false,
    reason,
    triggerSource: meta.triggerSource || reason,
    wokeAt: Date.now(),
    frozenPids: [],
    hallOpen: meta.hallOpen !== undefined ? Boolean(meta.hallOpen) : true,
    lux: meta.lux !== undefined ? meta.lux : cur.lux,
    screenState: 'Awake',
    relockCount: 0
  });

  if (!dryRun) {
    appendRotatedLog(logFile, `[WAKE] reason=${reason} src=${nextState.triggerSource} sleptSec=${sleptSec}`);
  }
  return { wasAsleep: Boolean(cur.asleep), state: nextState, actions, sleptSec, dryRun };
}

function runDaemonLoop() {
  const { dataDir, pidFile, logFile } = getLidPaths();
  const existing = readLivePid(pidFile, /lid-guard|tablet-guard/);
  if (existing && existing !== process.pid) process.exit(0);

  ensureDir(dataDir);
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
  const cfg = loadConfig();
  spawnSync('taskset', ['-pc', String(cfg.ecoCpuCores || '0,1'), String(process.pid)], { stdio: 'ignore' });
  spawnSync('renice', ['-n', String(cfg.ecoNice || 10), '-p', String(process.pid)], { stdio: 'ignore' });
  appendRotatedLog(logFile, `Lid Guard daemon started PID=${process.pid}`);

  let lastLuxCheckTs = 0;
  let darkSinceTs = 0;
  let suppressedLogged = false;

  const evaluate = () => {
    const liveCfg = loadConfig();
    if (!liveCfg.enabled) return;
    const curState = readLidSleepState();
    const serial = getAdbDeviceSerial();
    const bat = readTermuxBatteryLight();
    const charging = Boolean(bat && bat.isCharging);

    if (serial) {
      const pwr = readAdbPowerSnapshot(serial);
      const isScreenOff = pwr.connected && pwr.wakefulness && pwr.wakefulness !== 'Awake';
      if (isScreenOff && !charging && !curState.asleep && liveCfg.freezeOnScreenOffUnplugged) {
        if (!darkSinceTs) darkSinceTs = Date.now();
        if ((Date.now() - darkSinceTs) >= Number(liveCfg.screenOffBackpackSec || 45) * 1000) {
          enterSleepFreeze('screen_off_backpack', { triggerSource: 'adb_power', serial, battery: bat });
        }
      } else if (pwr.connected && pwr.wakefulness === 'Awake') {
        darkSinceTs = 0;
        if (curState.asleep) exitSleepFreeze('adb_screen_awake', { triggerSource: 'adb_power', serial });
      }
      return;
    }

    // Fallback when ADB is offline: Hall + Lux sensor polling
    const now = Date.now();
    const needLight = !curState.asleep && liveCfg.darkBagGuardNoAdb && !charging && (now - lastLuxCheckTs >= 90000);
    const sensor = readSensorsTermux(liveCfg, needLight);
    if (!sensor) return;
    if (needLight) lastLuxCheckTs = now;

    if (sensor.hallOpen === false && liveCfg.freezeOnHallLid && (!charging || liveCfg.freezeWhenChargingLid)) {
      darkSinceTs = 0;
      suppressedLogged = false;
      if (!curState.asleep) {
        enterSleepFreeze('hall_sensor_closed', { triggerSource: 'termux_sensor', hallOpen: false, serial: '', battery: bat });
      }
      return;
    }

    if (curState.asleep) {
      const light = (sensor.lux !== null) ? sensor : readSensorsTermux(liveCfg, true);
      const decision = evaluateDarkBagWakeGuard({
        curAsleep: true,
        hallOpen: sensor.hallOpen !== false,
        lux: light ? light.lux : null,
        charging,
        activeWork: false,
        cfg: liveCfg
      });
      if (decision.action === 'stay_asleep' && decision.reason === 'dark_bag_lux_guard') {
        if (!suppressedLogged) {
          suppressedLogged = true;
          appendRotatedLog(logFile, `[GUARD] Suppressed false hallOpen in dark bag (${decision.lux.toFixed(2)} lux < ${decision.threshold})`);
        }
        return;
      }
      if (decision.action === 'wake') {
        suppressedLogged = false;
        exitSleepFreeze('hall_sensor_open', { triggerSource: 'termux_sensor', hallOpen: true, lux: decision.lux, serial: '' });
      }
    }
  };

  evaluate();
  const timer = setInterval(evaluate, 30000);
  const shutdown = () => {
    clearInterval(timer);
    removeOwnPidFile(pidFile, process.pid);
    appendRotatedLog(logFile, `Lid Guard daemon stopped PID=${process.pid}`);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function getLidGuardStatus() {
  const cfg = loadConfig();
  const { pidFile, logFile } = getLidPaths();
  const pid = readLivePid(pidFile, /lid-guard|tablet-guard/);
  const state = readLidSleepState();
  const serial = getAdbDeviceSerial();
  const bat = readTermuxBatteryLight();
  return { pid, running: pid > 0, state, serial, battery: bat, config: cfg, logFile };
}

function startDaemon(binPath) {
  const { dataDir, pidFile, logFile } = getLidPaths();
  const existing = readLivePid(pidFile, /lid-guard|tablet-guard/);
  if (existing) return { started: false, pid: existing };
  ensureDir(dataDir);
  const outFd = fs.openSync(logFile, 'a');
  const ch = spawn(process.execPath, [binPath, 'lid-daemon-loop'], { detached: true, stdio: ['ignore', outFd, outFd] });
  ch.unref();
  fs.writeFileSync(pidFile, `${ch.pid}\n`, 'utf8');
  return { started: true, pid: ch.pid };
}

function stopDaemon() {
  const { pidFile } = getLidPaths();
  return stopPidAndWait(pidFile, /lid-guard|tablet-guard/, 2000);
}

module.exports = {
  DEFAULT_LID_STATE,
  getLidPaths,
  readLidSleepState,
  writeLidSleepState,
  parseAdbPowerOutput,
  parseSensorPayload,
  evaluateDarkBagWakeGuard,
  releaseWakeLockVerified,
  enterSleepFreeze,
  exitSleepFreeze,
  getLidGuardStatus,
  startDaemon,
  stopDaemon,
  runDaemonLoop
};
