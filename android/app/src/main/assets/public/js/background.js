// ============================================================
// 코디세이 출입기록 익스텐션 - Background Service Worker
// API: https://api.usr.codyssey.kr/rest/user/info/detail (mbrId 조회)
// API: https://api.usr.codyssey.kr/rest/secom/detail?mbrId={mbrId}&year={year}&month={month} (출입기록)
// ============================================================

// 공통 출입 로직 (단일 소스 — capacitor-adapter.js와 공유)
import {
  parseAttendance,
  applyOvernightFromPrevMonth
} from './shared-attendance.js';

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
  keepAliveEnabled: false // 세션 무한 연장 방지 — 사용자가 명시적으로 켜는 opt-in
};

// 알람 이름 프리픽스
const ALARM_PREFIX = 'codyssey_alarm_';

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

// 인증 오류/로그아웃 등 세션 상태 변화 시 출석 캐시 전체 삭제 (R7)
async function clearAttendanceCaches() {
  const all = await getStorage(null);
  const keysToRemove = Object.keys(all).filter(k => k.startsWith(CONFIG.STORAGE_KEYS.CACHE));
  if (keysToRemove.length) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

// ===== API 호출 (세션 쿠키 포함) =====
async function fetchWithAuth(url, options = {}) {
  const defaultOptions = {
    credentials: 'include', // 중요: 세션 쿠키(JSESSIONID) 자동 포함
    redirect: 'manual', // 302를 직접 감지하기 위해 자동 팔로우 방지
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers
    }
  };
  let res = await fetch(url, { ...defaultOptions, ...options });

  // 정상 리다이렉트(codyssey 도메인 남부)는 1회 수동 추적 (N10)
  // ※ cross-origin 리다이렉트는 opaqueredirect라 Location을 읽을 수 없음 — 그 경우 인증 오류로 분류
  if (res.status >= 300 && res.status < 400 && res.type !== 'opaqueredirect') {
    const location = res.headers.get('location') || '';
    if (location.includes('codyssey.kr') && !/login/i.test(location)) {
      res = await fetch(location, defaultOptions);
    } else {
      throw new Error('AUTH_REQUIRED');
    }
  }

  // 세션 만료 감지: 리다이렉트, 401, 로그인 페이지로의 이동
  if (res.type === 'opaqueredirect' || res.status === 302 || res.status === 301 || res.status === 401 || res.status === 403) {
    throw new Error('AUTH_REQUIRED');
  }
  if (res.url && /login/i.test(res.url)) {
    throw new Error('AUTH_REQUIRED');
  }
  return res;
}

