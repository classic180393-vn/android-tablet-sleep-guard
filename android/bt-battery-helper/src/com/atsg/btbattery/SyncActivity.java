package com.atsg.btbattery;

import android.app.Activity;
import android.os.Bundle;

public class SyncActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    BtBatteryCollector.schedulePeriodicSync(this);
    new Thread(() -> {
      BtBatteryCollector.collectAndSave(this, false);
      runOnUiThread(this::finish);
    }).start();
  }
}
