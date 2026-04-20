import { setStatusTemp } from './uiUtils.js';

let _llm, _storage;
let _autoSaveEnabled = false;
let _autoSaveTimer   = null;

export function initHistorySync({ llm, storage }) {
  _llm     = llm;
  _storage = storage;

  window.addEventListener('beforeunload', () => {
    console.log('[HistorySync] 画面遷移(beforeunload)を検知しました');
    _forceSaveOnExit();
  });
  window.addEventListener('pagehide', () => {
    console.log('[HistorySync] 画面非表示(pagehide)を検知しました');
    _forceSaveOnExit();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      console.log('[HistorySync] バックグラウンド移行(visibilitychange)を検知しました');
      _forceSaveOnExit();
    }
  });
}

export function getAutoSaveEnabled() { return _autoSaveEnabled; }
export function setAutoSaveEnabled(val) { _autoSaveEnabled = val; }
export function cancelAutoSave() { clearTimeout(_autoSaveTimer); }

export function applySettings(s) {
  if (!s) {
    _autoSaveEnabled = true;
    return;
  }
  if (s.autosave_history !== undefined) {
    _autoSaveEnabled = s.autosave_history === 'true';
  } else {
    _autoSaveEnabled = true;
  }
}

export function scheduleHistorySave() {
  if (!_autoSaveEnabled) {
    console.log('[HistorySync] 保存: 自動保存がOFFのためスキップ');
    return;
  }
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    try {
      console.log(`[HistorySync] 保存実行中... (現在の履歴件数: ${_llm.history.length})`);
      await _storage.saveHistory(_llm.history);
      console.log('[HistorySync] 履歴の保存が正常に完了しました!');
      setStatusTemp(document.getElementById('status-indicator'), '履歴を自動保存しました');
    } catch (err) {
      console.error('[HistorySync] 履歴の自動保存エラー:', err.message);
    }
  }, 2000);
}

function _forceSaveOnExit() {
  if (_autoSaveEnabled && _llm.history.length > 0) {
    console.log(`[HistorySync] 退避のための即時保存を実行します (件数: ${_llm.history.length})`);
    _storage.saveHistory(_llm.history);
  }
}
