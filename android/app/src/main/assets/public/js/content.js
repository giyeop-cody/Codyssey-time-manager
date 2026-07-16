// ============================================================
// 코디세이 출입기록 익스텐션 - Content Script
// 페이지에서 멤버 ID 자동 감지
// ============================================================

(function() {
  'use strict';

  // 멤버 ID 감지 함수
  function detectMemberId() {
    // 1. localStorage에서 찾기
    const lsKeys = ['mbrId', 'memberId', 'userId', 'loginUser', 'user_no', 'member_no'];
    for (const key of lsKeys) {
      const val = localStorage.getItem(key);
      if (val && /^\d+$/.test(val)) return val;
    }

    // 2. sessionStorage에서 찾기
    for (const key of lsKeys) {
      const val = sessionStorage.getItem(key);
      if (val && /^\d+$/.test(val)) return val;
    }

    // 3. 쿠키에서 찾기
    const cookies = document.cookie.split('; ');
    for (const cookie of cookies) {
      const [k, v] = cookie.split('=');
      if (lsKeys.includes(k.trim()) && /^\d+$/.test(v)) return v;
    }

    // 4. 페이지 내 데이터 속성에서 찾기
    const selectors = [
      '[data-mbr-id]', '[data-member-id]', '[data-user-id]', '[data-user-no]',
      '[data-member-no]', '#mbrId', '#memberId', '#userId'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const val = el.dataset.mbrId || el.dataset.memberId || el.dataset.userId || 
                   el.dataset.userNo || el.dataset.memberNo || el.value || el.textContent;
        if (val && /^\d+$/.test(val.trim())) return val.trim();
      }
    }

    // 5. 메타 태그에서 찾기
    const metaSelectors = ['meta[name="mbr-id"]', 'meta[name="member-id"]', 'meta[name="user-id"]'];
    for (const sel of metaSelectors) {
      const el = document.querySelector(sel);
      if (el && el.content && /^\d+$/.test(el.content)) return el.content;
    }

    // 6. 전역 변수에서 찾기 (React/Vue 등)
    const globalKeys = ['mbrId', 'memberId', 'userId', 'loginUser', 'userInfo', 'memberInfo'];
    for (const key of globalKeys) {
      if (window[key] && /^\d+$/.test(String(window[key]))) return String(window[key]);
      if (window[key] && window[key].mbrId && /^\d+$/.test(String(window[key].mbrId))) return String(window[key].mbrId);
      if (window[key] && window[key].memberId && /^\d+$/.test(String(window[key].memberId))) return String(window[key].memberId);
      if (window[key] && window[key].userId && /^\d+$/.test(String(window[key].userId))) return String(window[key].userId);
    }

    // 7. React DevTools 스타일 전역에서 찾기
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      // 무시 - 너무 복잡함
    }

    return null;
  }

  // 감지된 ID를 백그라운드로 전송
  function sendMemberId() {
    const memberId = detectMemberId();
    if (memberId) {
      chrome.runtime.sendMessage({ type: 'DETECT_MEMBER_ID', memberId });
    }
  }

  // 페이지 로드 시 즉시 실행
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sendMemberId);
  } else {
    sendMemberId();
  }

  // SPA 네비게이션 감지 (History API 훅)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    setTimeout(sendMemberId, 100);
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    setTimeout(sendMemberId, 100);
  };
  
  window.addEventListener('popstate', () => {
    setTimeout(sendMemberId, 100);
  });

  // MutationObserver로 동적 콘텐츠 감지
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // 로그인 폼이나 사용자 정보 영역이 추가되었는지 확인
            if (node.matches?.('[data-mbr-id], [data-member-id], [data-user-id], #mbrId, #memberId, #userId') ||
                node.querySelector?.('[data-mbr-id], [data-member-id], [data-user-id], #mbrId, #memberId, #userId')) {
              setTimeout(sendMemberId, 100);
              break;
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 백그라운드에서 요청 시 응답
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_MEMBER_ID') {
      const memberId = detectMemberId();
      sendResponse({ memberId });
      return true;
    }
  });

  // 주기적 재감지 (5분마다)
  setInterval(sendMemberId, 5 * 60 * 1000);

})();