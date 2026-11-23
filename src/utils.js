'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, defaults = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...defaults, ...parsed };
      }
    }
  } catch {}
  return { ...defaults };
}

function writeJsonAtomic(filePath, obj, compact = false) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}`;
  const payload = compact
    ? `${JSON.stringify(obj)}\n`
    : `${JSON.stringify(obj, null, 2)}\n`;
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, filePath);
}

function runShell(cmd, timeoutMs = 2500) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function runExec(bin, args = [], timeoutMs = 2500) {
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

function parseAdbDevicesOutput(out, preferredSerial = '') {
  if (!out || typeof out !== 'string') return '';
  const connected = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === 'device') {
      connected.push(parts[0]);
    }
  }
  if (connected.length === 0) return '';
  const pref = String(preferredSerial || '').trim();
  if (pref) {
    return connected.includes(pref) ? pref : '';
  }
  return connected[0];
}

function getAdbDeviceSerial() {
  const out = runExec('adb', ['devices'], 1200);
  return parseAdbDevicesOutput(out, process.env.ANDROID_SERIAL || '');
}

function runAdb(serial, adbArgs = [], timeoutMs = 2500) {
  const targetSerial = serial || getAdbDeviceSerial();
  if (!targetSerial) return '';
  return runExec('adb', ['-s', targetSerial, ...adbArgs], timeoutMs);
}

function isValidAndroidPackageName(pkg) {
  return typeof pkg === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(pkg);
}

function getAllCpuCoresRange(cpuCount = (Array.isArray(os.cpus()) ? os.cpus().length : 0)) {
  const n = Number(cpuCount);
  if (!Number.isFinite(n) || n <= 1) return '0';
  return `0-${Math.floor(n) - 1}`;
}

function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function appendRotatedLog(logFile, msg, maxBytes = 128 * 1024, keepBytes = 32 * 1024) {
  try {
    ensureDir(path.dirname(logFile));
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(logFile, `[${stamp}] ${msg}\n`, 'utf8');
    const st = fs.statSync(logFile);
    if (st.size > maxBytes) {
      const tail = fs.readFileSync(logFile, 'utf8').slice(-keepBytes);
      fs.writeFileSync(logFile, tail, 'utf8');
    }
  } catch {}
}

function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localHourKey(ts = Date.now()) {
  return String(new Date(ts).getHours()).padStart(2, '0');
}

function formatDuration(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h${String(rem).padStart(2, '0')}m` : `${h}h`;
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    try {
      if (fs.existsSync(`/proc/${pid}/stat`)) {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rparen = stat.lastIndexOf(')');
        if (rparen !== -1 && stat.slice(rparen + 2, rparen + 3) === 'Z') {
          return false;
        }
      }
    } catch {}
    return true;
  } catch {
    return false;
  }
}

function readLivePid(pidFile, matchPattern = null) {
  try {
    if (!fs.existsSync(pidFile)) return 0;
    const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
    if (!isPidAlive(pid)) return 0;
    if (matchPattern && fs.existsSync('/proc')) {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!matchPattern.test(cmdline)) return 0;
    }
    return pid;
  } catch {
    return 0;
  }
}

function removeOwnPidFile(pidFile, pid = process.pid) {
  try {
    if (!fs.existsSync(pidFile)) return;
    const cur = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
    if (cur === pid) fs.unlinkSync(pidFile);
  } catch {}
}

function stopPidAndWait(pidFile, matchPattern = null, timeoutMs = 2000) {
  const pid = readLivePid(pidFile, matchPattern);
  if (!pid) {
    try { fs.unlinkSync(pidFile); } catch {}
    return { stopped: false, pid: 0 };
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 2000);
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break;
    sleepSyncMs(50);
  }
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    const killDeadline = Date.now() + 250;
    while (Date.now() < killDeadline && isPidAlive(pid)) {
      sleepSyncMs(30);
    }
  }
  try { fs.unlinkSync(pidFile); } catch {}
  return { stopped: true, pid };
}

module.exports = {
  ensureDir,
  readJsonSafe,
  writeJsonAtomic,
  runShell,
  runExec,
  parseAdbDevicesOutput,
  getAdbDeviceSerial,
  runAdb,
  isValidAndroidPackageName,
  getAllCpuCoresRange,
  sleepSyncMs,
  appendRotatedLog,
  localDateKey,
  localHourKey,
  formatDuration,
  isPidAlive,
  readLivePid,
  removeOwnPidFile,
  stopPidAndWait
};
