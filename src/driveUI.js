import { updateUserAvatars, appendMessage, setStatus, setStatusTemp } from './uiUtils.js';
import { applySettings, resetToDefaults } from './settingsManager.js';
import { applyLocationIfEnabled, getLocationEnabled } from './locationManager.js';
import { getAutoSaveEnabled } from './historySync.js';
import {
  getCurrentVrmId, getVrmSystemPrompts, getVrmFileNames,
  refreshVRMList, loadDefaultVRMA, captureAiAvatar,
} from './vrmManager.js';

let _driveSync, _storage, _llm, _speech, _viewer;

const AVATAR_COLORS = [
  '#F44336','#E91E63','#9C27B0','#673AB7','#3F51B5',
  '#2196F3','#0097A7','#00897B','#43A047','#FB8C00','#F4511E',
];

function _avatarColorFromName(name) {
  if (!name) return '#7a90ff';
  const code = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return AVATAR_COLORS[code % AVATAR_COLORS.length];
}

function _getInitials(name, email) {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (email) return email[0].toUpperCase();
  return '?';
}

export function initDriveUI({ driveSync, storage, llm, speech, viewer }) {
  _driveSync = driveSync;
  _storage   = storage;
  _llm       = llm;
  _speech    = speech;
  _viewer    = viewer;

  driveSync.onSignInChange = _onSignInChange;

  document.getElementById('drive-signin-btn').addEventListener('click', () => {
    try {
      driveSync.signIn();
    } catch (err) {
      document.getElementById('drive-status').textContent = `❌ ${err.message}`;
    }
  });

  document.getElementById('drive-signout-btn').addEventListener('click', () => {
    driveSync.signOut();
    document.getElementById('drive-status').textContent = 'サインアウトしました';
  });
}

export function updateDriveSyncUI(isSignedIn) {
  const driveSigninBtn = document.getElementById('drive-signin-btn');
  const driveUiIn      = document.getElementById('drive-ui-in');
  const img            = document.getElementById('sync-avatar-img');
  const initials       = document.getElementById('sync-avatar-initials');
  const driveStatus    = document.getElementById('drive-status');

  driveSigninBtn.classList.toggle('hidden', isSignedIn);
  driveUiIn.classList.toggle('hidden', !isSignedIn);

  if (isSignedIn) {
    const name  = _driveSync.name;
    const email = _driveSync.email;
    initials.textContent       = _getInitials(name, email);
    initials.style.background  = _avatarColorFromName(name || email);
    initials.style.display     = '';

    const pic = _driveSync.picture;
    if (pic) {
      img.src     = pic;
      img.onload  = () => { img.classList.add('loaded'); initials.style.display = 'none'; };
      img.onerror = () => { img.classList.remove('loaded'); initials.style.display = ''; };
    }
  } else {
    img.src = '';
    img.classList.remove('loaded');
    initials.textContent  = '';
    initials.style.display = '';
    driveStatus.textContent = '';
  }
}

