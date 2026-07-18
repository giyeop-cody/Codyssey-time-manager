package kr.codyssey.attendance.service;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

import kr.codyssey.attendance.util.CookieManager;
import kr.codyssey.attendance.util.EvalSync;
import kr.codyssey.attendance.util.GateCheck;

/**
 * 1분 상시 감지 포그라운드 서비스 (W7, 18차).
 *
 * - SyncWorker(15분 주기 하한)로는 커버되지 않는 "입·퇴실 처리 즉시 감지"용.
 * - AlarmManager.setExactAndAllowWhileIdle(ELAPSED_REALTIME_WAKEUP)로 차기 주기를 자기 예약 →
 *   서비스가 OS에 죽어도 1분 뒤 부활. 살아있는 동안은 Handler로 연속 실행.
 * - 각 주기: 짧은 partial wake lock 하에 (설정 ON 시) keep-alive 핑 → GateCheck → EvalSync.
 * - 상시 알림(FGS 필수)은 무소음 채널 — 알람 소리는 codyssey_alarms 채널(NotificationHelper)이 담당.
 */
public class PollingService extends Service {

    public static final String ACTION_START   = "kr.codyssey.attendance.action.POLL_START";
    public static final String ACTION_REFRESH = "kr.codyssey.attendance.action.POLL_REFRESH";
    public static final String ACTION_STOP    = "kr.codyssey.attendance.action.POLL_STOP";

    private static final long TICK_MS = 60 * 1000;
    private static final long FALLBACK_TICK_MS = 5 * 60 * 1000; // 정확 알람 권한 없을 때
    private static final long WAKELOCK_MS = 60 * 1000;
    private static final long RESTART_DELAY_MS = 30 * 1000;     // 20차: 태스크 제거 후 자기 복구 지연
    private static final long TICK_DRIFT_LOG_MS = 3 * 60 * 1000; // 20차: 이 지연 이상이면 진단 로그
    private static final String PREFS_NAME = "codyssey_prefs";
    private static final String LAST_TICK_KEY = "dash_last_tick";
    private static final String EXPECT_TICK_KEY = "dash_expect_at"; // 20차: 차기 틱 예정 시각(지연 계측)
    private static final String CHANNEL_ID = "codyssey_monitor";
    private static final int NOTIF_ID = 10;

    private static HandlerThread thread;
    private static Handler handler;
    private static final AtomicBoolean ticking = new AtomicBoolean(false);

    private final Runnable tickRunnable = this::doTick;
    private PowerManager.WakeLock wakeLock;

    // ===== 수명주기 =====

