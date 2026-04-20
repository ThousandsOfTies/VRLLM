let _llm, _saveSettings;
let _locationEnabled = false;

export function initLocationManager({ llm, saveSettings }) {
  _llm          = llm;
  _saveSettings = saveSettings;

  const locationChk    = document.getElementById('location-chk');
  const locationStatus = document.getElementById('location-status');

  locationChk.addEventListener('change', async () => {
    if (locationChk.checked) {
      locationStatus.textContent = '位置情報を取得中...';
      const ctx = await fetchLocationContext();
      if (ctx) {
        _locationEnabled = true;
        _llm.locationContext = ctx;
        locationStatus.textContent = `✅ ${ctx}`;
      } else {
        _locationEnabled = false;
        locationChk.checked = false;
        _llm.locationContext = '';
        locationStatus.textContent = '❌ 取得できませんでした（ブラウザで位置情報の許可が必要です）';
      }
    } else {
      _locationEnabled = false;
      _llm.locationContext = '';
      locationStatus.textContent = '';
    }
    _saveSettings();
  });
}

export function getLocationEnabled() { return _locationEnabled; }

export function applySettings(s) {
  if (!s) return;
  if (s.location_enabled !== undefined) _locationEnabled = s.location_enabled === 'true';
}

export function applyLocationIfEnabled() {
  if (!_locationEnabled) return;
  fetchLocationContext().then(ctx => {
    if (ctx) _llm.locationContext = ctx;
  });
}

export function fetchLocationContext() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${coords.latitude}&lon=${coords.longitude}&format=json&accept-language=ja`,
            { headers: { 'User-Agent': 'VRLLM/1.0' } }
          );
          const data = await res.json();
          const addr    = data.address || {};
          const city    = addr.city || addr.town || addr.village || addr.hamlet || '';
          const state   = addr.state || '';
          const country = addr.country || '';
          const place   = [city, state, country].filter(Boolean).join('、');
          const now     = new Date();
          const timeStr = now.toLocaleString('ja-JP', {
            month: 'long', day: 'numeric', weekday: 'short',
            hour: '2-digit', minute: '2-digit',
          });
          resolve(`現在地: ${place}。現地日時: ${timeStr}。`);
        } catch { resolve(null); }
      },
      () => resolve(null),
      { timeout: 10_000 }
    );
  });
}
