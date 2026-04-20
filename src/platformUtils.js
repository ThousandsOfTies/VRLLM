let _viewer;
let _wakeLock = null;

export function initPlatformUtils({ viewer }) {
  _viewer = viewer;

  // Wake Lock
  _acquireWakeLock();
  document.addEventListener('pointerdown', _acquireWakeLock);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _acquireWakeLock();
  });
  window.addEventListener('focus',    _acquireWakeLock);
  window.addEventListener('pageshow', _acquireWakeLock);

  // PWA: Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
        .catch(err => console.warn('SW 登録失敗:', err));
    });
  }

  // Resize
  window.addEventListener('resize', () => _viewer.resize());

  // モバイル: キーボード表示時にビューアを非表示にしてレイアウト崩れを防ぐ
  const chatInput   = document.getElementById('chat-input');
  const viewerPanel = document.getElementById('viewer-panel');
  if (navigator.maxTouchPoints > 0) {
    chatInput.addEventListener('focus', () => {
      viewerPanel.style.display = 'none';
    });
    chatInput.addEventListener('blur', () => {
      const chatMessages = document.getElementById('chat-messages');
      const distanceFromBottom =
        chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
      setTimeout(() => {
        viewerPanel.style.display = '';
        _viewer.resize();
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
        // iOS Safari は window.scrollTo() 後に非同期でスクロール位置をリセットするため
        // requestAnimationFrame で次フレームまで遅延させてから復元する
        requestAnimationFrame(() => {
          if (distanceFromBottom < 80) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else {
            chatMessages.scrollTop =
              chatMessages.scrollHeight - chatMessages.clientHeight - distanceFromBottom;
          }
        });
      }, 300);
    });
  }
}

async function _acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (_wakeLock && !_wakeLock.released) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    console.log('[WakeLock] スクリーンロック防止を取得しました');
    _wakeLock.addEventListener('release', () => {
      console.log('[WakeLock] 解放されました。再取得を試みます...');
      _wakeLock = null;
      if (document.visibilityState === 'visible') _acquireWakeLock();
    });
  } catch (err) {
    console.warn('[WakeLock] 取得失敗:', err.message);
  }
}
