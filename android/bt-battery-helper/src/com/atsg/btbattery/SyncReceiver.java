package com.atsg.btbattery;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;

public class SyncReceiver extends BroadcastReceiver {
  public static final String ACTION_SYNC = "com.atsg.btbattery.ACTION_SYNC";
  private static final long MIN_INTERVAL_MS = 60L * 1000L;
  private static final Object LOCK = new Object();
  private static long lastSyncElapsedMs = -MIN_INTERVAL_MS;

  @Override
  public void onReceive(final Context ctx, final Intent intent) {
    if (ctx == null || intent == null || !ACTION_SYNC.equals(intent.getAction())) {
      return;
    }
    long now = SystemClock.elapsedRealtime();
    synchronized (LOCK) {
      if ((now - lastSyncElapsedMs) < MIN_INTERVAL_MS) {
        return;
      }
      lastSyncElapsedMs = now;
    }

    final Context appCtx = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
    final PendingResult pending = goAsync();
    final boolean quick = intent.getBooleanExtra("quick", true);
    new Thread(() -> {
      try {
        BtBatteryCollector.collectAndSave(appCtx, quick);
      } finally {
        if (pending != null) {
          try { pending.finish(); } catch (Throwable ignored) {}
        }
      }
    }).start();
  }
}
