// ============================================================
// Capacitor Adapter - Chrome Extension API를 Capacitor 플러그인으로 변환
// 이 파일을 popup.js, calendar.js 전에 로드해야 함
// ============================================================

(function() {
  'use strict';

  // Capacitor 플러그인 사용 가능 여부 확인
  const isCapacitor = typeof Capacitor !== 'undefined';
  const Plugins = isCapacitor ? Capacitor.Plugins : {};

  // chrome.storage.local → Capacitor Preferences
  if (typeof chrome !== 'undefined' && chrome.storage) {
    const originalStorage = chrome.storage.local;

    chrome.storage.local = {
      get: function(keys, callback) {
        if (isCapacitor && Plugins.Preferences) {
          const keyArray = Array.isArray(keys) ? keys : [keys];
          Promise.all(keyArray.map(k => Plugins.Preferences.get({ key: k })))
            .then(results => {
              const obj = {};
              keyArray.forEach((k, i) => {
                obj[k] = results[i].value;
              });
              if (callback) callback(obj);
            })
            .catch(err => {
              if (callback) callback({});
            });
        } else {
          originalStorage.get(keys, callback);
        }
      },

      set: function(items, callback) {
        if (isCapacitor && Plugins.Preferences) {
          const promises = Object.entries(items).map(([k, v]) =>
            Plugins.Preferences.set({ key: k, value: String(v) })
          );
          Promise.all(promises)
            .then(() => { if (callback) callback(); })
            .catch(err => { if (callback) callback(); });
        } else {
          originalStorage.set(items, callback);
        }
      },

      remove: function(keys, callback) {
        if (isCapacitor && Plugins.Preferences) {
          const keyArray = Array.isArray(keys) ? keys : [keys];
          Promise.all(keyArray.map(k => Plugins.Preferences.remove({ key: k })))
            .then(() => { if (callback) callback(); })
            .catch(err => { if (callback) callback(); });
        } else {
          originalStorage.remove(keys, callback);
        }
      },

      clear: function(callback) {
        if (isCapacitor && Plugins.Preferences) {
          Plugins.Preferences.clear()
            .then(() => { if (callback) callback(); })
            .catch(err => { if (callback) callback(); });
        } else {
          originalStorage.clear(callback);
        }
      }
    };
  }

  // chrome.runtime.sendMessage → Capacitor 플러그인 직접 호출
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.sendMessage = function(message, callback) {
      if (isCapacitor) {
        handleCapacitorMessage(message).then(result => {
          if (callback) callback(result);
        }).catch(err => {
          if (callback) callback({ success: false, error: err.message });
        });
        return true;
      }
    };
  }

  // chrome.alarms → Capacitor AlarmPlugin
  if (typeof chrome !== 'undefined' && !chrome.alarms) {
    chrome.alarms = {
      create: function(name, alarmInfo) {
        if (isCapacitor && Plugins.AlarmPlugin) {
          const triggerTime = alarmInfo.when || (alarmInfo.delayInMinutes ?
            Date.now() + alarmInfo.delayInMinutes * 60000 : 0);
          return Plugins.AlarmPlugin.schedule({
            triggerTimeMillis: triggerTime,
            label: name,
            id: name
          });
        }
      },
      clear: function(name) {
        if (isCapacitor && Plugins.AlarmPlugin) {
          return Plugins.AlarmPlugin.cancel({ id: name });
        }
      },
      clearAll: function() {
        if (isCapacitor && Plugins.AlarmPlugin) {
          return Plugins.AlarmPlugin.cancelAll({});
        }
      }
    };
  }

  // chrome.notifications → Capacitor LocalNotifications
  if (typeof chrome !== 'undefined' && !chrome.notifications) {
    chrome.notifications = {
      create: function(notificationId, options, callback) {
        if (isCapacitor && Plugins.LocalNotifications) {
          Plugins.LocalNotifications.schedule({
            notifications: [{
              id: notificationId.hashCode() & 0x7FFFFFFF,
              title: options.title,
              body: options.message,
              schedule: { at: new Date(Date.now() + 100) },
              sound: options.sound || undefined,
              attachments: options.iconUrl ? [{ id: 'icon', url: options.iconUrl }] : [],
              extra: { notificationId }
            }]
          }).then(() => {
            if (callback) callback(notificationId);
          });
        }
      },
      clear: function(notificationId, callback) {
        if (isCapacitor && Plugins.LocalNotifications) {
          Plugins.LocalNotifications.cancel({ notifications: [{ id: notificationId.hashCode() & 0x7FFFFFFF }] })
            .then(() => { if (callback) callback(true); });
        }
      }
    };
  }

  // 메시지 핸들러
  async function handleCapacitorMessage(message) {
    if (!message || !message.type) {
      return { success: false, error: 'Invalid message' };
    }

    try {
      switch (message.type) {
        case 'GET_STATUS': {
          const memberId = await getMemberId();
          if (!memberId) return { success: false, error: 'NOT_LOGGED_IN' };

          const attendance = await getAttendance(memberId, new Date().getFullYear(), new Date().getMonth() + 1);
          const settings = await getSettings();
          const alarms = await getAlarms();

          return {
            success: true,
            memberId,
            parsed: attendance,
            settings,
            alarms
          };
        }

        case 'FETCH_MEMBER_ID': {
          const memberId = await getMemberId();
          return { success: true, memberId };
        }

        case 'FETCH_ATTENDANCE': {
          const memberId = message.memberId || await getMemberId();
          if (!memberId) return { success: false, error: 'NOT_LOGGED_IN' };
          const attendance = await getAttendance(memberId, message.year, message.month);
          return { success: true, parsed: attendance };
        }

        case 'CALCULATE_TARGET': {
          const memberId = await getMemberId();
          if (!memberId) return { success: false, error: 'NOT_LOGGED_IN' };
          const attendance = await getAttendance(memberId, new Date().getFullYear(), new Date().getMonth() + 1);
          const settings = await getSettings();

          const extraMinutes = message.extraMinutes;
          const nowMin = getCurrentMinutes();
          const endMin = nowMin + extraMinutes;

          const monthlyReq = settings.monthlyRequiredHours * 60;
          const dailyMax = settings.dailyMaxHours * 60;

          const newMonthly = attendance.monthlyTotal + extraMinutes;
          const newDaily = attendance.dailyTotal + extraMinutes;
          const newMonthlyRemain = Math.max(0, monthlyReq - newMonthly);
          const newDailyRemain = Math.max(0, dailyMax - newDaily);

          return {
            success: true,
            endMinutes: endMin,
            endTimeStr: minutesToHHMM(endMin),
            newMonthlyTotal: newMonthly,
            newMonthlyRemain,
            newDailyTotal: newDaily,
            newDailyRemain,
            dailyOver: newDaily > dailyMax,
            monthlyOver: newMonthly > monthlyReq
          };
        }

        case 'SET_ALARM': {
          if (!Plugins.AlarmPlugin) return { success: false, error: 'AlarmPlugin not available' };
          const result = await Plugins.AlarmPlugin.schedule({
            triggerTimeMillis: message.endMinutes * 60 * 1000, // 분을 밀리초로
            label: message.label,
            id: String(message.endMinutes)
          });
          return result;
        }

        case 'CANCEL_ALARM': {
          if (!Plugins.AlarmPlugin) return { success: false, error: 'AlarmPlugin not available' };
          await Plugins.AlarmPlugin.cancel({ id: String(message.endMinutes) });
          return { success: true };
        }

        case 'GET_ALARMS': {
          // 저장된 알람 목록 반환 (로컬 스토리지에서)
          const alarmsData = await Plugins.Preferences.get({ key: 'alarms' });
          const alarms = alarmsData.value ? JSON.parse(alarmsData.value) : [];
          return { success: true, alarms };
        }

        case 'UPDATE_SETTINGS': {
          await Plugins.Preferences.set({ key: 'settings', value: JSON.stringify(message.settings) });
          return { success: true };
        }

        case 'GET_SETTINGS': {
          const settingsData = await Plugins.Preferences.get({ key: 'settings' });
          const defaultSettings = {
            monthlyRequiredHours: 80,
            dailyMaxHours: 12,
            notificationsEnabled: true,
            soundEnabled: true,
            autoRefresh: true,
            refreshInterval: 30,
            keepAliveEnabled: true
          };
          return { success: true, settings: settingsData.value ? JSON.parse(settingsData.value) : defaultSettings };
        }

        case 'LOGOUT': {
          await Plugins.Preferences.remove({ key: 'member_id' });
          await Plugins.Preferences.remove({ key: 'settings' });
          return { success: true };
        }

        case 'OPEN_LOGIN': {
          // 로그인 페이지 열기
          window.location.href = 'https://ams.codyssey.kr/loginForm';
          return { success: true };
        }

        case 'OPEN_CALENDAR': {
          // 캘린더 페이지 열기
          window.location.href = 'calendar.html';
          return { success: true };
        }

        default:
          return { success: false, error: 'Unknown message type' };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // 헬퍼 함수들
  async function getMemberId() {
    if (Plugins.Preferences) {
      const result = await Plugins.Preferences.get({ key: 'member_id' });
      return result.value;
    }
    return null;
  }

  async function getSettings() {
    if (Plugins.Preferences) {
      const result = await Plugins.Preferences.get({ key: 'settings' });
      const defaultSettings = {
        monthlyRequiredHours: 80,
        dailyMaxHours: 12,
        notificationsEnabled: true,
        soundEnabled: true,
        autoRefresh: true,
        refreshInterval: 30,
        keepAliveEnabled: true
      };
      if (result.value) {
        try {
          return { ...defaultSettings, ...JSON.parse(result.value) };
        } catch (e) {
          return defaultSettings;
        }
      }
      return defaultSettings;
    }

  async function getAttendance(memberId, year, month) {
    if (Plugins.NetworkPlugin) {
      const result = await Plugins.NetworkPlugin.getAttendance({
        memberId, year, month
      });
      return result.json || result.data;
    }
    return null;
  }

  async function getAlarms() {
    if (Plugins.Preferences) {
      const result = await Plugins.Preferences.get({ key: 'alarms' });
      return result.value ? JSON.parse(result.value) : [];
    }
    return [];
  }

  function getCurrentMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  function minutesToHHMM(minutes) {
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return `${h}:${m}`;
  }

  // String.hashCode 폴리필
  if (!String.prototype.hashCode) {
    String.prototype.hashCode = function() {
      let hash = 0;
      for (let i = 0; i < this.length; i++) {
        const char = this.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash;
    };
  }

  // 알림 이벤트 리스너 (네이티브 → 웹)
  if (isCapacitor) {
    document.addEventListener('kr.codyssey.attendance.ALARM_TRIGGERED', (e) => {
      window.dispatchEvent(new CustomEvent('ALARM_TRIGGERED', { detail: e.detail }));
    });

    document.addEventListener('kr.codyssey.attendance.SYNC_COMPLETE', () => {
      window.dispatchEvent(new CustomEvent('SYNC_COMPLETE'));
    });

    // 알림 권한 요청
    if (Plugins.LocalNotifications) {
      Plugins.LocalNotifications.requestPermissions();
    }
  }

  console.log('[Capacitor Adapter] Loaded', isCapacitor ? '(Capacitor mode)' : '(Web fallback mode)');
})();