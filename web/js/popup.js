// ============================================================
// 코디세이 출입 현황 알리미 - Popup 메인 로직
// ============================================================

// 공통 출입 로직 (단일 소스 — background/adapter와 공유)
import {
  elapsedSinceEntry,
  projectedMonthly,
  minutesToTimeStr,
  minutesToHHMM,
  parseClockHHMM,
  parseGoalDurationHHMM,
  formatEndMinutes,
  getTodayString,
  SERVER_DAILY_CAP_MINUTES,
  describeLoginServerError,
  shouldRetryTrimmedPassword,
  sanitizePasswordCandidate,
  credentialInputDigest,
  stripEdgeInvisibles,
  diagRingAppend,
  formatDiagEntry,
  detectCrossMidnightOpen,
  readOvernightDecision,
  recognizedTodayOvernightAware,
  recognizedMonthlyOvernightAware,
  overnightStatusSuffix,
  overnightEvidenceSuffix,
  OVERNIGHT_PREF_KEY
} from './shared-attendance.js';

// 유틸리티 함수들
function getCurrentMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}

function formatMonth(date) {
  return `${date.getFullYear()}년 ${date.getMonth()+1}월`;
}

// DOM 요소들
const els = {
  // 로그인
  loginScreen: document.getElementById('login-screen'),
  loginForm: document.getElementById('login-form'),
  loginEmail: document.getElementById('login-email'),
  loginPassword: document.getElementById('login-password'),
  loginPwToggle: document.getElementById('login-pw-toggle'),
  loginBtn: document.getElementById('login-btn'),
  loginError: document.getElementById('login-error'),
  loginLoading: document.getElementById('login-loading'),
  loginOfficialLink: document.getElementById('login-official-link'),

  // 대시보드
  dashboard: document.getElementById('dashboard'),
  monthlyTotal: document.getElementById('monthly-total'),
  dailyRealtime: document.getElementById('daily-realtime'),
  monthlyProgress: document.getElementById('monthly-progress'),
  dailyProgress: document.getElementById('daily-progress'),
  monthlyRemain: document.getElementById('monthly-remain'),
  dailyRemain: document.getElementById('daily-remain'),
  currentStatus: document.getElementById('current-status'),
  currentStatusText: document.getElementById('current-status-text'),
  dataWarning: document.getElementById('data-warning'),
  
  // 실시간 상태
  realtimeStatus: document.getElementById('realtime-status'),
  realtimeEntryTime: document.getElementById('realtime-entry-time'),
  realtimeElapsed: document.getElementById('realtime-elapsed'),
  realtimeRecognized: document.getElementById('realtime-recognized'),
  
  // 로그인 유지
  btnKeepAlive: document.getElementById('btn-keep-alive'),
  keepAliveStatus: document.getElementById('keep-alive-status'),
  keepAliveText: document.getElementById('keep-alive-text'),
  keepAliveNext: document.getElementById('keep-alive-next'),
  keepAliveIndicator: document.querySelector('.keep-alive-indicator'),

  // 캘린더
  calendarGridMini: document.getElementById('calendar-grid-mini'),
  calendarMonth: document.getElementById('calendar-month'),
  btnPrevMonth: document.getElementById('btn-prev-month'),
  btnNextMonth: document.getElementById('btn-next-month'),
  btnTodayMonth: document.getElementById('btn-today-month'),

  // 계산기 모드 (라디오 그룹)
  calcModeExit: document.getElementById('calc-mode-exit'),
  calcModeGoal: document.getElementById('calc-mode-goal'),
  modeCardExit: document.getElementById('mode-card-exit'),
  modeCardGoal: document.getElementById('mode-card-goal'),
  exitPanel: document.getElementById('exit-panel'),
  goalPanel: document.getElementById('goal-panel'),

  // 1. 퇴실 시간 입력
  exitTimeInput: document.getElementById('exit-time-input'),
  btnCalcExit: document.getElementById('btn-calc-exit'),
  exitResult: document.getElementById('exit-result'),
  exitTotalRecognized: document.getElementById('exit-total-recognized'),
  exitDailyTotal: document.getElementById('exit-daily-total'),
  exitDailyRemain: document.getElementById('exit-daily-remain'),
  exitMonthlyTotal: document.getElementById('exit-monthly-total'),
  exitMonthlyRemain: document.getElementById('exit-monthly-remain'),
  exitWarning: document.getElementById('exit-warning'),
  btnSetExitAlarm: document.getElementById('btn-set-exit-alarm'),
  btnCancelExitAlarm: document.getElementById('btn-cancel-exit-alarm'),

  // 2. 목표 시간 입력 (기간: 단일 HH:MM 칸)
  goalTimeInput: document.getElementById('goal-time-input'),
  btnCalcGoal: document.getElementById('btn-calc-goal'),
  goalResult: document.getElementById('goal-result'),
  goalEndTime: document.getElementById('goal-end-time'),
  goalDailyTotal: document.getElementById('goal-daily-total'),
  goalDailyRemain: document.getElementById('goal-daily-remain'),
  goalMonthlyTotal: document.getElementById('goal-monthly-total'),
  goalMonthlyRemain: document.getElementById('goal-monthly-remain'),
  goalWarning: document.getElementById('goal-warning'),
  btnSetGoalAlarm: document.getElementById('btn-set-goal-alarm'),
  btnCancelGoalAlarm: document.getElementById('btn-cancel-goal-alarm'),

  // 활성 알람 목록
  alarmsSection: document.getElementById('alarms-section'),
  alarmsCount: document.getElementById('alarms-count'),
  alarmsList: document.getElementById('alarms-list'),
  alarmsEmpty: document.getElementById('alarms-empty'),

  // 평가 알람 (E2: 서버 목록 자동 연동 — S3: 수동 등록 UI 제거)
  evalSyncStatus: document.getElementById('eval-sync-status'),
  btnSyncEval: document.getElementById('btn-sync-eval'),

  // 권한 배너
  permissionBanner: document.getElementById('permission-banner'),
  btnAllowNotification: document.getElementById('btn-allow-notification'),

  // 푸터
  lastUpdate: document.getElementById('last-update'),
  linkLogout: document.getElementById('link-logout'),

  // 설정 모달
  settingsModal: document.getElementById('settings-modal'),
  settingMonthlyHours: document.getElementById('setting-monthly-hours'),
  settingDailyHours: document.getElementById('setting-daily-hours'),
  settingDeadlineAlert: document.getElementById('setting-deadline-alert'),
  settingNotifications: document.getElementById('setting-notifications'),
  settingSound: document.getElementById('setting-sound'),
  settingAutoRefresh: document.getElementById('setting-auto-refresh'),
  settingRefreshInterval: document.getElementById('setting-refresh-interval'),
  settingKeepAlive: document.getElementById('setting-keep-alive'),
  settingGateNotify: document.getElementById('setting-gate-notify'),
  settingDash: document.getElementById('setting-dash'),
  btnBatteryExempt: document.getElementById('btn-battery-exempt'),
  btnExactAlarm: document.getElementById('btn-exact-alarm'),
  settingDashStatus: document.getElementById('setting-dash-status'),
  sessionExpiredBanner: document.getElementById('session-expired-banner'),
  // 29차: 자정 롤오버 임시 기록 배너
  overnightBanner: document.getElementById('overnight-banner'),
  overnightBannerText: document.getElementById('overnight-banner-text'),
  overnightBannerActions: document.getElementById('overnight-banner-actions'),
  btnOvernightStay: document.getElementById('btn-overnight-stay'),
  btnOvernightMissing: document.getElementById('btn-overnight-missing'),
  btnOvernightChange: document.getElementById('btn-overnight-change'),
  // 31차: 물리 탐지 (베타)
  settingPhyEnabled: document.getElementById('setting-phy-enabled'),
  settingPhyGeofence: document.getElementById('setting-phy-geofence'),
  btnPhyLearn: document.getElementById('btn-phy-learn'),
  settingPhyStatus: document.getElementById('setting-phy-status'),
  btnSessionRelogin: document.getElementById('btn-session-relogin'),
  initSplash: document.getElementById('init-splash'),
  loginDiag: document.getElementById('login-diag'),
  loginDiagList: document.getElementById('login-diag-list'),
  btnDiagCopy: document.getElementById('btn-diag-copy'),
  btnDiagClear: document.getElementById('btn-diag-clear'),
  settingsDiagList: document.getElementById('settings-diag-list'),
  btnSettingsDiagCopy: document.getElementById('btn-settings-diag-copy'),
  btnSettingsDiagClear: document.getElementById('btn-settings-diag-clear'),
  settingEvalLead: document.getElementById('setting-eval-lead'),
  settingEvalAutosync: document.getElementById('setting-eval-autosync'),
  settingEvalInstcdRow: document.getElementById('setting-eval-instcd-row'),
  settingEvalInstcd: document.getElementById('setting-eval-instcd'),
  btnSettingsSave: document.getElementById('btn-settings-save'),
  btnSettingsCancel: document.getElementById('btn-settings-cancel'),

  // 헤더 버튼들
  btnSettings: document.getElementById('btn-settings'),
  btnRefresh: document.getElementById('btn-refresh'),
};

// 상태 변수
let currentMemberId = null;
let currentParsed = null;
// 29차: 자정 롤오버 "임시 기록" — 전날 시작 미퇴실 세션 감지/확인 상태
let overnightDetection = null;
let overnightDecision = null; // 'overnight' | 'missing' | null
let phyInsideForBanner = null; // 31차: 자정 배너 물리 근거 캐시 (true 학원 근처 / false 학원 밖 / null 불명)
let currentSettings = null;
let refreshTimer = null;
let realtimeTimer = null;
let alarmListTimer = null; // 문제1: 알람 목록 자동 갱신
// 27차: 알람 목록은 innerHTML로 렌더되므로 클릭 핸들러를 data-index 위임 방식으로 처리한다.
// (MV3 CSP가 인라인 onclick을 차단 — 익스텐션 팝업에서 "해제" 버튼이 동작하지 않던 오류 해소)
let lastRenderedAlarmNames = [];
let keepAliveTimer = null;
let keepAliveEnabled = true;
let exitAlarmEndMinutes = null;
let goalAlarmEndMinutes = null;
let currentViewDate = new Date(); // 캘린더용
let currentEvalSync = null; // S4: 평가 연동 상태 (GET_STATUS 응답의 evalSync)

// ===== 크롬 런타임 메시지 전송 헬퍼 =====
function sendMessage(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...data }, resolve);
  });
}

// ===== 19차: 세션 진단 로그 (네이티브 DiagLog와 같은 링버퍼 — 웹 폴곤은 localStorage) =====
async function diag(tag, msg) {
  try {
    const p = window.Capacitor?.Plugins?.PollingPlugin;
    if (window.CodysseyNative?.isNative && p?.logDiag) {
      await p.logDiag({ tag, msg });
      return;
    }
  } catch (e) { /* 폴곤으로 */ }
  try {
    const raw = localStorage.getItem('diag_log') || '[]';
    localStorage.setItem('diag_log',
      JSON.stringify(diagRingAppend(JSON.parse(raw), { t: Date.now(), tag, msg })));
  } catch (e) { /* 진단 실패는 무시 */ }
}