    @Override
    public void onCreate() {
        super.onCreate();
        kr.codyssey.attendance.util.DiagLog.add(this, "SVC", "상시 감지 서비스 시작 (60초 주기)");
        startForegroundWithNotification();
        synchronized (PollingService.class) {
            if (thread == null) {
                thread = new HandlerThread("codyssey-dash");
                thread.start();
                handler = new Handler(thread.getLooper());
            }
        }
        wakeLock = ((PowerManager) getSystemService(POWER_SERVICE))
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "codyssey:dashTick");
        scheduleNextTick(this);
        handler.postDelayed(tickRunnable, 3000); // 즉시 1회(3초 후) + 이후 1분 주기
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // ACTION_START/ACTION_REFRESH: 알림 문구 갱신 + 예약 보장
        startForegroundWithNotification();
        scheduleNextTick(this);
        return START_STICKY; // OS가 죽이면 자동 복구 (인텐트 null → 주기 유지)
    }

    // 20차: 사용자가 최근 앱 목록에서 스와이프로 제거한 경우.
    // 삼성 등 제조사는 이 시점에 FGS를 죽이는 경우가 많은데 복구 예약이 전혀 없면
    // 앱을 다시 열기 전까지 1분 감지이 멈춰 알람이 오지 않는다 ("창을 키면 바로 옴" 증상).
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (isEnabled(this)) {
            kr.codyssey.attendance.util.DiagLog.add(this, "SVC",
                    "앱이 최근 목록에서 제거됨 — " + (RESTART_DELAY_MS / 1000) + "초 후 상시 감지 자동 복구 예약");
            scheduleRestartAlarm(this, RESTART_DELAY_MS);
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        // 20차: 사용자가 설정에서 끈 경우에만 복구 알람을 해제한다.
        // OS에 의한 비자발적 종료에서 알람까지 취소하면 부활 사슬이 완전히 끊겼다(결함 B).
        if (isEnabled(this)) {
            kr.codyssey.attendance.util.DiagLog.add(this, "SVC",
                    "상시 감지 서비스 정지 (설정 ON — 알람 사슬로 복구 예정)");
            scheduleNextTick(this);
        } else {
            kr.codyssey.attendance.util.DiagLog.add(this, "SVC", "상시 감지 서비스 정지 (사용자 해제)");
            cancelAlarm(this);
        }
        if (handler != null) handler.removeCallbacks(tickRunnable);
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ===== 주기 실행 =====

    private void doTick() {
        if (!ticking.compareAndSet(false, true)) return; // 이전 주기가 아직 실행 중이면 합류하지 않음
        acquireWakeLock();
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

            // 20차: 틱 지연 계측 — 예정 시각보다 3분+ 늦게 실행됐다는 것은
            // OS가 백그라운드 실행을 늦추고 있다는 실측 증거 (사용자가 진단 로그로 확인 가능)
            long nowTick = System.currentTimeMillis();
            long expect = prefs.getLong(EXPECT_TICK_KEY, 0);
            if (expect > 0 && nowTick - expect > TICK_DRIFT_LOG_MS) {
                kr.codyssey.attendance.util.DiagLog.add(this, "SVC",
                        "⚠️ 1분 감지 틱이 약 " + ((nowTick - expect) / 60000) + "분 지연됨 — OS가 백그라운드 실행을 지연시키는 중"
                        + " (배터리 최적화 예외·제조사 절전 해제 필요)");
            }
            prefs.edit().putLong(EXPECT_TICK_KEY, nowTick + TICK_MS).apply();

            boolean keepAlive = true;
            try {
                org.json.JSONObject settings = new org.json.JSONObject(prefs.getString("settings", "{}"));
                keepAlive = settings.optBoolean("keepAliveEnabled", true);
            } catch (Exception e) { /* 기본값 유지 */ }

            if (keepAlive) CookieManager.pingKeepAlive(this);
            GateCheck.run(this);   // 설정에서 입·퇴실 감지 OFF면 남부에서 즉시 반환
            EvalSync.run(this);    // 6시간 스로틀 남장이라 사실상 스킵 빈번 (비용 적음)

            // 19차: 세션 쿠키 존재 전이 — 소실 순간을 사용자가 확인할 수 있게 기록
            boolean hasCookie = kr.codyssey.attendance.util.CookieManager.hasSessionCookie(this);
            kr.codyssey.attendance.util.DiagLog.addOnChange(this, "COOKIE", hasCookie ? "have" : "none",
                    hasCookie ? "세션 쿠키(JSESSIONID) 존재 확인"
                              : "⚠️ 세션 쿠키(JSESSIONID) 소실 — 이후 서버 조회는 302로 실패 → 재로그인 필요");

            prefs.edit().putLong(LAST_TICK_KEY, System.currentTimeMillis()).apply();
            updateNotification();
        } catch (Exception e) {
            // 주기 실패는 다음 틱으로 (조용히)
        } finally {
            ticking.set(false);
            releaseWakeLock();
            // 살아있는 동안은 Handler로 연속 실행, 죽으면 알람이 부활시킴 (이중 예약 아님)
            if (handler != null) handler.postDelayed(tickRunnable, TICK_MS);
        }
    }

    private void acquireWakeLock() {
        try { if (wakeLock != null) wakeLock.acquire(WAKELOCK_MS); } catch (Exception ignored) {}
    }

    private void releaseWakeLock() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
    }

    // ===== 차기 주기 예약 (서비스 사망 대비) =====

    private static void scheduleNextTick(Context context) {
        scheduleRestartAlarm(context, nextInterval(context));
    }

    private static long nextInterval(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return TICK_MS;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            return FALLBACK_TICK_MS; // 정확 알람 권한 없으면 짧은 간격은 포기하고 5분으로
        }
        return TICK_MS;
    }

    // 20차: 부활 알람 단일 진입점. 수신지는 서비스 직접 시작이 아니라
    // TickReceiver(브로드캐스트) — 백그라운드 서비스 시작 제한을 우회하는 정상 경로.
    static void scheduleRestartAlarm(Context context, long delayMs) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = tickPendingIntent(context);
        long nextAt = SystemClock.elapsedRealtime() + delayMs;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, nextAt, pi);
            } else {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, nextAt, pi);
            }
            kr.codyssey.attendance.util.DiagLog.addOnChange(context, "SVC-SCHED", "ok",
                    "상시 감지 복구 알람 예약 정상 (정확 알람)");
        } catch (SecurityException e) {
            // 정확 알람 거부 — 긴 주기 inexact로 축소 (이 경우 부활 시각은 OS 재량)
            kr.codyssey.attendance.util.DiagLog.addOnChange(context, "SVC-SCHED", "denied",
                    "⚠️ 정확 알람 권한 거부 — 상시 감지 복구 알람이 부정확해짐 (지연 가능)");
            try {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, nextAt + FALLBACK_TICK_MS, pi);
            } catch (Exception e2) {
                kr.codyssey.attendance.util.DiagLog.add(context, "SVC-SCHED",
                        "⚠️ 복구 알람 예약 자체 실패: " + e2.getMessage());
            }
        }
    }

    private static void cancelAlarm(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(tickPendingIntent(context));
    }

    private static PendingIntent tickPendingIntent(Context context) {
        Intent i = new Intent(context, kr.codyssey.attendance.receiver.TickReceiver.class)
                .setAction(kr.codyssey.attendance.receiver.TickReceiver.ACTION_TICK);
        return PendingIntent.getBroadcast(context, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ===== 알림 =====

    private void startForegroundWithNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "상시 감지", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("1분 간격 입·퇴실/평가 감지 상태 표시 (무소음)");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification notif = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, notif);
        }
    }

    private void updateNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        // Android 13+ 알림 권한이 없으면 notify 자체가 예외 — 감지 자체와 무관하므로 흡수
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try { nm.notify(NOTIF_ID, buildNotification()); } catch (Exception ignored) {}
    }

    private Notification buildNotification() {
        long last = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getLong(LAST_TICK_KEY, 0);
        String lastStr = last > 0
                ? new SimpleDateFormat("HH:mm", Locale.US).format(new Date(last))
                : "--:--";
        Intent open = new Intent(this, kr.codyssey.attendance.MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_popup_sync)
                .setContentTitle("🔁 코디세이 상시 감지 중")
                .setContentText("1분 간격 · 마지막 감지 " + lastStr)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(pi)
                .build();
    }

    // ===== 정적 헬퍼 (플러그인/부팅 리시버에서 호출) =====

    public static void startDash(Context context) {
        Intent i = new Intent(context, PollingService.class).setAction(ACTION_START);
        ContextCompat.startForegroundService(context, i);
    }

    public static void stopDash(Context context) {
        Intent i = new Intent(context, PollingService.class).setAction(ACTION_STOP);
        context.startService(i);
    }

    public static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean("dash_enabled", false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean("dash_enabled", enabled).apply();
    }
}
