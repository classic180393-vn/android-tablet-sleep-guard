# Architecture Notes

## 1. Zero-Dependency Modularity
- **`src/lid-guard.js`**: Evaluates ADB power wakefulness or Termux Hall/Light sensors (`evaluateDarkBagWakeGuard`), orchestrates Wake-Lock release verification (`termux-wake-unlock`), worker `SIGSTOP`/`SIGCONT` suspension (explicitly bypassing `proot` descendants), OEM soft-sleep invocation, and Android Deep Doze transitions.
- **`src/battery-habit.js`**: Collects 60s hardware telemetry (`termux-battery-status` with ADB fallback), applies **Run-Length Encoding (RLE) Diff coalescing** (`coalesceSamplesDiff`), aggregates hourly/daily counters, and manages E-Core affinity (`taskset -pc 0,1`, `renice +10`).
- **`src/bt-battery-tracker.js`**: Reads atomic JSON snapshots exported by `com.atsg.btbattery` (Android Java helper), coalesces steady RLE spans, detects discrete firmware percentage steps, and separates active awake hours from folded-lid sleep hours.

## 2. Why RLE Diff Coalescing?
Continuous minute-by-minute logging produces `1,440` objects/day (~`220 KB`/day). By merging consecutive readings whenever `%`, charging flag, wake-lock state, current (`±350 mA`), temperature (`±0.8°C`), and CPU (`±25%`) stay within tolerance inside a 15-minute window:
- Steady idle periods collapse into a single entry with an incrementing `hits` counter and extended `endTs`.
- Total disk state stays capped under **`30 KB`** (`96` diff samples + `14` day rollups) while avoiding redundant flash writes (`heartbeat` flush every `5m` unless significant diff triggers immediate write).

## 3. Bluetooth Peripheral Measurement Pipeline
1. **Android layer (`com.atsg.btbattery`):** Uses `JobScheduler` (`2h` interval, `skipGatt = true`) plus Bluetooth broadcast events (`BATTERY_LEVEL_CHANGED`, `ACL_CONNECTED`, `ACL_DISCONNECTED`) to query bonded `BluetoothDevice.getBatteryLevel()`, falling back to BLE GATT Battery Service (`0x180F` / `0x2A19`) on manual probes.
2. **Termux analytics layer:** Correlates timestamp deltas against `lid_sleep_state.json` to calculate calibrated daily drain rates without keeping background BLE scans alive.
