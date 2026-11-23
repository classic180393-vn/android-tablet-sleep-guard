'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAdbPowerOutput,
  parseSensorPayload,
  evaluateDarkBagWakeGuard
} = require('../src/lid-guard');

test('evaluateDarkBagWakeGuard suppresses false wakeups inside dark bag', () => {
  const cfg = { darkBagGuardNoAdb: true, darkLuxThreshold: 0.8 };
  const blocked = evaluateDarkBagWakeGuard({
    curAsleep: true,
    hallOpen: true,
    lux: 0.0,
    charging: false,
    activeWork: false,
    cfg
  });
  assert.equal(blocked.action, 'stay_asleep');
  assert.equal(blocked.reason, 'dark_bag_lux_guard');

  const allowed = evaluateDarkBagWakeGuard({
    curAsleep: true,
    hallOpen: true,
    lux: 116.5,
    charging: false,
    activeWork: false,
    cfg
  });
  assert.equal(allowed.action, 'wake');
  assert.equal(allowed.reason, 'hall_sensor_open');
});

test('parseSensorPayload handles Hall + Ambient Light sensors safely', () => {
  const res = parseSensorPayload(JSON.stringify({
    'Generic Hall Effect Sensor Non-wakeup': { values: [0] },
    'Generic Ambient Light Sensor Non-wakeup': { values: [14.2] }
  }));
  assert.equal(res.hallOpen, false);
  assert.equal(res.lux, 14.2);
});

test('parseAdbPowerOutput extracts wakefulness and Termux partial wake-locks', () => {
  const dump = [
    'mWakefulness=Asleep',
    'mIsPowered=false',
    'mBatteryLevel=84',
    'mLastSleepReason=lid',
    'PARTIAL_WAKE_LOCK \'termux:service-wakelock\' ACQ=-2m'
  ].join('\n');
  const p = parseAdbPowerOutput(dump, '127.0.0.1:5555');
  assert.equal(p.connected, true);
  assert.equal(p.wakefulness, 'Asleep');
  assert.equal(p.termuxWakeLockHeld, true);
  assert.equal(p.batteryPct, 84);
});
