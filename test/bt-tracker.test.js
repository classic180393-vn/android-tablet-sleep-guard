'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('bt-battery-tracker splits active vs sleep hours and calibrates step resolution', () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'atsg_bt_test_'));
  process.env.ATSG_DATA_DIR = tmpData;
  const snapPath = path.join(tmpData, 'snap.json');
  process.env.ATSG_BT_SNAPSHOT = snapPath;

  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/bt-battery-tracker')];
  const tracker = require('../src/bt-battery-tracker');

  const t0 = 1795000000000;
  tracker.recordPeripheralSample({ ts: t0, pct: 80, conn: true, isPlugged: false, lidAsleep: false, src: 'api' });
  tracker.recordPeripheralSample({ ts: t0 + 1800000, pct: 80, conn: true, isPlugged: false, lidAsleep: false, src: 'api' }); // coalesced!
  tracker.recordPeripheralSample({ ts: t0 + 4 * 3600000, pct: 78, conn: true, isPlugged: false, lidAsleep: false, src: 'api' });
  const h = tracker.recordPeripheralSample({ ts: t0 + 8 * 3600000, pct: 76, conn: true, isPlugged: false, lidAsleep: false, src: 'api' });

  assert.equal(h.diffSamples.length, 3);
  assert.equal(h.meta.observedStepPct, 2);
  assert.equal(h.stats.confidence, 'calibrated');
  assert.equal(h.stats.totalPctDrop, 4);
  assert.equal(h.stats.learnedDrainPctPerDay, 12);

  // Also test charging gain measurement
  tracker.recordPeripheralSample({ ts: t0 + 8 * 3600000 + 60000, pct: 76, conn: true, isPlugged: true, lidAsleep: false, src: 'cli_charge' });
  const charged = tracker.recordPeripheralSample({ ts: t0 + 8.5 * 3600000 + 60000, pct: 96, conn: true, isPlugged: true, lidAsleep: false, src: 'cli_charge' });
  assert.equal(charged.stats.chargingPctGain, 20);
  assert.ok(charged.stats.chargingPctPerHr > 0);

  fs.writeFileSync(snapPath, JSON.stringify({
    ok: true,
    ts: t0 + 9 * 3600000,
    devices: [{ addr: 'AA:BB:CC:DD:EE:FF', name: 'Wireless Keyboard', conn: true, bat: 76, src: 'api' }]
  }));
  const synced = tracker.syncFromSnapshotFile();
  assert.equal(synced.keyboard.bat, 76);

  fs.rmSync(tmpData, { recursive: true, force: true });
  delete process.env.ATSG_DATA_DIR;
  delete process.env.ATSG_BT_SNAPSHOT;
});
