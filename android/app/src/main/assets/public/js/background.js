// ============================================================
// 코디세이 출입기록 익스텐션 - Background Service Worker
// API: https://api.usr.codyssey.kr/rest/user/info/detail (mbrId 조회)
// API: https://api.usr.codyssey.kr/rest/secom/detail?mbrId={mbrId}&year={year}&month={month} (출입기록)
// ============================================================

const CONFIG = {
  API_BASE: 'https://api.usr.codyssey.kr',
  LOGIN_URL: 'https://ams.codyssey.kr/loginForm',
  MONTHLY_REQUIRED_HOURS: 80,
  DAILY_MAX_HOURS: 12,
  STORAGE_KEYS: {
    MEMBER_ID: 'codyssey_member_id',
    SETTINGS: 'codyssey_settings',
    CACHE: 'codyssey_cache_',
    ALARMS: 'codyssey_alarms_'
  }
};

// 기본 설정
const DEFAULT_SETTINGS = {
  monthlyRequiredHours: 80,
  dailyMaxHours: 12,
  notificationsEnabled: true,
  soundEnabled: true,
  autoRefresh: true,
  refreshInterval: 30, // 분
  keepAliveEnabled: true // 로그인 유지 자동 실행
};

// 알람 이름 프리픽스
const ALARM_PREFIX = 'codyssey_exit_';

// ===== 유틸리티 =====
function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

function minutesToHHMM(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function getCurrentMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getMonthString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
}

// ===== 스토리지 =====
async function getStorage(keys) {
  return new Promise(resolve => {
    chrome.storage.local.get(keys, resolve);
  });
}

async function setStorage(data) {
  return new Promise(resolve => {
    chrome.storage.local.set(data, resolve);
  });
}

async function getSettings() {
  const data = await getStorage([CONFIG.STORAGE_KEYS.SETTINGS]);
  return { ...DEFAULT_SETTINGS, ...(data[CONFIG.STORAGE_KEYS.SETTINGS] || {}) };
}

async function saveSettings(settings) {
  await setStorage({ [CONFIG.STORAGE_KEYS.SETTINGS]: settings });
}

async function getMemberId() {
  const data = await getStorage([CONFIG.STORAGE_KEYS.MEMBER_ID]);
  return data[CONFIG.STORAGE_KEYS.MEMBER_ID] || null;
}

async function saveMemberId(memberId) {
  await setStorage({ [CONFIG.STORAGE_KEYS.MEMBER_ID]: memberId });
}

async function getCache(key) {
  const data = await getStorage([CONFIG.STORAGE_KEYS.CACHE + key]);
  const cached = data[CONFIG.STORAGE_KEYS.CACHE + key];
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5분 캐시
    return cached.data;
  }
  return null;
}

async function setCache(key, data) {
  await setStorage({ [CONFIG.STORAGE_KEYS.CACHE + key]: { data, timestamp: Date.now() } });
}

// ===== API 호출 (세션 쿠키 포함) =====
async function fetchWithAuth(url, options = {}) {
  const defaultOptions = {
    credentials: 'include', // 중요: 세션 쿠키(JSESSIONID) 자동 포함
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers
    }
  };
  const res = await fetch(url, { ...defaultOptions, ...options });
  return res;
}

// --- 1. 멤버 정보 조회 (mbrId 획득) ---
async function fetchMemberInfo() {
  const url = `${CONFIG.API_BASE}/rest/user/info/detail`;
  const res = await fetchWithAuth(url);

  if (res.status === 302 || res.status === 401) {
    throw new Error('AUTH_REQUIRED');
  }
  if (!res.ok) {
    throw new Error(`MEMBER_INFO_API_ERROR_${res.status}`);
  }

  const data = await res.json();
  return data;
}

// mbrId 추출 (응답 구조에 따라 조정 필요)
function extractMemberId(memberInfoData) {
  // 실제 응답 구조: { code: 200, result: { mbrId: "1000271067", ... } }
  if (!memberInfoData) return null;
  
  const result = memberInfoData.result || memberInfoData.data || memberInfoData;
  
  // 다양한 필드명 시도 (mbrId가 최우선)
  return result.mbrId 
      || result.memberId 
      || result.userId 
      || result.id 
      || result.no 
      || null;
}

