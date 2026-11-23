package com.atsg.btbattery;

import android.bluetooth.BluetoothAdapter;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BtEventReceiver extends BroadcastReceiver {
  private static final long MIN_INTERVAL_MS = 60L * 1000L;
  private static volatile long lastEventSyncMs = 0L;

  @Override
  public void onReceive(final Context ctx, final Intent intent) {
    if (intent == null || intent.getAction() == null) return;
    if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(intent.getAction())) {
      int st = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1);
      if (st != BluetoothAdapter.STATE_ON && st != BluetoothAdapter.STATE_OFF) return;
    }
    long now = System.currentTimeMillis();
    if ((now - lastEventSyncMs) < MIN_INTERVAL_MS) return;
    lastEventSyncMs = now;

    final PendingResult pending = goAsync();
    new Thread(() -> {
      try {
        BtBatteryCollector.collectAndSave(ctx.getApplicationContext(), true);
      } finally {
        try { pending.finish(); } catch (Throwable ignored) {}
      }
    }).start();
  }
}
