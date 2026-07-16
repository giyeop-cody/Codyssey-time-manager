// ============================================================
// 코디세이 출입기록 익스텐션 - Calendar 페이지
// ============================================================

// 공통 유틸/계산 (단일 소스 — L3: 자체 복사본 제거)
import {
  minutesToTimeStr,
  durationToMinutes,
  timeStrToMinutes,
  recognizedToday,
  recognizedMonthly,
  getTodayString
} from './shared-attendance.js';

// 유틸리티
function formatMonth(date) {
  return `${date.getFullYear()}년 ${date.getMonth()+1}월`;
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}

// 크롬 메시지 헬퍼
function sendMessage(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...data }, resolve);
  });
}

// DOM 요소
const els = {
  loadingOverlay: document.getElementById('loading-overlay'),
  loadingText: document.getElementById('loading-text'),
  calendarPage: document.getElementById('calendar-page'),
  calendarGrid: document.getElementById('calendar-grid'),
  monthTotal: document.getElementById('month-total'),
  monthAvg: document.getElementById('month-avg'),
  monthRemain: document.getElementById('month-remain'),
  btnPrevMonth: document.getElementById('btn-prev-month'),
  btnNextMonth: document.getElementById('btn-next-month'),
  btnTodayMonth: document.getElementById('btn-today-month'),
  dayDetailModal: document.getElementById('day-detail-modal'),
  dayDetailDate: document.getElementById('day-detail-date'),
  dayDetailClose: document.getElementById('day-detail-close'),
  dayTotal: document.getElementById('day-total'),
  dayLimit: document.getElementById('day-limit'),
  dayRecords: document.getElementById('day-records')
};

// 상태
let currentMemberId = null;
let currentSettings = null;
let currentViewDate = new Date(); // 현재 보고 있는 월
let attendanceData = null; // 파싱된 해당 월 데이터
let selectedDay = null;
let realtimeTimer = null; // L5: 오늘 셀 실시간 갱신

// 보고 있는 월이 실제 이번 달인지
function isCurrentMonthView() {
  const now = new Date();
  return currentViewDate.getFullYear() === now.getFullYear() &&
         currentViewDate.getMonth() === now.getMonth();
}

// ===== 로딩 표시 =====
function showLoading(text = '데이터 불러오는 중...') {
  els.loadingText.textContent = text;
  els.loadingOverlay.classList.remove('hidden');
  els.calendarPage.style.display = 'none';
}

function hideLoading() {
  els.loadingOverlay.classList.add('hidden');
  els.calendarPage.style.display = 'block';
}

// ===== 데이터 로드 =====
// M1 개선: GET_STATUS(현재 월만) 대신 FETCH_ATTENDANCE(year, month)로
// 보고 있는 월의 데이터를 직접 조회 — 월 이동 시 데이터가 갱신됨
async function loadAttendance() {
  showLoading(`${formatMonth(currentViewDate)} 데이터 불러오는 중...`);

  try {
    // 설정/멤버 ID는 최초 1회만 GET_STATUS로 확보 (미로그인 감지용)
    if (!currentMemberId || !currentSettings) {
      const status = await sendMessage('GET_STATUS');
      if (!status.success) {
        if (status.error === 'NOT_LOGGED_IN') {
          showError('로그인이 필요합니다. 익스텐션 팝업에서 로그인해주세요.');
          return;
        }
        throw new Error(status.error);
      }
      currentMemberId = status.memberId;
      currentSettings = status.settings;
    }

    const response = await sendMessage('FETCH_ATTENDANCE', {
      memberId: currentMemberId,
      year: currentViewDate.getFullYear(),
      month: currentViewDate.getMonth() + 1
    });

    if (!response.success) {
      throw new Error(response.error);
    }

    attendanceData = response.parsed;

    renderCalendar();
    updateMonthSummary();
    startRealtimeIfNeeded();
    hideLoading();
  } catch (error) {
    console.error('Calendar load error:', error);
    showError('데이터를 불러오는데 실패했습니다.');
  }
}

function showError(msg) {
  els.loadingText.textContent = msg;
  setTimeout(() => {
    window.close();
  }, 2000);
}

// L5: 이번 달을 보고 있고 입실 중이면 1분 단위로 그리드/요약 갱신
function startRealtimeIfNeeded() {
  stopRealtime();
  if (isCurrentMonthView() && attendanceData?.isCurrentlyIn) {
    realtimeTimer = setInterval(() => {
      renderCalendar();
      updateMonthSummary();
    }, 60 * 1000);
  }
}

