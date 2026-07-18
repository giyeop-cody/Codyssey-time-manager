// ============================================================
// Capacitor Adapter - Chrome Extension API를 Capacitor 플러그인으로 변환
// 이 파일을 popup.js, calendar.js 전에 로드해야 함 (type="module"로 로드)
// ============================================================

import {
  parseAttendance,
  applyOvernightFromPrevMonth,
  equivalentAlarmNames,
  getTodayString,
  snapshotSessionsByDate,
  detectGateEvents,
  formatGateEventMessage,
  gateEventKey,
  newEvalId,
  buildEvalAlarmName,
  validateEvalAlarm,
  findInstCd,
  parseScheduleRows,
  diffEvalItems,
  isEvalConfirmed,
  mergeDetailLists,
  EVAL_AUTO_ID_PREFIX,
  parseEvalNoticeAlarms,
  filterNewEvalNotices,
  EVAL_NOTICE_PAGE_PER_ROWS,
  EVAL_NOTICE_DEDUP_MS,
  EVAL_NOTICE_SEEN_TTL_MS
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
    keepAliveEnabled: false, // opt-in
    gateNotifyEnabled: true, // G1: 입·퇴실 처리 감지 알림 (요청 기능 — 기본 켬)
    evalLeadMinutes: 30, // E1: 평가 알람 기본 사전 알림 (분)
    evalAutoSyncEnabled: true, // E2: 코디세이 평가 일정 자동 연동 (E1 요청 사항)
    evalInstCd: '' // E2: instCd 자동 추출 실패 시 사용자 수동 입력
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
        // J3: 표준 시그니처 — get(null)은 전체 항목 반환
        if (keys === null || keys === undefined) {
          Plugins.Preferences.keys()
            .then(({ keys: allKeys }) => Promise.all((allKeys || []).map(k => getPrefs(k).then(v => [k, v]))))
            .then(entries => {
              const obj = {};
              entries.forEach(([k, v]) => { if (v !== null) obj[k] = v; });
              if (callback) callback(obj);
            })
            .catch(() => { if (callback) callback({}); });
          return;
        }
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
        notificationIdFor(String(notificationId))
          .then(nid => Plugins.LocalNotifications.cancel({ notifications: [{ id: nid }] }))
          .then(() => { if (callback) callback(true); })
          .catch(() => { if (callback) callback(true); });
      }
    };
  }

  // K14: 해시 기반 id는 충돌 시 타 알림을 덮어씀 — Preferences 영속 카운터로 고유 매핑 (네이티브 M7과 동일 원리)
  const NOTIF_ID_MAP_KEY = 'notif_id_map';
  const NOTIF_ID_COUNTER_KEY = 'notif_id_counter';
  const NOTIF_ID_BASE = 1000;
  // Q7: local_/notif_ 타임스탬프형 원샷 키는 매핑을 영속하지 않고 시간 기반 정수 사용 (맵 무한 증가 방지)
  const ONESHOT_NOTIF_KEY_RE = /^(local|notif)_\d+$/;

  async function notificationIdFor(idKey) {
    if (ONESHOT_NOTIF_KEY_RE.test(idKey)) {
      // W2: 키에 박힌 생성 시각으로 id를 "결정적"으로 계산 — create와 clear가 같은 id를 얻음
      //     (기존은 Date.now() 재계산이라 clear가 다른 id를 지워 알림이 남았음)
      // W3: 카운터형(1000~)과 네임스페이스 분리 — 1e9 대역으로 이동 (충돌·23일 주기 제거)
      const embedded = Number(idKey.split('_')[1]) || Date.now();
      return (1000000000 + (embedded % 1000000000)) | 0;
    }
    try {
      const map = (await getPrefs(NOTIF_ID_MAP_KEY)) || {};
      // Q9: hasOwnProperty로 프로토타입 키(__proto__ 등) 오동작 방지
      if (Object.prototype.hasOwnProperty.call(map, idKey)) return map[idKey];
      const next = ((await getPrefs(NOTIF_ID_COUNTER_KEY)) || NOTIF_ID_BASE) + 1;
      map[idKey] = next;
      await setPrefs(NOTIF_ID_COUNTER_KEY, next);
      await setPrefs(NOTIF_ID_MAP_KEY, map);
      return next;
    } catch (e) {
      // 저장소 실패 시에도 알림은 떠야 함 — 시간 기반 폴리곤 (W3: 1e9 대역)
      return (1000000000 + (Date.now() % 1000000000)) | 0;
    }
  }

  async function scheduleLocalNotification(title, body, idKey) {
    if (!Plugins.LocalNotifications) return;
    try {
      const nid = await notificationIdFor(idKey);
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
        // J1: force면 캐시 바이패스 (수동 새로고침)
        const result = await getAttendanceParsed(memberId, now.getFullYear(), now.getMonth() + 1, now, message.force === true);
        if (result.error) return { success: false, error: result.error };

        const parsed = result.parsed;

        // 전월 데이터가 필요한 경우를 한 번의 조회로 합침 (background.js와 동일 규칙):
        // ①이달에 입실 중이 아님(R2/L4) ②월 초 1~2일(G1 '어제'가 전월에 걸침 — B8)
        // W7: force 시 전월도 캐시 바이패스
        let gateSource = parsed.rawDetailList;
        if (!parsed.isCurrentlyIn || now.getDate() <= 2) {
          const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const prevResult = await getAttendanceRaw(memberId, prev.getFullYear(), prev.getMonth() + 1, message.force === true);
          if (prevResult.raw) {
            if (!parsed.isCurrentlyIn) applyOvernightFromPrevMonth(parsed, prevResult.raw);
            if (now.getDate() <= 2) gateSource = mergeDetailLists(prevResult.raw, parsed.rawDetailList);
          }
        }

        // G1: 새 조회 결과로 입·퇴실 처리 이벤트 감지 (스냅샷 중복 제거로 다중 호출 안전)
        processGateEvents(memberId, gateSource).catch(() => {});
        // E2: 평가 일정 자동 연동 (상태 diff로 다중 호출 안전)
        syncEvalAlarms(memberId).catch(() => {});

        const settings = await getSettings();
        await syncKeepAliveWork(settings); // N7: keep-alive 설정과 백그라운드 작업 동기화

        return {
          success: true,
          memberId,
          parsed,
          settings,
          alarms: await getStoredAlarms(),
          // S4: 평가 연동 상태 (네이티브 EvalSync.java와 같은 prefs 키 공유)
          evalSync: summarizeEvalSyncState(await getPrefs(EVAL_STATE_KEY))
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
        const result = await getAttendanceParsed(memberId, message.year, message.month, new Date(message.year, message.month - 1), message.force === true);
        if (result.error) return { success: false, error: result.error };
        return { success: true, parsed: result.parsed };
      }

      // Q1: 세션 전환(로그인 직후) — 저장 memberId + 캐시 폐기
      case 'CLEAR_MEMBER_ID': {
        await clearSessionIdentity();
        return { success: true };
      }

      case 'SET_ALARM': {
        if (!Plugins.AlarmPlugin) return { success: false, error: 'AlarmPlugin not available' };
        const endMinutes = message.endMinutes;
        const type = message.alarmType || 'exit';
        const label = message.label || '알림';

        // endMinutes(오늘 자정부터의 분) → 실제 epoch ms로 변환 (B4 수정)
        const target = new Date();
        target.setHours(0, 0, 0, 0);
        target.setTime(target.getTime() + endMinutes * 60000); // 24h 초과분(goal)은 자동으로 익일
        // K2: 과거 시각은 익스텐션과 동일하게 거부 (조용히 다음날로 미루던 동작 제거)
        if (target.getTime() <= Date.now()) {
          return { success: false, reason: 'past' };
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

      // E1: 평가 알람 등록 (평가 시각 - N분에 1회 알림)
      case 'SET_EVAL_ALARM': {
        if (!Plugins.AlarmPlugin) return { success: false, error: 'AlarmPlugin not available' };

        const title = (message.title || '').toString().trim() || '평가';
        const whenMs = Number(message.whenMs);
        const leadMinutes = Number(message.leadMinutes);

        const invalid = validateEvalAlarm(whenMs, leadMinutes);
        if (invalid) return { success: false, reason: invalid };

        const triggerAt = whenMs - leadMinutes * 60000;
        const alarmName = buildEvalAlarmName(message.evalId || newEvalId());

        const scheduleResult = await Plugins.AlarmPlugin.schedule({
          triggerTimeMillis: triggerAt,
          label: `📋 평가 ${leadMinutes}분 전: ${title}`,
          id: alarmName
        });

        // 활성 알람 목록에 함께 영속화 (BootReceiver 복원/일괄 정리/해제 파이프라인 재사용)
        const evalAlarms = await getStoredAlarms();
        const keptEval = evalAlarms.filter(a => a.name !== alarmName);
        keptEval.push({
          name: alarmName,
          time: triggerAt,
          label: `📋 ${title}`,
          endMinutes: null,
          type: 'eval',
          evalTitle: title,
          evalWhen: whenMs,
          leadMinutes,
          createdAt: Date.now()
        });
        await setPrefs(STORE_KEYS.ALARMS, keptEval);

        return { success: true, alarmName, triggerTime: triggerAt, exact: scheduleResult.exact !== false };
      }

      // E2: 평가 일정 수동 1회 동기화 (설정 저장 직후 등)
      case 'SYNC_EVAL_ALARMS': {
        const memberId = await ensureMemberId();
        const result = await syncEvalAlarms(memberId);
        return { success: result.ok !== false, result };
      }

      case 'CANCEL_ALARM': {
        // 문제2 수정: memberId로 이름을 재계산하지 않고 "목록에 저장된 실제 이름"으로 해제.
        // (memberId가 'unknown'이거나 계정 전환 시 실제 이름과 불일치해 해제가 무음 실패하던 결함)
        if (message.alarmName) {
          const names = equivalentAlarmNames(message.alarmName);
          if (Plugins.AlarmPlugin) {
            for (const n of names) {
              try { await Plugins.AlarmPlugin.cancel({ id: n }); } catch (e) { /* 무시 */ }
            }
          }
          const keptByName = (await getStoredAlarms()).filter(a => !a || !names.includes(a.name));
          await setPrefs(STORE_KEYS.ALARMS, keptByName);
          return { success: true };
        }

        // 하위 호환(endMinutes/type): 목록에서 해당 항목의 실제 이름을 우선 찾아 해제
        const endMinutes = message.endMinutes;
        const type = message.alarmType || 'exit';
        const alarmsNow = await getStoredAlarms();
        const found = alarmsNow.filter(a =>
          a && a.endMinutes === endMinutes && (a.type || 'exit') === type);

        const namesToCancel = new Set();
        if (found.length > 0) {
          for (const item of found) {
            for (const n of equivalentAlarmNames(item.name)) namesToCancel.add(n);
          }
        } else {
          // 목록에 없으면 기존처럼 이름을 재계산(폴곤)
          const memberId = (await getPrefs(STORE_KEYS.MEMBER_ID)) || 'unknown';
          namesToCancel.add(`codyssey_alarm_${memberId}_${type}_${endMinutes}`);
          namesToCancel.add(`codyssey_exit_${memberId}_${endMinutes}`);
        }

        if (Plugins.AlarmPlugin) {
          for (const n of namesToCancel) {
            try { await Plugins.AlarmPlugin.cancel({ id: n }); } catch (e) { /* 무시 */ }
          }
        }
        const kept = alarmsNow.filter(a => !a || !namesToCancel.has(a.name));
        await setPrefs(STORE_KEYS.ALARMS, kept);
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
        // E2: 평가 연동 토글/기본 시점(분) 변경을 자동 알람에 즉시 반영 (lead 변경 시 재예약)
        ensureMemberId()
          .then(id => (id ? syncEvalAlarms(id) : null))
          .catch(() => {});
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
        await clearGateSnapshots(); // G1: 스냅샷도 계정과 함께 폐기
        // E2: 평가 동기화 상태/instCd 캐시도 폐기
        try { await Plugins.Preferences.remove({ key: 'eval_sync_state' }); } catch (e) { /* 무시 */ }
        try { await Plugins.Preferences.remove({ key: 'eval_inst_cd' }); } catch (e) { /* 무시 */ }
        // Q4: keep-alive 설정도 해제 — 재부팅 시 BootReceiver가 유령 핑을 다시 예약하지 않도록
        try {
          const settings = await getSettings();
          settings.keepAliveEnabled = false;
          await setPrefs(STORE_KEYS.SETTINGS, settings);
        } catch (e) { /* 무시 */ }
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
    const list = Array.isArray(alarms) ? alarms : [];
    // K8: 발화하지 못한 채 지나간 알람(기기 전원 꺼짐 중 소실 등)은 읽을 때 자가정비.
    // (M6의 네이티브 목록 제거와 경합하지 않음 — 제거된 항목만 재기록하지 않으면 됨)
    // 25차: 발화 시각 직후 즉시 목록에서 사라져 "지워져서 안 온 것 아닌가"로 보이던
    // 혼동을 막기 위해, 네이티브 stale 상한(15분)만큼은 목록에 남겨 증적을 보존.
    const now = Date.now();
    const PRUNE_GRACE_MS = 15 * 60 * 1000;
    const fresh = list.filter(a => !a || typeof a.time !== 'number' || a.time > now - PRUNE_GRACE_MS);
    if (fresh.length !== list.length) {
      await setPrefs(STORE_KEYS.ALARMS, fresh);
    }
    return fresh;
  }

  // N7: 백그라운드 주기 동기화 — keep-alive 또는 입·퇴실 감지(G1, 기본 켬)가 하나라도 켜져 있으면 예약
  // G1: 15분 간격 (WorkManager 최소 주기) — 입·퇴실 알림 지연 상한을 낮추기 위함
  async function syncKeepAliveWork(settings) {
    if (!Plugins.AlarmPlugin) return;
    try {
      const needSync = settings.keepAliveEnabled || settings.gateNotifyEnabled !== false;
      if (needSync) {
        await Plugins.AlarmPlugin.schedulePeriodicSync({ intervalMinutes: 15 });
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
    if (isAuthStatus(res.status)) {
      diagNative('AUTH', '회원 정보 조회 인증류 HTTP ' + res.status + ' — memberId 확보 실패');
      return null;
    }
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
  // 19차: 403(정책/일시 차단)·301/307/308(정규화 리다이렉트)은 세션 만료 아님 — 단발 302/303/401도
  // 즉시 폐기하지 않고 shouldDiscardSession의 연속+재조사를 거친다.
  function isAuthStatus(status) {
    return status === 302 || status === 303 || status === 401;
  }

  // 19차: 단발 인증류 응답은 일시 오류(망 흔들림·포털 리다이렉트)일 수 있어 즉시 세션을 버리지 않는다.
  // 연속 2회 이상 + 회원 정보 재조사까지 실패해야 세션 종료(만료/중복 로그인 로그아웃)로 확정.
  let authFailStreak = 0;
  async function diagNative(tag, msg) {
    try {
      if (Plugins.PollingPlugin && Plugins.PollingPlugin.logDiag) {
        await Plugins.PollingPlugin.logDiag({ tag, msg });
      }
    } catch (e) { /* 진단 로그 실패는 무시 */ }
  }
  async function shouldDiscardSession(source, status) {
    authFailStreak++;
    diagNative('AUTH', source + ' 인증류 응답 HTTP ' + status + ' (' + authFailStreak + '회째)');
    if (authFailStreak < 2) return false;
    try {
      const res = await Plugins.NetworkPlugin.getMemberInfo({});
      if (res.status === 200) {
        authFailStreak = 0;
        diagNative('AUTH', source + ' HTTP ' + status + '였지만 회원 정보 재조사는 정상 — 일시 오류 판정, 세션 유지');
        return false;
      }
      diagNative('AUTH', source + ' HTTP ' + status + ' 연속 ' + authFailStreak + '회 + 회원 정보 재조사 HTTP ' + res.status);
    } catch (e) { /* 재조사 실패 → 폐기 확정 */ }
    diagNative('AUTH', '세션 종료 확정 (' + source + ' 연속 실패 + 재조사 실패) — 만료 또는 서버측 로그아웃(중복 로그인)');
    return true;
  }

  // 원본 JSON 조회 (N8 캐시 적용, J1: force면 캐시 바이패스). { raw } 또는 { error }
  async function getAttendanceRaw(memberId, year, month, force = false) {
    if (!force) {
      const cached = await getCachedAttendance(memberId, year, month);
      if (cached) return { raw: cached };
    }

    if (!Plugins.NetworkPlugin) return { error: 'NETWORK_PLUGIN_UNAVAILABLE' };
    const res = await Plugins.NetworkPlugin.getAttendance({ memberId, year, month });

    if (isAuthStatus(res.status)) {
      if (await shouldDiscardSession('출입 조회', res.status)) {
        await clearSessionIdentity(); // R7 캐시 + Q1 memberId 폐기
        return { error: 'NOT_LOGGED_IN' };
      }
      return { error: `ATTENDANCE_API_ERROR_${res.status}` }; // 일시 — 대시보드 유지
    }
    if (res.status && res.status >= 400) {
      return { error: `ATTENDANCE_API_ERROR_${res.status}` };
    }

    const raw = res.json || safeJson(res.data);
    if (!raw || !raw.detail_list) {
      // 로그인 페이지 HTML이 그대로 온 경우 인증 오류로 분류 (N4)
      if (typeof res.data === 'string' && /login|로그인/i.test(res.data)) {
        if (await shouldDiscardSession('출입 본문 검사', 0)) {
          await clearSessionIdentity();
          return { error: 'NOT_LOGGED_IN' };
        }
        return { error: 'ATTENDANCE_PARSE_ERROR' };
      }
      return { error: 'ATTENDANCE_PARSE_ERROR' };
    }

    authFailStreak = 0; // 정상 응답 — 인증류 연속 카운터 리셋 (19차)
    await setCachedAttendance(memberId, year, month, raw);
    return { raw };
  }

  async function getAttendanceParsed(memberId, year, month, targetDate, force = false) {
    const result = await getAttendanceRaw(memberId, year, month, force);
    if (result.error) return result;
    return { parsed: parseAttendance(result.raw, targetDate) };
  }

  // Q1: 세션 전환(로그인 직후/만료) 시 저장 memberId + 캐시 폐기 — 스테일 id 재사용 방지
  async function clearSessionIdentity() {
    try { await Plugins.Preferences.remove({ key: STORE_KEYS.MEMBER_ID }); } catch (e) { /* 무시 */ }
    await clearAttendanceCaches();
    await clearGateSnapshots(); // G1: 계정 바뀌면 이전 계정 스냅샷도 폐기
    // E2: 평가 동기화 상태/instCd 캐시도 계정과 함께 폐기
    try { await Plugins.Preferences.remove({ key: 'eval_sync_state' }); } catch (e) { /* 무시 */ }
    try { await Plugins.Preferences.remove({ key: 'eval_inst_cd' }); } catch (e) { /* 무시 */ }
    // 21차: 죽은 세션의 쿠키 백업도 폐기 — 다음 재시작 때 무효 세션이 부활하지 않게
    // (네이티브 CookieManager.clearPersistedSession과 동일 키, Capacitor Preferences 공유 파일)
    try { await Plugins.Preferences.remove({ key: 'session_jsessionid' }); } catch (e) { /* 무시 */ }
  }

  // ===== G1: 입·퇴실 처리 감지 =====
  // 스냅샷 키/포맷은 Android GateCheck.java와 동일 (양쪽이 같은 저장소를 써서 중복 알림 방지)
  const GATE_SNAP_PREFIX = 'gate_snapshot_';

  async function clearGateSnapshots() {
    try {
      const all = await Plugins.Preferences.keys();
      const keys = (all.keys || []).filter(k => k.startsWith(GATE_SNAP_PREFIX));
      await Promise.all(keys.map(k => Plugins.Preferences.remove({ key: k })));
    } catch (e) { /* 무시 */ }
  }

  // 오늘/어제 세션 스냅샷을 갱신하며 새 입·퇴실 처리 이벤트를 알림
  // - 최초 스냅샷은 조용히 채택, 알림 꺼져 있어도 스냅샷은 갱신 (재활성 시 폭주 방지)
  async function processGateEvents(memberId, rawData) {
    try {
      if (!memberId || !rawData) return;

      const todayStr = getTodayString();
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yesterdayStr = getTodayString(y);
      const nextDates = snapshotSessionsByDate(rawData, [todayStr, yesterdayStr]);

      const key = GATE_SNAP_PREFIX + memberId;
      const stored = await getPrefs(key);
      const prevDates = stored && stored.dates ? stored.dates : null;

      const settings = await getSettings();
      if (prevDates && settings.gateNotifyEnabled && settings.notificationsEnabled) {
        const events = detectGateEvents(prevDates, nextDates);
        for (const event of events) {
          const msg = formatGateEventMessage(event, todayStr);
          await scheduleLocalNotification(msg.title, msg.body, gateEventKey(event));
        }
      }

      await setPrefs(key, { dates: nextDates, updatedAt: Date.now() });
    } catch (e) {
      console.warn('[Adapter] 입·퇴실 감지 처리 실패:', e); // 감지 실패가 본래 조회를 깨면 안 됨
    }
  }

  // ===== E2: 평가 일정 자동 연동 =====
  // API: POST https://api.usr.codyssey.kr/schedule/scheduleAllList/ (쿼리스트링, 본문 없음)
  // ※ usr 프론트엔드 번들 실측(2026-07-17) 확정 — 레거시 명세(api.codyssey.kr) 아님
  // 저장 상태키 eval_sync_state는 네이티브 EvalSync.java와 공유 — 어느 쪽이 동기화하든 중복 없음
  const EVAL_STATE_KEY = 'eval_sync_state';
  const EVAL_INST_CD_KEY = 'eval_inst_cd';
  const EVAL_SCHEDULE_API = 'https://api.usr.codyssey.kr';

  function evalYmdDot(d) {
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatEvalWhenKo(ms) {
    const d = new Date(ms);
    const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  async function fetchEvalSchedule(memberId, instCd, fromDate, toDate) {
    if (!Plugins.NetworkPlugin) throw new Error('NETWORK_PLUGIN_UNAVAILABLE');
    const url = `${EVAL_SCHEDULE_API}/schedule/scheduleAllList/?`
      + `mbrId=${encodeURIComponent(memberId)}&instCd=${encodeURIComponent(instCd)}`
      + `&bgngYmd=${evalYmdDot(fromDate)}&endYmd=${evalYmdDot(toDate)}&scheduleType=request`;
    const res = await Plugins.NetworkPlugin.fetch({ url, method: 'POST' }); // 명세: 본문 무시(전송 안 함)
    if (isAuthStatus(res.status)) {
      if (await shouldDiscardSession('평가 스케줄', res.status)) {
        await clearSessionIdentity();
        throw new Error('NOT_LOGGED_IN');
      }
      throw new Error(`EVAL_SCHEDULE_API_ERROR_${res.status || 0}`);
    }
    if (res.status !== 200) throw new Error(`EVAL_SCHEDULE_API_ERROR_${res.status || 0}`);
    const json = res.json || safeJson(res.data);
    if (!json) throw new Error('EVAL_SCHEDULE_PARSE_ERROR');
    authFailStreak = 0;
    return json;
  }

  // instCd 해결: 설정 수동값 → 저장 캐시 → member info 재귀 탐색(발견 시 캐시) 순
  async function resolveInstCd() {
    const settings = await getSettings();
    if (settings.evalInstCd) return settings.evalInstCd;
    const cached = await getPrefs(EVAL_INST_CD_KEY);
    if (cached) return String(cached);
    try {
      if (!Plugins.NetworkPlugin) return null;
      const res = await Plugins.NetworkPlugin.getMemberInfo({});
      const found = findInstCd(res.json || safeJson(res.data));
      if (found) {
        await setPrefs(EVAL_INST_CD_KEY, found);
        return found;
      }
    } catch (e) { /* 아래 null 반환 */ }
    return null;
  }

  // 자동 평가 알람 1건 취소 (네이티브 + 목록)
  async function cancelAutoEvalAlarm(name) {
    if (Plugins.AlarmPlugin) {
      try { await Plugins.AlarmPlugin.cancel({ id: name }); } catch (e) { /* 무시 */ }
    }
    const kept = (await getStoredAlarms()).filter(a => !a || a.name !== name);
    await setPrefs(STORE_KEYS.ALARMS, kept);
  }

  // 평가 일정 → N분 전 알람 자동 등록/변경/해제 (신규·취소 시 알림)
  // leadMinutes 변경도 changed로 감지해 재예약 (설정 기본 시점 변경이 자동 알람에 반영됨)
  // ※ 동시 호출(GET_STATUS+설정 저장 등)의 상태-읽기 경합(중복 등록/알림) 방지용 in-flight 공유
  let evalSyncInFlight = null;
  function syncEvalAlarms(memberId) {
    if (evalSyncInFlight) return evalSyncInFlight;
    evalSyncInFlight = doSyncEvalAlarms(memberId)
      .finally(() => { evalSyncInFlight = null; });
    return evalSyncInFlight;
  }

  // 15차(E3): 스케줄 채널 + 알림함 채널 이원화 — 한쪽 실패필도 다른 채널로 감지
  async function doSyncEvalAlarms(memberId) {
    if (!memberId || !Plugins.AlarmPlugin) return { ok: false, reason: 'unavailable' };
    const settings = await getSettings();
    if (settings.evalAutoSyncEnabled === false) return { ok: false, reason: 'disabled' };

    let schedErr = null;
    let schedInfo = null;
    let noticeErr = null;
    let noticeInfo = null;
    try {
      schedInfo = await syncEvalScheduleChannel(memberId, settings);
    } catch (e) {
      schedErr = String(e.message || 'unknown');
      console.warn('[Adapter] 평가 동기화(스케줄 채널) 실패:', schedErr);
    }
    try {
      noticeInfo = await syncEvalNoticeChannel(memberId, settings);
    } catch (e) {
      noticeErr = String(e.message || 'unknown');
      console.warn('[Adapter] 평가 동기화(알림함 채널) 실패:', noticeErr);
    }

    // S4/15차: 채널별 실패 사유 병합 기록
    try {
      const cur = (await getPrefs(EVAL_STATE_KEY)) || {};
      const merged = { ...cur };
      if (schedErr) { merged.lastError = schedErr; merged.lastErrorAt = Date.now(); }
      else { delete merged.lastError; delete merged.lastErrorAt; }
      if (noticeErr) { merged.alarmError = noticeErr; merged.alarmErrorAt = Date.now(); }
      else { delete merged.alarmError; delete merged.alarmErrorAt; }
      if (noticeInfo) merged.noticeFresh = noticeInfo.fresh;
      await setPrefs(EVAL_STATE_KEY, merged);
    } catch (e2) { /* 상태 기록 실패는 무시 */ }

    return {
      ok: !schedErr || !noticeErr,
      ...(schedInfo || {}),
      reason: schedErr || undefined,
      noticeError: noticeErr || undefined,
      noticeFresh: noticeInfo ? noticeInfo.fresh : undefined
    };
  }

  // E3(15차): 알림함(alarmList/list) 평가 감지 채널 — body으로 페이로드 전송
  const EVAL_NOTICE_STATE_KEY = 'eval_notice_seen';

  async function fetchEvalNoticeList(page = 1, pagePerRows = EVAL_NOTICE_PAGE_PER_ROWS) {
    if (!Plugins.NetworkPlugin) throw new Error('NETWORK_PLUGIN_UNAVAILABLE');
    const res = await Plugins.NetworkPlugin.fetch({
      url: `${EVAL_SCHEDULE_API}/alarm/alarmList/list`,
      method: 'POST',
      body: { page, pagePerRows } // 실측 페이로드 (사용자 제공 명세)
    });
    if (isAuthStatus(res.status)) {
      if (await shouldDiscardSession('평가 알림함', res.status)) {
        await clearSessionIdentity();
        throw new Error('NOT_LOGGED_IN');
      }
      throw new Error(`EVAL_NOTICE_API_ERROR_${res.status || 0}`);
    }
    if (res.status !== 200) throw new Error(`EVAL_NOTICE_API_ERROR_${res.status || 0}`);
    const json = res.json || safeJson(res.data);
    if (!json) throw new Error('EVAL_NOTICE_PARSE_ERROR');
    authFailStreak = 0;
    return json;
  }

  async function upsertEvalAlarmEntryNative(entry) {
    const alarms = await getStoredAlarms();
    const kept = alarms.filter(a => !a || a.name !== entry.name);
    kept.push(entry);
    await setPrefs(STORE_KEYS.ALARMS, kept);
  }

  async function syncEvalNoticeChannel(memberId, settings) {
    const raw = await fetchEvalNoticeList(1);
    const list = (raw && raw.result && (raw.result.list || raw.result.items)) || raw.list || [];
    const items = parseEvalNoticeAlarms(list);
    const seen = ((await getPrefs(EVAL_NOTICE_STATE_KEY)) || {}).ids || {};
    const fresh = filterNewEvalNotices(seen, items);
    let notified = 0;
    let scheduled = 0;

    if (fresh.length) {
      const lead = settings.evalLeadMinutes ?? 30;
      const now = Date.now();
      const currentAlarms = (await getStoredAlarms())
        .filter(a => a && a.type === 'eval' && typeof a.evalWhen === 'number');

      for (const it of fresh) {
        seen[it.pstartSn] = { whenMs: it.whenMs, title: it.title, firstSeenAt: now };

        // E3 중복 방지: 스케줄 채널이 같은 평가(±2분)를 이미 알람으로 잡았으면 캐시만
        const covered = currentAlarms.some(a => Math.abs(a.evalWhen - it.whenMs) <= EVAL_NOTICE_DEDUP_MS);
        if (covered) continue;
        if (it.whenMs <= now) continue;

        const name = buildEvalAlarmName(EVAL_AUTO_ID_PREFIX + it.key);
        const triggerAt = Math.max(it.whenMs - lead * 60000, now + 5000);
        if (Plugins.AlarmPlugin) {
          await Plugins.AlarmPlugin.schedule({
            triggerTimeMillis: triggerAt,
            label: `📋 평가 ${lead}분 전: ${it.title}`,
            id: name
          });
        }
        await upsertEvalAlarmEntryNative({
          name,
          time: triggerAt,
          label: `📋 ${it.title}`,
          endMinutes: null,
          type: 'eval',
          evalTitle: it.title,
          evalWhen: it.whenMs,
          leadMinutes: lead,
          auto: true,
          state: it.state || '',
          createdAt: now
        });
        currentAlarms.push({ evalWhen: it.whenMs, type: 'eval' });
        scheduled++;
        if (settings.notificationsEnabled && notified < 3) {
          notified++;
          // 안정 id — 캐시 쓰기 전 재실행돼도 같은 알림 id로 중복 표시되지 않음
          await scheduleLocalNotification(
            '📋 평가 일정 감지',
            `${formatEvalWhenKo(it.whenMs)} — ${it.title} (알림함 감지 · ${lead}분 전 알람 등록)`,
            `evalnotice_${it.pstartSn}`
          );
        }
      }

      // seen 캐시 프루닝 + 저장
      const cutoff = Date.now() - EVAL_NOTICE_SEEN_TTL_MS;
      for (const k of Object.keys(seen)) {
        if ((seen[k].firstSeenAt || 0) < cutoff) delete seen[k];
      }
      await setPrefs(EVAL_NOTICE_STATE_KEY, { ids: seen, updatedAt: Date.now() });
    }
    return { ok: true, fresh: fresh.length, notified, scheduled, total: items.length };
  }

  // 채널1: scheduleAllList (기존 E2 로직)
  async function syncEvalScheduleChannel(memberId, settings) {
    const instCd = await resolveInstCd();
    if (!instCd) throw new Error('no_instcd');
    try {

      const state = await getPrefs(EVAL_STATE_KEY);
      const prevItems = (state && state.memberId === String(memberId) && Array.isArray(state.items))
        ? state.items : [];

      // C1: 어제~+365일 (30일 밖 평가도 잡히는 즉시 등록)
      const from = new Date(); from.setDate(from.getDate() - 1);
      const to = new Date(); to.setDate(to.getDate() + 365);
      const raw = await fetchEvalSchedule(memberId, instCd, from, to);
      const reqList = (raw && raw.result && (raw.result.reqList || raw.result.list)) || raw.reqList || [];
      const parsed = parseScheduleRows(reqList);
      const lead = settings.evalLeadMinutes ?? 30;
      const diff = diffEvalItems(prevItems, parsed.items, lead);

      const now = Date.now();
      const nextItems = [];
      let notified = 0;

      for (const it of parsed.items) {
        const action = diff.added.some(a => a.key === it.key) ? 'add'
          : diff.changed.some(c => c.key === it.key) ? 'change' : 'keep';
        const existing = prevItems.find(p => p.key === it.key);
        const name = (existing && existing.name) || buildEvalAlarmName(EVAL_AUTO_ID_PREFIX + it.key);

        // 지나간 평가: 예약·목록 정리 후 상태에서도 제외
        if (it.whenMs <= now) {
          if (existing) await cancelAutoEvalAlarm(name);
          continue;
        }

        if (action !== 'keep') {
          await cancelAutoEvalAlarm(name); // 변경 시 이전 예약 정리 후 재예약
          // lead가 이미 지났으면 즉시 알림(5초 후)
          const triggerAt = Math.max(it.whenMs - lead * 60000, now + 5000);
          await Plugins.AlarmPlugin.schedule({
            triggerTimeMillis: triggerAt,
            label: `📋 평가 ${lead}분 전: ${it.title}`,
            id: name
          });
          const alarms = await getStoredAlarms();
          const kept = alarms.filter(a => a && a.name !== name);
          kept.push({
            name,
            time: triggerAt,
            label: `📋 ${it.title}`,
            endMinutes: null,
            type: 'eval',
            evalTitle: it.title,
            evalWhen: it.whenMs,
            leadMinutes: lead,
            auto: true,
            state: it.state || '',
            createdAt: now
          });
          await setPrefs(STORE_KEYS.ALARMS, kept);
          // C2: 협의중(00001)은 조용히 등록 — 확정/진행(00002/00003) 또는 미상일 때만 "감지" 알림
          if (settings.notificationsEnabled && notified < 3 && isEvalConfirmed(it.state)) {
            notified++;
            await scheduleLocalNotification(
              '📋 평가 일정 감지',
              `${formatEvalWhenKo(it.whenMs)} — ${it.title} (${lead}분 전 알람 등록)`,
              `evalnew_${it.key}`
            );
          }
        } else if (existing) {
          // C2: 협의중 → 확정/진행 전환 시 "확정" 알림 (알람 재예약 없이 안내)
          const prevState = existing.state || '';
          if (!isEvalConfirmed(prevState) && isEvalConfirmed(it.state)
              && settings.notificationsEnabled && notified < 3) {
            notified++;
            await scheduleLocalNotification(
              '📋 평가 확정',
              `${formatEvalWhenKo(it.whenMs)} — ${it.title} 평가가 확정되었습니다. (${lead}분 전 알람 유지)`,
              `evalconf_${it.key}_${now}`
            );
          }
          nextItems.push({ ...existing, ...it, name: existing.name });
          continue;
        }
        nextItems.push({ ...it, name, leadMinutes: lead, auto: true });
      }

      for (const rem of diff.removed) {
        if (rem.name) await cancelAutoEvalAlarm(rem.name);
        if (settings.notificationsEnabled && notified < 3) {
          notified++;
          await scheduleLocalNotification(
            '📋 평가 일정 변경',
            `${rem.title || '평가'} 일정이 취소/완료되어 알람을 해제했습니다.`,
            `evaldel_${rem.key}_${now}`
          );
        }
      }

      await setPrefs(EVAL_STATE_KEY, {
        memberId: String(memberId),
        instCd,
        items: nextItems,
        fetchedAt: now,
        skipped: parsed.skipped,
        nonEv: parsed.nonEv || 0,
        sampleKeys: parsed.sampleKeys || null // 필드명 보정용 진단 (첫 EV 행의 키 목록)
      });
      return { ok: true, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, items: nextItems.length };
    } catch (e) {
      throw e; // 실패 병합 기록은 오케스트레이터(doSyncEvalAlarms)에서 일원 처리
    }
  }

  // GET_STATUS 팝업 표시용 평가 동기화 상태 요약 (S4/15차: 알림함 채널 오류 포함)
  function summarizeEvalSyncState(state) {
    if (!state) return { fetchedAt: 0, items: 0, lastError: null, alarmError: null };
    return {
      fetchedAt: state.fetchedAt || 0,
      items: Array.isArray(state.items) ? state.items.length : 0,
      lastError: state.lastError || null,
      alarmError: state.alarmError || null,
      noticeFresh: state.noticeFresh || 0
    };
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

  // ===== Android 로그인 헬퍼 (popup.js에서 직접 사용 — CORS 우회용 네이티브 HTTP) =====
  window.CodysseyNative = {
    isNative: isCapacitor && !!Plugins.NetworkPlugin,
    preCheckLogin: async function(userId) {
      if (!this.isNative) throw new Error('NATIVE_NOT_AVAILABLE');
      const res = await Plugins.NetworkPlugin.preCheckLogin({ userId });
      return { status: res.status || 0, body: res.json || safeJson(res.data) || {}, location: res.location || '' };
    },
    authenticate: async function(userId, password, from) {
      if (!this.isNative) throw new Error('NATIVE_NOT_AVAILABLE');
      const res = await Plugins.NetworkPlugin.authenticate({ userId, password, from: from || '' });
      return { status: res.status || 0, body: res.json || safeJson(res.data) || {}, location: res.location || '' };
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

  // ===== W7/28차: 백그라운드 감지 복원 — WorkManager 15분 주기 (기본 켬, 1분 FGS는 28차에서 폐기) =====
  if (isCapacitor && Plugins.PollingPlugin) {
    getPrefs(STORE_KEYS.SETTINGS).then(settings => {
      if (settings && settings.dashEnabled === false) return;
      return Plugins.PollingPlugin.startDash();
    }).catch(() => {});
  }

  // ===== Q5: 하드웨어 뒤로가기 처리 (미처리 시 앱이 바로 종료됨) =====
  // W5: 재진입/중복 로드 시 리스너가 두 번 등록되지 않도록 단일 등록 가드
  if (isCapacitor && Plugins.App && Plugins.App.addListener && !window.__codysseyBackButtonHooked) {
    window.__codysseyBackButtonHooked = true;
    try {
      Plugins.App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) {
          window.history.back();
        } else {
          Plugins.App.exitApp();
        }
      }).catch(() => {});
    } catch (e) { /* 리스너 미지원 환경 무시 */ }
  }

  // K6: MainActivity가 알림 탭 이벤트 전달 전에 이 플래그를 폴리 -> JS 리스너 준비 여부 확인용
  window.__codysseyAdapterReady = true;
  window.dispatchEvent(new CustomEvent('CodysseyAdapterReady'));

  console.log('[Capacitor Adapter] Loaded', isCapacitor ? '(Capacitor mode)' : '(Web fallback mode)');
})();
