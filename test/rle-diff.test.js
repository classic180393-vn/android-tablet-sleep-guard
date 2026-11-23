'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_LOCAL_SAMPLES,
  createDefaultState,
  coalesceSamplesDiff,
  parseBatteryStatusJson,
  parseAdbBatteryDump,
  recordSample,
  computeAnalytics
} = require('../src/battery-habit');

test('coalesceSamplesDiff merges identical steady samples into RLE spans', () => {
  const t0 = 1795000000000;
  const raw = [
    { ts: t0, pct: 90, isCharging: false, currentMa: 900, tempC: 30.0, cpu: 20, wakeLock: false },
    { ts: t0 + 60000, pct: 90, isCharging: false, currentMa: 940, tempC: 30.1, cpu: 22, wakeLock: false },
    { ts: t0 + 120000, pct: 90, isCharging: false, currentMa: 1850, tempC: 30.4, cpu: 30, wakeLock: false }, // delta mA >= 350 -> new bucket
    { ts: t0 + 180000, pct: 89, isCharging: false, currentMa: 1800, tempC: 30.4, cpu: 30, wakeLock: false }  // pct changed -> new bucket
  ];
  const coalesced = coalesceSamplesDiff(raw, MAX_LOCAL_SAMPLES);
  assert.equal(coalesced.length, 3);
  assert.equal(coalesced[0].hits, 2);
  assert.equal(coalesced[0].endTs, t0 + 60000);
  assert.equal(coalesced[1].currentMa, 1850);
  assert.equal(coalesced[2].pct, 89);
});

test('recordSample computes day stats and empirical discharge rate accurately', () => {
  const st = createDefaultState({});
  const t0 = 1795000000000;
  recordSample(st, {
    battery: { ok: true, pct: 90, isCharging: false, plugged: 'UNPLUGGED', currentMa: 1000, powerW: 4.0, tempC: 28.0, chargeCounterMah: 7200 },
    workloads: { totalCpu: 35, wakeLockHeld: false }
  }, 1, t0);
  recordSample(st, {
    battery: { ok: true, pct: 88, isCharging: false, plugged: 'UNPLUGGED', currentMa: 900, powerW: 3.6, tempC: 27.8, chargeCounterMah: 7000 },
    workloads: { totalCpu: 15, wakeLockHeld: false }
  }, 1, t0 + 8 * 3600 * 1000); // 8 hours later -> 0.25%/h

  const an = computeAnalytics(st, { ok: true, pct: 88, isCharging: false, currentMa: 900, chargeCounterMah: 7000 });
  assert.equal(an.empiricalPctPerHour, 0.25);
  assert.equal(an.estRemainHours, 7.8);
});

test('parseBatteryStatusJson and parseAdbBatteryDump normalize fields', () => {
  const tJson = parseBatteryStatusJson(JSON.stringify({
    percentage: 80, plugged: 'UNPLUGGED', status: 'DISCHARGING', temperature: 28.0, voltage: 4000, current: 500000, charge_counter: 6000000, cycle: 12
  }));
  assert.equal(tJson.pct, 80);
  assert.equal(tJson.currentMa, 500);
  assert.equal(tJson.isCharging, false);

  const adbParsed = parseAdbBatteryDump('  AC powered: true\n  level: 56\n  voltage: 4200\n  temperature: 345\n  Charge counter: 6120000\n');
  assert.equal(adbParsed.pct, 56);
  assert.equal(adbParsed.isCharging, true);
  assert.equal(adbParsed.tempC, 34.5);
});
