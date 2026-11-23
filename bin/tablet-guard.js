#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getConfigDir, getConfigPath, getDataDir, loadConfig } = require('../src/config');
const { ensureDir, formatDuration, writeJsonAtomic, getAllCpuCoresRange } = require('../src/utils');
const lidGuard = require('../src/lid-guard');
const batteryHabit = require('../src/battery-habit');
const btTracker = require('../src/bt-battery-tracker');

const cmd = String(process.argv[2] || 'status').toLowerCase();
const sub = String(process.argv[3] || '').toLowerCase();

function printHelp() {
  console.log([
    'android-tablet-sleep-guard (tablet-guard) — CLI',
    '',
    'Usage:',
    '  tablet-guard init                  Create default config & data directories',
    '  tablet-guard status                Show Lid Guard, Battery Habit & daemon status',
    '  tablet-guard sleep [--dry-run]     Enter Deep-Freeze (unlock wake-lock + Doze + stop workers)',
    '  tablet-guard wake  [--dry-run]     Wake from Deep-Freeze (SIGCONT + unforce Doze)',
    '  tablet-guard eco                   Pin daemons to E-cores (0,1), nice +10 & release Wake-Lock',
    `  tablet-guard perf                  Restore daemons to all CPU cores (${getAllCpuCoresRange()}), nice 0`,
    '  tablet-guard battery               Show tablet battery telemetry, RLE diff stats & drain rate',
    '  tablet-guard bt-sync               Trigger Android BT helper & record peripheral battery snapshot',
    '  tablet-guard bt-report             Show detachable Bluetooth keyboard battery report',
    '  tablet-guard daemon start|stop|restart|status   Manage background daemons',
    '  tablet-guard help                  Show this help'
  ].join('\n'));
}

if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
  printHelp();
  process.exit(0);
}

if (cmd === 'lid-daemon-loop') {
  lidGuard.runDaemonLoop();
  return;
}
if (cmd === 'habit-daemon-loop') {
  batteryHabit.runDaemonLoop();
  return;
}

if (cmd === 'init') {
  ensureDir(getConfigDir());
  ensureDir(getDataDir());
  const cfgPath = getConfigPath();
  if (!fs.existsSync(cfgPath)) {
    const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'examples', 'config.example.json'), 'utf8'));
    writeJsonAtomic(cfgPath, example);
    console.log(`Created config: ${cfgPath}`);
  } else {
    console.log(`Config already exists: ${cfgPath}`);
  }
  process.exit(0);
}

const dryRun = process.argv.includes('--dry-run');

if (cmd === 'sleep') {
  const res = lidGuard.enterSleepFreeze('manual_cli_sleep', { dryRun });
  console.log(`Deep-Freeze ${dryRun ? '[DRY-RUN] ' : ''}applied: ${res.actions.join(' | ')}`);
  process.exit(0);
}

if (cmd === 'wake') {
  const res = lidGuard.exitSleepFreeze('manual_cli_wake', { dryRun });
  console.log(`Awake ${dryRun ? '[DRY-RUN] ' : ''}(slept ${res.sleptSec}s): ${res.actions.join(' | ')}`);
  process.exit(0);
}

if (cmd === 'eco') {
  const cfg = loadConfig();
  const pinned = batteryHabit.pinHelpersToEcoCores(cfg, false);
  const wl = lidGuard.releaseWakeLockVerified('', dryRun);
  console.log(`Eco Mode enabled: pinned PIDs=[${pinned.join(',') || 'none'}] to E-cores (${cfg.ecoCpuCores}), wakeLockReleased=${wl.released}`);
  process.exit(0);
}

if (cmd === 'perf') {
  const cfg = loadConfig();
  const restored = batteryHabit.pinHelpersToEcoCores(cfg, true);
  console.log(`Performance Mode restored: PIDs=[${restored.join(',') || 'none'}] -> cores ${getAllCpuCoresRange()}`);
  process.exit(0);
}