async function readDiagEntries() {
  try {
    const p = window.Capacitor?.Plugins?.PollingPlugin;
    if (window.CodysseyNative?.isNative && p?.getDiagLog) {
      const r = await p.getDiagLog();
      const arr = JSON.parse(r.raw || '[]');
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) { /* 폴곤으로 */ }
  try { return JSON.parse(localStorage.getItem('diag_log') || '[]'); } catch (e) { return []; }
}

async function clearDiagEntries() {
  try {
    const p = window.Capacitor?.Plugins?.PollingPlugin;
    if (window.CodysseyNative?.isNative && p?.clearDiagLog) await p.clearDiagLog();
  } catch (e) { /* 무시 */ }
  try { localStorage.removeItem('diag_log'); } catch (e) { /* 무시 */ }
}

async function renderLoginDiag() {
  if (!els.loginDiag) return;
  const entries = await readDiagEntries();
  if (!entries.length) { els.loginDiag.style.display = 'none'; return; }
  els.loginDiagList.innerHTML = '';
  entries.slice(-8).reverse().forEach(e => {
    const div = document.createElement('div');
    div.className = 'login-diag-item';
    div.textContent = formatDiagEntry(e);
    els.loginDiagList.appendChild(div);
  });
  els.loginDiag.style.display = 'block';
}

// 37차: 설정 화면용 진단 로그 표시 — 백그라운드 감지 불량 원인(TICK/GATE/COOKIE/NOTIF) 확인용
async function renderSettingsDiag() {
  if (!els.settingsDiagList) return;
  const entries = await readDiagEntries();
  els.settingsDiagList.innerHTML = '';
  if (!entries.length) {
    const div = document.createElement('div');
    div.className = 'login-diag-item';
    div.textContent = '기록 없음 — 알림이 안 온 시점 이후 항목이 쌓이면 여기에 표시됩니다';
    els.settingsDiagList.appendChild(div);
    return;
  }
  entries.slice(-8).reverse().forEach(e => {
    const div = document.createElement('div');
    div.className = 'login-diag-item';
    div.textContent = formatDiagEntry(e);
    els.settingsDiagList.appendChild(div);
  });
}

// ===== UI 상태 관리 =====
// 24차: 초기 스플래시 — 세션 확인 구간 동안 로그인 폼 섬광 노출을 차단
function hideInitSplash() {
  if (els.initSplash) els.initSplash.style.display = 'none';
}

function showLoginScreen(cause) {
  hideInitSplash();
  els.loginScreen.style.display = 'block';
  els.dashboard.style.display = 'none';
  els.loginLoading.classList.remove('show');
  els.loginForm.style.display = 'flex';
  els.loginError.classList.remove('show');
  // 19차: 왜 이 화면이 나왔는지를 진단 로그에 남김 + 즉시 표시
  if (cause) diag('POPUP', '로그인 화면 표시 — ' + cause).then(renderLoginDiag);
  else renderLoginDiag();
}

function showLoginLoading() {
  els.loginForm.style.display = 'none';
  els.loginLoading.classList.add('show');
}

function showDashboard() {
  hideInitSplash();
  els.loginScreen.style.display = 'none';
  els.dashboard.style.display = 'flex';
}

// 22차: 세션 만료 시 로그인 폼으로 화면을 뺏지 않고 캐시 대시보드 유지 + 배너
function showExpiredBanner() {
  if (els.sessionExpiredBanner) els.sessionExpiredBanner.style.display = 'flex';
}
function hideExpiredBanner() {
  if (els.sessionExpiredBanner) els.sessionExpiredBanner.style.display = 'none';
}

function showLoginError(msg) {
  els.loginError.textContent = msg;
  els.loginError.classList.add('show');
  els.loginForm.style.display = 'flex';
  els.loginLoading.classList.remove('show');
}

function setLoginButtonLoading(loading) {
  const btnText = els.loginBtn.querySelector('.btn-text');
  const btnLoading = els.loginBtn.querySelector('.btn-loading');
  if (loading) {
    btnText.style.display = 'none';
    btnLoading.style.display = 'inline-flex';
    els.loginBtn.disabled = true;
  } else {
    btnText.style.display = 'inline';
    btnLoading.style.display = 'none';
    els.loginBtn.disabled = false;
  }
}

// ===== 데이터 로드 및 UI 업데이트 =====
async function loadDashboard(forceRefresh = false) {
  try {
    // J1: forceRefresh면 서버에서 강제 갱신 (5분 캐시 바이패스)
    const response = await sendMessage('GET_STATUS', { force: forceRefresh });
    if (!response.success) {
      if (response.error === 'NOT_LOGGED_IN') {
        // 19차: 세션 무효 '확정'에만 여기 도달 (단발 302/401은 어댑터가 세션 유지 판정)
        // 22차: member_id는 남아 있으므로 캐시 대시보드 + 만료 배너 유지 (폼으로 튕기지 않음)
        if (currentMemberId || currentParsed) {
          diag('POPUP', '세션 만료 — 캐시 대시보드 유지 (재로그인 대기)');
          showDashboard();
          showExpiredBanner();
          updateLastUpdateTime();
          return;
        }
        showLoginScreen('세션 무효 확정 — 상태 조회 반복 실패 + 회원 정보 재조사 실패 (만료 또는 서버측 로그아웃)');
        return;
      }
      throw new Error(response.error);
    }

    currentMemberId = response.memberId;
    currentParsed = response.parsed;
    currentSettings = response.settings;
    currentEvalSync = response.evalSync || null; // S4: 평가 연동 상태

    hideExpiredBanner(); // 22차: 세션 회복(재로그인 성공)되면 배너 해제

    await syncOvernightFromStorage(); // 29차: 롤오버 선택 상태 병합
    updateDashboardUI();
    checkNotificationPermission();
    updateLastUpdateTime();
    updateKeepAliveUI();
    startRealtimeUpdate();
    startAlarmListRefresh(); // 문제1: 알람 목록 주기 갱신
    renderCalendar(); // 캘린더 렌더링
    
    showDashboard();
  } catch (error) {
    console.error('Dashboard load error:', error);
    // 19차: 인증류 '확정'(위 분기)이 아닌 오류(망 흔들림·일시 응답 이상)는
    // 기존 데이터가 있으면 화면 유지 — 로그인 폼으로 튕기지 않음. 다음 갱신 주기에 회복.
    diag('POPUP', '대시보드 갱신 실패 (화면 유지) — ' + (error.message || '알 수 없는 오류'));
    if (currentParsed) {
      updateLastUpdateTime();
      return;
    }
    showLoginError(describeError(error));
    showLoginScreen('첫 데이터 로드 실패: ' + String(error.message || '').slice(0, 60));
  }
}

// 오류 코드를 사용자 친화적 메시지로 변환 (관측 가능성 개선)
function describeError(error) {
  const code = (error && error.message) || '';
  if (code.includes('AUTH') || code.includes('NOT_LOGGED_IN')) {
    return '로그인이 필요합니다. 다시 로그인해주세요.';
  }
  if (code.includes('PARSE')) {
    return '출입 데이터 형식이 예상과 다릅니다. 앱 업데이트가 필요할 수 있습니다.';
  }
  if (code.includes('API_ERROR') || code.includes('ATTENDANCE') || code.includes('MEMBER_INFO')) {
    return '코디세이 서버에서 오류를 반환했습니다. 잠시 후 다시 시도해주세요.';
  }
  if (code.includes('Failed to fetch') || code.includes('NetworkError') || code.includes('Network')) {
    return '네트워크 연결을 확인해주세요.';
  }
  return '데이터를 불러오는데 실패했습니다. 다시 시도해주세요.';
}

// ===== 29차: 자정 롤오버 "임시 기록" — 전날 미퇴실 세션 확인 =====
function getOvernightDecisionRaw() {
  try { return JSON.parse(localStorage.getItem(OVERNIGHT_PREF_KEY) || 'null'); } catch (e) { return null; }
}

async function persistOvernightDecision(obj) {
  const v = JSON.stringify(obj || null);
  try {
    if (obj) localStorage.setItem(OVERNIGHT_PREF_KEY, v);
    else localStorage.removeItem(OVERNIGHT_PREF_KEY);
  } catch (e) { /* 무시 */ }
  // 앱: 네이티브 GateCheck(백그라운드 자정 확인 알림)도 읽을 수 있게 공유 prefs에 반영
  try {
    const P = window.Capacitor?.Plugins?.Preferences;
    if (P && window.CodysseyNative?.isNative) {
      if (obj) await P.set({ key: OVERNIGHT_PREF_KEY, value: v });
      else await P.remove({ key: OVERNIGHT_PREF_KEY });
    }
  } catch (e) { /* 무시 */ }
  // 익스텐션: 백그라운드(SW)의 자정 확인이 읽을 수 있게 chrome.storage에도 반영
  try {
    if (!window.CodysseyNative?.isNative && typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [OVERNIGHT_PREF_KEY]: obj || null });
    }
  } catch (e) { /* 무시 */ }
}

// 익스텐션: SW 측 알림 경로와 선택 상태 공유 — chrome.storage의 최신값을 localStorage로 병합
async function syncOvernightFromStorage() {
  try {
    if (window.CodysseyNative?.isNative) return; // 앱은 localStorage 기준으로 충분
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const r = await chrome.storage.local.get(OVERNIGHT_PREF_KEY);
      const v = r ? r[OVERNIGHT_PREF_KEY] : undefined;
      if (v) localStorage.setItem(OVERNIGHT_PREF_KEY, JSON.stringify(v));
    }
  } catch (e) { /* 무시 */ }
}

function refreshOvernightState() {
  overnightDetection = detectCrossMidnightOpen(currentParsed);
  overnightDecision = readOvernightDecision(getOvernightDecisionRaw(), overnightDetection, currentMemberId);
  updateOvernightBanner();
  // 31차: 물리 탐지가 켜져 있으면 배너 문구에 물리 근거 첨부 (비동기 — 도착 시 재렌더)
  if (overnightDetection) refreshPhyInsideForBanner();
  // 세션이 닫히면(정상 퇴실 처리) 지난 확인 결과는 정리
  if (!overnightDetection && getOvernightDecisionRaw()) {
    persistOvernightDecision(null);
    overnightDecision = null;
  }
}

// 31차: 네이티브 물리 판정(학원 근처 여부)을 가져와 배너 근거 문구에 반영
async function refreshPhyInsideForBanner() {
  phyInsideForBanner = null;
  try {
    const phy = window.Capacitor?.Plugins?.PhyPlugin;
    if (!phy) return;
    const st = await phy.getPhyStatus();
    if (st && st.enabled) {
      phyInsideForBanner = (st.inside === null || st.inside === undefined) ? null : !!st.inside;
    }
  } catch (e) { /* 웹/구버전 무시 */ }
  updateOvernightBanner();
}

function updateOvernightBanner() {
  const banner = els.overnightBanner;
  if (!banner) return;
  if (!overnightDetection) { banner.classList.remove('show'); return; }
  banner.classList.add('show');
  const d = overnightDetection;
  if (!overnightDecision) {
    els.overnightBannerText.textContent =
      `🌙 전날 ${d.entryTimeStr} 입실 기록이 자정을 넘겼습니다. 밤샘 근무인가요, 퇴실 누락인가요? (확인 전까지 "임시"로 오늘 집계 제외)`
      + overnightEvidenceSuffix(phyInsideForBanner); // 31차: 물리 근거 첨부
    els.overnightBannerActions.style.display = 'flex';
    els.btnOvernightChange.style.display = 'none';
  } else if (overnightDecision === 'overnight') {
    els.overnightBannerText.textContent = `🌙 전날 ${d.entryTimeStr} 입실 — 밤샘 근무로 집계 중입니다.`;
    els.overnightBannerActions.style.display = 'none';
    els.btnOvernightChange.style.display = 'inline';
  } else {
    els.overnightBannerText.textContent = `🚪 전날 ${d.entryTimeStr} 입실 — 퇴실 누락으로 처리해 오늘 집계에서 제외 중입니다.`;
    els.overnightBannerActions.style.display = 'none';
    els.btnOvernightChange.style.display = 'inline';
  }
}

async function chooseOvernight(decision) {
  if (!overnightDetection) return;
  if (decision) {
    await persistOvernightDecision({
      entryDate: overnightDetection.entryDateStr,
      memberId: currentMemberId,
      decision,
      at: Date.now()
    });
    overnightDecision = decision;
    diag('OVN', decision === 'overnight'
      ? `밤샘 근무 선택 — 전날 ${overnightDetection.entryTimeStr} 입실분 정상 집계`
      : `퇴실 누락 선택 — 전날 ${overnightDetection.entryTimeStr} 입실분 오늘 집계 제외`);
  } else {
    await persistOvernightDecision(null);
    overnightDecision = null;
    diag('OVN', '자정 롤오버 확인 결과 초기화 (변경)');
  }
  updateOvernightBanner();
  updateDashboardUI();
}

