'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getConfigDir() {
  return process.env.ATSG_CONFIG_DIR || path.join(os.homedir(), '.config', 'android-tablet-sleep-guard');
}

function getDataDir() {
  return process.env.ATSG_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'android-tablet-sleep-guard');
}

function getConfigPath() {
  return process.env.ATSG_CONFIG || path.join(getConfigDir(), 'config.json');
}

const DEFAULT_CONFIG = {
  deviceName: 'Android Tablet (Termux)',
  enabled: true,
  ecoCpuCores: '0,1',
  ecoNice: 10,
  sampleIntervalSec: 60,
  flushHeartbeatMin: 5,
  idleWakeUnlockMin: 5,
  autoOptimize: true,
  hallSensorPattern: 'hall|magnetic|lid',
  lightSensorPattern: 'light|als|lux',
  freezeOnHallLid: true,
  freezeOnScreenOffUnplugged: true,
  freezeWhenChargingLid: false,
  lidSettleDelayMs: 2000,
  screenOffBackpackSec: 45,
  darkBagGuardNoAdb: true,
  darkLuxThreshold: 0.8,
  darkBagConfirmSec: 180,
  wakeInBagRelock: true,
  darkBagScreenTimeoutMs: 30000,
  forceDeviceIdleOnFreeze: true,
  oemSoftSleepPreset: 'none',
  oemStoppablePackages: [],
  freezeNativeWorkerRegex: '',
  autoPinHelperRegex: 'lid-guard|battery-habit|tablet-guard',
  btSnapshotPath: process.env.ATSG_BT_SNAPSHOT || '/storage/emulated/0/Download/.atsg_bt_battery.json',
  btHelperPackage: 'com.atsg.btbattery',
  btDevices: {
    keyboard: { pattern: 'Wireless Keyboard|Keyboard|BT.*Keyboard', name: 'Wireless Keyboard', designMah: 500 },
    mouse: { pattern: 'Mouse|BT.*Mouse', name: 'Bluetooth Mouse', designMah: 1000 },
    pen: { pattern: 'Stylus|Pen', name: 'Bluetooth Stylus', designMah: 60 }
  }
};

function loadConfig(overridePath = null) {
  const cfgPath = overridePath || getConfigPath();
  let userCfg = {};
  try {
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        userCfg = parsed;
      }
    }
  } catch {}
  const merged = {
    ...DEFAULT_CONFIG,
    ...userCfg,
    btDevices: {
      ...DEFAULT_CONFIG.btDevices,
      ...(userCfg.btDevices || {})
    }
  };
  if (process.env.ATSG_BT_SNAPSHOT) {
    merged.btSnapshotPath = process.env.ATSG_BT_SNAPSHOT;
  }
  return merged;
}

module.exports = {
  DEFAULT_CONFIG,
  getConfigDir,
  getDataDir,
  getConfigPath,
  loadConfig
};
