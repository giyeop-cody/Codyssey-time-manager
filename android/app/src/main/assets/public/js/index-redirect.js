// App entry redirect: index.html -> popup.html
// Extracted from inline <script> for MV3 CSP compliance (script-src 'self'
// blocks inline scripts). Works in both Capacitor WebView and extension pages.
// location.replace keeps no history entry (avoids index<->popup back-button loop).
window.location.replace('popup.html');