function stopRealtime() {
  if (realtimeTimer) {
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
}

// 해당 날짜에 표시할 분 — 오늘 셀은 실시간 인정 값 사용 (L5)
function displayMinutesFor(dateStr) {
  const serverValue = attendanceData.dailyBreakdown[dateStr] || 0;
  if (dateStr === getTodayString() && attendanceData.isCurrentlyIn) {
    return Math.max(serverValue, recognizedToday(attendanceData));
  }
  return serverValue;
}

// ===== 캘린더 렌더링 =====
function renderCalendar() {
  if (!attendanceData) return;

  const year = currentViewDate.getFullYear();
  const month = currentViewDate.getMonth(); // 0-11
  const today = new Date();
  const dailyMax = currentSettings.dailyMaxHours * 60;

  // 첫째 날 요일 (0=일, 1=월...)
  const firstDay = new Date(year, month, 1).getDay();
  // 이번 달 마지막 날
  const lastDate = new Date(year, month + 1, 0).getDate();
  // 지난 달 마지막 날
  const prevLastDate = new Date(year, month, 0).getDate();

  const grid = els.calendarGrid;

  // 요일 헤더 이후만 남기고 제거
  const headers = grid.querySelectorAll('.calendar-day-header');
  grid.innerHTML = '';
  headers.forEach(h => grid.appendChild(h));

  // 지난 달 날짜들
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = prevLastDate - i;
    const date = new Date(year, month - 1, day);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayData = attendanceData.dailyBreakdown[dateStr] || 0;
    grid.appendChild(createDayElement(day, dateStr, dayData, dailyMax, true, false));
  }

  // 이번 달 날짜들
  for (let day = 1; day <= lastDate; day++) {
    const date = new Date(year, month, day);
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayData = displayMinutesFor(dateStr); // L5: 오늘은 실시간 값
    const isToday = isSameDay(date, today);
    const isCurrentIn = attendanceData.isCurrentlyIn && isToday;
    grid.appendChild(createDayElement(day, dateStr, dayData, dailyMax, false, isToday, isCurrentIn));
  }

  // 다음 달 날짜들 (6주 완성)
  const totalCells = firstDay + lastDate;
  const nextMonthDays = Math.ceil(totalCells / 7) * 7 - totalCells;
  for (let day = 1; day <= nextMonthDays; day++) {
    const date = new Date(year, month + 1, day);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayData = attendanceData.dailyBreakdown[dateStr] || 0;
    grid.appendChild(createDayElement(day, dateStr, dayData, dailyMax, true, false));
  }
}

function createDayElement(day, dateStr, minutes, dailyMax, isOtherMonth, isToday = false, isCurrentIn = false) {
  const div = document.createElement('div');
  div.className = 'calendar-day';
  div.dataset.date = dateStr;

  if (isOtherMonth) div.classList.add('other-month');
  if (isToday) div.classList.add('today');
  if (minutes > 0) div.classList.add('has-record');
  if (minutes > dailyMax) div.classList.add('has-over');
  if (isCurrentIn) div.classList.add('current-in');

  // 날짜 번호
  const numDiv = document.createElement('div');
  numDiv.className = 'calendar-day-number';
  numDiv.textContent = day;
  div.appendChild(numDiv);

  // 기록들
  const recordsDiv = document.createElement('div');
  recordsDiv.className = 'calendar-day-records';

  if (minutes > 0) {
    const recordDiv = document.createElement('div');
    recordDiv.className = 'calendar-record' + (minutes > dailyMax ? ' over' : '') + (isCurrentIn ? ' current' : '');
    recordDiv.textContent = minutesToTimeStr(minutes);
    recordsDiv.appendChild(recordDiv);
  } else if (isCurrentIn) {
    const recordDiv = document.createElement('div');
    recordDiv.className = 'calendar-record current';
    recordDiv.textContent = '입실중';
    recordsDiv.appendChild(recordDiv);
  }

  div.appendChild(recordsDiv);

  // 클릭 이벤트
  div.addEventListener('click', () => openDayDetail(dateStr, minutes));

  return div;
}

