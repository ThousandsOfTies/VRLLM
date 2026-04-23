import { setStatus } from './uiUtils.js';
import {
  getVrmState, setCurrentVrmSystemPrompt, refreshVRMList, loadBuiltinVRM,
  applySettings as vrmApplySettings,
} from './vrmManager.js';
import {
  getAutoSaveEnabled, setAutoSaveEnabled, cancelAutoSave,
  applySettings as historyApplySettings,
} from './historySync.js';
import { getLocationEnabled, applySettings as locationApplySettings } from './locationManager.js';

let _viewer, _llm, _speech, _driveSync, _storage;
let _saveSettingsTimer = null;
let _savedArmCorr = 0;
let _savedShCorr  = 0;
let _savedChCorr  = 0;

export function initSettingsManager({ viewer, llm, speech, driveSync, storage }) {
  _viewer    = viewer;
  _llm       = llm;
  _speech    = speech;
  _driveSync = driveSync;
  _storage   = storage;

  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  document.getElementById('settings-btn').addEventListener('click', _openSettings);
  document.getElementById('save-settings-btn').addEventListener('click', _saveSettingsHandler);
  document.getElementById('cancel-settings-btn').addEventListener('click', _cancelSettings);
  document.getElementById('aivis-check-btn').addEventListener('click', _checkAivis);
  document.getElementById('clear-history-btn').addEventListener('click', _clearHistory);

  // Drive 自動保存チェックボックス
  document.getElementById('drive-autosave-chk').addEventListener('change', (e) => {
    setAutoSaveEnabled(e.target.checked);
    saveSettings();
    if (!e.target.checked) cancelAutoSave();
  });

  _registerSliderListeners();
  _registerCloudStatusListeners();
}

// ---- Public API ----
export function getArmCorr()      { return _savedArmCorr; }
export function getShoulderCorr() { return _savedShCorr; }
export function getChestCorr()    { return _savedChCorr; }

export function collectSettings() {
  const vrmState = getVrmState();
  return {
    ..._llm.getSettings(),
    ..._speech.getSettings(),
    autosave_history:        String(getAutoSaveEnabled()),
    location_enabled:        String(getLocationEnabled()),
    vrm_char_names:          JSON.stringify(vrmState.charNames),
    vrm_system_prompts:      JSON.stringify(vrmState.systemPrompts),
    selected_vrm_id:         vrmState.currentVrmId,
    vrma_arm_correction:     String(_savedArmCorr),
    vrma_shoulder_correction: String(_savedShCorr),
    vrma_chest_correction:   String(_savedChCorr),
  };
}

export function saveSettings() {
  clearTimeout(_saveSettingsTimer);
  _saveSettingsTimer = setTimeout(() => {
    _storage.saveSettings(collectSettings()).catch(err =>
      console.warn('設定保存失敗:', err.message)
    );
  }, 500);
}

export function applySettings(s) {
  if (!s) {
    historyApplySettings(null);
    return;
  }
  _llm.applySettings(s);
  _speech.applySettings(s);
  historyApplySettings(s);
  locationApplySettings(s);
  vrmApplySettings(s);
  if (s.vrma_arm_correction !== undefined) {
    _savedArmCorr = parseFloat(s.vrma_arm_correction) || 0;
    _viewer.setVRMArmCorrection(_savedArmCorr);
  }
  if (s.vrma_shoulder_correction !== undefined) {
    _savedShCorr = parseFloat(s.vrma_shoulder_correction) || 0;
    _viewer.setVRMAShoulderCorrection(_savedShCorr);
  }
  if (s.vrma_chest_correction !== undefined) {
    _savedChCorr = parseFloat(s.vrma_chest_correction) || 0;
    _viewer.setVRMAChestCorrection(_savedChCorr);
  }
}

export function resetToDefaults() {
  console.log('[Sync] 全ての状態をデフォルトにリセットします...');
  historyApplySettings({ autosave_history: 'true' });
  locationApplySettings({ location_enabled: 'false' });
  vrmApplySettings({ vrm_char_names: '{}', vrm_system_prompts: '{}', selected_vrm_id: '__builtin__' });
  _llm.applySettings({});
  _speech.applySettings({});
  _llm.clearHistory();
  _llm.userProfile = [];

  document.getElementById('chat-messages').innerHTML = '';
  const spEl = document.getElementById('setting-system-prompt');
  if (spEl) spEl.value = '';
  const upEl = document.getElementById('setting-user-profile');
  if (upEl) upEl.value = '';

  const settingsPanel = document.getElementById('settings-panel');
  if (!settingsPanel.classList.contains('hidden')) {
    document.getElementById('setting-endpoint').value   = _llm.endpoint;
    document.getElementById('setting-api-key').value    = _llm.apiKey;
    document.getElementById('setting-model').value      = _llm.model;
    document.getElementById('setting-tts-lang').value   = _llm.ttsLang;
    const ss = _speech.getSettings();
    document.getElementById('setting-aivis-url').value     = ss.aivis_url || '';
    document.getElementById('setting-aivis-speaker').value = ss.aivis_speaker_id || '';
  }

  loadBuiltinVRM().catch(e => console.warn('Reset VRM failed:', e));
}

