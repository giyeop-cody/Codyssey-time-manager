const config = {
  appId: 'kr.codyssey.attendance',
  appName: '코디세이 출입 현황 알리미',
  webDir: 'web',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    LocalNotifications: {
      iconColor: '#4ec9b0'
    },
    Preferences: {
      group: 'codyssey_prefs'
    }
  },
  // N9 개선: config.xml의 <access origin>을 '*' 대신 실제 사용 도메인으로 제한.
  // (android/.../res/xml/config.xml은 cap sync가 이 값으로 재생성함)
  cordova: {
    accessOrigins: [
      'https://*.codyssey.kr',
      'https://codyssey.kr'
    ]
  }
};

module.exports = config;
