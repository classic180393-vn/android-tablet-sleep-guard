package com.atsg.btbattery;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.ComponentName;
import android.content.Context;
import android.os.Environment;
import android.os.PowerManager;
import android.util.Log;
import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class BtBatteryCollector {
  public static final String TAG = "AtsgBtBattery";
  public static final int JOB_ID = 101;
  public static final long PERIODIC_INTERVAL_MS = 2L * 3600L * 1000L;
  public static final long PERIODIC_FLEX_MS = 30L * 60L * 1000L;

  private static final UUID UUID_BAS = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb");
  private static final UUID UUID_BAT_LVL = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb");

  private BtBatteryCollector() {}

  public static void schedulePeriodicSync(Context ctx) {
    try {
      JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
      if (js == null) return;
      JobInfo existing = js.getPendingJob(JOB_ID);
      if (existing != null && existing.getIntervalMillis() == PERIODIC_INTERVAL_MS) {
        return;
      }
      JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, SyncJobService.class))
          .setPeriodic(PERIODIC_INTERVAL_MS, PERIODIC_FLEX_MS)
          .setPersisted(true)
          .build();
      js.schedule(job);
    } catch (Throwable t) {
      Log.e(TAG, "schedulePeriodicSync failed", t);
    }
  }

  public static String collectAndSave(Context ctx, boolean skipGatt) {
    String json = collectJson(ctx, skipGatt);
    try {
      File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
      if (!dir.exists()) dir.mkdirs();
      File tmp = new File(dir, ".atsg_bt_battery.json.tmp");
      File out = new File(dir, ".atsg_bt_battery.json");
      try (FileOutputStream fos = new FileOutputStream(tmp)) {
        fos.write((json + "\n").getBytes(StandardCharsets.UTF_8));
      }
      if (!tmp.renameTo(out)) {
        try (FileOutputStream fos = new FileOutputStream(out)) {
          fos.write((json + "\n").getBytes(StandardCharsets.UTF_8));
        }
        tmp.delete();
      }
    } catch (Throwable e) {
      Log.e(TAG, "Write snapshot failed", e);
    }
    return json;
  }

  private static String esc(String s) {
    if (s == null || s.isEmpty()) return "";
    StringBuilder out = new StringBuilder(s.length() + 8);
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '\\': out.append("\\\\"); break;
        case '"': out.append("\\\""); break;
        case '\b': out.append("\\b"); break;
        case '\f': out.append("\\f"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        default:
          if (c < 0x20) {
            out.append("\\u00");
            out.append(Character.forDigit((c >> 4) & 0xF, 16));
            out.append(Character.forDigit(c & 0xF, 16));
          } else {
            out.append(c);
          }
      }
    }
    return out.toString();
  }

  public static String collectJson(Context ctx, boolean skipGatt) {
    try {
      PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
      boolean screenOn = pm != null && pm.isInteractive();
      BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
      BluetoothAdapter ad = bm != null ? bm.getAdapter() : null;
      if (ad == null) return "{\"ok\":false,\"err\":\"no_adapter\",\"screenOn\":" + screenOn + "}";
      boolean btOn = ad.isEnabled();
      Set<BluetoothDevice> bonded = ad.getBondedDevices();
      if (bonded == null) return "{\"ok\":false,\"err\":\"no_bonded\",\"screenOn\":" + screenOn + ",\"btOn\":" + btOn + "}";

      Method getBattM = null;
      Method isConnM = null;
      try { getBattM = BluetoothDevice.class.getMethod("getBatteryLevel"); } catch (Throwable ignored) {}
      try { isConnM = BluetoothDevice.class.getMethod("isConnected"); } catch (Throwable ignored) {}

      List<BluetoothDevice> needGatt = new ArrayList<>();
      final Map<String, Integer> batMap = new ConcurrentHashMap<>();
      final Map<String, String> srcMap = new ConcurrentHashMap<>();
      final List<BluetoothDevice> devs = new ArrayList<>();

      for (BluetoothDevice d : bonded) {
        devs.add(d);
        boolean conn = false;
        if (isConnM != null) {
          try { conn = Boolean.TRUE.equals(isConnM.invoke(d)); } catch (Throwable ignored) {}
        }
        int lvl = -1;
        if (getBattM != null) {
          try {
            Object v = getBattM.invoke(d);
            if (v instanceof Integer) lvl = (Integer) v;
          } catch (Throwable ignored) {}
        }
        if (lvl >= 0 && lvl <= 100) {
          batMap.put(d.getAddress(), lvl);
          srcMap.put(d.getAddress(), "api");
        } else if (!skipGatt && conn && d.getType() != BluetoothDevice.DEVICE_TYPE_CLASSIC) {
          needGatt.add(d);
        }
      }

      if (!needGatt.isEmpty()) {
        final CountDownLatch latch = new CountDownLatch(needGatt.size());
        for (final BluetoothDevice d : needGatt) {
          d.connectGatt(ctx.getApplicationContext(), false, new BluetoothGattCallback() {
            private void done(BluetoothGatt g) {
              try { g.close(); } catch (Throwable ignored) {}
              latch.countDown();
            }
            @Override
            public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
              if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                if (!g.discoverServices()) done(g);
              } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                done(g);
              }
            }
            @Override
            public void onServicesDiscovered(BluetoothGatt g, int status) {
              if (status == BluetoothGatt.GATT_SUCCESS) {
                BluetoothGattService svc = g.getService(UUID_BAS);
                if (svc != null) {
                  BluetoothGattCharacteristic ch = svc.getCharacteristic(UUID_BAT_LVL);
                  if (ch != null && g.readCharacteristic(ch)) return;
                }
              }
              done(g);
            }
            @Override
            public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value, int status) {
              if (status == BluetoothGatt.GATT_SUCCESS && value != null && value.length > 0) {
                batMap.put(d.getAddress(), value[0] & 0xFF);
                srcMap.put(d.getAddress(), "gatt");
              }
              done(g);
            }
            @Override
            @SuppressWarnings("deprecation")
            public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
              if (status == BluetoothGatt.GATT_SUCCESS) {
                byte[] value = ch.getValue();
                if (value != null && value.length > 0) {
                  batMap.put(d.getAddress(), value[0] & 0xFF);
                  srcMap.put(d.getAddress(), "gatt");
                }
              }
              done(g);
            }
          }, BluetoothDevice.TRANSPORT_LE);
        }
        latch.await(4500, TimeUnit.MILLISECONDS);
      }

      StringBuilder sb = new StringBuilder();
      sb.append("{\"ok\":true,\"ts\":").append(System.currentTimeMillis())
        .append(",\"screenOn\":").append(screenOn)
        .append(",\"btOn\":").append(btOn)
        .append(",\"devices\":[");
      for (int i = 0; i < devs.size(); i++) {
        BluetoothDevice d = devs.get(i);
        boolean conn = false;
        if (isConnM != null) {
          try { conn = Boolean.TRUE.equals(isConnM.invoke(d)); } catch (Throwable ignored) {}
        }
        Integer lvl = batMap.get(d.getAddress());
        if (i > 0) sb.append(",");
        sb.append("{\"addr\":\"").append(esc(d.getAddress()))
          .append("\",\"name\":\"").append(esc(d.getName()))
          .append("\",\"conn\":").append(conn)
          .append(",\"bat\":").append(lvl != null ? lvl : -1)
          .append(",\"src\":\"").append(esc(srcMap.get(d.getAddress()))).append("\"}");
      }
      sb.append("]}");
      return sb.toString();
    } catch (Throwable t) {
      return "{\"ok\":false,\"err\":\"" + esc(t.toString()) + "\"}";
    }
  }
}
