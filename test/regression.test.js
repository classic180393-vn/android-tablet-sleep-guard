'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { DEFAULT_CONFIG } = require('../src/config');
const {
  parseAdbDevicesOutput,
  getAllCpuCoresRange,
  isValidAndroidPackageName,
  isPidAlive,
  stopPidAndWait
} = require('../src/utils');
const { parseAdbBatteryDump } = require('../src/battery-habit');

test('config DEFAULT_CONFIG uses clean generic ATSG defaults without fallback snapshot or env overrides leaking', () => {
  assert.equal(DEFAULT_CONFIG.btFallbackSnapshotPath, undefined);
  assert.equal(DEFAULT_CONFIG.hallSensorPattern, 'hall|magnetic|lid');
  assert.equal(DEFAULT_CONFIG.lightSensorPattern, 'light|als|lux');
  assert.equal(DEFAULT_CONFIG.btHelperPackage, 'com.atsg.btbattery');
  assert.equal(DEFAULT_CONFIG.btSnapshotPath.endsWith('.atsg_bt_battery.json'), true);
  assert.equal(DEFAULT_CONFIG.btDevices.mouse.designMah, 1000);
});

test('parseAdbDevicesOutput honors ANDROID_SERIAL and filters non-device lines', () => {
  const sample = [
    'List of devices attached',
    '127.0.0.1:5555\tdevice',
    'emulator-5554\tdevice',
    'deadbeef\toffline',
    ''
  ].join('\n');

  assert.equal(parseAdbDevicesOutput(sample, ''), '127.0.0.1:5555');
  assert.equal(parseAdbDevicesOutput(sample, 'emulator-5554'), 'emulator-5554');
  assert.equal(parseAdbDevicesOutput(sample, 'deadbeef'), '');
  assert.equal(parseAdbDevicesOutput(sample, 'nonexistent'), '');
  assert.equal(parseAdbDevicesOutput('List of devices attached\n', ''), '');
});

test('getAllCpuCoresRange formats dynamic CPU ranges', () => {
  assert.equal(getAllCpuCoresRange(1), '0');
  assert.equal(getAllCpuCoresRange(4), '0-3');
  assert.equal(getAllCpuCoresRange(8), '0-7');
  assert.equal(getAllCpuCoresRange(10), '0-9');
  const hostCount = os.cpus().length;
  const expected = hostCount <= 1 ? '0' : `0-${hostCount - 1}`;
  assert.equal(getAllCpuCoresRange(), expected);
});

test('isValidAndroidPackageName accepts valid package IDs and rejects injection payloads', () => {
  assert.equal(isValidAndroidPackageName('com.atsg.btbattery'), true);
  assert.equal(isValidAndroidPackageName('com.lenovo.leos.appstore'), true);
  assert.equal(isValidAndroidPackageName('com.bad;rm -rf /'), false);
  assert.equal(isValidAndroidPackageName('com.foo$(id)'), false);
  assert.equal(isValidAndroidPackageName('singleword'), false);
  assert.equal(isValidAndroidPackageName(''), false);
});

test('parseAdbBatteryDump handles 0% battery level without dropping snapshot', () => {
  const zeroPct = parseAdbBatteryDump('  AC powered: false\n  level: 0\n  voltage: 3300\n  temperature: 250\n');
  assert.ok(zeroPct);
  assert.equal(zeroPct.ok, true);
  assert.equal(zeroPct.pct, 0);
  assert.equal(zeroPct.isCharging, false);
  assert.equal(zeroPct.tempC, 25.0);

  const missingLevel = parseAdbBatteryDump('  AC powered: true\n  voltage: 4200\n');
  assert.equal(missingLevel, null);
});

test('stopPidAndWait waits for target process to terminate and removes pid file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atsg_pid_test_'));
  const pidFile = path.join(tmpDir, 'worker.pid');
  const ch = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 120)); setInterval(() => {}, 1000);'],
    { detached: true, stdio: 'ignore' }
  );
  ch.unref();
  try {
    fs.writeFileSync(pidFile, `${ch.pid}\n`, 'utf8');
    assert.equal(isPidAlive(ch.pid), true);
    const res = stopPidAndWait(pidFile, null, 2000);
    assert.equal(res.stopped, true);
    assert.equal(res.pid, ch.pid);
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(isPidAlive(ch.pid), false);
  } finally {
    try { process.kill(ch.pid, 'SIGKILL'); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exitSleepFreeze invokes OEM Soft-Sleep wake restoration when configured', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atsg_lid_wake_test_'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    oemSoftSleepPreset: 'lenovo-zui',
    oemStoppablePackages: []
  }), 'utf8');

  const prevCfg = process.env.ATSG_CONFIG;
  const prevData = process.env.ATSG_DATA_DIR;
  process.env.ATSG_CONFIG = cfgPath;
  process.env.ATSG_DATA_DIR = tmpDir;

  try {
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/lid-guard')];
    const lidGuard = require('../src/lid-guard');
    const res = lidGuard.exitSleepFreeze('test_wake', { dryRun: true, serial: '' });
    assert.equal(res.actions.includes('OEM Soft-Sleep restored'), true);
  } finally {
    if (prevCfg === undefined) delete process.env.ATSG_CONFIG;
    else process.env.ATSG_CONFIG = prevCfg;
    if (prevData === undefined) delete process.env.ATSG_DATA_DIR;
    else process.env.ATSG_DATA_DIR = prevData;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('oem-soft-sleep.sh activates preset when oemStoppablePackages is [] and rejects unsafe packages', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atsg_oem_test_'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const mockAdb = path.join(binDir, 'adb');
  fs.writeFileSync(mockAdb, [
    '#!/usr/bin/env bash',
    'if [ "${1:-}" = "devices" ]; then',
    '  printf "List of devices attached\\n127.0.0.1:5555\\tdevice\\n"',
    '  exit 0',
    'fi',
    'printf "active\\n"'
  ].join('\n'), 'utf8');
  fs.chmodSync(mockAdb, 0o755);

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'oem-soft-sleep.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH || ''}`,
    ANDROID_SERIAL: '127.0.0.1:5555'
  };

  try {
    const cfgPreset = path.join(tmpDir, 'preset.json');
    fs.writeFileSync(cfgPreset, JSON.stringify({
      oemSoftSleepPreset: 'lenovo-zui',
      oemStoppablePackages: []
    }), 'utf8');
    const resPreset = spawnSync('bash', [scriptPath, 'status'], {
      encoding: 'utf8',
      env: { ...env, ATSG_CONFIG: cfgPreset }
    });
    assert.equal(resPreset.status, 0);
    assert.match(resPreset.stdout, /com\.lenovo\.leos\.appstore/);

    const cfgUnsafe = path.join(tmpDir, 'unsafe.json');
    fs.writeFileSync(cfgUnsafe, JSON.stringify({
      oemSoftSleepPreset: 'none',
      oemStoppablePackages: ['com.example.safe', 'com.bad;echo pwn']
    }), 'utf8');
    const resUnsafe = spawnSync('bash', [scriptPath, 'status'], {
      encoding: 'utf8',
      env: { ...env, ATSG_CONFIG: cfgUnsafe }
    });
    assert.equal(resUnsafe.status, 0);
    assert.match(resUnsafe.stdout, /\[STATUS\] com\.example\.safe/);
    assert.equal(resUnsafe.stdout.includes('pwn'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