// ===== 월간 요약 업데이트 =====
function updateMonthSummary() {
  if (!attendanceData || !currentSettings) return;

  // L5: 이번 달을 볼 때는 실시간(경과 포함) 값, 과거 월은 서버 확정 값
  const monthlyTotal = isCurrentMonthView()
    ? Math.max(attendanceData.monthlyTotal, recognizedMonthly(attendanceData))
    : attendanceData.monthlyTotal;
  const monthlyReq = currentSettings.monthlyRequiredHours * 60;
  const monthlyRemain = Math.max(0, monthlyReq - monthlyTotal);

  // 일 평균 (기록이 있는 날만)
  const recordedDays = Object.keys(attendanceData.dailyBreakdown).length;
  const avg = recordedDays > 0 ? Math.round(monthlyTotal / recordedDays) : 0;

  els.monthTotal.textContent = minutesToTimeStr(monthlyTotal);
  els.monthAvg.textContent = minutesToTimeStr(avg);
  els.monthRemain.textContent = `남음: ${minutesToTimeStr(monthlyRemain)}`;
  els.monthRemain.className = `month-summary-value ${monthlyRemain > 0 ? 'remain' : 'ok'}`;
}

// ===== 일별 상세 모달 =====
function openDayDetail(dateStr, minutes) {
  selectedDay = dateStr;
  const dailyMax = currentSettings.dailyMaxHours * 60;
  const isOver = minutes > dailyMax;

  // 날짜 포맷
  const [y, m, d] = dateStr.split('-').map(Number);
  els.dayDetailDate.textContent = `${y}년 ${m}월 ${d}일`;

  // 요약
  els.dayTotal.textContent = minutesToTimeStr(minutes);
  els.dayTotal.className = `day-detail-value ${isOver ? 'over' : 'normal'}`;
  els.dayLimit.textContent = `최대 ${currentSettings.dailyMaxHours}시간`;

  // 상세 기록 - rawDetailList에서 세션 정보 사용
  const todayStr = getTodayString();
  const dayData = (attendanceData.rawDetailList || []).find(d => d.date === dateStr);

  if (dayData && dayData.sessions && dayData.sessions.length > 0) {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

    els.dayRecords.innerHTML = dayData.sessions.map(session => {
      const entryTime = session.entry_time || '';
      const exitTime = session.exit_time || '';
      const durationStr = session.duration || '';
      const durationMin = durationToMinutes(durationStr);
      const isMissing = session.is_missing === true;
      const missingType = session.missing_type;
      const isOverRecord = durationMin > dailyMax;

      let displayTime = `${entryTime} ~ ${exitTime || '입실 중'}`;
      let displayDuration = minutesToTimeStr(durationMin);

      // 오늘 날짜의 진행 중 세션만 실시간 계산 (과거 날짜는 서버 확정 값)
      if (isMissing && missingType === 'exit' && entryTime && dateStr === todayStr) {
        const entryMin = timeStrToMinutes(entryTime);
        if (entryMin !== null) {
          const realDuration = nowMin - entryMin;
          displayDuration = minutesToTimeStr(realDuration);
        }
      }

      return `
        <div class="day-detail-record ${isMissing && missingType === 'exit' ? 'current' : ''}">
          <span class="day-detail-record-time">${displayTime}</span>
          <span class="day-detail-record-duration ${isOverRecord ? 'over' : ''}">${displayDuration}</span>
        </div>
      `;
    }).join('');
  } else {
    els.dayRecords.innerHTML = '<div class="day-detail-empty">해당 날짜의 출입 기록이 없습니다.</div>';
  }

  els.dayDetailModal.classList.add('show');
}

function closeDayDetail() {
  els.dayDetailModal.classList.remove('show');
  selectedDay = null;
}

// ===== 네비게이션 =====
function goToMonth(offset) {
  stopRealtime();
  currentViewDate = new Date(currentViewDate.getFullYear(), currentViewDate.getMonth() + offset, 1);
  loadAttendance(); // M1: 이동한 월의 데이터를 FETCH_ATTENDANCE로 다시 조회
}

function goToThisMonth() {
  stopRealtime();
  currentViewDate = new Date();
  currentViewDate.setDate(1);
  loadAttendance();
}

// ===== 초기화 =====
function init() {
  // 네비게이션 버튼
  els.btnPrevMonth.addEventListener('click', () => goToMonth(-1));
  els.btnNextMonth.addEventListener('click', () => goToMonth(1));
  els.btnTodayMonth.addEventListener('click', goToThisMonth);

  // 모달 닫기
  els.dayDetailClose.addEventListener('click', closeDayDetail);
  els.dayDetailModal.addEventListener('click', (e) => {
    if (e.target === els.dayDetailModal) closeDayDetail();
  });

  // ESC 키로 모달 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDayDetail();
  });

  // 초기 로드
  loadAttendance();
}

document.addEventListener('DOMContentLoaded', init);