// JSON 응답 검증 후 파싱 (로그인 페이지 HTML이 반환되는 경우 인증 오류로 분류)
async function readJsonResponse(res, apiName) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text().catch(() => '');
    if (/login|로그인/i.test(text)) throw new Error('AUTH_REQUIRED');
    throw new Error(`${apiName}_PARSE_ERROR`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${apiName}_PARSE_ERROR`);
  }
}

// --- 1. 멤버 정보 조회 (mbrId 획득) ---
async function fetchMemberInfo() {
  const url = `${CONFIG.API_BASE}/rest/user/info/detail`;
  const res = await fetchWithAuth(url);

  if (!res.ok) {
    throw new Error(`MEMBER_INFO_API_ERROR_${res.status}`);
  }

  return await readJsonResponse(res, 'MEMBER_INFO');
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
  let res;
  try {
    res = await fetchWithAuth(url);
  } catch (e) {
    // 세션 만료인데 캐시만 잔존하는 상태 방지 — 캐시 무효화 후 오류 전파 (R7)
    if (e.message === 'AUTH_REQUIRED') await clearAttendanceCaches();
    throw e;
  }

  if (!res.ok) {
    throw new Error(`ATTENDANCE_API_ERROR_${res.status}`);
  }

  const data = await readJsonResponse(res, 'ATTENDANCE');
  await setCache(cacheKey, data);
  return data;
}

// ===== 알람 관리 =====
function buildAlarmName(memberId, type, endMinutes) {
  return `${ALARM_PREFIX}${memberId}_${type}_${endMinutes}`;
}

// 알람 이름 파싱 (신형 codyssey_alarm_{memberId}_{type}_{endMinutes} + 구형 호환)
function parseAlarmName(name) {
  const parts = name.split('_');
  if (parts[1] === 'alarm' && parts.length >= 5) {
    return { memberId: parts[2], type: parts[3], endMinutes: parseInt(parts[4]) };
  }
  // 구형 codyssey_exit_{memberId}_{endMinutes}
  if (parts[1] === 'exit' && parts.length >= 4) {
    return { memberId: parts[2], type: 'exit', endMinutes: parseInt(parts[3]) };
  }
  return null;
}

async function scheduleExitAlarm(memberId, endMinutes, label = '퇴실 시간', type = 'exit') {
  const now = Date.now();
  const target = new Date();
  target.setHours(0, 0, 0, 0);
  target.setTime(target.getTime() + endMinutes * 60000); // 24시간 초과분은 자동으로 다음 날
  const delay = target.getTime() - now;

  if (delay <= 0) return { success: false, reason: 'past' };

  const alarmName = buildAlarmName(memberId, type, endMinutes);
  
  // 기존 알람 제거 후 재생성 (알람 목록에서도 중복 제거)
  await chrome.alarms.clear(alarmName);
  await chrome.alarms.create(alarmName, { when: target.getTime() });
  
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  const alarmList = (alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [])
    .filter(a => a.name !== alarmName);
  alarmList.push({
    name: alarmName,
    time: target.getTime(),
    label,
    endMinutes,
    type,
    createdAt: now
  });
  await setStorage({ [CONFIG.STORAGE_KEYS.ALARMS + memberId]: alarmList });

  return { success: true, alarmName, triggerTime: target.getTime() };
}

function legacyAlarmName(memberId, endMinutes) {
  return `codyssey_exit_${memberId}_${endMinutes}`;
}

async function cancelExitAlarm(memberId, endMinutes, type = 'exit') {
  const alarmName = buildAlarmName(memberId, type, endMinutes);
  const legacyName = legacyAlarmName(memberId, endMinutes);
  await chrome.alarms.clear(alarmName);
  // 구형 이름으로 저장된 경우도 함께 정리 (N3 유령 알람 방지)
  await chrome.alarms.clear(legacyName);
  
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  const alarmList = (alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [])
    .filter(a => a.name !== alarmName && a.name !== legacyName);
  await setStorage({ [CONFIG.STORAGE_KEYS.ALARMS + memberId]: alarmList });
}

async function getActiveAlarms(memberId) {
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  const list = alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [];
  // 구형 항목 정규화 (type/createdAt 기본값 보강 — N3)
  return list.map(a => ({
    ...a,
    type: a.type || 'exit',
    createdAt: a.createdAt || a.time
  }));
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
  const parsedName = parseAlarmName(alarm.name);
  if (!parsedName) return;

  const { memberId, type, endMinutes } = parsedName;
  const what = type === 'goal' ? '목표 달성 시간' : '퇴실 시간';

  await showNotification(
    '⏰ 코디세이 출입 알림',
    `설정한 ${minutesToHHMM(endMinutes % 1440)} ${what}이 되었습니다.`,
    memberId
  );
  
  // 알람 울린 후 정리
  await cancelExitAlarm(memberId, endMinutes, type);
  
  // 팝업이 열려있으면 업데이트 알림
  chrome.runtime.sendMessage({ type: 'ALARM_TRIGGERED', memberId, endMinutes, alarmType: type }).catch(() => {});
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

          // 월 경계 입실(R2): 이달 데이터에서 입실 중이 아니고 월초(1~3일)이면 전월 데이터 확인
          if (!parsed.isCurrentlyIn && now.getDate() <= 3) {
            try {
              const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
              const prevData = await fetchAttendance(memberId, prev.getFullYear(), prev.getMonth() + 1);
              applyOvernightFromPrevMonth(parsed, prevData);
            } catch (e) {
              console.warn('전월 데이터 확인 실패:', e);
            }
          }

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
          const { endMinutes, label, alarmType } = message;
          const result = await scheduleExitAlarm(memberId, endMinutes, label, alarmType || 'exit');
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
          const { endMinutes, alarmType } = message;
          await cancelExitAlarm(memberId, endMinutes, alarmType || 'exit');
          sendResponse({ success: true });
          break;
        }

        // --- 팝업 발신 로컬 알림 (chrome.notifications로 라우팅) ---
        case 'LOCAL_NOTIFY': {
          await showNotification(message.title || '알림', message.body || '', null);
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
          // 서버 세션 쿠키(JSESSIONID 등)도 함께 삭제 — 로그아웃 후 자동 재로그인 방지
          try {
            const cookies = await chrome.cookies.getAll({ domain: 'codyssey.kr' });
            await Promise.all(cookies.map(c =>
              chrome.cookies.remove({
                url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
                name: c.name
              }).catch(() => {})
            ));
          } catch (e) {
            console.warn('세션 쿠키 삭제 실패:', e);
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
          chrome.tabs.create({ url: chrome.runtime.getURL('calendar.html') });
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