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
  }
};

module.exports = config;
