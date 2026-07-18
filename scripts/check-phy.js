// 32차 N31-12: 물리 탐지 판정 상수가 네이티브(PhysicalCheck.java)와
// JS 미러(shared-attendance.js) 간에 일치하는지 정적 검증.
// 값이 어긋나면 팝업 표시와 네이티브 알림이 서로 다르게 동작 → 빌드 단계에서 차단.
import { readFileSync } from 'node:fs';

const JS_PATH = 'web/js/shared-attendance.js';
const JAVA_PATH = 'android/app/src/main/java/kr/codyssey/attendance/util/PhysicalCheck.java';

const js = readFileSync(JS_PATH, 'utf8');
const java = readFileSync(JAVA_PATH, 'utf8');

// [JS 상수명, 자바 상수명]
const PAIRS = [
  ['PHY_WEIGHT_SSID', 'WEIGHT_SSID'],
  ['PHY_WEIGHT_BSSID', 'WEIGHT_BSSID'],
  ['PHY_WEIGHT_CELL', 'WEIGHT_CELL'],
  ['PHY_THRESHOLD_INSIDE', 'THRESHOLD_INSIDE'],
  ['PHY_STREAK_FLIP', 'STREAK_FLIP'],
  ['PHY_STREAK_ALERT', 'STREAK_ALERT'],
  ['PHY_SCORE_CAP', null], // 자바 쪽은 scoreSignals 안의 리터럴(6)
];

function jsConst(name) {
  const m = js.match(new RegExp(`export const ${name} = (\\d+);`));
  return m ? parseInt(m[1], 10) : null;
}
function javaConst(name) {
  const m = java.match(new RegExp(`public static final int ${name} = (\\d+);`));
  return m ? parseInt(m[1], 10) : null;
}

let fail = 0;
for (const [jsName, javaName] of PAIRS) {
  const jv = jsConst(jsName);
  if (javaName) {
    const av = javaConst(javaName);
    const ok = jv !== null && jv === av;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${jsName} (js=${jv}) = ${javaName} (java=${av})`);
    if (!ok) fail++;
  } else {
    // PHY_SCORE_CAP: 자바 리터럴 상한과 일치 여부 — scoreSignals의 "Math.min(score, N)" 검사
    const m = java.match(/Math\.min\(score, (\d+)\)/);
    const av = m ? parseInt(m[1], 10) : null;
    const ok = jv !== null && jv === av;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${jsName} (js=${jv}) = java score cap (${av})`);
    if (!ok) fail++;
  }
}

if (fail > 0) {
  console.error(`\nN31-12 FAIL: 판정 상수 불일치 ${fail}건 — PhysicalCheck.java와 shared-attendance.js를 함께 수정하세요.`);
  process.exit(1);
}
console.log('\n판정 상수 미러 일치 확인 완료');