// ---- Private handlers ----
function _openSettings() {
  const settingsPanel = document.getElementById('settings-panel');
  settingsPanel.classList.toggle('hidden');
  if (settingsPanel.classList.contains('hidden')) return;

  const vrmState = getVrmState();
  document.getElementById('setting-endpoint').value      = _llm.endpoint;
  document.getElementById('setting-api-key').value       = _llm.apiKey;
  document.getElementById('setting-model').value         = _llm.model;
  document.getElementById('setting-system-prompt').value =
    vrmState.systemPrompts[vrmState.currentVrmId] ?? _llm.systemPrompt;
  document.getElementById('setting-tts-lang').value      = _llm.ttsLang;

  const ss = _speech.getSettings();
  document.getElementById('setting-aivis-url').value     = ss.aivis_url              || 'http://127.0.0.1:10101';
  
  // スピーカーリストの初期化（現在のIDだけ先に入れておく）
  const speakerSelect = document.getElementById('setting-aivis-speaker');
  speakerSelect.innerHTML = `<option value="${ss.aivis_speaker_id}">${ss.aivis_speaker_id}</option>`;
  speakerSelect.value = ss.aivis_speaker_id || '';
  document.getElementById('setting-cloud-api-key').value     = ss.aivis_cloud_api_key    || '';
  document.getElementById('setting-cloud-model-uuid').value  = ss.aivis_cloud_model_uuid || '';

  _updateCloudStatus();

  document.getElementById('setting-arm-correction').value      = _savedArmCorr;
  document.getElementById('setting-arm-correction-num').value  = _savedArmCorr;
  _viewer.setVRMArmCorrection(_savedArmCorr);

  document.getElementById('setting-shoulder-correction').value     = _savedShCorr;
  document.getElementById('setting-shoulder-correction-num').value = _savedShCorr;
  _viewer.setVRMAShoulderCorrection(_savedShCorr);

  document.getElementById('setting-chest-correction').value     = _savedChCorr;
  document.getElementById('setting-chest-correction-num').value = _savedChCorr;
  _viewer.setVRMAChestCorrection(_savedChCorr);

  refreshVRMList();

  if (_driveSync.isSignedIn) {
    document.getElementById('drive-autosave-chk').checked = getAutoSaveEnabled();
  }

  const locationEnabled = getLocationEnabled();
  document.getElementById('location-chk').checked = locationEnabled;
  document.getElementById('location-status').textContent =
    locationEnabled && _llm.locationContext ? `✅ ${_llm.locationContext}` : '';

  document.getElementById('setting-user-profile').value =
    _llm.userProfile ? _llm.userProfile.join('\n') : '';
}

function _saveSettingsHandler() {
  _llm.endpoint = document.getElementById('setting-endpoint').value.trim();
  _llm.apiKey   = document.getElementById('setting-api-key').value.trim();
  _llm.model    = document.getElementById('setting-model').value.trim();

  const rawPrompt = document.getElementById('setting-system-prompt').value.trim();
  if (!rawPrompt) {
    _llm.systemPrompt = _llm.constructor.DEFAULT_SYSTEM_PROMPT;
    document.getElementById('setting-system-prompt').value = _llm.systemPrompt;
    setStatus('システムプロンプトをデフォルトに戻しました');
  } else {
    _llm.systemPrompt = rawPrompt;
  }
  setCurrentVrmSystemPrompt(_llm.systemPrompt);
  _llm.ttsLang = document.getElementById('setting-tts-lang').value;

  _savedArmCorr = parseFloat(document.getElementById('setting-arm-correction-num').value) || 0;
  _viewer.setVRMArmCorrection(_savedArmCorr);
  _savedShCorr = parseFloat(document.getElementById('setting-shoulder-correction-num').value) || 0;
  _viewer.setVRMAShoulderCorrection(_savedShCorr);
  _savedChCorr = parseFloat(document.getElementById('setting-chest-correction-num').value) || 0;
  _viewer.setVRMAChestCorrection(_savedChCorr);

  _speech.updateAivisSettings(
    document.getElementById('setting-aivis-url').value.trim(),
    document.getElementById('setting-aivis-speaker').value.trim()
  );
  _speech.updateCloudSettings(
    document.getElementById('setting-cloud-api-key').value.trim(),
    document.getElementById('setting-cloud-model-uuid').value.trim()
  );

  const profileText = document.getElementById('setting-user-profile').value;
  if (profileText !== undefined) {
    const newProfile = profileText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (JSON.stringify(_llm.userProfile) !== JSON.stringify(newProfile)) {
      _llm.userProfile = newProfile;
      if (_driveSync.isSignedIn) {
        _driveSync.saveUserProfile(_llm.userProfile).catch(e => console.warn('手動プロファイル保存失敗:', e));
      } else if (typeof _storage._b?.saveUserProfile === 'function') {
        _storage._b.saveUserProfile(_llm.userProfile);
      }
      console.log('✅ プロファイルを手動で更新しました:', _llm.userProfile);
    }
  }

  saveSettings();
  document.getElementById('settings-panel').classList.add('hidden');
  setStatus('設定を保存しました');
}

