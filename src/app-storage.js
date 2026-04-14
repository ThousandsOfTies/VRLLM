/**
 * ストレージ抽象レイヤー。
 * Google サインイン済み → Google Drive、未サインイン → IndexedDB に透過的にルーティングする。
 */
export class AppStorage {
  /**
   * @param {import('./google-drive-sync.js').GoogleDriveSync} driveSync
   * @param {import('./local-storage.js').LocalStorage} local
   */
  constructor(driveSync, local) {
    this._drive = driveSync;
    this._local = local;
  }

  get _b() {
    return this._drive.isSignedIn ? this._drive : this._local;
  }

  saveSettings(settings)     { return this._b.saveSettings(settings); }
  loadSettings()             { return this._b.loadSettings(); }

  saveHistory(messages)      { return this._b.saveHistory(messages); }
  loadHistory()              { return this._b.loadHistory(); }

  savePresets(presets)       { return this._b.savePresets(presets); }
  loadPresets()              { return this._b.loadPresets(); }

  uploadVRM(file, onProgress) { return this._b.uploadVRM(file, onProgress); }
  listVRMFiles()              { return this._b.listVRMFiles(); }
  downloadVRM(fileId)         { return this._b.downloadVRM(fileId); }
  deleteVRM(fileId)           { return this._b.deleteVRM(fileId); }
}
