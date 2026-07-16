// ============================================================
// 코디세이 출입 현황 알리미 - Popup 메인 로직
// ============================================================

// 공통 출입 로직 (단일 소스 — background/adapter와 공유)
import {
  elapsedSinceEntry,
  recognizedToday,
  recognizedMonthly,
  projectedMonthly,
  minutesToTimeStr,
  minutesToHHMM,
  getTodayString,
  SERVER_DAILY_CAP_MINUTES
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
  loginBtn: document.getElementById('login-btn'),
  loginError: document.getElementById('login-error'),
  loginLoading: document.getElementById('login-loading'),

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

  // 계산기 토글
  calcModeToggle: document.getElementById('calc-mode-toggle'),
  exitPanel: document.getElementById('exit-panel'),
  goalPanel: document.getElementById('goal-panel'),
  toggleLabelExit: document.querySelector('.toggle-label.exit-mode'),
  toggleLabelGoal: document.querySelector('.toggle-label.goal-mode'),

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

  // 2. 목표 시간 입력
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
  settingNotifications: document.getElementById('setting-notifications'),
  settingSound: document.getElementById('setting-sound'),
  settingAutoRefresh: document.getElementById('setting-auto-refresh'),
  settingRefreshInterval: document.getElementById('setting-refresh-interval'),
  settingKeepAlive: document.getElementById('setting-keep-alive'),
  btnSettingsSave: document.getElementById('btn-settings-save'),
  btnSettingsCancel: document.getElementById('btn-settings-cancel'),

  // 헤더 버튼들
  btnCalendar: document.getElementById('btn-calendar'), // deprecated
  btnSettings: document.getElementById('btn-settings'),
  btnRefresh: document.getElementById('btn-refresh'),
};

// 상태 변수
let currentMemberId = null;
let currentParsed = null;
let currentSettings = null;
let refreshTimer = null;
let realtimeTimer = null;
let keepAliveTimer = null;
let keepAliveEnabled = true;
let exitAlarmEndMinutes = null;
let goalAlarmEndMinutes = null;
let currentViewDate = new Date(); // 캘린더용

// ===== 크롬 런타임 메시지 전송 헬퍼 =====
function sendMessage(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...data }, resolve);
  });
}

// ===== UI 상태 관리 =====
function showLoginScreen() {
  els.loginScreen.style.display = 'block';
  els.dashboard.style.display = 'none';
  els.loginLoading.classList.remove('show');
  els.loginForm.style.display = 'flex';
  els.loginError.classList.remove('show');
}

function showLoginLoading() {
  els.loginForm.style.display = 'none';
  els.loginLoading.classList.add('show');
}