function updateDashboardUI() {
  if (!currentParsed || !currentSettings) return;

  refreshOvernightState(); // 29차: 자정 롤오버 임시 처리 상태 최신화

  const { monthlyTotal, dailyTotal, lastInTime, lastOutTime, isCurrentlyIn } = currentParsed;
  const monthlyReq = currentSettings.monthlyRequiredHours * 60;
  const dailyMax = currentSettings.dailyMaxHours * 60;

  // 월 누적 인정 시간 = 서버 누적 값 + (현재 시간 - 마지막 입실 시간)
  const realtimeMonthly = calculateRealtimeMonthly();
  const monthlyRemainMin = Math.max(0, monthlyReq - realtimeMonthly);
  const monthlyPct = Math.min(100, (realtimeMonthly / monthlyReq) * 100);

  // 월 누적 (실시간 반영)
  els.monthlyTotal.textContent = minutesToTimeStr(realtimeMonthly);
  els.monthlyProgress.style.width = `${monthlyPct}%`;
  els.monthlyRemain.textContent = `남음: ${minutesToTimeStr(monthlyRemainMin)}`;
  els.monthlyRemain.className = `remain ${monthlyRemainMin > 0 ? 'warning' : 'ok'}`;

  // 오늘 실시간 인정 (누적 + 실시간 경과)
  const realtimeRecognized = calculateRealtimeRecognized();
  els.dailyRealtime.textContent = minutesToTimeStr(realtimeRecognized);
  els.dailyProgress.style.width = `${Math.min(100, (realtimeRecognized / dailyMax) * 100)}%`;
  els.dailyRemain.textContent = `남음: ${minutesToTimeStr(Math.max(0, dailyMax - realtimeRecognized))}`;
  els.dailyRemain.className = `remain ${Math.max(0, dailyMax - realtimeRecognized) > 0 ? 'warning' : 'ok'}`;

  // 입실 기록 누락 경고 (R5) + S1: 낡은 미퇴실 세션 제외 안내
  if (els.dataWarning) {
    if (currentParsed.hasMissingEntry) {
      els.dataWarning.textContent = '⚠️ 입실 기록 누락이 감지되었습니다. 출입 내역이 실제와 다를 수 있습니다.';
      els.dataWarning.style.display = 'block';
    } else if (currentParsed.staleOpenSession) {
      const st = currentParsed.staleOpenSession;
      els.dataWarning.textContent = `⚠️ ${st.dateStr} ${st.entry} 입실 기록에 퇴실이 없어 오래된 세션으로 판단, 실시간 누적에서 제외했습니다. 퇴실 처리 여부를 확인해주세요.`;
      els.dataWarning.style.display = 'block';
    } else {
      els.dataWarning.style.display = 'none';
    }
  }

  // 실시간 추정치 표시 (R3): 입실 중에는 서버 확정 전 추정값임을 툴팁으로 안내
  els.monthlyTotal.title = isCurrentlyIn
    ? '실시간 추정치 (입실 경과 포함, 서버 확정 전)'
    : '';

  // 현재 상태 (29차: 자정 롤오버 시 괄호 표기 — 임시/밤샘/누락)
  if (isCurrentlyIn && lastInTime !== null) {
    els.currentStatus.className = 'current-status show in';
    els.currentStatusText.textContent = `입실 중 (입실: ${minutesToHHMM(lastInTime)})`
      + overnightStatusSuffix(overnightDetection, overnightDecision);
    // 실시간 상세 표시
    els.realtimeStatus.classList.add('show');
    els.realtimeEntryTime.textContent = minutesToHHMM(lastInTime);
  } else if (lastOutTime !== null) {
    els.currentStatus.className = 'current-status show out';
    els.currentStatusText.textContent = `퇴실 완료 (마지막: ${minutesToHHMM(lastOutTime)})`;
    els.realtimeStatus.classList.remove('show');
  } else {
    els.currentStatus.className = 'current-status';
    els.realtimeStatus.classList.remove('show');
  }

  // 계산 결과 초기화
  resetAllCalculations();
  updateCalcModeUI(); // 토글 모드에 맞는 패널 표시

  // S4: 평가 연동 상태 표시
  renderEvalSyncStatus();

  // 알람 목록 로드 및 렌더링
  loadAndRenderAlarms();
}