// --- 2. 출입기록 조회 ---
async function fetchAttendance(memberId, year, month) {
  const cacheKey = `attendance_${memberId}_${year}_${month}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  // 사용자 지정 정확한 엔드포인트
  const url = `${CONFIG.API_BASE}/rest/secom/detail?mbrId=${memberId}&year=${year}&month=${String(month).padStart(2,'0')}`;
  const res = await fetchWithAuth(url);

  if (res.status === 302 || res.status === 401) {
    throw new Error('AUTH_REQUIRED');
  }
  if (!res.ok) {
    throw new Error(`ATTENDANCE_API_ERROR_${res.status}`);
  }

  const data = await res.json();
  await setCache(cacheKey, data);
  return data;
}

// ===== 출입기록 파싱 =====
function parseAttendance(data, targetDate = new Date()) {
  // 실제 응답 구조: { success: true, detail_list: [...], month: "07", year: "2026", max_recog_hours: 12 }
  const detailList = data.detail_list || data.result || data.data || data || [];
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;
  const todayStr = getTodayString();
  const nowMin = getCurrentMinutes();

  let monthlyTotal = 0;
  let dailyTotal = 0;
  let lastInTime = null;
  let lastOutTime = null;
  let isCurrentlyIn = false;
  const dailyBreakdown = {};

  // HH:MM:SS 또는 HH:MM 형식을 분으로 변환
  function durationToMinutes(durationStr) {
    if (!durationStr) return 0;
    const parts = durationStr.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 60 + parts[1] + Math.round(parts[2] / 60);
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  }

  // HH:MM:SS 형식을 분 단위(time)로 변환 (entry_time, exit_time용)
  function timeStrToMinutes(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':').map(Number);
    if (parts.length >= 2) {
      return parts[0] * 60 + parts[1];
    }
    return null;
  }

  for (const day of detailList) {
    const dateStr = day.date || '';
    if (!dateStr) continue;
    if (!dateStr.startsWith(`${year}-${String(month).padStart(2,'0')}`)) continue;

    // 서버에서 이미 12시간 캡 적용된 일일 총 시간 사용
    const dailyTotalMinutes = durationToMinutes(day.daily_total_duration);
    
    monthlyTotal += dailyTotalMinutes;
    if (!dailyBreakdown[dateStr]) dailyBreakdown[dateStr] = 0;
    dailyBreakdown[dateStr] = dailyTotalMinutes; // 중복 세션 합산 방지

    // 오늘인 경우 상세 계산
    if (dateStr === todayStr) {
      dailyTotal = dailyTotalMinutes;
      
      // 세션들 순회하며 현재 상태 확인
      const sessions = day.sessions || [];
      for (const session of sessions) {
        const entryMin = timeStrToMinutes(session.entry_time);
        const exitMin = timeStrToMinutes(session.exit_time);
        const isMissing = session.is_missing === true;
        const missingType = session.missing_type;

        // 퇴실 누락된 세션이 있으면 현재 입실 중
        if (isMissing && missingType === 'exit' && entryMin !== null) {
          isCurrentlyIn = true;
          lastInTime = entryMin;
          lastOutTime = null;
        } else if (entryMin !== null && exitMin !== null) {
          // 정상 퇴실한 세션
          lastInTime = entryMin;
          lastOutTime = exitMin;
        }
      }
    }
  }

  return {
    monthlyTotal,
    dailyTotal,
    lastInTime,
    lastOutTime,
    isCurrentlyIn,
    dailyBreakdown,
    // 캘린더용 원본 데이터도 포함
    rawDetailList: detailList
  };
}

// ===== 알람 관리 =====
async function scheduleExitAlarm(memberId, endMinutes, label = '퇴실 시간') {
  const now = Date.now();
  const target = new Date();
  target.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
  const delay = target.getTime() - now;

  if (delay <= 0) return { success: false, reason: 'past' };

  const alarmName = `${ALARM_PREFIX}${memberId}_${endMinutes}`;
  
  // 기존 알람 제거
  await chrome.alarms.clear(alarmName);
  
  // 새 알람 생성
  await chrome.alarms.create(alarmName, { when: target.getTime() });
  
  // 알람 정보 저장
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  const alarmList = alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [];
  alarmList.push({ name: alarmName, time: target.getTime(), label, endMinutes });
  await setStorage({ [CONFIG.STORAGE_KEYS.ALARMS + memberId]: alarmList });

  return { success: true, alarmName, triggerTime: target.getTime() };
}

async function cancelExitAlarm(memberId, endMinutes) {
  const alarmName = `${ALARM_PREFIX}${memberId}_${endMinutes}`;
  await chrome.alarms.clear(alarmName);
  
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  const alarmList = (alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || []).filter(a => a.name !== alarmName);
  await setStorage({ [CONFIG.STORAGE_KEYS.ALARMS + memberId]: alarmList });
}

async function getActiveAlarms(memberId) {
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  return alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [];
}

// ===== 알림 표시 =====
async function showNotification(title, body, memberId) {
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;

  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title,
      message: body,
      priority: 2,
      requireInteraction: true
    });
  } catch (e) {
    console.warn('Notification failed:', e);
  }
}

// 알람 리스너
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const parts = alarm.name.split('_');
  const memberId = parts[1];
  const endMinutes = parseInt(parts[2]);

  await showNotification('⏰ 코디세이 출입 알림', `설정한 ${minutesToHHMM(endMinutes)} 퇴실 시간이 되었습니다.`, memberId);
  
  // 알람 울린 후 정리
  await cancelExitAlarm(memberId, endMinutes);
  
  // 팝업이 열려있으면 업데이트 알림
  chrome.runtime.sendMessage({ type: 'ALARM_TRIGGERED', memberId, endMinutes });
});

// ===== 메시지 핸들러 =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        // --- 상태 조회 (메인) ---
        case 'GET_STATUS': {
          let memberId = await getMemberId();
          
          // 저장된 mbrId 없으면 API로 조회
          if (!memberId) {
            try {
              const memberInfo = await fetchMemberInfo();
              memberId = extractMemberId(memberInfo);
              if (memberId) {
                await saveMemberId(memberId);
              }
            } catch (e) {
              if (e.message === 'AUTH_REQUIRED') {
                sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
                return;
              }
              console.warn('Member info fetch failed:', e);
            }
          }
          
          if (!memberId) {
            sendResponse({ success: false, error: 'NO_MEMBER_ID' });
            return;
          }

          const now = new Date();
          const data = await fetchAttendance(memberId, now.getFullYear(), now.getMonth() + 1);
          const parsed = parseAttendance(data, now);
          const settings = await getSettings();
          const alarms = await getActiveAlarms(memberId);
          sendResponse({ success: true, memberId, parsed, settings, alarms });
          break;
        }

        // --- 멤버 ID 직접 조회 (수동 새로고침용) ---
        case 'FETCH_MEMBER_ID': {
          try {
            const memberInfo = await fetchMemberInfo();
            const memberId = extractMemberId(memberInfo);
            if (memberId) {
              await saveMemberId(memberId);
              sendResponse({ success: true, memberId, raw: memberInfo });
            } else {
              sendResponse({ success: false, error: 'MBR_ID_NOT_FOUND_IN_RESPONSE', raw: memberInfo });
            }
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          break;
        }

        // --- 로그인 ---
        case 'LOGIN': {
          sendResponse({ success: true });
          break;
        }

        // --- 콘텐츠 스크립트에서 감지된 mbrId 저장 ---
        case 'DETECT_MEMBER_ID': {
          if (message.memberId) {
            await saveMemberId(message.memberId);
            sendResponse({ success: true, memberId: message.memberId });
          } else {
            sendResponse({ success: false, error: 'NO_MEMBER_ID' });
          }
          break;
        }

        // --- 출입기록 조회 (캘린더용 - 특정 년월) ---
        case 'FETCH_ATTENDANCE': {
          let memberId = message.memberId || await getMemberId();
          
          if (!memberId) {
            // 자동으로 멤버 정보 조회 시도
            try {
              const memberInfo = await fetchMemberInfo();
              memberId = extractMemberId(memberInfo);
              if (memberId) await saveMemberId(memberId);
            } catch (e) {
              sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
              return;
            }
          }
          
          if (!memberId) {
            sendResponse({ success: false, error: 'NO_MEMBER_ID' });
            return;
          }
          
          const { year, month } = message;
          const data = await fetchAttendance(memberId, year, month);
          const parsed = parseAttendance(data, new Date(year, month - 1));
          sendResponse({ success: true, parsed });
          break;
        }

        // --- 목표 계산 ---
        case 'CALCULATE_TARGET': {
          let memberId = await getMemberId();
          if (!memberId) {
            sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
            return;
          }
          const { extraMinutes } = message;
          const now = new Date();
          const data = await fetchAttendance(memberId, now.getFullYear(), now.getMonth() + 1);
          const parsed = parseAttendance(data, now);
          const settings = await getSettings();
          
          const monthlyReq = settings.monthlyRequiredHours * 60;
          const dailyMax = settings.dailyMaxHours * 60;
          const nowMin = getCurrentMinutes();
          const endMin = nowMin + extraMinutes;
          
          const newMonthly = parsed.monthlyTotal + extraMinutes;
          const newDaily = parsed.dailyTotal + extraMinutes;
          const newMonthlyRemain = Math.max(0, monthlyReq - newMonthly);
          const newDailyRemain = Math.max(0, dailyMax - newDaily);
          
          sendResponse({
            success: true,
            endMinutes: endMin,
            endTimeStr: minutesToHHMM(endMin),
            newMonthlyTotal: newMonthly,
            newMonthlyRemain,
            newDailyTotal: newDaily,
            newDailyRemain,
            dailyOver: newDaily > dailyMax,
            monthlyOver: newMonthly > monthlyReq
          });
          break;
        }

        // --- 알람 설정 ---
        case 'SET_ALARM': {
          const memberId = await getMemberId();
          if (!memberId) {
            sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
            return;
          }
          const { endMinutes, label } = message;
          const result = await scheduleExitAlarm(memberId, endMinutes, label);
          sendResponse(result);
          break;
        }

        // --- 알람 해제 ---
        case 'CANCEL_ALARM': {
          const memberId = await getMemberId();
          if (!memberId) {
            sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
            return;
          }
          const { endMinutes } = message;
          await cancelExitAlarm(memberId, endMinutes);
          sendResponse({ success: true });
          break;
        }

        // --- 알람 목록 ---
        case 'GET_ALARMS': {
          const memberId = await getMemberId();
          if (!memberId) {
            sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
            return;
          }
          const alarms = await getActiveAlarms(memberId);
          sendResponse({ success: true, alarms });
          break;
        }

        // --- 설정 저장 ---
        case 'UPDATE_SETTINGS': {
          await saveSettings(message.settings);
          sendResponse({ success: true });
          break;
        }

        // --- 설정 조회 ---
        case 'GET_SETTINGS': {
          const settings = await getSettings();
          sendResponse({ success: true, settings });
          break;
        }

        // --- 로그아웃 ---
        case 'LOGOUT': {
          await setStorage({ [CONFIG.STORAGE_KEYS.MEMBER_ID]: null });
          const all = await getStorage(null);
          const keysToRemove = Object.keys(all).filter(k => k.startsWith(CONFIG.STORAGE_KEYS.CACHE));
          if (keysToRemove.length) {
            await chrome.storage.local.remove(keysToRemove);
          }
          sendResponse({ success: true });
          break;
        }

        // --- 로그인 페이지 열기 ---
        case 'OPEN_LOGIN': {
          chrome.tabs.create({ url: CONFIG.LOGIN_URL });
          sendResponse({ success: true });
          break;
        }

        // --- 저장된 멤버 ID 조회 ---
        case 'GET_MEMBER_ID_FROM_STORAGE': {
          const memberId = await getMemberId();
          sendResponse({ memberId });
          break;
        }

        // --- 캘린더 열기 ---
        case 'OPEN_CALENDAR': {
          chrome.tabs.create({ url: chrome.runtime.getURL('html/calendar.html') });
          sendResponse({ success: true });
          break;
        }
      }
    } catch (error) {
      console.error('Background error:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true; // 비동기 응답
});

// ===== 설치/업데이트 시 =====
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await saveSettings(DEFAULT_SETTINGS);
    console.log('코디세이 출입기록 익스텐션 설치됨');
  }
});

// 주기적 백그라운드 동기화 (캐시 무효화)
chrome.alarms.create('periodic_sync', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'periodic_sync') {
    const memberId = await getMemberId();
    if (memberId) {
      const now = new Date();
      const cacheKey = `attendance_${memberId}_${now.getFullYear()}_${now.getMonth()+1}`;
      await chrome.storage.local.remove(CONFIG.STORAGE_KEYS.CACHE + cacheKey);
    }
  }
});