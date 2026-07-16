// ============================================================
// Capacitor Adapter - Chrome Extension API를 Capacitor 플러그인으로 변환
// 이 파일을 popup.js, calendar.js 전에 로드해야 함
// ============================================================

(function() {
  'use strict';

  // Capacitor 플러그인 사용 가능 여부 확인
  const isCapacitor = typeof Capacitor !== 'undefined' && typeof Capacitor.Plugins !== 'undefined';
  const Plugins = isCapacitor ? Capacitor.Plugins : {};

  const STORE_KEYS = {
    MEMBER_ID: 'member_id',
    SETTINGS: 'settings',
    ALARMS: 'codyssey_alarms'
  };

  const DEFAULT_SETTINGS = {
    monthlyRequiredHours: 80,
    dailyMaxHours: 12,
    notificationsEnabled: true,
    soundEnabled: true,
    autoRefresh: true,
    refreshInterval: 30, // 분
    keepAliveEnabled: false // opt-in: 세션 무한 연장 방지
  };

  // ===== chrome.storage.local → Capacitor Preferences (JSON 직렬화) =====
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && isCapacitor && Plugins.Preferences) {
    chrome.storage.local = {
      get: function(keys, callback) {
        const keyArray = Array.isArray(keys) ? keys : [keys];
        Promise.all(keyArray.map(k => Plugins.Preferences.get({ key: k })))
          .then(results => {
            const obj = {};
            keyArray.forEach((k, i) => {
              const raw = results[i].value;
              if (raw === null || raw === undefined) { obj[k] = undefined; return; }
              try { obj[k] = JSON.parse(raw); } catch (e) { obj[k] = raw; }
            });
            if (callback) callback(obj);
          })
          .catch(() => { if (callback) callback({}); });
      },
      set: function(items, callback) {
        const promises = Object.entries(items).map(([k, v]) =>
          Plugins.Preferences.set({ key: k, value: JSON.stringify(v) })
        );
        Promise.all(promises)
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

  // ===== chrome.runtime.sendMessage =====
  // Capacitor: 네이티브 플러그인으로 라우팅
  // 확장(Chrome): 반드시 원래 sendMessage로 위임해야 함 (그렇지 않으면 익스텐션 팝업 전면 마비)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function(message, callback) {
      if (isCapacitor) {
        handleCapacitorMessage(message)
          .then(result => { if (callback) callback(result); })
          .catch(err => { if (callback) callback({ success: false, error: err.message }); });
        return true;
      }
      return originalSendMessage(message, callback);
    };
  }

  // ===== chrome.alarms → Capacitor AlarmPlugin (없는 환경에서만 폴리필) =====
  if (typeof chrome !== 'undefined' && !chrome.alarms && isCapacitor && Plugins.AlarmPlugin) {
    chrome.alarms = {
      create: function(name, alarmInfo) {
        const triggerTime = alarmInfo.when || Date.now();
        return Plugins.AlarmPlugin.schedule({
          triggerTimeMillis: triggerTime,
          label: name,
          id: name
        });
      },
      clear: function(name) {
        return Plugins.AlarmPlugin.cancel({ id: name });
      },
      clearAll: function() {
        return Plugins.AlarmPlugin.cancelAll({});
      }
    };
  }

  // ===== chrome.notifications → Capacitor LocalNotifications (없는 환경에서만) =====
  if (typeof chrome !== 'undefined' && !chrome.notifications && isCapacitor && Plugins.LocalNotifications) {
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
        const raw = await getAttendanceRaw(memberId, now.getFullYear(), now.getMonth() + 1);
        if (!raw) return { success: false, error: 'ATTENDANCE_FETCH_FAILED' };

        return {
          success: true,
          memberId,
          parsed: parseAttendance(raw, now),
          settings: await getSettings(),
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
        const raw = await getAttendanceRaw(memberId, message.year, message.month);
        if (!raw) return { success: false, error: 'ATTENDANCE_FETCH_FAILED' };
        return { success: true, parsed: parseAttendance(raw, new Date(message.year, message.month - 1)) };
      }

      case 'CALCULATE_TARGET': {
        const memberId = await ensureMemberId();
        if (!memberId) return { success: false, error: 'NOT_LOGGED_IN' };
        const now = new Date();
        const raw = await getAttendanceRaw(memberId, now.getFullYear(), now.getMonth() + 1);
        const parsed = parseAttendance(raw, now);
        const settings = await getSettings();

        const extraMinutes = message.extraMinutes;
        const nowMin = getCurrentMinutes();
        const endMin = nowMin + extraMinutes;

        const dailyMax = settings.dailyMaxHours * 60;
        const monthlyReq = settings.monthlyRequiredHours * 60;
        const elapsed = elapsedSinceEntry(parsed);
        const todayUncapped = parsed.dailyTotal + elapsed + extraMinutes;
        const newDaily = Math.min(todayUncapped, dailyMax);
        const newMonthly = (parsed.monthlyTotal - parsed.dailyTotal) + newDaily;

        return {
          success: true,
          endMinutes: endMin,
          endTimeStr: minutesToHHMM(endMin),
          newMonthlyTotal: newMonthly,
          newMonthlyRemain: Math.max(0, monthlyReq - newMonthly),
          newDailyTotal: newDaily,
          newDailyRemain: Math.max(0, dailyMax - newDaily),
          dailyOver: todayUncapped > dailyMax,
          monthlyOver: newMonthly > monthlyReq
        };
      }

      case 'SET_ALARM': {
        if (!Plugins.AlarmPlugin) return { success: false, error: 'AlarmPlugin not available' };
        const endMinutes = message.endMinutes;
        const type = message.alarmType || 'exit';
        const label = message.label || '알림';

        // endMinutes(오늘 자정부터의 분) → 실제 epoch ms로 변환 (1970년대 예약 버그 수정)
        const target = new Date();
        target.setHours(0, 0, 0, 0);
        target.setTime(target.getTime() + endMinutes * 60000);
        if (target.getTime() <= Date.now()) {
          target.setDate(target.getDate() + 1); // 이미 지난 시각이면 다음 날
        }

        const memberId = (await getPrefs(STORE_KEYS.MEMBER_ID)) || 'unknown';
        const alarmName = `codyssey_alarm_${memberId}_${type}_${endMinutes}`;

        const result = await Plugins.AlarmPlugin.schedule({
          triggerTimeMillis: target.getTime(),
          label,
          id: alarmName
        });

        // 목록을 Preferences에도 영속화 (GET_ALARMS가 비는 버그 수정)
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

        return Object.assign({ success: true, alarmName, triggerTime: target.getTime() }, result);
      }

      case 'CANCEL_ALARM': {
        const endMinutes = message.endMinutes;
        const type = message.alarmType || 'exit';
        const memberId = (await getPrefs(STORE_KEYS.MEMBER_ID)) || 'unknown';
        const alarmName = `codyssey_alarm_${memberId}_${type}_${endMinutes}`;

        if (Plugins.AlarmPlugin) {
          try { await Plugins.AlarmPlugin.cancel({ id: alarmName }); } catch (e) { /* 무시 */ }
        }
        const alarms = (await getStoredAlarms()).filter(a => a.name !== alarmName);
        await setPrefs(STORE_KEYS.ALARMS, alarms);
        return { success: true };
      }

      case 'GET_ALARMS': {
        return { success: true, alarms: await getStoredAlarms() };
      }

      case 'UPDATE_SETTINGS': {
        const current = await getSettings();
        await setPrefs(STORE_KEYS.SETTINGS, Object.assign({}, current, message.settings));
        return { success: true };
      }

      case 'GET_SETTINGS': {
        return { success: true, settings: await getSettings() };
      }

      case 'LOGOUT': {
        await Plugins.Preferences.remove({ key: STORE_KEYS.MEMBER_ID });
        await Plugins.Preferences.remove({ key: STORE_KEYS.ALARMS });
        // 서버 세션 쿠키도 정리 (평문 세션 잔존 방지)
        if (Plugins.NetworkPlugin && Plugins.NetworkPlugin.clearCookies) {
          try { await Plugins.NetworkPlugin.clearCookies({}); } catch (e) { /* 무시 */ }
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

  // ===== 멤버/출입 API =====
  async function ensureMemberId() {
    let memberId = await getPrefs(STORE_KEYS.MEMBER_ID);
    if (memberId) return memberId;
    if (!Plugins.NetworkPlugin) return null;

    const res = await Plugins.NetworkPlugin.getMemberInfo({});
    const info = res.json || safeJson(res.data);
    memberId = extractMemberId(info);
    if (memberId) {
      await setPrefs(STORE_KEYS.MEMBER_ID, String(memberId));
      return String(memberId);
    }
    return null;
  }

  async function getAttendanceRaw(memberId, year, month) {
    if (!Plugins.NetworkPlugin) return null;
    const res = await Plugins.NetworkPlugin.getAttendance({ memberId, year, month });
    if (res.status && res.status >= 400) return null;
    return res.json || safeJson(res.data);
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

  // ===== 출입기록 파싱 (background.js와 동일 규칙) =====
  function parseAttendance(data, targetDate) {
    const detailList = (data && (data.detail_list || data.result || data.data)) || [];
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    const todayStr = getTodayString();

    let monthlyTotal = 0;
    let dailyTotal = 0;
    let lastInTime = null;
    let lastOutTime = null;
    let isCurrentlyIn = false;
    let entryTimestamp = null;
    let hasMissingEntry = false;
    const dailyBreakdown = {};

    for (const day of detailList) {
      const dateStr = day.date || '';
      if (!dateStr) continue;
      if (!dateStr.startsWith(`${year}-${String(month).padStart(2, '0')}`)) continue;

      const dailyTotalMinutes = durationToMinutes(day.daily_total_duration);
      monthlyTotal += dailyTotalMinutes;
      dailyBreakdown[dateStr] = dailyTotalMinutes;

      const sessions = (day.sessions || []).slice().sort((a, b) => {
        const ta = timeStrToMinutes(a.entry_time);
        const tb = timeStrToMinutes(b.entry_time);
        return (ta === null ? 0 : ta) - (tb === null ? 0 : tb);
      });

      for (const session of sessions) {
        const entryMin = timeStrToMinutes(session.entry_time);
        const exitMin = timeStrToMinutes(session.exit_time);
        const isMissing = session.is_missing === true;

        if (isMissing && session.missing_type === 'exit' && entryMin !== null) {
          // 퇴실 누락 = 현재 입실 중 (오늘뿐 아니라 전날 입실도 감지 → 자정 경계 처리)
          isCurrentlyIn = true;
          lastInTime = entryMin;
          lastOutTime = null;
          entryTimestamp = parseEntryTimestamp(dateStr, session.entry_time);
        } else if (isMissing && session.missing_type === 'entry') {
          hasMissingEntry = true;
        } else if (entryMin !== null && exitMin !== null && dateStr === todayStr) {
          lastInTime = entryMin;
          lastOutTime = exitMin;
        }
      }

      if (dateStr === todayStr) {
        dailyTotal = dailyTotalMinutes;
      }
    }

    return {
      monthlyTotal,
      dailyTotal,
      lastInTime,
      lastOutTime,
      isCurrentlyIn,
      entryTimestamp,
      hasMissingEntry,
      dailyBreakdown,
      rawDetailList: detailList
    };
  }

  function parseEntryTimestamp(dateStr, entryTime) {
    if (!dateStr || !entryTime) return null;
    const time = entryTime.length === 5 ? entryTime + ':00' : entryTime;
    const ts = new Date(`${dateStr}T${time}`).getTime();
    return isNaN(ts) ? null : ts;
  }

  function elapsedSinceEntry(parsed) {
    if (!parsed || !parsed.isCurrentlyIn) return 0;
    if (parsed.entryTimestamp) {
      return Math.max(0, Math.floor((Date.now() - parsed.entryTimestamp) / 60000));
    }
    if (parsed.lastInTime === null) return 0;
    return Math.max(0, getCurrentMinutes() - parsed.lastInTime);
  }

  function durationToMinutes(durationStr) {
    if (!durationStr) return 0;
    const parts = durationStr.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 60 + parts[1] + Math.round(parts[2] / 60);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  function timeStrToMinutes(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':').map(Number);
    if (parts.length >= 2 && !parts.some(isNaN)) return parts[0] * 60 + parts[1];
    return null;
  }

  function getCurrentMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  function getTodayString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function minutesToHHMM(minutes) {
    if (minutes === null || minutes === undefined || isNaN(minutes)) return '--:--';
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return `${h}:${m}`;
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
    }
  };

  // ===== 알림 권한 요청 (Android 13+) =====
  if (isCapacitor && Plugins.LocalNotifications) {
    Plugins.LocalNotifications.requestPermissions().catch(() => {});
  }

  console.log('[Capacitor Adapter] Loaded', isCapacitor ? '(Capacitor mode)' : '(Web fallback mode)');
})();