// S4: 평가 연동 상태 한 줄 표시 (수동 등록 폼을 대체)
function renderEvalSyncStatus() {
  const el = els.evalSyncStatus;
  if (!el) return;
  if (currentSettings && currentSettings.evalAutoSyncEnabled === false) {
    el.textContent = '평가 일정 자동 연동이 꺼져 있습니다. (설정에서 켤 수 있습니다)';
    return;
  }
  const s = currentEvalSync;
  const stamp = (t) => {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${formatTime(d)}`;
  };
  if (s && s.lastError) {
    const when = s.fetchedAt ? ` (${stamp(s.fetchedAt)})` : '';
    el.textContent = `⚠️ 연동 실패${when}: ${describeEvalSyncError(s.lastError)}`;
    return;
  }
  let base;
  if (!s || !s.fetchedAt) {
    base = '아직 평가 일정을 가져오지 못했습니다. 잠시 후 자동으로 확인합니다.';
  } else {
    base = `✅ ${stamp(s.fetchedAt)} 확인 완료 · 예정된 평가 알람 ${s.items}건`;
    if (s.noticeFresh) base += ` · 알림함 신규 감지 ${s.noticeFresh}건`;
  }
  if (s && s.alarmError) base += ' · ⚠️ 알림함 채널 오류 (스케줄 채널은 정상)';
  el.textContent = base;
}

// S4: 평가 연동 오류 코드 → 사용자용 한글 설명
function describeEvalSyncError(err) {
  const e = String(err || '');
  if (/AUTH_REQUIRED|NOT_LOGGED_IN|30[12378]|401|403/.test(e)) {
    return '로그인 세션이 만료되었거나 확인할 수 없습니다. 로그아웃 후 다시 로그인해주세요.';
  }
  if (/no_instcd/.test(e)) return '기관 코드(instCd)를 찾지 못했습니다. 설정에서 직접 입력해주세요.';
  if (/no_member/.test(e)) return '로그인 정보가 없습니다. 다시 로그인해주세요.';
  if (/NETWORK_PLUGIN|unavailable/i.test(e)) return '기기 네트워크 기능을 사용할 수 없습니다.';
  if (/api_-1|Failed to fetch|NetworkError|timeout/i.test(e)) return '네트워크 연결 상태를 확인해주세요.';
  return e;
}

// 실시간 인정 시간 계산 (서버 규칙: 일 12시간 캡 — shared-attendance.js 참조)
// 29차: 자정 롤오버 임시/누락 상태면 전날 세션 경과를 오늘에 합산하지 않음
function calculateRealtimeRecognized() {
  if (!currentParsed) return 0;
  return recognizedTodayOvernightAware(currentParsed, overnightDetection, overnightDecision);
}

// formatEndMinutes는 shared-attendance.js 단일 소스 사용 (K11)

// 실시간 월 누적 인정 시간 계산 (일일 상한 적용, 29차: 롤오버 인지형)
function calculateRealtimeMonthly() {
  if (!currentParsed) return 0;
  return recognizedMonthlyOvernightAware(currentParsed, overnightDetection, overnightDecision);
}

// 실시간 업데이트 (1초마다)
function startRealtimeUpdate() {
  stopRealtimeUpdate();
  if (!currentParsed?.isCurrentlyIn || !currentParsed?.lastInTime) return;
  
  realtimeTimer = setInterval(() => {
    updateRealtimeUI();
  }, 1000);
  updateRealtimeUI();
}

function stopRealtimeUpdate() {
  if (realtimeTimer) {
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
}

// 문제1: 팝업을 열어둔 채 알람이 울리고 지나가도 목록이 스스로 정리되도록
// (1분 간격으로 GET_ALARMS → 서버측 K8 정리 + renderAlarms의 시간 지남 필터)
function startAlarmListRefresh() {
  clearAlarmListRefresh();
  alarmListTimer = setInterval(() => {
    loadAndRenderAlarms();
  }, 60 * 1000);
}

function clearAlarmListRefresh() {
  if (alarmListTimer) {
    clearInterval(alarmListTimer);
    alarmListTimer = null;
  }
}

function updateRealtimeUI() {
  if (!currentParsed?.isCurrentlyIn || !currentParsed?.lastInTime) {
    els.realtimeStatus.classList.remove('show');
    stopRealtimeUpdate();
    updateDashboardUI(); // 전체 다시 그리기
    return;
  }
  
  const elapsed = elapsedSinceEntry(currentParsed);
  const recognized = calculateRealtimeRecognized(); // 29차: 롤오버 인지
  
  els.realtimeElapsed.textContent = minutesToTimeStr(elapsed);
  els.realtimeRecognized.textContent = minutesToTimeStr(recognized);
  els.realtimeEntryTime.textContent = minutesToHHMM(currentParsed.lastInTime);
  
  // 실시간 인정 시간도 업데이트
  els.dailyRealtime.textContent = minutesToTimeStr(recognized);
  const dailyMax = currentSettings.dailyMaxHours * 60;
  const dailyPct = Math.min(100, (recognized / dailyMax) * 100);
  els.dailyProgress.style.width = `${dailyPct}%`;
  els.dailyRemain.textContent = `남음: ${minutesToTimeStr(Math.max(0, dailyMax - recognized))}`;
  els.dailyRemain.className = `remain ${Math.max(0, dailyMax - recognized) > 0 ? 'warning' : 'ok'}`;
  
  // 월 누적도 실시간으로 함께 업데이트 (서버 누적 + 현재 시간 - 마지막 입실 시간)
  const realtimeMonthly = calculateRealtimeMonthly(); // 29차: 롤오버 인지
  const monthlyReq = currentSettings.monthlyRequiredHours * 60;
  const monthlyRemainMin = Math.max(0, monthlyReq - realtimeMonthly);
  els.monthlyTotal.textContent = minutesToTimeStr(realtimeMonthly);
  els.monthlyProgress.style.width = `${Math.min(100, (realtimeMonthly / monthlyReq) * 100)}%`;
  els.monthlyRemain.textContent = `남음: ${minutesToTimeStr(monthlyRemainMin)}`;
  els.monthlyRemain.className = `remain ${monthlyRemainMin > 0 ? 'warning' : 'ok'}`;
  
  // 계산 중인 결과도 실시간 반영
  updateExitCalculationLive();
  updateGoalCalculationLive();
}

// 퇴실 계산 실시간 반영
function updateExitCalculationLive() {
  if (!els.exitResult.classList.contains('show') || exitAlarmEndMinutes === null) return;
  const nowMin = getCurrentMinutes();
  if (nowMin >= exitAlarmEndMinutes) return; // 시간 지남
  
  const entryMin = currentParsed.lastInTime;
  const todayTotalSoFar = calculateRealtimeRecognized(); // 29차: 롤오버 인지
  const additionalMinutes = exitAlarmEndMinutes - nowMin;
  const projectedDailyTotal = todayTotalSoFar + additionalMinutes;
  const dailyMax = currentSettings.dailyMaxHours * 60;
  const recognizedDaily = Math.min(projectedDailyTotal, SERVER_DAILY_CAP_MINUTES);
  
  const projectedMonthlyTotal = projectedMonthly(currentParsed, additionalMinutes);
  const monthlyReq = currentSettings.monthlyRequiredHours * 60;
  const monthlyRemain = Math.max(0, monthlyReq - projectedMonthlyTotal);
  const dailyRemain = Math.max(0, dailyMax - recognizedDaily);
  
  els.exitTotalRecognized.textContent = minutesToTimeStr(recognizedDaily);
  els.exitDailyTotal.textContent = minutesToTimeStr(recognizedDaily);
  els.exitDailyRemain.textContent = minutesToTimeStr(dailyRemain);
  els.exitDailyRemain.className = `calculator-result-value ${dailyRemain > 0 ? 'remain' : 'ok'}`;
  els.exitMonthlyTotal.textContent = minutesToTimeStr(projectedMonthlyTotal);
  els.exitMonthlyRemain.textContent = minutesToTimeStr(monthlyRemain);
  els.exitMonthlyRemain.className = `calculator-result-value ${monthlyRemain > 0 ? 'remain' : 'ok'}`;
  
  if (projectedDailyTotal > dailyMax) {
    els.exitWarning.classList.add('show');
    els.exitWarning.textContent = `⚠️ 일 최대 ${currentSettings.dailyMaxHours}시간 초과! (인정: ${minutesToTimeStr(recognizedDaily)})`;
  }
}

// 목표 계산 실시간 반영
function updateGoalCalculationLive() {
  if (!els.goalResult.classList.contains('show') || goalAlarmEndMinutes === null) return;
  const nowMin = getCurrentMinutes();
  if (nowMin >= goalAlarmEndMinutes) return;
  
  const todayTotalSoFar = calculateRealtimeRecognized(); // 29차: 롤오버 인지
  const remainingToGoal = goalAlarmEndMinutes - nowMin;
  const projectedDailyTotal = todayTotalSoFar + remainingToGoal;
  const dailyMax = currentSettings.dailyMaxHours * 60;
  const recognizedDaily = Math.min(projectedDailyTotal, SERVER_DAILY_CAP_MINUTES);
  
  const projectedMonthlyTotal = projectedMonthly(currentParsed, remainingToGoal);
  const monthlyReq = currentSettings.monthlyRequiredHours * 60;
  const monthlyRemain = Math.max(0, monthlyReq - projectedMonthlyTotal);
  const dailyRemain = Math.max(0, dailyMax - recognizedDaily);
  
  els.goalEndTime.textContent = formatEndMinutes(goalAlarmEndMinutes);
  els.goalDailyTotal.textContent = minutesToTimeStr(recognizedDaily);
  els.goalDailyRemain.textContent = minutesToTimeStr(dailyRemain);
  els.goalDailyRemain.className = `calculator-result-value ${dailyRemain > 0 ? 'remain' : 'ok'}`;
  els.goalMonthlyTotal.textContent = minutesToTimeStr(projectedMonthlyTotal);
  els.goalMonthlyRemain.textContent = minutesToTimeStr(monthlyRemain);
  els.goalMonthlyRemain.className = `calculator-result-value ${monthlyRemain > 0 ? 'remain' : 'ok'}`;
}

function updateLastUpdateTime() {
  els.lastUpdate.textContent = `최근 업데이트: ${formatTime(new Date())}`;
}

// ===== 알람 목록 로드 및 렌더링 =====
async function loadAndRenderAlarms() {
  try {
    const response = await sendMessage('GET_ALARMS');
    if (response.success) {
      renderAlarms(response.alarms);
    }
  } catch (error) {
    console.error('Load alarms error:', error);
  }
}

function renderAlarms(alarms) {
  // 문제1 수정: 렌더 시점에도 시간 지남 항목은 제거 — 어떤 경로(구버전 데이터/걸러지지 않은 응답)로든
  // "(시간 지남)" 유령 항목이 화면에 남지 않도록 최종 방어선을 둠
  const nowRender = Date.now();
  const liveAlarms = (alarms || []).filter(a => a && typeof a.time === 'number' && a.time > nowRender);

  if (liveAlarms.length === 0) {
    lastRenderedAlarmNames = [];
    els.alarmsList.innerHTML = '<div class="alarms-empty">설정된 알람이 없습니다.</div>';
    els.alarmsCount.textContent = '0개';
    return;
  }

  els.alarmsCount.textContent = `${liveAlarms.length}개`;

  // 27차: 렌더된 순서와 동일한 이름 배열 — 해제 버튼(data-alarm-idx) 위임 클릭 시 이 배열로 이름을 찾는다
  lastRenderedAlarmNames = liveAlarms.map(a => String((a && a.name) || ''));

  const now = Date.now();
  els.alarmsList.innerHTML = liveAlarms.map((alarm, idx) => {
    const isEval = (alarm.type || '') === 'eval'; // E1: 평가 알람은 날짜+시각 표기
    const timeStr = isEval
      ? formatEvalWhen(alarm.evalWhen || alarm.time)
      : formatEndMinutes(alarm.endMinutes);
    const label = alarm.label || '알람';
    const type = isEval ? 'eval' : (alarm.type || (label.includes('퇴실') ? 'exit' : 'goal'));
    const remainingMin = Math.max(1, Math.ceil((alarm.time - now) / 60000));
    const createdStr = alarm.createdAt
      ? new Date(alarm.createdAt).toLocaleString()
      : new Date(alarm.time).toLocaleString();
    const subText = isEval
      ? `${alarm.leadMinutes ?? 0}분 전 알림 · ${remainingMin}분 후`
      : `${remainingMin}분 후`;

    return `
      <div class="alarm-item ${type}" data-end-minutes="${alarm.endMinutes}" data-alarm-type="${type}">
        <div class="alarm-info">
          <div class="alarm-label">${label}</div>
          <div class="alarm-time">${timeStr} (${subText})</div>
          <div class="alarm-meta">설정: ${createdStr}</div>
        </div>
        <div class="alarm-actions">
          <button class="btn btn-danger btn-sm" data-alarm-idx="${idx}">해제</button>
        </div>
      </div>
    `;
  }).join('');
}

// E1: 평가 일시 표기 (예: 7월 18일 (토) 14:00)
function formatEvalWhen(ms) {
  const d = new Date(ms);
  const date = d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  return `${date} ${formatTime(d)}`;
}

// (S3) E1 수동 평가 등록 UI/핸들러 제거 — 평가 알람은 서버 목록 자동 연동(E2)이 유일 경로
// ※ SET_EVAL_ALARM 메시지 핸들러는 호환용으로 background/adapter에 유지

// 문제2 수정: 해제는 목록에 표시된 "실제 알람 이름"으로 요청 — 순간의 memberId와 무관하게 정확히 해제
window.cancelAlarmFromList = async function(alarmName) {
  try {
    // 26차: 목록에서 해제해도 당일 자동 재등록 금지 (exit/goal 타입만 해당)
    try {
      const resp = await sendMessage('GET_ALARMS');
      const item = (resp.alarms || []).find(a => a && a.name === alarmName);
      const t = item && (item.type || 'exit');
      if (item && (t === 'exit' || t === 'goal')) setAutoAlarmDisabledToday(t, true);
    } catch (e) { /* 플래그 실패는 무시 — 해제 자체는 진행 */ }

    await sendMessage('CANCEL_ALARM', { alarmName });
    showNotification('알람 해제', '설정된 알림이 취소되었습니다.');
    await loadAndRenderAlarms();
    // 계산기 버튼 상태도 동기화
    syncAlarmButtons();
  } catch (error) {
    console.error('Cancel alarm error:', error);
  }
};

async function syncAlarmButtons() {
  // exit/goal 알람 버튼 상태 동기화
  try {
    const alarmsResponse = await sendMessage('GET_ALARMS');
    if (!alarmsResponse.success) return;
    
    const alarms = alarmsResponse.alarms;
    
    if (exitAlarmEndMinutes !== null) {
      const existing = alarms.find(a => a.endMinutes === exitAlarmEndMinutes && (a.type || 'exit') === 'exit');
      if (existing) {
        els.btnSetExitAlarm.style.display = 'none';
        els.btnCancelExitAlarm.style.display = 'block';
      } else {
        els.btnSetExitAlarm.style.display = 'block';
        els.btnCancelExitAlarm.style.display = 'none';
      }
    }
    if (goalAlarmEndMinutes !== null) {
      const existing = alarms.find(a => a.endMinutes === goalAlarmEndMinutes && (a.type || 'exit') === 'goal');
      if (existing) {
        els.btnSetGoalAlarm.style.display = 'none';
        els.btnCancelGoalAlarm.style.display = 'block';
      } else {
        els.btnSetGoalAlarm.style.display = 'block';
        els.btnCancelGoalAlarm.style.display = 'none';
      }
    }
  } catch (error) {
    console.error('Sync alarm buttons error:', error);
  }
}

// ===== 캘린더 렌더링 =====
// 보고 있는 월이 실제 이번 달인지 (K9: 실시간 값은 이번 달에만 적용)
function isCurrentMonthView() {
  const now = new Date();
  return currentViewDate.getFullYear() === now.getFullYear() &&
         currentViewDate.getMonth() === now.getMonth();
}

// K9: 오늘 셀은 서버 확정 값과 실시간 인정 값 중 큰 값 표시 (calendar.js L5와 동작 통일)
function miniDisplayMinutes(dateStr, serverValue) {
  if (dateStr === getTodayString() && isCurrentMonthView() && currentParsed?.isCurrentlyIn) {
    return Math.max(serverValue, calculateRealtimeRecognized()); // 29차: 롤오버 인지
  }
  return serverValue;
}

function renderCalendar() {
  if (!currentSettings) return;
  
  // 캘린더용 데이터 선택 (해당 월 데이터가 있으면 사용, 없으면 현재 월 데이터)
  const calendarData = window.calendarParsed || currentParsed;
  if (!calendarData) return;
  
  const year = currentViewDate.getFullYear();
  const month = currentViewDate.getMonth();
  const today = new Date();
  const todayStr = getTodayString();
  const dailyMax = currentSettings.dailyMaxHours * 60;

  const firstDay = new Date(year, month, 1).getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();
  const prevLastDate = new Date(year, month, 0).getDate();

  const grid = els.calendarGridMini;
  
  // 헤더(요일)만 남기고 제거
  const headers = grid.querySelectorAll('.calendar-day-header');
  grid.innerHTML = '';
  headers.forEach(h => grid.appendChild(h));

  // 지난 달
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = prevLastDate - i;
    const date = new Date(year, month - 1, day);
    const dateStr = getTodayString(date);
    const dayData = calendarData.dailyBreakdown[dateStr] || 0;
    grid.appendChild(createMiniDayElement(day, dateStr, dayData, dailyMax, true, false, todayStr));
  }

  // 이번 달
  for (let day = 1; day <= lastDate; day++) {
    const date = new Date(year, month, day);
    const dateStr = getTodayString(date);
    const dayData = miniDisplayMinutes(dateStr, calendarData.dailyBreakdown[dateStr] || 0); // K9: 오늘은 실시간 값
    const isToday = dateStr === todayStr;
    grid.appendChild(createMiniDayElement(day, dateStr, dayData, dailyMax, false, isToday, todayStr));
  }

  // 다음 달
  const totalCells = firstDay + lastDate;
  const nextMonthDays = Math.ceil(totalCells / 7) * 7 - totalCells;
  for (let day = 1; day <= nextMonthDays; day++) {
    const date = new Date(year, month + 1, day);
    const dateStr = getTodayString(date);
    const dayData = calendarData.dailyBreakdown[dateStr] || 0;
    grid.appendChild(createMiniDayElement(day, dateStr, dayData, dailyMax, true, false, todayStr));
  }

  // 월 표시
  els.calendarMonth.textContent = formatMonth(currentViewDate);
}

function createMiniDayElement(day, dateStr, minutes, dailyMax, isOtherMonth, isToday, todayStr) {
  const div = document.createElement('div');
  div.className = 'calendar-day';
  div.dataset.date = dateStr;
  
  if (isOtherMonth) div.classList.add('other-month');
  if (isToday) div.classList.add('today');
  if (minutes > 0) div.classList.add('has-record');
  if (minutes > dailyMax) div.classList.add('has-over');
  
  // 현재 입실 중인 날짜 표시
  if (currentParsed?.isCurrentlyIn && dateStr === todayStr && minutes === 0) {
    div.classList.add('current-in');
  }

  const numDiv = document.createElement('div');
  numDiv.className = 'calendar-day-number';
  numDiv.textContent = day;
  div.appendChild(numDiv);

  const recordsDiv = document.createElement('div');
  recordsDiv.className = 'calendar-day-records';
  
  if (minutes > 0) {
    const recordDiv = document.createElement('div');
    recordDiv.className = 'calendar-record' + (minutes > dailyMax ? ' over' : '');
    recordDiv.textContent = minutesToTimeStr(minutes);
    recordsDiv.appendChild(recordDiv);
  } else if (currentParsed?.isCurrentlyIn && dateStr === todayStr) {
    // 입실 중인데 기록이 0인 경우 (방금 입실)
    const recordDiv = document.createElement('div');
    recordDiv.className = 'calendar-record current';
    recordDiv.textContent = '입실중';
    recordsDiv.appendChild(recordDiv);
  }
  
  div.appendChild(recordsDiv);
  return div;
}

// ===== 캘린더 네비게이션 =====
function goToMonth(offset) {
  currentViewDate = new Date(currentViewDate.getFullYear(), currentViewDate.getMonth() + offset, 1);
  loadCalendarData();
}

function goToThisMonth() {
  currentViewDate = new Date();
  currentViewDate.setDate(1);
  loadCalendarData();
}

async function loadCalendarData() {
  if (!currentMemberId || !currentSettings) return;
  
  try {
    const year = currentViewDate.getFullYear();
    const month = currentViewDate.getMonth() + 1;
    
    // J4: 그리드 가장자리 인접 월 셀에도 기록이 표시되도록 전/다음 월을 함께 조회
    const prevDate = new Date(year, month - 2, 1);
    const nextDate = new Date(year, month, 1);
    const [curRes, prevRes, nextRes] = await Promise.all([
      sendMessage('FETCH_ATTENDANCE', { memberId: currentMemberId, year, month }),
      sendMessage('FETCH_ATTENDANCE', { memberId: currentMemberId, year: prevDate.getFullYear(), month: prevDate.getMonth() + 1 }),
      sendMessage('FETCH_ATTENDANCE', { memberId: currentMemberId, year: nextDate.getFullYear(), month: nextDate.getMonth() + 1 })
    ]);
    
    if (curRes.success) {
      const parsed = curRes.parsed;
      // 인접 월은 dailyBreakdown만 병합 (합계/입실 상태는 보고 있는 월 기준 유지)
      if (prevRes && prevRes.success) {
        parsed.dailyBreakdown = { ...prevRes.parsed.dailyBreakdown, ...parsed.dailyBreakdown };
      }
      if (nextRes && nextRes.success) {
        parsed.dailyBreakdown = { ...parsed.dailyBreakdown, ...nextRes.parsed.dailyBreakdown };
      }
      window.calendarParsed = parsed;
      renderCalendar();
    } else {
      // 실패 시 기존 데이터로 렌더링
      renderCalendar();
    }
  } catch (error) {
    console.error('Calendar data load error:', error);
    renderCalendar();
  }
}

// ===== 계산기 모드 전환 (라디오 그룹 — 카드가 곧 라디오 버튼, 상호 배타) =====
function updateCalcModeUI() {
  const isGoalMode = els.calcModeGoal.checked;
  els.exitPanel.classList.toggle('hidden', isGoalMode);
  els.goalPanel.classList.toggle('hidden', !isGoalMode);
  els.modeCardExit.classList.toggle('active', !isGoalMode);
  els.modeCardGoal.classList.toggle('active', isGoalMode);
  resetAllCalculations();
}

// ===== 알림 권한 =====
async function checkNotificationPermission() {
  // Android(네이티브): 앱 시작 시 LocalNotifications 권한을 이미 요청하므로 배너 불필요
  if (window.CodysseyNative && window.CodysseyNative.isNative) {
    els.permissionBanner.classList.remove('show');
    return;
  }
  if (!('Notification' in window)) return;
  const perm = Notification.permission;
  if (perm === 'default') {
    els.permissionBanner.classList.add('show');
  } else {
    els.permissionBanner.classList.remove('show');
  }
}

async function requestNotificationPermission() {
  // Android(네이티브): LocalNotifications.requestPermissions()로 이미 처리됨
  if (window.CodysseyNative && window.CodysseyNative.isNative) {
    return true;
  }
  if (!('Notification' in window)) {
    alert('이 브라우저는 알림을 지원하지 않습니다.');
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    els.permissionBanner.classList.remove('show');
    return true;
  }
  return false;
}

// ===== 1. 퇴실 시간 입력 -> 총 인정 시간 계산 =====
async function calculateExitTime() {
  const exitMin = parseClockHHMM(els.exitTimeInput.value); // HH:MM 마스크 + 범위 검증
  if (exitMin === null) {
    alert('퇴실 예정 시간을 입력하세요. (시:분, 예: 18:30)');
    els.exitTimeInput.focus();
    return;
  }

  try {
    const nowMin = getCurrentMinutes();
    const entryMin = currentParsed.lastInTime;
    
    if (!currentParsed.isCurrentlyIn || entryMin === null) {
      alert('현재 입실 중이 아닙니다.');
      return;
    }
    
    if (exitMin <= nowMin) {
      alert('퇴실 시간은 현재 시간보다 이후여야 합니다.');
      return;
    }
    
    // 서버 누적 값 + (현재 시간 - 마지막 입실 시간) 기준으로 계산 (일일 상한 적용)
    const todayTotalSoFar = calculateRealtimeRecognized(); // 29차: 롤오버 인지
    const additionalMinutes = exitMin - nowMin;
    const projectedDailyTotal = todayTotalSoFar + additionalMinutes;
    const dailyMax = currentSettings.dailyMaxHours * 60;
    const recognizedDaily = Math.min(projectedDailyTotal, SERVER_DAILY_CAP_MINUTES);
    
    const projectedMonthlyTotal = projectedMonthly(currentParsed, additionalMinutes);
    const monthlyReq = currentSettings.monthlyRequiredHours * 60;
    const monthlyRemain = Math.max(0, monthlyReq - projectedMonthlyTotal);
    const dailyRemain = Math.max(0, dailyMax - recognizedDaily);
    
    exitAlarmEndMinutes = exitMin;
    
    // 결과 표시
    els.exitTotalRecognized.textContent = minutesToTimeStr(recognizedDaily);
    els.exitDailyTotal.textContent = minutesToTimeStr(recognizedDaily);
    els.exitDailyRemain.textContent = minutesToTimeStr(dailyRemain);
    els.exitDailyRemain.className = `calculator-result-value ${dailyRemain > 0 ? 'remain' : 'ok'}`;
    els.exitMonthlyTotal.textContent = minutesToTimeStr(projectedMonthlyTotal);
    els.exitMonthlyRemain.textContent = minutesToTimeStr(monthlyRemain);
    els.exitMonthlyRemain.className = `calculator-result-value ${monthlyRemain > 0 ? 'remain' : 'ok'}`;
    
    // 경고
    if (projectedDailyTotal > dailyMax) {
      els.exitWarning.classList.add('show');
      els.exitWarning.textContent = `⚠️ 일 최대 ${currentSettings.dailyMaxHours}시간 초과! (인정: ${minutesToTimeStr(recognizedDaily)})`;
    } else {
      els.exitWarning.classList.remove('show');
    }
    
    // 알람: 26차 — 계산 즉시 자동 등록 (삭제는 '해제' 또는 목록에서)
    els.btnSetExitAlarm.style.display = 'block';
    els.btnCancelExitAlarm.style.display = 'none';
    els.exitResult.classList.add('show');

    await autoRegisterAlarm(exitAlarmEndMinutes, 'exit', '퇴실 알림');
    
  } catch (error) {
    console.error('Calculate exit error:', error);
    alert('계산 중 오류가 발생했습니다.');
  }
}

// ===== HH:MM 입력 마스크 — 숫자만 받고 2자리 뒤 콜론 자동 삽입 (양 계산 칸 공용) =====
function attachHHMMMask(inputEl) {
  if (!inputEl) return;
  inputEl.addEventListener('input', () => {
    const digits = inputEl.value.replace(/\D/g, '').slice(0, 4);
    inputEl.value = digits.length > 2 ? digits.slice(0, 2) + ':' + digits.slice(2) : digits;
  });
}

// ===== 2. 목표 시간 입력 -> 퇴실 시간 계산 =====
async function calculateGoalTime() {
  const goalMinutes = parseGoalDurationHHMM(els.goalTimeInput.value);
  if (goalMinutes === null) {
    alert('올바른 목표 시간을 입력하세요. (시:분, 예: 08:00 — 최대 12:00)');
    els.goalTimeInput.focus();
    return;
  }

  try {
    const nowMin = getCurrentMinutes();
    const entryMin = currentParsed.lastInTime;
    
    if (!currentParsed.isCurrentlyIn || entryMin === null) {
      alert('현재 입실 중이 아닙니다.');
      return;
    }
    
    // 서버 누적 값 + (현재 시간 - 마지막 입실 시간) 기준으로 계산 (일일 상한 적용)
    const todayTotalSoFar = calculateRealtimeRecognized(); // 29차: 롤오버 인지
    const remainingToGoal = goalMinutes - todayTotalSoFar;
    
    if (remainingToGoal <= 0) {
      alert(`이미 목표 시간(${minutesToTimeStr(goalMinutes)})을 달성했습니다!`);
      return;
    }
    
    const endMin = nowMin + remainingToGoal;
    const dailyMax = currentSettings.dailyMaxHours * 60;
    const projectedDailyTotal = todayTotalSoFar + remainingToGoal;
    const recognizedDaily = Math.min(projectedDailyTotal, SERVER_DAILY_CAP_MINUTES);
    
    const projectedMonthlyTotal = projectedMonthly(currentParsed, remainingToGoal);
    const monthlyReq = currentSettings.monthlyRequiredHours * 60;
    const monthlyRemain = Math.max(0, monthlyReq - projectedMonthlyTotal);
    const dailyRemain = Math.max(0, dailyMax - recognizedDaily);
    
    goalAlarmEndMinutes = endMin;
    
    // 결과 표시
    els.goalEndTime.textContent = formatEndMinutes(endMin);
    els.goalDailyTotal.textContent = minutesToTimeStr(recognizedDaily);
    els.goalDailyRemain.textContent = minutesToTimeStr(dailyRemain);
    els.goalDailyRemain.className = `calculator-result-value ${dailyRemain > 0 ? 'remain' : 'ok'}`;
    els.goalMonthlyTotal.textContent = minutesToTimeStr(projectedMonthlyTotal);
    els.goalMonthlyRemain.textContent = minutesToTimeStr(monthlyRemain);
    els.goalMonthlyRemain.className = `calculator-result-value ${monthlyRemain > 0 ? 'remain' : 'ok'}`;
    
    // 경고
    if (projectedDailyTotal > dailyMax) {
      els.goalWarning.classList.add('show');
      els.goalWarning.textContent = `⚠️ 일 최대 ${currentSettings.dailyMaxHours}시간 초과! (인정: ${minutesToTimeStr(recognizedDaily)})`;
    } else {
      els.goalWarning.classList.remove('show');
    }
    
    // 알람: 26차 — 계산 즉시 자동 등록 (삭제는 '해제' 또는 목록에서)
    els.btnSetGoalAlarm.style.display = 'block';
    els.btnCancelGoalAlarm.style.display = 'none';
    els.goalResult.classList.add('show');

    await autoRegisterAlarm(goalAlarmEndMinutes, 'goal', '목표 달성 알림');
    
  } catch (error) {
    console.error('Calculate goal error:', error);
    alert('계산 중 오류가 발생했습니다.');
  }
}

function resetAllCalculations() {
  // 퇴실 시간 계산 초기화
  els.exitResult.classList.remove('show');
  els.exitWarning.classList.remove('show');
  els.btnSetExitAlarm.style.display = 'none';
  els.btnCancelExitAlarm.style.display = 'none';
  exitAlarmEndMinutes = null;
  
  // 목표 시간 계산 초기화
  els.goalResult.classList.remove('show');
  els.goalWarning.classList.remove('show');
  els.btnSetGoalAlarm.style.display = 'none';
  els.btnCancelGoalAlarm.style.display = 'none';
  goalAlarmEndMinutes = null;
}

// ===== 알람 설정/해제 =====
async function setExitAlarm() {
  if (exitAlarmEndMinutes === null) return;
  await setGenericAlarm(exitAlarmEndMinutes, 'exit', '퇴실 알림', () => {
    els.btnSetExitAlarm.style.display = 'none';
    els.btnCancelExitAlarm.style.display = 'block';
  });
}

async function cancelExitAlarm() {
  if (exitAlarmEndMinutes === null) return;
  await cancelGenericAlarm(exitAlarmEndMinutes, 'exit', () => {
    els.btnSetExitAlarm.style.display = 'block';
    els.btnCancelExitAlarm.style.display = 'none';
  });
}

async function setGoalAlarm() {
  if (goalAlarmEndMinutes === null) return;
  await setGenericAlarm(goalAlarmEndMinutes, 'goal', '목표 달성 알림', () => {
    els.btnSetGoalAlarm.style.display = 'none';
    els.btnCancelGoalAlarm.style.display = 'block';
  });
}

async function cancelGoalAlarm() {
  if (goalAlarmEndMinutes === null) return;
  await cancelGenericAlarm(goalAlarmEndMinutes, 'goal', () => {
    els.btnSetGoalAlarm.style.display = 'block';
    els.btnCancelGoalAlarm.style.display = 'none';
  });
}

async function setGenericAlarm(endMinutes, alarmType, label, onSuccess) {
  const hasPerm = await requestNotificationPermission();
  // 23차: 권한 없으면 조용히 return되어 사용자가 '설정된 줄'로 착각하던 결함 — 안내 + 설정 진입
  if (!hasPerm) {
    alert('알림 권한이 꺼져 있어 알람이 울리지 않습니다.\n설정 > 알림에서 이 앱의 알림을 허용한 뒤 다시 설정해주세요.');
    return;
  }

  try {
    const timeStr = formatEndMinutes(endMinutes);
    const response = await sendMessage('SET_ALARM', { 
      endMinutes,
      alarmType,
      label: `${label} (${timeStr})`
    });
    
    if (response.success) {
      // 26차: 수동 재등록은 사용자 명시 행동 — 당일 자동 재등록 금지 해제
      setAutoAlarmDisabledToday(alarmType, false);
      onSuccess();
      showNotification('알람 설정 완료', `${timeStr}에 ${label}이 울립니다.`);
      // M5: 정확 알람 권한이 없어 부정확 경로로 예약된 경우 안내
      if (response.exact === false) {
        setTimeout(() => {
          alert('정확한 알람 권한이 꺼져 있어 알림 시각이 몇 분 늦어질 수 있습니다.\n알림 권한 설정에서 "정확한 알람"을 허용해주세요.');
          if (window.CodysseyNative && window.CodysseyNative.isNative) {
            window.CodysseyNative.requestExactAlarmPermission().catch(() => {});
          }
        }, 300);
      }
    } else {
      // K2: 과거 시각 등 설정 거부 사유를 사용자에게 표시 (무음 실패 방지)
      alert(response.reason === 'past'
        ? '설정한 시간이 이미 지났습니다. 시간을 다시 확인해주세요.'
        : `알람 설정에 실패했습니다. (${response.error || '알 수 없는 오류'})`);
    }
  } catch (error) {
    console.error('Set alarm error:', error);
    alert('알람 설정 중 오류가 발생했습니다.');
  }
}

async function cancelGenericAlarm(endMinutes, alarmType, onSuccess) {
  try {
    await sendMessage('CANCEL_ALARM', { endMinutes, alarmType });
    // 26차: 수동 해제는 사용자 명시 행동 — 당일 자동 재등록 금지 (재등록은 '설정' 버튼으로)
    setAutoAlarmDisabledToday(alarmType, true);
    onSuccess();
    showNotification('알람 해제', '설정된 알림이 취소되었습니다. (오늘은 자동으로 다시 등록되지 않습니다)');
  } catch (error) {
    console.error('Cancel alarm error:', error);
  }
}

// ===== 26차: 계산 즉시 자동 알람 등록 (익스텐션/앱 공유 popup.js — 양쪽 동일 동작) =====
// 규칙:
//  1) 계산으로 시각이 결정되면 같은 타입·시각 알람이 없을 때 자동 등록 (버튼은 '해제' 상태로)
//  2) 사용자가 '해제'를 누르면 그 날은 자동 재등록 금지 (재등록은 '설정'으로 수동)
//  3) 계산 시각이 바뀌면 오늘 자의 같은 타입 자동 알람을 교체
const AUTO_ALARM_DISABLED_PREFIX = 'codyssey_auto_alarm_disabled_';

function autoAlarmDisabledKey(type) {
  return AUTO_ALARM_DISABLED_PREFIX + type + '_' + getTodayString();
}
function isAutoAlarmDisabledToday(type) {
  try { return localStorage.getItem(autoAlarmDisabledKey(type)) === '1'; } catch (e) { return false; }
}
function setAutoAlarmDisabledToday(type, disabled) {
  try {
    const key = autoAlarmDisabledKey(type);
    if (disabled) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch (e) { /* 웹뷰/익스텐션 저장 실패는 치명 아님 */ }
}

function isAlarmTimeToday(time) {
  if (typeof time !== 'number') return false;
  const d = new Date(time);
  const t = new Date();
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}

async function autoRegisterAlarm(endMinutes, type, label) {
  if (endMinutes === null) return;
  if (isAutoAlarmDisabledToday(type)) return; // 오늘 해제한 알람은 자동 재등록하지 않음
  try {
    const alarmsResponse = await sendMessage('GET_ALARMS');
    const alarms = (alarmsResponse && alarmsResponse.alarms) || [];

    // 이미 동일 시각·타입으로 미래 알람이 있으면 유지 (버튼 상태만 동기화)
    const sameFuture = alarms.find(a =>
      a && a.endMinutes === endMinutes && (a.type || 'exit') === type && (a.time || 0) > Date.now());
    if (sameFuture) { syncAlarmButtons(); return; }

    // 계산 시각이 바뀐 경우 — 오늘 날짜의 같은 타입 알람을 교체
    for (const a of alarms) {
      if (a && (a.type || 'exit') === type && a.endMinutes !== endMinutes && isAlarmTimeToday(a.time)) {
        try { await sendMessage('CANCEL_ALARM', { alarmName: a.name }); } catch (e) { /* 무시 */ }
      }
    }

    const timeStr = formatEndMinutes(endMinutes);
    const response = await sendMessage('SET_ALARM', {
      endMinutes,
      alarmType: type,
      label: `${label} (${timeStr})`
    });
    if (response && response.success) {
      showNotification('알람 자동 등록', `${timeStr}에 ${label}이 울립니다. (목록에서 삭제 가능)`);
      if (response.exact === false) {
        alert('정확한 알람 권한이 꺼져 있어 알림 시각이 늦어질 수 있습니다.\n시스템 설정에서 "정확한 알람"을 허용해주세요.');
      }
      syncAlarmButtons();
    }
  } catch (e) { /* 자동 등록 실패 시 버튼 수동 경로로 충분 */ }
}

// ===== 알림 표시 (백그라운드/네이티브 경유 — 팝업 Notification 생성자 대신) =====
function showNotification(title, body) {
  try {
    sendMessage('LOCAL_NOTIFY', { title, body });
  } catch (e) {
    console.warn('알림 표시 실패:', e);
  }
}

// ===== 로그인 유지 (Keep Alive) =====
function updateKeepAliveUI() {
  if (!currentSettings) return;
  
  keepAliveEnabled = currentSettings.keepAliveEnabled !== false;
  
  if (keepAliveEnabled) {
    els.btnKeepAlive.classList.add('active');
    els.btnKeepAlive.textContent = '⏸️';
    els.btnKeepAlive.title = '로그인 유지 중 (클릭하여 중지)';
    startKeepAlive();
  } else {
    els.btnKeepAlive.classList.remove('active');
    els.btnKeepAlive.textContent = '🔄';
    els.btnKeepAlive.title = '로그인 유지 시작';
    stopKeepAlive();
  }
  
  els.keepAliveStatus.classList.add('show');
  // B4: 입·퇴실 감지/평가 연동이 켜져 있으면 그 5분 주기 조회가 세션을 유지하므로 별도 핑은 생략됨
  els.keepAliveText.textContent = keepAliveEnabled ? '로그인 유지: 활성 (감지 켜짐 시 감지 조회로 대체)' : '로그인 유지: 비활성';
  if (els.keepAliveIndicator) {
    els.keepAliveIndicator.classList.toggle('active', keepAliveEnabled);
  }
}

function startKeepAlive() {
  stopKeepAlive();
  if (!keepAliveEnabled) return;
  
  pingKeepAlive();
  scheduleNextKeepAlive();
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function scheduleNextKeepAlive() {
  const baseMinutes = 25;
  const randomMinutes = Math.floor(Math.random() * 4);
  const intervalMinutes = baseMinutes + randomMinutes;
  const intervalMs = intervalMinutes * 60 * 1000;
  
  const nextTime = new Date(Date.now() + intervalMs);
  els.keepAliveNext.textContent = `다음: ${formatTime(nextTime)} (${intervalMinutes}분 후)`;
  
  keepAliveTimer = setTimeout(() => {
    pingKeepAlive();
    scheduleNextKeepAlive();
  }, intervalMs);
}

async function pingKeepAlive() {
  try {
    const response = await sendMessage('FETCH_MEMBER_ID');
    if (response.success) {
      console.log('[Keep-Alive] 세션 유지 성공:', formatTime(new Date()));
    }
  } catch (error) {
    console.warn('[Keep-Alive] 세션 유지 실패:', error);
  }
}

// ===== 설정 모달 =====
function openSettings() {
  if (!currentSettings) return;
  
  els.settingMonthlyHours.value = currentSettings.monthlyRequiredHours;
  els.settingDailyHours.value = currentSettings.dailyMaxHours;
  els.settingDeadlineAlert.checked = currentSettings.deadlineAlertEnabled !== false; // 36차: 월 페이스 경고 기본 켬
  els.settingNotifications.checked = currentSettings.notificationsEnabled;
  els.settingSound.checked = currentSettings.soundEnabled;
  els.settingAutoRefresh.checked = currentSettings.autoRefresh;
  els.settingRefreshInterval.value = currentSettings.refreshInterval;
  els.settingKeepAlive.checked = currentSettings.keepAliveEnabled !== false;
  els.settingGateNotify.checked = currentSettings.gateNotifyEnabled !== false; // G1
  els.settingEvalLead.value = currentSettings.evalLeadMinutes ?? 30; // E1
  els.settingEvalAutosync.checked = currentSettings.evalAutoSyncEnabled !== false; // E2
  els.settingEvalInstcd.value = currentSettings.evalInstCd || ''; // E2 수동 instCd
  els.settingEvalInstcdRow.style.display = els.settingEvalAutosync.checked ? 'flex' : 'none';
  els.settingDash.checked = currentSettings.dashEnabled !== false; // W7/28차: 백그라운드 감지(5분 주기) 기본 켬
  refreshDashStatusUI();
  refreshPhyStatusUI(); // 31차: 물리 탐지 상태/토글 동기화
  renderSettingsDiag(); // 37차: 진단 로그 표시
  
  els.settingsModal.classList.add('show');
}

// 31차: 물리 탐지 상태 요약 (설정 화면 표시 + 토글 초기값 동기화)
async function refreshPhyStatusUI() {
  if (!els.settingPhyStatus) return;
  const phy = window.Capacitor?.Plugins?.PhyPlugin;
  if (!(window.CodysseyNative && window.CodysseyNative.isNative) || !phy) {
    els.settingPhyStatus.textContent = '(Android 앱에서 사용 가능)'; // 42차: 39차에서 베타 수집 제거 — 낡은 문구 갱신
    [els.settingPhyEnabled, els.settingPhyGeofence, els.btnPhyLearn]
      .forEach(el => { if (el) el.disabled = true; });
    return;
  }
  try {
    const st = await phy.getPhyStatus();
    if (els.settingPhyEnabled) els.settingPhyEnabled.checked = !!st.enabled;
    if (els.settingPhyGeofence) els.settingPhyGeofence.checked = !!st.geofence;
    const insideTxt = (st.inside === null || st.inside === undefined)
      ? '판정 중' : (st.inside ? '학원 근처' : '학원 밖');
    let txt = `상태: ${st.enabled ? '켜짐' : '꺼짐'} · 판정 ${insideTxt} · 학습 ${st.locations}건`; // 42차: '건건' 중복 접미사 정정
    txt += st.fine ? ' · 위치 권한 ✅' : ' · 위치 권한 없음 ⚠️';
    if (st.enabled && !st.fine) txt += ' — 토글을 껐다 켜면 권한 요청';
    if (st.geofence) txt += st.backgroundLocation ? ' · 항상 허용 ✅' : ' · 항상 허용 필요 ⚠️';
    if (st.activity && st.activity !== 'unknown') txt += ` · 활동 ${st.activity}`;
    els.settingPhyStatus.textContent = txt;
  } catch (e) {
    els.settingPhyStatus.textContent = '상태 조회 실패 (구버전 앱)';
  }
}

// W7: 상시 감지 상태 요약 (설정: 켜짐 · 마지막 감지 HH:mm · 절전 예외 여부)
async function refreshDashStatusUI() {
  if (!els.settingDashStatus) return;
  const polling = window.Capacitor?.Plugins?.PollingPlugin;
  if (!(window.CodysseyNative && window.CodysseyNative.isNative) || !polling) {
    els.settingDashStatus.textContent = '(Android 앱에서 사용 가능)';
    // 42차: 플랫폼 동등성 — 물리 탐지 행과 동일하게 익스텐션에서는 Android 전용 제어 비활성
    [els.settingDash, els.btnBatteryExempt, els.btnExactAlarm]
      .forEach(el => { if (el) el.disabled = true; });
    return;
  }
  try {
    const st = await polling.getDashStatus();
    const bat = await polling.isIgnoringBatteryOptimizations();
    const interval = st.intervalMinutes || 15;
    let txt = '설정: ' + (st.enabled ? `켜짐(약 ${interval}분 간격·상시 알림 없음)` : '꺼짐');
    txt += st.lastTick
      ? ' · 마지막 감지 ' + new Date(st.lastTick).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      : ' · 마지막 감지 없음';
    txt += ' · ' + (bat.granted ? '절전 예외 ✅' : '절전 예외 안 됨 ⚠️');
    // 20차: 정확 알람 권한 상태 — 꺼져 있으면 백그라운드 알람이 밀리는 직접 원인
    if (st.exactAlarm !== undefined) {
      txt += ' · ' + (st.exactAlarm ? '정확 알람 ✅' : '정확 알람 꺼짐 ⚠️');
    }
    els.settingDashStatus.textContent = txt;
  } catch (e) {
    els.settingDashStatus.textContent = '상태 조회 실패';
  }
}

function closeSettings() {
  els.settingsModal.classList.remove('show');
}

// W7: 네이티브 런타임 설정 즉시 적용 (웹/익스텐션에서는 무시)
async function applyNativeRuntimeSettings(settings) {
  if (!(window.CodysseyNative && window.CodysseyNative.isNative)) return;
  try {
    const polling = window.Capacitor?.Plugins?.PollingPlugin;
    if (polling) {
      if (settings.dashEnabled === false) await polling.stopDash();
      else await polling.startDash();
    }
  } catch (e) { /* 구버전 앱/플러그인 부재 — 무시 */ }
  try {
    const alarm = window.Capacitor?.Plugins?.AlarmPlugin;
    if (alarm && alarm.setAlarmSound) {
      await alarm.setAlarmSound({ enabled: settings.soundEnabled !== false });
    }
  } catch (e) { /* 무시 */ }
}

async function saveSettings() {
  const settings = {
    monthlyRequiredHours: parseInt(els.settingMonthlyHours.value) || 80,
    dailyMaxHours: parseInt(els.settingDailyHours.value) || 12,
    notificationsEnabled: els.settingNotifications.checked,
    soundEnabled: els.settingSound.checked,
    autoRefresh: els.settingAutoRefresh.checked,
    refreshInterval: parseInt(els.settingRefreshInterval.value) || 30,
    keepAliveEnabled: els.settingKeepAlive.checked,
    gateNotifyEnabled: els.settingGateNotify.checked, // G1
    evalLeadMinutes: Math.min(1440, Math.max(0, parseInt(els.settingEvalLead.value) || 30)), // E1
    evalAutoSyncEnabled: els.settingEvalAutosync.checked, // E2
    evalInstCd: els.settingEvalInstcd.value.trim(), // E2 수동 instCd (빈값=자동 감지)
    dashEnabled: els.settingDash.checked, // W7/28차: 백그라운드 감지(5분 주기)
    deadlineAlertEnabled: els.settingDeadlineAlert.checked // 36차: 월 페이스 경고
  };

  // W7: 네이티브 즉시 반영 — 설정 저장과 같은 동작으로 상시 감지/알람 소리 적용
  await applyNativeRuntimeSettings(settings);

  try {
    await sendMessage('UPDATE_SETTINGS', { settings });
    currentSettings = settings;
    closeSettings();
    updateDashboardUI();
    updateKeepAliveUI();
    showNotification('설정 저장됨', '변경사항이 적용되었습니다.');
  } catch (error) {
    console.error('Save settings error:', error);
    alert('설정 저장 중 오류가 발생했습니다.');
  }
}

// ===== 로그인 수행 (Android는 네이티브 HTTP로 CORS 우회, 웹/익스텐션은 직접 fetch) =====
async function performLogin(email, password) {
  // 1. Android (Capacitor 네이티브) 경로
  if (window.CodysseyNative && window.CodysseyNative.isNative) {
    const pre = await window.CodysseyNative.preCheckLogin(email);
    if (pre.status >= 400) throw new Error(`사전 인증 실패 (HTTP ${pre.status})`);
    const fromValue = pre.body?.result?.from || '';

    const auth = await window.CodysseyNative.authenticate(email, password, fromValue);
    if (auth.status >= 400) {
      // L2: 서버 문구(E0000 "등록되지 않은 회원입니다." 등)를 원인별 안내로 해석 (16차 실측 매트릭스 근거)
      const mapped = describeLoginServerError(auth.status, auth.body);
      throw new Error(mapped || auth.body?.message || `로그인에 실패했습니다. (HTTP ${auth.status}) 이메일과 비밀번호를 확인해주세요.`);
    }
    // 리다이렉트 대상이 로그인 페이지면 인증 실패 (익스텐션 final URL 판정과 동일)
    if (auth.location && /login/i.test(auth.location) && !/authenticate/i.test(auth.location)) {
      throw new Error(`로그인에 실패했습니다. (로그인 페이지 회귀: HTTP ${auth.status}) 이메일과 비밀번호를 확인해주세요.`);
    }
    // L1: 네트워크는 성공이어도 본문의 실패 코드 확인 (서버가 200+에러 JSON 반환 대응)
    if (auth.body && typeof auth.body === 'object') {
      const failed = auth.body.success === false
        || (typeof auth.body.code === 'number' && auth.body.code >= 400);
      if (failed) {
        const mapped = describeLoginServerError(auth.status, auth.body);
        throw new Error(mapped || auth.body.message || '로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
      }
    }
    return;
  }

  // 2. 크롬 익스텐션/웹 경로 (host_permissions로 CORS 허용됨)
  const preCheckResponse = await fetch('https://api.ams.codyssey.kr/rest/login/pre-check', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ userId: email })
  });

  if (!preCheckResponse.ok) {
    throw new Error('사전 인증 실패');
  }

  const preCheckData = await preCheckResponse.json();
  const fromValue = preCheckData.result?.from || '';

  const formData = new URLSearchParams();
  formData.append('userId', email);
  formData.append('password', password);
  formData.append('from', fromValue);

  const loginResponse = await fetch('https://api.ams.codyssey.kr/authenticate', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Origin': 'https://ams.codyssey.kr',
      'Referer': 'https://ams.codyssey.kr/',
    },
    body: formData.toString()
  });

  // L1/M8 개선: status 외에 응답 본문 + 최종 URL까지 확인.
  // (redirect:'follow'라 302는 도달 불가 — status만 복면 자격증명 오류를 성공으로 오인 가능)
  const bodyText = await loginResponse.text().catch(() => '');
  const finalUrl = loginResponse.url || '';

  // 최종 URL이 로그인 페이지로 되돌아왔거나 본문이 로그인 폼 HTML이면 인증 실패
  if (/login/i.test(finalUrl) && !/authenticate/i.test(finalUrl)) {
    throw new Error('로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
  }
  if (/<!doctype html|<html[\s>]/i.test(bodyText) && /login|로그인/i.test(bodyText)) {
    throw new Error('로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
  }

  // JSON 응답이면 실패 코드/메시지 확인
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyText); } catch { /* JSON 아님 */ }
  if (bodyJson) {
    const failed = bodyJson.success === false
      || (typeof bodyJson.code === 'number' && bodyJson.code >= 400)
      || (typeof bodyJson.code === 'string' && /^[45]\d\d/.test(bodyJson.code))
      || (bodyJson.error && !bodyJson.result);
    if (failed) {
      const mapped = describeLoginServerError(loginResponse.status, bodyJson);
      throw new Error(mapped || bodyJson.message || bodyJson.errorMessage || '로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
    }
  }

  if (!loginResponse.ok && loginResponse.status >= 400) {
    throw new Error(bodyJson?.message || '로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
  }

  // 여기까지 통과 = 성공 (redirect 포함 2xx, 또는 에러 없는 JSON)
}

// ===== 로그아웃 =====
async function logout() {
  try {
    stopRealtimeUpdate();
    stopKeepAlive();
    clearRefreshTimer();
    clearAlarmListRefresh();
    await sendMessage('LOGOUT');
    currentMemberId = null;
    currentParsed = null;
    window.calendarParsed = null; // Q1: 캘린더 데이터도 폐기 (계정 전환 잔여 데이터 방지)
    currentViewDate = new Date();
    showLoginScreen('사용자 로그아웃');
    els.loginEmail.value = '';
    els.loginPassword.value = '';
    showNotification('로그아웃', '성공적으로 로그아웃되었습니다.');
  } catch (error) {
    console.error('Logout error:', error);
  }
}

// ===== 자동 새로고침 =====
function startAutoRefresh() {
  clearRefreshTimer();
  if (currentSettings?.autoRefresh) {
    const interval = (currentSettings.refreshInterval || 30) * 60 * 1000;
    refreshTimer = setInterval(() => {
      loadDashboard();
    }, interval);
  }
}

function clearRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ===== 이벤트 리스너 =====
function setupEventListeners() {
  // 로그인 폼 - 실제 인증 수행
  els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setLoginButtonLoading(true);
    
    // L2+: 원본을 보존해 두고(진단 표시용), 이메일은 앞뒤 공백·보이지 않는 문자까지 제거
    const rawEmail = els.loginEmail.value;
    const rawPassword = els.loginPassword.value;
    const email = stripEdgeInvisibles(rawEmail);
    const password = rawPassword;
    
    if (!email || !password) {
      showLoginError('이메일과 비밀번호를 모두 입력해주세요.');
      setLoginButtonLoading(false);
      return;
    }

    showLoginLoading();

    try {
      let removedOnRetry = 0;
      try {
        await performLogin(email, password);
        // L2+: 붙여넣기 오염(앞뒤 공백·보이지 않는 문자) 시 정리 후 1회 자동 재시도
      } catch (firstError) {
        const retry = shouldRetryTrimmedPassword(password, firstError && firstError.message)
          ? sanitizePasswordCandidate(password)
          : null;
        if (retry) {
          await performLogin(email, retry.candidate);
          removedOnRetry = retry.removed;
        } else {
          throw firstError;
        }
      }
      if (removedOnRetry > 0) {
        els.loginPassword.value = '';
        showNotification('로그인 완료', `비밀번호 앞뒤 공백·보이지 않는 문자 ${removedOnRetry}개를 제거하고 로그인했습니다.`);
      }
      els.loginOfficialLink?.classList.remove('show');

      // Q1: 세션 전환 — 저장된 이전 memberId/캐시 폐기 후 신선 조회
      // (다른 계정으로 로그인 시 이전 mbrId로 API를 호출하는 스테일 방지)
      await sendMessage('CLEAR_MEMBER_ID');
      window.calendarParsed = null;

      // 로그인 성공 - 대시보드 로드
      const response = await sendMessage('GET_STATUS', { force: true });
      if (response.success) {
        currentMemberId = response.memberId;
        diag('LOGIN', '로그인 완료 — 대시보드 진입');
        currentParsed = response.parsed;
        currentSettings = response.settings;
        currentEvalSync = response.evalSync || null; // S4
        await syncOvernightFromStorage(); // 29차: 롤오버 선택 상태 병합
        updateDashboardUI();
        checkNotificationPermission();
        updateLastUpdateTime();
        updateKeepAliveUI();
        startAutoRefresh();
        renderCalendar();
        showDashboard();
      } else {
        showLoginError('로그인 후 데이터를 불러오는데 실패했습니다.');
      }
    } catch (error) {
      console.error('Login error:', error);
      showLoginError((error.message || '로그인 처리 중 오류가 발생했습니다.')
        + '\n(입력 진단: ' + credentialInputDigest(rawEmail, rawPassword) + ')');
      // L2: 인증 계열 실패 시 공식 사이트 확인 경로 제공 (비밀번호 찾기/재설정)
      els.loginOfficialLink?.classList.add('show');
    } finally {
      setLoginButtonLoading(false);
    }
  });

  // W7: 절전모드 예외 요청 — 시스템 다이얼로그 열고 돌아오면 상태 재조회
  // 32ch N31-9: native permission result -> refresh status line immediately
  window.addEventListener('CodysseyNativeEvent', (e) => {
    if (e && e.detail && e.detail.type === 'PHY_PERMISSION_RESULT') {
      refreshPhyStatusUI();
      if (e.detail.label === 'denied') {
        showNotification('위치 권한 거부됨', '학원 근처 감지는 위치 권한이 있어야 동작합니다. 앱 설정에서 허용해 주세요.');
      }
    }
  });

  els.btnBatteryExempt?.addEventListener('click', async () => {
    try {
      await window.Capacitor?.Plugins?.PollingPlugin?.requestBatteryOptimizationExemption();
    } catch (e) { /* 웹/구버전 무시 */ }
    setTimeout(refreshDashStatusUI, 2000);
  });

  // 20차: 정확한 알람(알람·리마인더) 권한 화면 열기 — 백그라운드 알람 지연의 직접 원인 해소
  els.btnExactAlarm?.addEventListener('click', async () => {
    try {
      await window.CodysseyNative?.requestExactAlarmPermission?.();
    } catch (e) { /* 웹/구버전 무시 */ }
    setTimeout(refreshDashStatusUI, 2000);
  });

  // 31차: 물리 탐지 토글/버튼 — 즉시 네이티브 반영 (저장 버튼과 무관. 웹/익스텐션은 토글 비활성)
  els.settingPhyEnabled?.addEventListener('change', async () => {
    const enabled = els.settingPhyEnabled.checked;
    try {
      const r = await window.Capacitor?.Plugins?.PhyPlugin?.setPhyEnabled({ enabled });
      if (enabled && r && r.fine === false) {
        showNotification('위치 권한 요청', '학원 근처 감지에 위치 권한이 필요합니다. 요청창에서 허용해 주세요.');
      }
    } catch (e) { /* 웹/구버전 무시 */ }
    setTimeout(refreshPhyStatusUI, 800);
  });
  els.settingPhyGeofence?.addEventListener('change', async () => {
    try {
      const r = await window.Capacitor?.Plugins?.PhyPlugin?.setPhyGeofence({ enabled: els.settingPhyGeofence.checked });
      if (r && r.needBackground) {
        showNotification("'항상 허용' 필요", '즉시 감지(지오펜스)는 위치 권한을 "항상 허용"으로 바꿔야 합니다. 앱 설정 화면을 엽니다.');
        try { await window.Capacitor?.Plugins?.PhyPlugin?.openPhySettings(); } catch (e) { /* 무시 */ }
      }
    } catch (e) { /* 무시 */ }
    setTimeout(refreshPhyStatusUI, 1500);
  });
  els.btnPhyLearn?.addEventListener('click', async () => {
    try {
      const r = await window.Capacitor?.Plugins?.PhyPlugin?.learnNow();
      showNotification('학원 신호 학습', (r && r.result) || '완료');
    } catch (e) { /* 무시 */ }
    setTimeout(refreshPhyStatusUI, 800);
  });

  // 22차: 세션 만료 배너의 재로그인 — 배너는 유지하되 로그인 폼으로 전환해 재인증 유도
  // 29차: 자정 롤오버 확인 — 밤샘/누락/변경
  els.btnOvernightStay?.addEventListener('click', () => { chooseOvernight('overnight'); });
  els.btnOvernightMissing?.addEventListener('click', () => { chooseOvernight('missing'); });
  els.btnOvernightChange?.addEventListener('click', () => { chooseOvernight(null); });

  els.btnSessionRelogin?.addEventListener('click', () => {
    showLoginScreen('세션 만료 — 재로그인 시도');
  });

  // 19차: 진단 로그 복사 (원인 판독 공유용) / 지우기
  els.btnDiagCopy?.addEventListener('click', async () => {
    const entries = await readDiagEntries();
    const txt = entries.map(formatDiagEntry).join('\n');
    try {
      await navigator.clipboard.writeText(txt);
      els.btnDiagCopy.textContent = '복사됨 ✓';
      setTimeout(() => { els.btnDiagCopy.textContent = '진단 로그 복사'; }, 1500);
    } catch (e) {
      showLoginError('클립보드 복사 실패 — 로그를 길게 눌러 수동 복사해주세요.');
    }
  });
  els.btnDiagClear?.addEventListener('click', async () => {
    await clearDiagEntries();
    renderLoginDiag();
  });

  // 37차: 설정 화면 진단 로그 복사/지우기
  els.btnSettingsDiagCopy?.addEventListener('click', async () => {
    const entries = await readDiagEntries();
    let prefix = '';
    try {
      // 41차: 복사 시점 네이티브 스냅샷 1줄 — 링버퍼가 전이만 남겨도 마지막 출입 조회 결과가 남음
      const d = await window.Capacitor?.Plugins?.PollingPlugin?.getDiagLog();
      if (d && d.metaSummary) prefix = d.metaSummary + '\n\n';
    } catch (e) { /* non-native or 실패 시 스냅샷 생략 */ }
    const txt = prefix + entries.map(formatDiagEntry).join('\n');
    try {
      await navigator.clipboard.writeText(txt);
      els.btnSettingsDiagCopy.textContent = '복사됨 ✓';
      setTimeout(() => { els.btnSettingsDiagCopy.textContent = '전체 복사'; }, 1500);
    } catch (e) {
      showLoginError('클립보드 복사 실패 — 로그를 길게 눌러 수동 복사해주세요.');
    }
  });
  els.btnSettingsDiagClear?.addEventListener('click', async () => {
    await clearDiagEntries();
    renderSettingsDiag();
  });

  // L2+: 비밀번호 표시/숨기기 토글 — 붙여넣기 내용 확인용 (공식 로그인 폼도 동일 기능 제공)
  els.loginPwToggle?.addEventListener('click', () => {
    const showing = els.loginPassword.type === 'text';
    els.loginPassword.type = showing ? 'password' : 'text';
    els.loginPwToggle.textContent = showing ? '👁' : '🙈';
    els.loginPwToggle.title = showing ? '비밀번호 표시' : '비밀번호 숨기기';
  });

  // L2: 공식 사이트 바로가기 — 공식 로그인 확인 + 비밀번호 찾기/재설정용
  els.loginOfficialLink?.addEventListener('click', async () => {
    const url = 'https://ams.codyssey.kr/loginForm';
    try {
      const app = window.Capacitor?.Plugins?.App;
      if (window.CodysseyNative?.isNative && app?.openUrl) {
        await app.openUrl({ url });
        return;
      }
    } catch (e) { /* 폴아웃: window.open */ }
    window.open(url, '_blank', 'noopener');
  });

  // 대시보드 버튼들 (⟳는 캐시를 우회해서 강제 갱신 — J1)
  els.btnRefresh.addEventListener('click', () => loadDashboard(true));
  els.btnSettings.addEventListener('click', openSettings);

  // 27차: 알람 목록 "해제" 버튼 — 이벤트 위임 (MV3 CSP: 인라인 onclick 불가)
  els.alarmsList.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-alarm-idx]') : null;
    if (!btn) return;
    const idx = Number(btn.dataset.alarmIdx);
    const name = lastRenderedAlarmNames[idx];
    if (name) cancelAlarmFromList(name);
  });
  
  // 로그인 유지 토글
  els.btnKeepAlive.addEventListener('click', () => {
    keepAliveEnabled = !keepAliveEnabled;
    if (keepAliveEnabled) {
      startKeepAlive();
    } else {
      stopKeepAlive();
    }
    updateKeepAliveUI();
    if (currentSettings) {
      currentSettings.keepAliveEnabled = keepAliveEnabled;
      sendMessage('UPDATE_SETTINGS', { settings: currentSettings });
    }
  });

  // 계산기 모드 라디오 (같은 name 묶음이라 선택은 상호 배타)
  els.calcModeExit.addEventListener('change', updateCalcModeUI);
  els.calcModeGoal.addEventListener('change', updateCalcModeUI);

  // 1. 퇴실 예정 시간 계산
  els.btnCalcExit.addEventListener('click', calculateExitTime);
  els.exitTimeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') calculateExitTime();
  });

  // 2. 목표 시간 계산
  els.btnCalcGoal.addEventListener('click', calculateGoalTime);
  els.goalTimeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') calculateGoalTime();
  });

  // HH:MM 마스크 (숫자 입력 → 자동 콜론) — 두 계산 칸 공용
  attachHHMMMask(els.exitTimeInput);
  attachHHMMMask(els.goalTimeInput);

  // 알람 버튼들
  els.btnSetExitAlarm.addEventListener('click', setExitAlarm);
  els.btnCancelExitAlarm.addEventListener('click', cancelExitAlarm);
  els.btnSetGoalAlarm.addEventListener('click', setGoalAlarm);
  els.btnCancelGoalAlarm.addEventListener('click', cancelGoalAlarm);

  // S4: 평가 일정 즉시 동기화 (자동 연동 — 수동 등록은 제거됨)
  els.btnSyncEval.addEventListener('click', async () => {
    if (els.evalSyncStatus) els.evalSyncStatus.textContent = '평가 일정을 가져오는 중...';
    try {
      const res = await sendMessage('SYNC_EVAL_ALARMS');
      const r = res && res.result;
      if (r && r.ok !== false) {
        currentEvalSync = { fetchedAt: Date.now(), items: Number(r.items) || 0, lastError: null };
      } else {
        const reason = (r && r.reason) || (res && res.error) || 'unknown';
        currentEvalSync = { ...(currentEvalSync || {}), lastError: reason };
      }
    } catch (e) {
      currentEvalSync = { ...(currentEvalSync || {}), lastError: String(e && e.message || 'unknown') };
    }
    renderEvalSyncStatus();
    loadAndRenderAlarms();
  });

  // 캘린더 네비게이션
  els.btnPrevMonth.addEventListener('click', () => goToMonth(-1));
  els.btnNextMonth.addEventListener('click', () => goToMonth(1));
  els.btnTodayMonth.addEventListener('click', goToThisMonth);

  // 알림 권한
  els.btnAllowNotification.addEventListener('click', requestNotificationPermission);

  // 로그아웃
  els.linkLogout.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });

  // 설정 모달
  els.btnSettingsSave.addEventListener('click', saveSettings);
  els.btnSettingsCancel.addEventListener('click', closeSettings);
  els.settingsModal.addEventListener('click', (e) => {
    if (e.target === els.settingsModal) closeSettings();
  });
  // E2: 자동 연동 토글 시 수동 instCd 입력란 노출 전환
  els.settingEvalAutosync.addEventListener('change', () => {
    els.settingEvalInstcdRow.style.display = els.settingEvalAutosync.checked ? 'flex' : 'none';
  });

  // 백그라운드/네이티브 메시지 리스너
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ALARM_TRIGGERED') {
      loadDashboard();
      return;
    }
    // Q2 (K13 회귀 수정): 사용자가 보고(입력 중) 있는 동안 자동 갱신하면
    // 계산기 입력·결과가 리셋됨 → 백그라운드일 때만 조용히 갱신
    if (message.type === 'SYNC_COMPLETE' && document.hidden) {
      loadDashboard();
    }
  });
}

// ===== 초기화 =====
async function init() {
  setupEventListeners();
  
  // 시작 시 세션 확인 - 이미 로그인되어 있으면 바로 대시보드로
  const hasSession = await checkExistingSession();
  if (hasSession) {
    await loadDashboard();
    startAutoRefresh();
  } else {
    showLoginScreen('초기 진입 — 저장된 로그인 없음 (정상)');
  }
}

async function checkExistingSession() {
  try {
    // 멤버 정보 조회로 세션 유효성 확인
    const response = await sendMessage('FETCH_MEMBER_ID');
    if (response.success && response.memberId) {
      // 저장된 멤버 ID가 있으면 대시보드 로드 시도
      const statusResponse = await sendMessage('GET_STATUS');
      return statusResponse.success;
    }
    return false;
  } catch (error) {
    console.log('세션 확인 실패:', error);
    return false;
  }
}

document.addEventListener('DOMContentLoaded', init);

window.addEventListener('focus', () => {
  const loginVisible = els.loginScreen && window.getComputedStyle(els.loginScreen).display !== 'none';
  if (currentMemberId && !loginVisible) {
    loadDashboard();
  }
});

window.addEventListener('beforeunload', () => {
  stopRealtimeUpdate();
  stopKeepAlive();
  clearRefreshTimer();
  clearAlarmListRefresh();
});