export function showReauthToast(email) {
  if (document.getElementById('reauth-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'reauth-toast';
  Object.assign(toast.style, {
    position:     'fixed',
    top:          '30%',
    left:         '50%',
    transform:    'translateX(-50%)',
    background:   'rgba(0, 0, 0, 0.9)',
    color:        '#fff',
    padding:      '20px 24px',
    borderRadius: '12px',
    boxShadow:    '0 10px 25px rgba(0,0,0,0.5)',
    zIndex:       '9999',
    display:      'flex',
    flexDirection: 'column',
    alignItems:   'center',
    gap:          '15px',
    width:        '85%',
    maxWidth:     '350px',
    textAlign:    'center',
    fontSize:     '14px',
  });

  const text = document.createElement('span');
  text.textContent = `Drive同期 (${email}) を再開しますか？`;

  const btn = document.createElement('button');
  btn.textContent = 'はい';
  Object.assign(btn.style, {
    padding: '6px 16px', borderRadius: '20px', border: 'none',
    background: '#4CAF50', color: '#fff', fontWeight: 'bold', cursor: 'pointer',
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    background: 'none', border: 'none', color: '#bbb',
    cursor: 'pointer', fontSize: '16px', padding: '0 4px',
  });

  btn.addEventListener('click', () => {
    try { _driveSync.signIn(); } catch (e) { console.error(e); }
    toast.remove();
  });
  closeBtn.addEventListener('click', () => toast.remove());

  toast.append(text, btn, closeBtn);
  document.body.appendChild(toast);
}

async function _onSignInChange(isSignedIn, isNewLogin = false) {
  const driveStatus     = document.getElementById('drive-status');
  const driveAutosaveChk = document.getElementById('drive-autosave-chk');
  const locationChk     = document.getElementById('location-chk');
  const locationStatus  = document.getElementById('location-status');
  const settingsPanel   = document.getElementById('settings-panel');
  const chatMessages    = document.getElementById('chat-messages');

  updateDriveSyncUI(isSignedIn);

  if (isSignedIn) {
    updateUserAvatars();

    if (isNewLogin) resetToDefaults();

    driveStatus.textContent = '同期中...';
    _storage.loadSettings().then(async s => {
      if (!s) {
        driveStatus.textContent = '⚠️ Drive に設定がまだ保存されていません';
        return;
      }

      const prevVrmId = getCurrentVrmId();
      applySettings(s);
      applyLocationIfEnabled();
      driveAutosaveChk.checked = getAutoSaveEnabled();
      locationChk.checked = getLocationEnabled();

      if (!settingsPanel.classList.contains('hidden')) {
        document.getElementById('setting-endpoint').value      = _llm.endpoint;
        document.getElementById('setting-api-key').value       = _llm.apiKey;
        document.getElementById('setting-model').value         = _llm.model;
        const vrmSystemPrompts = getVrmSystemPrompts();
        const currentVrmId    = getCurrentVrmId();
        document.getElementById('setting-system-prompt').value =
          vrmSystemPrompts[currentVrmId] ?? _llm.systemPrompt;
        document.getElementById('setting-tts-lang').value = _llm.ttsLang;
        const ss = _speech.getSettings();
        document.getElementById('setting-aivis-url').value        = ss.aivis_url || '';
        document.getElementById('setting-aivis-speaker').value    = ss.aivis_speaker_id || '';
        document.getElementById('setting-cloud-api-key').value    = ss.aivis_cloud_api_key || '';
        document.getElementById('setting-cloud-model-uuid').value = ss.aivis_cloud_model_uuid || '';
        locationStatus.textContent =
          getLocationEnabled() && _llm.locationContext ? `✅ ${_llm.locationContext}` : '';
      }

      // プロファイルと会話履歴の非同期ロード
      (async () => {
        try {
          console.log('[HistorySync] Drive同期後: プロファイル読み込み処理を開始します...');
          const profileInfo = await _driveSync.loadUserProfile();
          if (profileInfo && Array.isArray(profileInfo)) {
            _llm.userProfile = profileInfo;
            console.log('[HistorySync] Drive同期後: プロファイルを復元しました:', profileInfo);
          } else {
            console.log('[HistorySync] Drive同期後: 既存のプロファイルは見つかりませんでした（または空です）');
          }
        } catch (err) {
          console.error('[HistorySync] Drive同期後: プロファイル読み込み失敗:', err.message);
        }

        if (getAutoSaveEnabled()) {
          try {
            console.log('[HistorySync] Drive同期後: 会話履歴の読み込み処理を開始します...');
            const hist = await _storage.loadHistory();
            if (hist && Array.isArray(hist.messages)) {
              console.log(`[HistorySync] Drive同期後: 会話履歴を受信しました (API取得件数: ${hist.messages.length}件)`);
              const pastMsgs = hist.messages.filter(m => m.role === 'user' || m.role === 'assistant');
              if (pastMsgs.length > 0) {
                _llm.history = isNewLogin ? pastMsgs : [...pastMsgs, ..._llm.history];
                chatMessages.innerHTML = '';
                for (const msg of _llm.history) appendMessage(msg.role, msg.content, true);
                console.log(`[HistorySync] Drive同期後: 会話履歴を反映完了 (最終件数: ${_llm.history.length}件)`);
              } else {
                console.log('[HistorySync] Drive同期後: 受信した履歴データに有効な発言が含まれていませんでした');
              }
            } else {
              console.log('[HistorySync] Drive同期後: クラウド上に保存された履歴データが存在しませんでした');
            }
          } catch (err) {
            console.error('[HistorySync] Drive同期後: 会話履歴読み込み失敗:', err.message);
          }
        } else {
          console.log('[HistorySync] Drive同期後: 自動保存設定がOFFのため、履歴の復元をスキップします');
        }
      })();

      // Drive から設定を読んだ結果 VRM が変わっていれば読み込む
      const currentVrmId = getCurrentVrmId();
      if (currentVrmId !== prevVrmId && currentVrmId !== '__builtin__') {
        try {
          await refreshVRMList(currentVrmId);
          const vrmFileNames = getVrmFileNames();
          const fname = vrmFileNames[currentVrmId] || currentVrmId;
          const buf = await _storage.downloadVRM(currentVrmId);
          const file = new File([buf], fname, { type: 'application/octet-stream' });
          await _viewer.loadVRM(file, (pct) => setStatus(`読み込み中... ${pct}%`));
          await loadDefaultVRMA(true);
          setStatus('');
          captureAiAvatar();
        } catch (err) {
          console.warn('Drive サインイン後の VRM 読み込み失敗:', err.message);
        }
      }

      setStatusTemp(driveStatus, '✅ Drive から設定を読み込みました');
    }).catch(err => {
      driveStatus.textContent = `❌ 設定の読み込みに失敗しました: ${err.message}`;
    });
  }

  const existingToast = document.getElementById('reauth-toast');
  if (isSignedIn && existingToast) existingToast.remove();
}
