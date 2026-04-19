const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SCOPES = 'email profile https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
const SETTINGS_FILE = 'vrllm-settings.json';
const VRM_FOLDER = 'VRLLM';
const SESSION_KEY = 'vrllm_google_session';
// アクセストークンの有効期限より少し短めに設定（秒）
const TOKEN_LIFETIME_SEC = 3500;

export class GoogleDriveSync {
  constructor() {
    this._token = null;
    this._tokenClient = null;
    this._tokenExpiry = 0; // Unix ms
    this._email = null;
    this._name = null;
    this._picture = null;
    this._refreshTimer = null; // 期限前サイレントリフレッシュ用タイマー
    this.onSignInChange = null; // callback(isSignedIn: boolean)
  }

  // ---- 初期化 ----

  async init() {
    await this._loadGIS();
    this._tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: async (resp) => {
        if (resp.error) {
          // サイレント再認証が失敗した場合は静かに無視（手動サインインを待つ）
          if (resp.error === 'immediate_failed' || resp.error === 'user_cancelled') return;
          console.error('OAuth error:', resp.error);
          return;
        }
        const wasSignedIn = !!this._token;
        this._token = resp.access_token;
        this._tokenExpiry = Date.now() + TOKEN_LIFETIME_SEC * 1000;
        this._scheduleTokenRefresh();
        
        if (wasSignedIn) {
          // トークンリフレッシュ: セッションのみ更新
          this._saveSession();
        } else {
          // 新規サインイン（またはアカウント切り替え初期化）
          await this._fetchAndSaveEmail();
          // 第2引数 isNewLogin を true にして通知
          this.onSignInChange?.(true, true);
        }
      },
    });

    // 保存済みセッションの復元を試みる
    await this._tryRestoreSession();
  }

  // ---- セッション永続化 ----

  _saveSession() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        token:   this._token,
        expiry:  this._tokenExpiry,
        email:   this._email,
        name:    this._name,
        picture: this._picture,
      }));
    } catch (_) {}
  }

  _clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  async _tryRestoreSession() {
    let saved;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      saved = JSON.parse(raw);
    } catch (_) { return; }

    const { token, expiry, email, name, picture } = saved;

    // アカウント情報はトークン期限切れでも後続のsignIn()のヒントとして活用するため復元
    this._email       = email   ?? null;
    this._name        = name    ?? null;
    this._picture     = picture ?? null;

    // トークンがまだ有効期限内の場合はそのまま復元
    if (token && expiry && Date.now() < expiry) {
      this._token       = token;
      this._tokenExpiry = expiry;
      this._scheduleTokenRefresh();
      this.onSignInChange?.(true);
      return;
    }

    // 期限切れだがメールヒントがある場合はサイレント再認証を試みる
    if (email && this._tokenClient) {
      this._tokenClient.requestAccessToken({ prompt: '', hint: email });
      // 結果は callback で処理される
    }
  }

  get picture() { return this._picture; }
  get name()    { return this._name; }
  get email()   { return this._email; }

  async _fetchAndSaveEmail() {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${this._token}` },
      });
      if (res.ok) {
        const info = await res.json();
        this._email   = info.email   ?? null;
        this._name    = info.name    ?? null;
        this._picture = info.picture ?? null;
      }
    } catch (_) {}
    this._saveSession();
  }

  _loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Google Identity Services の読み込みに失敗しました'));
      document.head.appendChild(s);
    });
  }

  // ---- 認証 ----

  get isSignedIn() { return !!this._token; }

  signIn() {
    if (!this._tokenClient) throw new Error('初期化中です。少し待ってからお試しください');
    // 既知のアカウントがあればヒントを渡す（アカウント選択をスキップできる場合がある）
    const opts = this._email ? { prompt: '', hint: this._email } : { prompt: 'select_account' };
    this._tokenClient.requestAccessToken(opts);
  }

  signOut() {
    clearTimeout(this._refreshTimer);
    if (this._token) google.accounts.oauth2.revoke(this._token, () => {});
    this._token       = null;
    this._tokenExpiry = 0;
    this._email       = null;
    this._name        = null;
    this._picture     = null;
    this._clearSession();
    this.onSignInChange?.(false);
  }

  // ---- 設定の同期 (drive.appdata) ----

  async saveSettings(settings) {
    this._requireAuth();
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const fileId = await this._findFile(SETTINGS_FILE, 'appDataFolder');
    if (fileId) {
      await this._patchMedia(fileId, blob);
    } else {
      await this._multipartCreate(SETTINGS_FILE, blob, ['appDataFolder']);
    }
  }

  async loadSettings() {
    this._requireAuth();
    const fileId = await this._findFile(SETTINGS_FILE, 'appDataFolder');
    if (!fileId) return null;
    const res = await this._fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error(`設定の読み込み失敗 (${res.status})`);
    return res.json();
  }

  // ---- VRMファイルの同期 (drive.file) ----

  async uploadVRM(file, onProgress) {
    this._requireAuth();
    const folderId = await this._ensureVRMFolder();
    const existingId = await this._findFile(file.name, folderId);
    if (existingId) {
      await this._resumableUpdate(existingId, file, onProgress);
    } else {
      await this._resumableCreate(file.name, file, [folderId], onProgress);
    }
  }

  async listVRMFiles() {
    this._requireAuth();
    const folderId = await this._findVRMFolder();
    if (!folderId) return [];
    const q = `'${folderId}' in parents and trashed=false`;
    const data = await this._apiGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,modifiedTime)&orderBy=name`
    );
    return (data.files || []).filter(f => f.name.toLowerCase().endsWith('.vrm'));
  }

  async downloadVRM(fileId) {
    this._requireAuth();
    const res = await this._fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error(`VRMダウンロード失敗 (${res.status})`);
    return res.arrayBuffer();
  }

  async deleteVRM(fileId) {
    this._requireAuth();
    const res = await this._fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`VRM削除失敗 (${res.status})`);
  }

  // ---- 会話履歴 ----

  async saveHistory(messages) {
    this._requireAuth();
    const data = { messages, savedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const fileId = await this._findFile('vrllm-history.json', 'appDataFolder');
    if (fileId) {
      await this._patchMedia(fileId, blob);
    } else {
      await this._multipartCreate('vrllm-history.json', blob, ['appDataFolder']);
    }
  }

  async loadHistory() {
    this._requireAuth();
    const fileId = await this._findFile('vrllm-history.json', 'appDataFolder');
    if (!fileId) return null;
    const res = await this._fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error(`履歴読み込み失敗 (${res.status})`);
    return res.json(); // { messages, savedAt }
  }

  // ---- ユーザープロファイル（長期記憶） ----

  async saveUserProfile(profileArray) {
    this._requireAuth();
    const data = { profile: profileArray, savedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const fileId = await this._findFile('vrllm-profile.json', 'appDataFolder');
    if (fileId) {
      await this._patchMedia(fileId, blob);
    } else {
      await this._multipartCreate('vrllm-profile.json', blob, ['appDataFolder']);
    }
  }

  async loadUserProfile() {
    this._requireAuth();
    const fileId = await this._findFile('vrllm-profile.json', 'appDataFolder');
    if (!fileId) return []; // ファイルがなければ空配列
    const res = await this._fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error(`プロファイル読み込み失敗 (${res.status})`);
    const data = await res.json();
    return data.profile || [];
  }

  // ---- キャラクタープリセット ----

  async savePresets(presets) {
    this._requireAuth();
    const blob = new Blob([JSON.stringify({ presets }, null, 2)], { type: 'application/json' });
    const fileId = await this._findFile('vrllm-presets.json', 'appDataFolder');
    if (fileId) {
      await this._patchMedia(fileId, blob);
    } else {
      await this._multipartCreate('vrllm-presets.json', blob, ['appDataFolder']);
    }
  }

  async loadPresets() {
    this._requireAuth();
    const fileId = await this._findFile('vrllm-presets.json', 'appDataFolder');
    if (!fileId) return [];
    const res = await this._fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error(`プリセット読み込み失敗 (${res.status})`);
    const data = await res.json();
    return data.presets || [];
  }

  // ---- 内部ヘルパー ----

  // トークン期限の1分前にサイレントリフレッシュをスケジュールする。
  // 成功すればコールバックで新トークンが設定され、このタイマーが再登録される。
  _scheduleTokenRefresh() {
    clearTimeout(this._refreshTimer);
    const msUntilRefresh = this._tokenExpiry - Date.now() - 60_000; // 1分前
    if (msUntilRefresh <= 0) return; // 既に期限切れ間近はスキップ
    this._refreshTimer = setTimeout(() => {
      if (this._email && this._tokenClient) {
        this._tokenClient.requestAccessToken({ prompt: '', hint: this._email });
      }
    }, msUntilRefresh);
  }

  _requireAuth() {
    if (!this._token) throw new Error('Googleにサインインしてください');
  }

  async _ensureVRMFolder() {
    const id = await this._findVRMFolder();
    if (id) return id;
    const res = await this._fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: VRM_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!res.ok) throw new Error(`フォルダ作成失敗 (${res.status})`);
    return (await res.json()).id;
  }

  async _findVRMFolder() {
    const q = `name='${this._escapeQ(VRM_FOLDER)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const data = await this._apiGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`
    );
    return data.files?.[0]?.id ?? null;
  }

  async _findFile(name, parentId) {
    const q = `name='${this._escapeQ(name)}' and '${parentId}' in parents and trashed=false`;
    const spaces = parentId === 'appDataFolder' ? 'appDataFolder' : 'drive';
    const data = await this._apiGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=${spaces}`
    );
    return data.files?.[0]?.id ?? null;
  }

  // 小さいファイル用 (設定JSON)
  async _multipartCreate(name, blob, parents) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name, parents })], { type: 'application/json' }));
    form.append('file', blob);
    const res = await this._fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', body: form }
    );
    if (!res.ok) throw new Error(`ファイル作成失敗 (${res.status})`);
  }

  async _patchMedia(fileId, blob) {
    const res = await this._fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      }
    );
    if (!res.ok) throw new Error(`ファイル更新失敗 (${res.status})`);
  }

  // 大きいファイル用 (VRM) — resumable upload
  async _resumableCreate(name, blob, parents, onProgress) {
    const initRes = await this._fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(blob.size),
        },
        body: JSON.stringify({ name, parents }),
      }
    );
    if (!initRes.ok) throw new Error(`アップロード開始失敗 (${initRes.status})`);
    await this._putToResumableUrl(initRes.headers.get('Location'), blob, onProgress);
  }

  async _resumableUpdate(fileId, blob, onProgress) {
    const initRes = await this._fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(blob.size),
        },
        body: '{}',
      }
    );
    if (!initRes.ok) throw new Error(`アップロード開始失敗 (${initRes.status})`);
    await this._putToResumableUrl(initRes.headers.get('Location'), blob, onProgress);
  }

  _putToResumableUrl(url, blob, onProgress) {
    if (!onProgress) {
      return fetch(url, {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      }).then(res => {
        if (!res.ok) throw new Error(`アップロード失敗 (${res.status})`);
      });
    }
    // XHR でプログレス取得
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`アップロード失敗 (${xhr.status})`));
      xhr.onerror = () => reject(new Error('ネットワークエラー'));
      xhr.send(blob);
    });
  }

  async _apiGet(url) {
    const res = await this._fetch(url);
    if (!res.ok) throw new Error(`API エラー (${res.status})`);
    return res.json();
  }

  // Authorization ヘッダーを付与、401 で自動サインアウト
  async _fetch(url, options = {}) {
    const headers = { ...options.headers, Authorization: `Bearer ${this._token}` };
    // iOS Safariでバックグラウンド移行時(visibilitychange等)にリクエストがキャンセルされるのを防ぐため keepalive: true
    const res = await fetch(url, { keepalive: true, ...options, headers });
    if (res.status === 401) {
      this._token = null;
      this._tokenExpiry = 0;
      // トークン情報のみ消去し、メールなどのアカウント情報は維持して再認証のヒントにする
      this._saveSession();
      this.onSignInChange?.(false);
      throw new Error('認証の有効期限が切れました。再度サインインしてください');
    }
    return res;
  }

  _escapeQ(name) {
    return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }
}
