// VRLLM Service Worker
// 戦略: 同一オリジンの静的アセットはキャッシュ優先で返し、バックグラウンドで更新
const CACHE = 'vrllm-v1';

self.addEventListener('install', (e) => {
  // アプリシェルを即座にキャッシュ
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(['./', './index.html']))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // 古いキャッシュを削除
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // クロスオリジン (LLM API / Google API) はそのままパス
  if (url.origin !== self.location.origin) return;
  // POST等はキャッシュ対象外
  if (e.request.method !== 'GET') return;

  // Stale-while-revalidate:
  //   キャッシュがあれば即返しつつ、バックグラウンドでキャッシュを更新
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      }).catch(() => null);

      return cached ?? await fetchPromise;
    })
  );
});
