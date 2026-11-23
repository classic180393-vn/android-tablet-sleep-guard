package com.atsg.btbattery;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context ctx, Intent intent) {
    if (ctx == null || intent == null) return;
    String action = intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
        && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
      return;
    }
    Context appCtx = ctx.getApplicationContext();
    BtBatteryCollector.schedulePeriodicSync(appCtx != null ? appCtx : ctx);
  }
}
