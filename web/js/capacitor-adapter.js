// ============================================================
// Capacitor Adapter - Chrome Extension API를 Capacitor 플러그인으로 변환
// 이 파일을 popup.js, calendar.js 전에 로드해야 함 (type="module"로 로드)
// ============================================================

import {
  parseAttendance,
  applyOvernightFromPrevMonth,
  elapsedSinceEntry,
  projectedMonthly,
  minutesToHHMM,
  SERVER_DAILY_CAP_MINUTES
} from './shared-attendance.js';

(function() {
  'use strict';

  // Capacitor 플러그인 사용 가능 여부 확인
  const isCapacitor = typeof Capacitor !== 'undefined' && typeof Capacitor.Plugins !== 'undefined';
  const Plugins = isCapacitor ? Capacitor.Plugins : {};

  const STORE_KEYS = {
    MEMBER_ID: 'member_id',
    SETTINGS: 'settings',
    ALARMS: 'codyssey_alarms',
    // M4: 캐시 키는 memberId 포함 (계정 전환 시 타인 데이터 노출 방지)
    cachePrefix: (memberId) => `cache_attendance_${memberId}_`
  };
  const CACHE_PREFIX_ANY = 'cache_attendance_';

  const DEFAULT_SETTINGS = {
    monthlyRequiredHours: 80,
    dailyMaxHours: 12,
    notificationsEnabled: true,
    soundEnabled: true,
    autoRefresh: true,
    refreshInterval: 30, // 분
    keepAliveEnabled: false // opt-in
  };

  const CACHE_TTL_MS = 5 * 60 * 1000;

  // ===== chrome 런타임 폴리필/위임 =====
  // 확장(Chrome): 원래 API 그대로 사용 (sendMessage 위임)
  // Capacitor(WebView): chrome 객체가 없거나 불완전 → 네이티브 라우팅으로 폴리필
  if (typeof chrome === 'undefined') {
    window.chrome = {};
  }

  // chrome.runtime.onMessage 리스너 레지스트리 (네이티브 이벤트 → JS 디스패치용)
  const runtimeListeners = [];

  function dispatchRuntimeMessage(message) {
    for (const fn of runtimeListeners) {
      try { fn(message, {}, () => {}); } catch (e) { console.warn('[Adapter] onMessage listener error:', e); }
    }
  }

  if (isCapacitor && !chrome.runtime) {
    chrome.runtime = {};
  }

  if (isCapacitor) {
    // sendMessage → 네이티브 핸들러
    chrome.runtime.sendMessage = function(message, callback) {
      handleCapacitorMessage(message)
        .then(result => { if (callback) callback(result); })
        .catch(err => { if (callback) callback({ success: false, error: err.message }); });
      return true;
    };
    // onMessage → 리스너 레지스트리 (네이티브 이벤트 브릿지에 연결)
    chrome.runtime.onMessage = {
      addListener: function(fn) {
        if (typeof fn === 'function') runtimeListeners.push(fn);
      }
    };
    if (!chrome.runtime.getURL) {
      chrome.runtime.getURL = function(path) { return path; };
    }
  } else if (chrome.runtime && chrome.runtime.sendMessage) {
    // 익스텐션 환경: 반드시 원래 sendMessage로 위임 (익스텐션 마비 방지)
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function(message, callback) {
      return originalSendMessage(message, callback);
    };
  }

  // 네이티브 → JS 이벤트 브릿지 (R8: 알림 발화 등)
  // MainActivity/AlarmReceiver가 WebView에 dispatchEvent하는 CodysseyNativeEvent를 수신
  window.addEventListener('CodysseyNativeEvent', (e) => {
    if (e && e.detail && e.detail.type) {
      dispatchRuntimeMessage(e.detail);
    }
  });

  // ===== chrome.storage.local → Capacitor Preferences (JSON 직렬화) =====
  if (isCapacitor && Plugins.Preferences) {
    if (!chrome.storage) chrome.storage = {};
    chrome.storage.local = {
      get: function(keys, callback) {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        Promise.all(keyArray.map(k => getPrefs(k)))
          .then(values => {
            const obj = {};
            keyArray.forEach((k, i) => { obj[k] = values[i] === null ? undefined : values[i]; });
            if (callback) callback(obj);
          })
          .catch(() => { if (callback) callback({}); });
      },
      set: function(items, callback) {
        Promise.all(Object.entries(items).map(([k, v]) => setPrefs(k, v)))
          .then(() => { if (callback) callback(); })
          .catch(() => { if (callback) callback(); });
      },
      remove: function(keys, callback) {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        Promise.all(keyArray.map(k => Plugins.Preferences.remove({ key: k })))
          .then(() => { if (callback) callback(); })
          .catch(() => { if (callback) callback(); });
      },
      clear: function(callback) {
        Plugins.Preferences.clear()
          .then(() => { if (callback) callback(); })
          .catch(() => { if (callback) callback(); });
      }
    };
  }

  // ===== chrome.notifications → Capacitor LocalNotifications =====
  if (!chrome.notifications && isCapacitor && Plugins.LocalNotifications) {
    chrome.notifications = {
      create: function(notificationId, options, callback) {
        // 사용 형태 통일: create({type,title,message}) 또는 create(id, options)
        let id = notificationId;
        let opts = options;
        if (typeof notificationId === 'object') {
          opts = notificationId;
          id = 'notif_' + Date.now();
        }
        scheduleLocalNotification(opts.title || '알림', opts.message || '', String(id));
        if (callback) callback(id);
      },
      clear: function(notificationId, callback) {
        const nid = Math.abs(hashString(String(notificationId))) % 2000000000;
        Plugins.LocalNotifications.cancel({ notifications: [{ id: nid }] })
          .then(() => { if (callback) callback(true); });
      }
    };
  }

  function hashString(s) {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return hash;
  }

  async function scheduleLocalNotification(title, body, idKey) {
    if (!Plugins.LocalNotifications) return;
    try {
      const nid = Math.abs(hashString(idKey)) % 2000000000;
      await Plugins.LocalNotifications.schedule({
        notifications: [{
          id: nid,
          title,
          body,
          schedule: { at: new Date(Date.now() + 100), allowWhileIdle: true }
        }]
      });
    } catch (e) {
      console.warn('[Adapter] Local notification failed:', e);
    }
  }

  // ===== 메시지 핸들러 =====
  async function handleCapacitorMessage(message) {
    if (!message || !message.type) {
      return { success: false, error: 'Invalid message' };
    }

    switch (message.type) {
      case 'GET_STATUS': {
        const memberId = await ensureMemberId();
        if (!memberId) return { success: false, error: 'NOT_LOGGED_IN' };

        const now = new Date();
        const result = await getAttendanceParsed(memberId, now.getFullYear(), now.getMonth() + 1, now);
        if (result.error) return { success: false, error: result.error };

        const parsed = result.parsed;

        // 월 경계 입실(R2/L4): 이달 데이터에 입실 중이 없으면 전월 말 확인 (월초 제한 제거)
        if (!parsed.isCurrentlyIn) {
          const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const prevResult = await getAttendanceRaw(memberId, prev.getFullYear(), prev.getMonth() + 1);
          if (prevResult.raw) applyOvernightFromPrevMonth(parsed, prevResult.raw);
        }

        const settings = await getSettings();
        await syncKeepAliveWork(settings); // N7: keep-alive 설정과 백그라운드 작업 동기화

        return {
          success: true,
          memberId,
          parsed,
          settings,
          alarms: await getStoredAlarms()
        };
      }

      case 'FETCH_MEMBER_ID': {
        try {
          const memberId = await ensureMemberId();
          if (memberId) return { success: true, memberId };
          return { success: false, error: 'NOT_LOGGED_IN' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'FETCH_ATTENDANCE': {
        const memberId = message.memberId || await ensureMemberId();
        if (!memberId) return { success: false, error: 'NOT_LOGGED_IN' };
        const result = await getAttendanceParsed(memberId, message.year, message.month, new Date(message.year, message.month - 1));
        if (result.error) return { success: false, error: result.error };
        return { success: true, parsed: result.parsed };
      }

      case 'CALCULATE_TARGET': {
        const memberId = await ensureMemberId();
        if (!memberId) return { success: false, error: 'NOT_LOGGED_IN' };
        const now = new Date();
        const result = await getAttendanceParsed(memberId, now.getFullYear(), now.getMonth() + 1, now);
        if (result.error) return { success: false, error: result.error };

        const parsed = result.parsed;
        const settings = await getSettings();
        const extraMinutes = message.extraMinutes;
        const nowMin = getCurrentMinutes();
        const endMin = nowMin + extraMinutes;

        const monthlyReq = settings.monthlyRequiredHours * 60;
        const elapsed = elapsedSinceEntry(parsed);
        const todayUncapped = parsed.dailyTotal + elapsed + extraMinutes;
        const newDaily = Math.min(todayUncapped, SERVER_DAILY_CAP_MINUTES);
        const newMonthly = projectedMonthly(parsed, extraMinutes);

        return {
          success: true,
          endMinutes: endMin,
          endTimeStr: minutesToHHMM(endMin),
          newMonthlyTotal: newMonthly,
          newMonthlyRemain: Math.max(0, monthlyReq - newMonthly),
          newDailyTotal: newDaily,
          newDailyRemain: Math.max(0, SERVER_DAILY_CAP_MINUTES - newDaily),
          dailyOver: todayUncapped > SERVER_DAILY_CAP_MINUTES,
          monthlyOver: newMonthly > monthlyReq
        };
      }

      case 'SET_ALARM': {
        if (!Plugins.AlarmPlugin) return { success: false, error: 'AlarmPlugin not available' };
        const endMinutes = message.endMinutes;
        const type = message.alarmType || 'exit';
        const label = message.label || '알림';

        // endMinutes(오늘 자정부터의 분) → 실제 epoch ms로 변환 (B4 수정)
        const target = new Date();
        target.setHours(0, 0, 0, 0);
        target.setTime(target.getTime() + endMinutes * 60000);
        if (target.getTime() <= Date.now()) {
          target.setDate(target.getDate() + 1);
        }

        const memberId = (await getPrefs(STORE_KEYS.MEMBER_ID)) || 'unknown';
        const alarmName = `codyssey_alarm_${memberId}_${type}_${endMinutes}`;

        const scheduleResult = await Plugins.AlarmPlugin.schedule({
          triggerTimeMillis: target.getTime(),
          label,
          id: alarmName
        });

        // 목록을 Preferences에 영속화 (B5 수정)
        const alarms = await getStoredAlarms();
        const filtered = alarms.filter(a => a.name !== alarmName);
        filtered.push({
          name: alarmName,
          time: target.getTime(),
          label,
          endMinutes,
          type,
          createdAt: Date.now()
        });
        await setPrefs(STORE_KEYS.ALARMS, filtered);

        // M5: 정확 알람 권한이 없어 부정확 경로(WorkManager)로 예약된 경우 플래그 전달
        return {
          success: true,
          alarmName,
          triggerTime: target.getTime(),
          exact: scheduleResult.exact !== false
        };
      }

      case 'CANCEL_ALARM': {
        const endMinutes = message.endMinutes;
        const type = message.alarmType || 'exit';
        const memberId = (await getPrefs(STORE_KEYS.MEMBER_ID)) || 'unknown';
        const alarmName = `codyssey_alarm_${memberId}_${type}_${endMinutes}`;
        const legacyName = `codyssey_exit_${memberId}_${endMinutes}`;

        if (Plugins.AlarmPlugin) {
          try { await Plugins.AlarmPlugin.cancel({ id: alarmName }); } catch (e) { /* 무시 */ }
          try { await Plugins.AlarmPlugin.cancel({ id: legacyName }); } catch (e) { /* 무시 */ }
        }
        const alarms = (await getStoredAlarms())
          .filter(a => a.name !== alarmName && a.name !== legacyName);
        await setPrefs(STORE_KEYS.ALARMS, alarms);
        return { success: true };
      }

      case 'GET_ALARMS': {
        const alarms = await getStoredAlarms();
        return {
          success: true,
          alarms: alarms.map(a => ({ ...a, type: a.type || 'exit', createdAt: a.createdAt || a.time }))
        };
      }

      case 'UPDATE_SETTINGS': {
        const current = await getSettings();
        const next = Object.assign({}, current, message.settings);
        await setPrefs(STORE_KEYS.SETTINGS, next);
        await syncKeepAliveWork(next); // N7: 설정 변경 즉시 백그라운드 작업 반영
        return { success: true };
      }

      case 'GET_SETTINGS': {
        return { success: true, settings: await getSettings() };
      }

      case 'LOGOUT': {
        // M3: 네이티브 예약 알람(WorkManager/AlarmManager)을 개별 취소 후 목록 비움
        const storedAlarms = await getStoredAlarms();
        if (Plugins.AlarmPlugin) {
          for (const a of storedAlarms) {
            if (a && a.name) {
              try { await Plugins.AlarmPlugin.cancel({ id: a.name }); } catch (e) { /* 무시 */ }
            }
          }
          try { await Plugins.AlarmPlugin.cancelAll({}); } catch (e) { /* 무시 */ }
        }
        await Plugins.Preferences.remove({ key: STORE_KEYS.MEMBER_ID });
        await Plugins.Preferences.remove({ key: STORE_KEYS.ALARMS });
        await clearAttendanceCaches();
        // 서버 세션 쿠키도 정리 (C5)
        if (Plugins.NetworkPlugin && Plugins.NetworkPlugin.clearCookies) {
          try { await Plugins.NetworkPlugin.clearCookies({}); } catch (e) { /* 무시 */ }
        }
        if (Plugins.AlarmPlugin) {
          try { await Plugins.AlarmPlugin.cancelPeriodicSync({}); } catch (e) { /* 무시 */ }
        }
        return { success: true };
      }

      case 'LOCAL_NOTIFY': {
        await scheduleLocalNotification(message.title || '알림', message.body || '', 'local_' + Date.now());
        return { success: true };
      }

      case 'OPEN_LOGIN': {
        window.location.href = 'https://ams.codyssey.kr/loginForm';
        return { success: true };
      }

      case 'OPEN_CALENDAR': {
        window.location.href = 'calendar.html';
        return { success: true };
      }

      case 'DETECT_MEMBER_ID': {
        if (message.memberId) {
          await setPrefs(STORE_KEYS.MEMBER_ID, message.memberId);
          return { success: true, memberId: message.memberId };
        }
        return { success: false, error: 'NO_MEMBER_ID' };
      }

      default:
        return { success: false, error: 'Unknown message type' };
    }
  }

  // ===== Preferences 헬퍼 =====
  async function getPrefs(key) {
    const result = await Plugins.Preferences.get({ key });
    if (result.value === null || result.value === undefined) return null;
    try { return JSON.parse(result.value); } catch (e) { return result.value; }
  }

  async function setPrefs(key, value) {
    await Plugins.Preferences.set({ key, value: JSON.stringify(value) });
  }

  async function getSettings() {
    const stored = await getPrefs(STORE_KEYS.SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS, stored || {});
  }

  async function getStoredAlarms() {
    const alarms = await getPrefs(STORE_KEYS.ALARMS);
    return Array.isArray(alarms) ? alarms : [];
  }

  // N7: keep-alive 설정과 백그라운드 주기 동기화
  async function syncKeepAliveWork(settings) {
    if (!Plugins.AlarmPlugin) return;
    try {
      if (settings.keepAliveEnabled) {
        await Plugins.AlarmPlugin.schedulePeriodicSync({ intervalMinutes: 30 });
      } else {
        await Plugins.AlarmPlugin.cancelPeriodicSync({});
      }
    } catch (e) { /* 무시 */ }
  }

  // ===== 응답 캐시 (N8: 크롬 5분 캐시와 동일, M4: memberId 포함 키) =====
  async function getCachedAttendance(memberId, year, month) {
    const cached = await getPrefs(STORE_KEYS.cachePrefix(memberId) + year + '_' + month);
    if (cached && cached.timestamp && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
    return null;
  }

  async function setCachedAttendance(memberId, year, month, data) {
    await setPrefs(STORE_KEYS.cachePrefix(memberId) + year + '_' + month, { data, timestamp: Date.now() });
  }

  async function clearAttendanceCaches() {
    const all = await Plugins.Preferences.keys();
    const keys = (all.keys || []).filter(k => k.startsWith(CACHE_PREFIX_ANY));
    await Promise.all(keys.map(k => Plugins.Preferences.remove({ key: k })));
  }

  // ===== 멤버/출입 API =====
  async function ensureMemberId() {
    let memberId = await getPrefs(STORE_KEYS.MEMBER_ID);
    if (memberId) return memberId;
    if (!Plugins.NetworkPlugin) return null;

    const res = await Plugins.NetworkPlugin.getMemberInfo({});
    if (isAuthStatus(res.status)) return null;
    const info = res.json || safeJson(res.data);
    if (res.status && res.status >= 400) return null;
    memberId = extractMemberId(info);
    if (memberId) {
      await setPrefs(STORE_KEYS.MEMBER_ID, String(memberId));
      return String(memberId);
    }
    return null;
  }

  // 세션 만료로 분류할 상태 코드 (네이티브는 리다이렉트 비추적이라 3xx가 그대로 옴 — N4)
  function isAuthStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308 ||
           status === 401 || status === 403;
  }

  // 원본 JSON 조회 (N8 캐시 적용). { raw } 또는 { error }
  async function getAttendanceRaw(memberId, year, month) {
    const cached = await getCachedAttendance(memberId, year, month);
    if (cached) return { raw: cached };

    if (!Plugins.NetworkPlugin) return { error: 'NETWORK_PLUGIN_UNAVAILABLE' };
    const res = await Plugins.NetworkPlugin.getAttendance({ memberId, year, month });

    if (isAuthStatus(res.status)) {
      await clearAttendanceCaches(); // R7: 만료 시 캐시 잔존 방지
      return { error: 'NOT_LOGGED_IN' };
    }
    if (res.status && res.status >= 400) {
      return { error: `ATTENDANCE_API_ERROR_${res.status}` };
    }

    const raw = res.json || safeJson(res.data);
    if (!raw || !raw.detail_list) {
      // 로그인 페이지 HTML이 그대로 온 경우 인증 오류로 분류 (N4)
      if (typeof res.data === 'string' && /login|로그인/i.test(res.data)) {
        await clearAttendanceCaches();
        return { error: 'NOT_LOGGED_IN' };
      }
      return { error: 'ATTENDANCE_PARSE_ERROR' };
    }

    await setCachedAttendance(memberId, year, month, raw);
    return { raw };
  }

  async function getAttendanceParsed(memberId, year, month, targetDate) {
    const result = await getAttendanceRaw(memberId, year, month);
    if (result.error) return result;
    return { parsed: parseAttendance(result.raw, targetDate) };
  }

  function safeJson(s) {
    if (!s) return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function extractMemberId(memberInfoData) {
    if (!memberInfoData) return null;
    const result = memberInfoData.result || memberInfoData.data || memberInfoData;
    return result.mbrId || result.memberId || result.userId || result.id || result.no || null;
  }

  function getCurrentMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  // ===== Android 로그인 헬퍼 (popup.js에서 직접 사용 — CORS 우회용 네이티브 HTTP) =====
  window.CodysseyNative = {
    isNative: isCapacitor && !!Plugins.NetworkPlugin,
    preCheckLogin: async function(userId) {
      if (!this.isNative) throw new Error('NATIVE_NOT_AVAILABLE');
      const res = await Plugins.NetworkPlugin.preCheckLogin({ userId });
      return { status: res.status || 0, body: res.json || safeJson(res.data) || {} };
    },
    authenticate: async function(userId, password, from) {
      if (!this.isNative) throw new Error('NATIVE_NOT_AVAILABLE');
      const res = await Plugins.NetworkPlugin.authenticate({ userId, password, from: from || '' });
      return { status: res.status || 0, body: res.json || safeJson(res.data) || {} };
    },
    // M5: 정확 알람 권한 설정 화면 열기 (Android 12+)
    requestExactAlarmPermission: async function() {
      if (!Plugins.AlarmPlugin || !Plugins.AlarmPlugin.requestExactAlarmPermission) {
        return { granted: true };
      }
      const res = await Plugins.AlarmPlugin.requestExactAlarmPermission({});
      return { granted: res.granted !== false };
    }
  };

  // ===== 알림 권한 요청 (Android 13+) =====
  if (isCapacitor && Plugins.LocalNotifications) {
    Plugins.LocalNotifications.requestPermissions().catch(() => {});
  }

  console.log('[Capacitor Adapter] Loaded', isCapacitor ? '(Capacitor mode)' : '(Web fallback mode)');
})();
