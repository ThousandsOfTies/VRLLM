const DB_NAME    = 'VRLLMLocal';
const DB_VERSION = 1;

export class LocalStorage {
  constructor() {
    this._db = null;
  }

  async init() {
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = ({ target: { result: db } }) => {
        for (const name of ['settings', 'history', 'presets']) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
        if (!db.objectStoreNames.contains('vrm-files')) {
          db.createObjectStore('vrm-files', { keyPath: 'id' });
        }
      };
      req.onsuccess = ({ target }) => resolve(target.result);
      req.onerror   = ({ target }) => reject(target.error);
    });
  }

  // ---- 内部ヘルパー ----

  _kv(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
  }

  _all(store) {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror   = () => reject(req.error);
    });
  }

  // ---- 設定 ----

  async saveSettings(settings) {
    await this._kv('settings', 'readwrite', s => s.put(settings, 'main'));
  }

  async loadSettings() {
    return this._kv('settings', 'readonly', s => s.get('main'));
  }

  // ---- 会話履歴 ----

  async saveHistory(messages) {
    const data = { messages, savedAt: new Date().toISOString() };
    await this._kv('history', 'readwrite', s => s.put(data, 'main'));
  }

  async loadHistory() {
    return this._kv('history', 'readonly', s => s.get('main'));
  }

  // ---- キャラクタープリセット ----

  async savePresets(presets) {
    await this._kv('presets', 'readwrite', s => s.put(presets, 'main'));
  }

  async loadPresets() {
    return (await this._kv('presets', 'readonly', s => s.get('main'))) ?? [];
  }

  // ---- VRMファイル ----

  async uploadVRM(file, onProgress) {
    const data = await file.arrayBuffer();
    onProgress?.(100);
    await this._kv('vrm-files', 'readwrite', s => s.put({
      id:           file.name,
      name:         file.name,
      size:         file.size,
      modifiedTime: new Date().toISOString(),
      data,
    }));
  }

  async listVRMFiles() {
    const all = await this._all('vrm-files');
    return all.map(({ id, name, size, modifiedTime }) => ({ id, name, size, modifiedTime }));
  }

  async downloadVRM(fileId) {
    const record = await this._kv('vrm-files', 'readonly', s => s.get(fileId));
    if (!record) throw new Error(`VRMファイルが見つかりません: ${fileId}`);
    return record.data;
  }

  async deleteVRM(fileId) {
    await this._kv('vrm-files', 'readwrite', s => s.delete(fileId));
  }
}