if (cmd === 'battery') {
  const st = batteryHabit.loadHabitState();
  const bat = batteryHabit.readBatterySnapshot();
  const an = batteryHabit.computeAnalytics(st, bat);
  console.log([
    '=== Tablet Battery Telemetry & RLE Habit Summary ===',
    `  • Level        : ${bat.ok ? `${bat.pct}% (${bat.status} | ${bat.plugged})` : 'unavailable (install termux-api)'}`,
    `  • Current/Temp : ${bat.currentMa} mA (${bat.powerW} W) @ ${bat.voltageMv} mV | ${bat.tempC} C`,
    `  • Charge/Cycle : ${bat.chargeCounterMah} mAh | Cycle ${bat.cycle} (${bat.health})`,
    `  • Drain Rate   : ${an.empiricalPctPerHour != null ? `${an.empiricalPctPerHour}%/h` : 'collecting'} | Est Left: ${an.estRemainHours != null ? `~${an.estRemainHours}h` : '--'}`,
    `  • Storage      : ${st.totals.samples} samples -> ${(st.recentSamples || []).length}/${batteryHabit.MAX_LOCAL_SAMPLES} RLE diff points (${st.totals.skippedDiskWrites} writes skipped)`,
    `  • Totals       : Unplugged ${formatDuration(st.totals.unpluggedMin)} | Charging ${formatDuration(st.totals.chargingMin)} | Wake-Lock waste ${formatDuration(st.totals.idleWakeLockWasteMin)}`
  ].join('\n'));
  process.exit(0);
}

if (cmd === 'bt-sync') {
  const res = btTracker.triggerAndroidBtSync();
  console.log(btTracker.formatBtReport());
  if (!res || !res.keyboard) process.exitCode = 1;
  process.exit();
}

if (cmd === 'bt-report') {
  btTracker.syncFromSnapshotFile();
  console.log(btTracker.formatBtReport());
  process.exit(0);
}

if (cmd === 'daemon') {
  if (sub === 'start') {
    const l = lidGuard.startDaemon(__filename);
    const b = batteryHabit.startDaemon(__filename);
    console.log(`Lid Guard: ${l.started ? `started PID=${l.pid}` : `already running PID=${l.pid}`}`);
    console.log(`Battery Habit: ${b.started ? `started PID=${b.pid}` : `already running PID=${b.pid}`}`);
    process.exit(0);
  }
  if (sub === 'stop') {
    const l = lidGuard.stopDaemon();
    const b = batteryHabit.stopDaemon();
    console.log(`Lid Guard: ${l.stopped ? `stopped PID=${l.pid}` : 'not running'}`);
    console.log(`Battery Habit: ${b.stopped ? `stopped PID=${b.pid}` : 'not running'}`);
    process.exit(0);
  }
  if (sub === 'restart') {
    lidGuard.stopDaemon();
    batteryHabit.stopDaemon();
    const l = lidGuard.startDaemon(__filename);
    const b = batteryHabit.startDaemon(__filename);
    console.log(`Restarted daemons -> Lid PID=${l.pid}, Battery PID=${b.pid}`);
    process.exit(0);
  }
}

// Default: 'status' or 'daemon status'
const lid = lidGuard.getLidGuardStatus();
const hab = batteryHabit.loadHabitState();
const an = batteryHabit.computeAnalytics(hab, lid.battery);
console.log([
  '=== Android Tablet Sleep Guard — Status ===',
  `  • Config       : ${getConfigPath()}`,
  `  • Lid Daemon   : ${lid.running ? `RUNNING (PID ${lid.pid})` : 'STOPPED'}`,
  `  • State        : ${lid.state.asleep ? `ASLEEP (${lid.state.reason})` : `AWAKE (${lid.state.reason || 'active'})`}`,
  `  • ADB Link     : ${lid.serial || 'Offline (using Termux Sensor/API fallback)'}`,
  `  • Tablet Bat   : ${lid.battery ? `${lid.battery.pct}% (${lid.battery.status} | ${lid.battery.tempC}C | ${lid.battery.currentMa}mA)` : 'unavailable'}`,
  `  • Drain/Remain : ${an.empiricalPctPerHour != null ? `${an.empiricalPctPerHour}%/h` : '--%/h'} | Est: ${an.estRemainHours != null ? `~${an.estRemainHours}h` : '--'}`,
  `  • RLE Points   : ${(hab.recentSamples || []).length}/${batteryHabit.MAX_LOCAL_SAMPLES} | Skipped writes: ${hab.totals.skippedDiskWrites || 0}`
].join('\n'));
