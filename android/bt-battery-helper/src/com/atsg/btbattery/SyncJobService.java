package com.atsg.btbattery;

import android.app.job.JobParameters;
import android.app.job.JobService;

public class SyncJobService extends JobService {
  private volatile boolean cancelled = false;

  @Override
  public boolean onStartJob(final JobParameters params) {
    cancelled = false;
    new Thread(() -> {
      if (!cancelled) {
        BtBatteryCollector.collectAndSave(getApplicationContext(), true);
      }
      jobFinished(params, false);
    }).start();
    return true;
  }

  @Override
  public boolean onStopJob(JobParameters params) {
    cancelled = true;
    return true;
  }
}