function showDashboard() {
  els.loginScreen.style.display = 'none';
  els.dashboard.style.display = 'flex';
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
async function loadDashboard() {
  try {
    const response = await sendMessage('GET_STATUS');
    if (!response.success) {
      if (response.error === 'NOT_LOGGED_IN') {
        showLoginScreen();
        return;
      }
      throw new Error(response.error);
    }

    currentMemberId = response.memberId;
    currentParsed = response.parsed;
    currentSettings = response.settings;
    
    updateDashboardUI();
    checkNotificationPermission();
    updateLastUpdateTime();
    updateKeepAliveUI();
    startRealtimeUpdate();
    renderCalendar(); // 캘린더 렌더링
    
    showDashboard();
  } catch (error) {
    console.error('Dashboard load error:', error);
    showLoginError(describeError(error));
    showLoginScreen();
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

function updateDashboardUI() {
  if (!currentParsed || !currentSettings) return;

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

  // 입실 기록 누락 경고 (R5)
  if (els.dataWarning) {
    if (currentParsed.hasMissingEntry) {
      els.dataWarning.textContent = '⚠️ 입실 기록 누락이 감지되었습니다. 출입 내역이 실제와 다를 수 있습니다.';
      els.dataWarning.style.display = 'block';
    } else {
      els.dataWarning.style.display = 'none';
    }
  }

  // 실시간 추정치 표시 (R3): 입실 중에는 서버 확정 전 추정값임을 툴팁으로 안내
  els.monthlyTotal.title = isCurrentlyIn
    ? '실시간 추정치 (입실 경과 포함, 서버 확정 전)'
    : '';

  // 현재 상태
  if (isCurrentlyIn && lastInTime !== null) {
    els.currentStatus.className = 'current-status show in';
    els.currentStatusText.textContent = `입실 중 (입실: ${minutesToHHMM(lastInTime)})`;
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
  
  // 알람 목록 로드 및 렌더링
  loadAndRenderAlarms();
}

// 실시간 인정 시간 계산 (서버 규칙: 일 12시간 캡 — shared-attendance.js 참조)
function calculateRealtimeRecognized() {
  if (!currentParsed) return 0;
  return recognizedToday(currentParsed);
}

// endMinutes(오늘 자정부터 분) 표시 — 24시간 초과 시 'N일 후 HH:MM'
function formatEndMinutes(m) {
  if (m === null || m === undefined || isNaN(m)) return '--:--';
  if (m < 1440) return minutesToHHMM(m);
  const days = Math.floor(m / 1440);
  return `${days}일 후 ${minutesToHHMM(m % 1440)}`;
}

// 실시간 월 누적 인정 시간 계산 (일일 상한 적용)
function calculateRealtimeMonthly() {
  return recognizedMonthly(currentParsed);
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

function updateRealtimeUI() {
  if (!currentParsed?.isCurrentlyIn || !currentParsed?.lastInTime) {
    els.realtimeStatus.classList.remove('show');
    stopRealtimeUpdate();
    updateDashboardUI(); // 전체 다시 그리기
    return;
  }
  
  const elapsed = elapsedSinceEntry(currentParsed);
  const recognized = recognizedToday(currentParsed);
  
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
  const realtimeMonthly = recognizedMonthly(currentParsed);
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
  const todayTotalSoFar = recognizedToday(currentParsed);
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
  
  const todayTotalSoFar = recognizedToday(currentParsed);
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
  if (!alarms || alarms.length === 0) {
    els.alarmsList.innerHTML = '<div class="alarms-empty">설정된 알람이 없습니다.</div>';
    els.alarmsCount.textContent = '0개';
    return;
  }
  
  els.alarmsCount.textContent = `${alarms.length}개`;
  
  const now = Date.now();
  els.alarmsList.innerHTML = alarms.map(alarm => {
    const isPast = alarm.time < now;
    const timeStr = formatEndMinutes(alarm.endMinutes);
    const label = alarm.label || '알람';
    const type = alarm.type || (label.includes('퇴실') ? 'exit' : 'goal');
    const remainingMs = alarm.time - now;
    const remainingMin = Math.max(0, Math.ceil(remainingMs / 60000));
    const remainingStr = remainingMin > 0 ? ` (${remainingMin}분 후)` : ' (시간 지남)';
    const createdStr = alarm.createdAt
      ? new Date(alarm.createdAt).toLocaleString()
      : new Date(alarm.time).toLocaleString();

    return `
      <div class="alarm-item ${type}" data-end-minutes="${alarm.endMinutes}" data-alarm-type="${type}">
        <div class="alarm-info">
          <div class="alarm-label">${label}</div>
          <div class="alarm-time">${timeStr}${remainingStr}</div>
          <div class="alarm-meta">설정: ${createdStr}</div>
        </div>
        <div class="alarm-actions">
          <button class="btn btn-danger btn-sm" onclick="cancelAlarmFromList(${alarm.endMinutes}, '${type}')">해제</button>
        </div>
      </div>
    `;
  }).join('');
}

// 전역 함수로 노출 (onclick에서 호출하기 위해)
window.cancelAlarmFromList = async function(endMinutes, alarmType = 'exit') {
  try {
    await sendMessage('CANCEL_ALARM', { endMinutes, alarmType });
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
    const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayData = calendarData.dailyBreakdown[dateStr] || 0;
    grid.appendChild(createMiniDayElement(day, dateStr, dayData, dailyMax, true, false, todayStr));
  }

  // 이번 달
  for (let day = 1; day <= lastDate; day++) {
    const date = new Date(year, month, day);
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayData = calendarData.dailyBreakdown[dateStr] || 0;
    const isToday = dateStr === todayStr;
    grid.appendChild(createMiniDayElement(day, dateStr, dayData, dailyMax, false, isToday, todayStr));
  }

  // 다음 달
  const totalCells = firstDay + lastDate;
  const nextMonthDays = Math.ceil(totalCells / 7) * 7 - totalCells;
  for (let day = 1; day <= nextMonthDays; day++) {
    const date = new Date(year, month + 1, day);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
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
    
    // 해당 월 데이터 fetch
    const response = await sendMessage('FETCH_ATTENDANCE', { 
      memberId: currentMemberId, 
      year, 
      month 
    });
    
    if (response.success) {
      // 기존 currentParsed에 병합하거나 별도 저장
      // 여기서는 렌더링용으로 임시 저장
      window.calendarParsed = response.parsed;
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

// ===== 계산기 토글 =====
function updateCalcModeUI() {
  const isGoalMode = els.calcModeToggle.checked;
  
  if (isGoalMode) {
    els.exitPanel.classList.add('hidden');
    els.goalPanel.classList.remove('hidden');
    els.toggleLabelExit.classList.remove('active');
    els.toggleLabelGoal.classList.add('active');
  } else {
    els.exitPanel.classList.remove('hidden');
    els.goalPanel.classList.add('hidden');
    els.toggleLabelExit.classList.add('active');
    els.toggleLabelGoal.classList.remove('active');
  }
  
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

// ===== 입력 파싱 헬퍼 =====
function parseTimeInput(val, allowMinutesOnly = false) {
  val = val.trim();
  if (!val) return null;
  if (val.includes(':')) {
    const [h, m] = val.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  }
  if (allowMinutesOnly) {
    const n = Number(val);
    return isNaN(n) ? null : n;
  }
  return null;
}

function parseExitTimeInput(val) {
  val = val.trim();
  if (!val) return null;
  if (!val.includes(':')) return null;
  const [h, m] = val.split(':').map(Number);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// ===== 1. 퇴실 시간 입력 -> 총 인정 시간 계산 =====
async function calculateExitTime() {
  const exitMin = parseExitTimeInput(els.exitTimeInput.value);
  if (exitMin === null) {
    alert('올바른 퇴실 시간을 입력하세요.\n예: 18:30');
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
    const todayTotalSoFar = recognizedToday(currentParsed);
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
    
    // 알람 버튼
    els.btnSetExitAlarm.style.display = 'block';
    els.btnCancelExitAlarm.style.display = 'none';
    els.exitResult.classList.add('show');
    
    // 기존 알람 확인
    const alarmsResponse = await sendMessage('GET_ALARMS');
    if (alarmsResponse.success) {
      const existing = alarmsResponse.alarms.find(a => a.endMinutes === exitAlarmEndMinutes && (a.type || 'exit') === 'exit');
      if (existing) {
        els.btnSetExitAlarm.style.display = 'none';
        els.btnCancelExitAlarm.style.display = 'block';
      }
    }
    
  } catch (error) {
    console.error('Calculate exit error:', error);
    alert('계산 중 오류가 발생했습니다.');
  }
}

// ===== 2. 목표 시간 입력 -> 퇴실 시간 계산 =====
async function calculateGoalTime() {
  const goalMinutes = parseTimeInput(els.goalTimeInput.value, true);
  if (goalMinutes === null || goalMinutes <= 0) {
    alert('올바른 목표 시간을 입력하세요.\n예: 8:00 또는 480 (분)');
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
    const todayTotalSoFar = recognizedToday(currentParsed);
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
    
    // 알람 버튼
    els.btnSetGoalAlarm.style.display = 'block';
    els.btnCancelGoalAlarm.style.display = 'none';
    els.goalResult.classList.add('show');
    
    // 기존 알람 확인
    const alarmsResponse = await sendMessage('GET_ALARMS');
    if (alarmsResponse.success) {
      const existing = alarmsResponse.alarms.find(a => a.endMinutes === goalAlarmEndMinutes && (a.type || 'exit') === 'goal');
      if (existing) {
        els.btnSetGoalAlarm.style.display = 'none';
        els.btnCancelGoalAlarm.style.display = 'block';
      }
    }
    
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
  if (!hasPerm) return;

  try {
    const timeStr = formatEndMinutes(endMinutes);
    const response = await sendMessage('SET_ALARM', { 
      endMinutes,
      alarmType,
      label: `${label} (${timeStr})`
    });
    
    if (response.success) {
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
    }
  } catch (error) {
    console.error('Set alarm error:', error);
    alert('알람 설정 중 오류가 발생했습니다.');
  }
}

async function cancelGenericAlarm(endMinutes, alarmType, onSuccess) {
  try {
    await sendMessage('CANCEL_ALARM', { endMinutes, alarmType });
    onSuccess();
    showNotification('알람 해제', '설정된 알림이 취소되었습니다.');
  } catch (error) {
    console.error('Cancel alarm error:', error);
  }
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
  els.keepAliveText.textContent = keepAliveEnabled ? '로그인 유지: 활성' : '로그인 유지: 비활성';
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
  els.settingNotifications.checked = currentSettings.notificationsEnabled;
  els.settingSound.checked = currentSettings.soundEnabled;
  els.settingAutoRefresh.checked = currentSettings.autoRefresh;
  els.settingRefreshInterval.value = currentSettings.refreshInterval;
  els.settingKeepAlive.checked = currentSettings.keepAliveEnabled !== false;
  
  els.settingsModal.classList.add('show');
}

function closeSettings() {
  els.settingsModal.classList.remove('show');
}

async function saveSettings() {
  const settings = {
    monthlyRequiredHours: parseInt(els.settingMonthlyHours.value) || 80,
    dailyMaxHours: parseInt(els.settingDailyHours.value) || 12,
    notificationsEnabled: els.settingNotifications.checked,
    soundEnabled: els.settingSound.checked,
    autoRefresh: els.settingAutoRefresh.checked,
    refreshInterval: parseInt(els.settingRefreshInterval.value) || 30,
    keepAliveEnabled: els.settingKeepAlive.checked
  };

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
    if (pre.status >= 400) throw new Error('사전 인증 실패');
    const fromValue = pre.body?.result?.from || '';

    const auth = await window.CodysseyNative.authenticate(email, password, fromValue);
    if (auth.status >= 400) {
      throw new Error(auth.body?.message || '로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
    }
    // L1: 네트워크는 성공이어도 본문의 실패 코드 확인 (서버가 200+에러 JSON 반환 대응)
    if (auth.body && typeof auth.body === 'object') {
      const failed = auth.body.success === false
        || (typeof auth.body.code === 'number' && auth.body.code >= 400);
      if (failed) {
        throw new Error(auth.body.message || '로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
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
      throw new Error(bodyJson.message || bodyJson.errorMessage || '로그인에 실패했습니다. 이메일과 비밀번호를 확인해주세요.');
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
    await sendMessage('LOGOUT');
    currentMemberId = null;
    currentParsed = null;
    showLoginScreen();
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
    
    const email = els.loginEmail.value.trim();
    const password = els.loginPassword.value;
    
    if (!email || !password) {
      showLoginError('이메일과 비밀번호를 모두 입력해주세요.');
      setLoginButtonLoading(false);
      return;
    }

    showLoginLoading();

    try {
      await performLogin(email, password);

      // 로그인 성공 - 대시보드 로드
      const response = await sendMessage('GET_STATUS');
      if (response.success) {
        currentMemberId = response.memberId;
        currentParsed = response.parsed;
        currentSettings = response.settings;
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
      showLoginError(error.message || '로그인 처리 중 오류가 발생했습니다.');
    } finally {
      setLoginButtonLoading(false);
    }
  });

  // 대시보드 버튼들
  els.btnRefresh.addEventListener('click', () => loadDashboard());
  els.btnSettings.addEventListener('click', openSettings);
  
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

  // 계산기 모드 토글
  els.calcModeToggle.addEventListener('change', updateCalcModeUI);

  // 1. 퇴실 시간 계산
  els.btnCalcExit.addEventListener('click', calculateExitTime);
  els.exitTimeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') calculateExitTime();
  });

  // 2. 목표 시간 계산
  els.btnCalcGoal.addEventListener('click', calculateGoalTime);
  els.goalTimeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') calculateGoalTime();
  });

  // 알람 버튼들
  els.btnSetExitAlarm.addEventListener('click', setExitAlarm);
  els.btnCancelExitAlarm.addEventListener('click', cancelExitAlarm);
  els.btnSetGoalAlarm.addEventListener('click', setGoalAlarm);
  els.btnCancelGoalAlarm.addEventListener('click', cancelGoalAlarm);

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

  // 백그라운드 메시지 리스너
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ALARM_TRIGGERED') {
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
    showLoginScreen();
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
});