async function _checkAivis() {
  const statusEl2 = document.getElementById('aivis-status');
  const url       = document.getElementById('setting-aivis-url').value.trim();
  const select    = document.getElementById('setting-aivis-speaker');
  const currentId = select.value;

  statusEl2.textContent = '確認中...';
  
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/speakers`);
    if (!res.ok) throw new Error();
    const speakers = await res.json();

    // リストを更新
    select.innerHTML = '';
    speakers.forEach(sp => {
      sp.styles.forEach(st => {
        const opt = document.createElement('option');
        opt.value = st.id;
        opt.textContent = `${sp.name} (${st.name}) : ${st.id}`;
        select.appendChild(opt);
      });
    });
    
    // 前の選択があれば復元、なければ先頭
    if ([...select.options].some(o => o.value === currentId)) {
      select.value = currentId;
    }

    _speech.updateAivisSettings(url, select.value);
    statusEl2.textContent = '✅ AivisSpeech に接続し、リストを更新しました';
  } catch (e) {
    statusEl2.innerHTML = `
      <div style="color:#ff6b6b; margin-top:8px; border:1px solid #ff6b6b; padding:8px; border-radius:4px; font-size:12px; line-height:1.4;">
        ❌ 接続に失敗しました<br><br>
        <b>もっとも簡単な解決策:</b><br>
        1. URLバー左の<b>「鍵マーク(または設定アイコン)」</b>をクリック<br>
        2. <b>「サイトの設定」</b>を開く<br>
        3. <b>「安全でないコンテンツ(Insecure content)」</b>を<b>「許可」</b>に変更<br>
        4. このページを再読み込みして、もう一度更新してください。<br><br>
        ※技術的な解決策: AivisSpeechを --cors_policy_mode all オプション付きで起動することでも解決します。
      </div>`;
  }
}

function _cancelSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
  _viewer.setVRMArmCorrection(_savedArmCorr);
  _viewer.setVRMAShoulderCorrection(_savedShCorr);
  _viewer.setVRMAChestCorrection(_savedChCorr);
}

function _clearHistory() {
  _llm.clearHistory();
  document.getElementById('chat-messages').innerHTML = '';
  cancelAutoSave();
  setStatus('会話履歴をクリアしました');
  document.getElementById('settings-panel').classList.add('hidden');
}

function _registerSliderListeners() {
  document.getElementById('setting-arm-correction').addEventListener('input', (e) => {
    document.getElementById('setting-arm-correction-num').value = e.target.value;
    _viewer.setVRMArmCorrection(parseFloat(e.target.value) || 0);
  });
  document.getElementById('setting-arm-correction-num').addEventListener('input', (e) => {
    const v = Math.max(-90, Math.min(90, parseFloat(e.target.value) || 0));
    document.getElementById('setting-arm-correction').value = v;
    _viewer.setVRMArmCorrection(v);
  });

  document.getElementById('setting-shoulder-correction').addEventListener('input', (e) => {
    document.getElementById('setting-shoulder-correction-num').value = e.target.value;
    _viewer.setVRMAShoulderCorrection(parseFloat(e.target.value) || 0);
  });
  document.getElementById('setting-shoulder-correction-num').addEventListener('input', (e) => {
    const v = Math.max(-90, Math.min(90, parseFloat(e.target.value) || 0));
    document.getElementById('setting-shoulder-correction').value = v;
    _viewer.setVRMAShoulderCorrection(v);
  });

  document.getElementById('setting-chest-correction').addEventListener('input', (e) => {
    document.getElementById('setting-chest-correction-num').value = e.target.value;
    _viewer.setVRMAChestCorrection(parseFloat(e.target.value) || 0);
  });
  document.getElementById('setting-chest-correction-num').addEventListener('input', (e) => {
    const v = Math.max(-90, Math.min(90, parseFloat(e.target.value) || 0));
    document.getElementById('setting-chest-correction').value = v;
    _viewer.setVRMAChestCorrection(v);
  });
}

function _updateCloudStatus() {
  const apiKey   = document.getElementById('setting-cloud-api-key').value.trim();
  const modelUuid = document.getElementById('setting-cloud-model-uuid').value.trim();
  let msg;
  if (!apiKey) {
    msg = _speech._useAivis ? '✅ ローカル AivisSpeech 使用中' : '❌ ブラウザTTS使用中';
  } else if (!modelUuid) {
    msg = '⚠️ Cloud API: モデルUUIDが未設定';
  } else {
    msg = '✅ Cloud API 使用中';
  }
  document.getElementById('aivis-status').textContent = msg;
}

function _registerCloudStatusListeners() {
  document.getElementById('setting-cloud-api-key').addEventListener('input', _updateCloudStatus);
  document.getElementById('setting-cloud-model-uuid').addEventListener('input', _updateCloudStatus);
}
