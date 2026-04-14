import './style.css';
import { VRMViewer } from './vrm-viewer.js';
import { LLMClient } from './llm-client.js';
import { SpeechManager } from './speech.js';
import { LipSync } from './lip-sync.js';
import { TTSPipeline } from './tts-pipeline.js';
import { GoogleDriveSync } from './google-drive-sync.js';
import { LocalStorage } from './local-storage.js';
import { AppStorage } from './app-storage.js';

// ---- インスタンス生成 ----
const canvas = document.getElementById('vrm-canvas');
const viewer = new VRMViewer(canvas);
const llm = new LLMClient();
const speech = new SpeechManager();
const lipSync = new LipSync(viewer);
const driveSync = new GoogleDriveSync();
const local   = new LocalStorage();
const storage = new AppStorage(driveSync, local);

// ---- DOM 参照 ----
const loadVrmBtn = document.getElementById('load-vrm-btn');
const vrmFileInput = document.getElementById('vrm-file-input');
const loadVRMABtn = document.getElementById('load-vrma-btn');
const vrmaFileInput = document.getElementById('vrma-file-input');
const vrmaPresetSelect = document.getElementById('vrma-preset-select');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const chatMessages = document.getElementById('chat-messages');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const cancelSettingsBtn = document.getElementById('cancel-settings-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const statusEl = document.getElementById('status-indicator');
const vrmLoadStatus = document.getElementById('vrm-load-status');

// ---- VRM 読み込み ----
loadVrmBtn.addEventListener('click', () => vrmFileInput.click());

async function loadBuiltinVRM() {
  setStatus('モデルを読み込み中...');
  loadVrmBtn.disabled = true;
  try {
    await viewer.loadVRM(import.meta.env.BASE_URL + 'vrm/Lilym.vrm', (pct) => setStatus(`読み込み中... ${pct}%`));
    setStatus('デフォルトモーション適用中...');
    await viewer.loadVRMA(import.meta.env.BASE_URL + 'vrma/VRMA_03.vrma', { loop: true, isIdle: true });
    vrmaPresetSelect.value = 'vrma/VRMA_03.vrma';
    setStatus('');
  } catch (err) {
    setStatus(`モデル読み込みエラー: ${err.message}`);
    console.error(err);
  } finally {
    loadVrmBtn.disabled = false;
  }
}

vrmFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  loadVrmBtn.disabled = true;
  vrmLoadStatus.textContent = '読み込み中...';
  try {
    await viewer.loadVRM(file, (pct) => { vrmLoadStatus.textContent = `読み込み中... ${pct}%`; });
    vrmLoadStatus.textContent = `✅ ${file.name}`;
    setStatus('');
  } catch (err) {
    vrmLoadStatus.textContent = `❌ ${err.message}`;
    console.error(err);
    loadVrmBtn.disabled = false;
    vrmFileInput.value = '';
    return;
  }
  // デフォルトモーション
  try {
    const vrmaUrl = import.meta.env.BASE_URL + 'vrma/VRMA_03.vrma';
    await viewer.loadVRMA(vrmaUrl, { loop: true });
    vrmaPresetSelect.value = 'vrma/VRMA_03.vrma';
  } catch (vrmaErr) {
    console.warn('デフォルトモーション読み込み失敗:', vrmaErr.message);
  } finally {
    loadVrmBtn.disabled = false;
    vrmFileInput.value = '';
  }
});

// 起動時にビルトインモデルを自動ロード
loadBuiltinVRM();

// ---- VRMA 読み込み ----
loadVRMABtn.addEventListener('click', () => vrmaFileInput.click());

vrmaFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('VRMAを読み込み中...');
  loadVRMABtn.disabled = true;
  try {
    await viewer.loadVRMA(file);
    setStatus('アニメーション再生中');
  } catch (err) {
    setStatus(`VRMAエラー: ${err.message}`);
    console.error(err);
  } finally {
    loadVRMABtn.disabled = false;
    vrmaFileInput.value = '';
  }
});

// ---- VRMAプリセット選択 ----
vrmaPresetSelect.addEventListener('change', async () => {
  const path = vrmaPresetSelect.value;
  const prevValue = vrmaPresetSelect.dataset.current ?? 'vrma/VRMA_03.vrma';
  setStatus('モーション読み込み中...');
  try {
    await viewer.loadVRMA(import.meta.env.BASE_URL + path);
    vrmaPresetSelect.dataset.current = path;
    setStatus('アニメーション再生中');
  } catch (err) {
    setStatus(`VRMAエラー: ${err.message}`);
    vrmaPresetSelect.value = prevValue;
    console.error(err);
  }
});

// ---- チャット送信 ----

// 感情コールバックを事前に登録
llm.onEmotionDetected = (emotion) => {
  viewer.applyEmotion(emotion);
  setStatus(`感情: ${emotion}`);
};

// 実行中のパイプライン（割り込み停止用）
let _activePipeline = null;

async function sendMessage(text) {
  text = text.trim();
  if (!text) return;

  // iOS Safari などの自動再生ブロック（無音になり、onended が発火せず口がバグる問題）を回避するため、
  // ユーザーがボタンを押した直後のタイミングで AudioContext を解禁（resume）しておく
  await speech.unlockAudio();

  chatInput.value = '';
  autoResizeTextarea();

  appendMessage('user', text, true);  // 送信時は強制スクロール

  const assistantEl = appendMessage('assistant', '', true);
  const textNode = assistantEl.querySelector('.message-text');

  setStatus('考え中...');
  setInputEnabled(false);

  // 実行中の再生を停止
  if (_activePipeline) { _activePipeline.stop(); _activePipeline = null; }
  lipSync.stop();
  viewer.stopTalking();

  // 新しいパイプラインを作成
  const pipeline = new TTSPipeline(speech);
  _activePipeline = pipeline;

  pipeline.onSpeechStart = () => {
    lipSync.start();
    viewer.startTalking();
    setStatus('話し中...');
  };
  pipeline.onSpeechEnd = () => {
    lipSync.stop();
    viewer.stopTalking();
    viewer.resetExpressions();
    setStatus('');
  };

  let fullResponse = '';

  try {
    for await (const chunk of llm.chat(text)) {
      // 別のメッセージで割り込まれた場合は中断
      if (_activePipeline !== pipeline) break;

      fullResponse += chunk;
      pipeline.push(chunk);
      textNode.textContent = fullResponse.replace(/^\s+/, '');
      scrollToBottom();
    }

    const spokenText = fullResponse.trim();
    if (!spokenText) {
      textNode.textContent = '(応答がありませんでした)';
      setStatus('');
      return;
    }
    textNode.textContent = spokenText;

    // LLM完了 → パイプラインの残りを流して全再生完了まで待つ
    await pipeline.done({ lang: llm.ttsLang });
    scheduleHistorySave();

  } catch (err) {
    textNode.textContent = `エラー: ${err.message}`;
    viewer.resetExpressions();
    lipSync.stop();
    viewer.stopTalking();
    setStatus('エラーが発生しました');
    console.error(err);
  } finally {
    if (_activePipeline === pipeline) _activePipeline = null;
    setInputEnabled(true);
    // タッチデバイスではフォーカスするとキーボードが再出現するので抑制
    if (!navigator.maxTouchPoints) chatInput.focus();
    // 会話モード: TTS終了後に自動でマイクON
    if (autoListenMode && !speech.isListening) {
      startListeningOnce();
    }
  }
}

sendBtn.addEventListener('click', () => sendMessage(chatInput.value));

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage(chatInput.value);
  }
});

chatInput.addEventListener('input', autoResizeTextarea);

// ---- マイク ----
if (!speech.sttSupported) {
  micBtn.disabled = true;
  micBtn.title = 'このブラウザは音声認識に非対応です';
}

// 会話モード: TTS終了後に自動でマイクON (長押しでON/OFF)
let autoListenMode = false;

function startListeningOnce() {
  speech.setLang(llm.ttsLang);
  speech.startListening();
  micBtn.classList.add('active');
  setStatus('聞いています...');

  speech.onTranscript = (text) => {
    micBtn.classList.remove('active');
    sendMessage(text);
  };

  // 認識タイムアウト等でリスニングが終了した際のUI復元 & 会話モード継続
  speech.onListeningEnd = () => {
    micBtn.classList.remove('active');
    if (autoListenMode && !chatInput.disabled) {
      startListeningOnce();
    } else if (!autoListenMode) {
      setStatus('');
    }
  };
}

function enterAutoListen() {
  autoListenMode = true;
  micBtn.classList.add('auto-listen');
  micBtn.title = '会話モード中 (長押しで終了)';
  setStatus('会話モード ON');
  if (!speech.isListening && !chatInput.disabled) {
    startListeningOnce();
  }
}

function exitAutoListen() {
  autoListenMode = false;
  micBtn.classList.remove('auto-listen');
  micBtn.title = '音声入力 (クリックで開始/停止)';
  if (speech.isListening) {
    speech.stopListening();
    micBtn.classList.remove('active');
  }
  setStatus('');
}

// 長押し検出 (600ms)
let _longPressTimer = null;
let _longPressTriggered = false;

micBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // 長押しコンテキストメニューを抑制

// iOS Safari の絵文字長押し（文字情報・コールアウト）を抑制し pointercancel を防ぐ
micBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
}, { passive: false });

micBtn.addEventListener('pointerdown', () => {
  if (micBtn.disabled) return;
  _longPressTriggered = false;
  _longPressTimer = setTimeout(() => {
    _longPressTimer = null;
    _longPressTriggered = true;
    if (autoListenMode) exitAutoListen();
    else enterAutoListen();
  }, 600);
});

micBtn.addEventListener('pointerup', () => {
  if (_longPressTimer !== null) {
    clearTimeout(_longPressTimer);
    _longPressTimer = null;
  }
  if (_longPressTriggered) return; // 長押し済みはクリック処理をスキップ

  // 短押し: 会話モード中なら終了、それ以外は通常のON/OFF
  if (autoListenMode) {
    exitAutoListen();
    return;
  }
  if (speech.isListening) {
    speech.stopListening();
    micBtn.classList.remove('active');
    setStatus('');
    return;
  }
  startListeningOnce();
});

micBtn.addEventListener('pointerleave', () => {
  if (_longPressTimer !== null) {
    clearTimeout(_longPressTimer);
    _longPressTimer = null;
  }
});

micBtn.addEventListener('pointercancel', () => {
  if (_longPressTimer !== null) {
    clearTimeout(_longPressTimer);
    _longPressTimer = null;
  }
});

// ---- 設定タブ ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ---- 設定パネル ----
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    document.getElementById('setting-endpoint').value = llm.endpoint;
    document.getElementById('setting-api-key').value = llm.apiKey;
    document.getElementById('setting-model').value = llm.model;
    document.getElementById('setting-system-prompt').value = llm.systemPrompt;
    document.getElementById('setting-tts-lang').value = llm.ttsLang;
    const speechSettings = speech.getSettings();
    document.getElementById('setting-aivis-url').value         = speechSettings.aivis_url              || 'http://localhost:10101';
    document.getElementById('setting-aivis-speaker').value     = speechSettings.aivis_speaker_id        || '888753760';
    document.getElementById('setting-cloud-api-key').value     = speechSettings.aivis_cloud_api_key    || '';
    document.getElementById('setting-cloud-model-uuid').value  = speechSettings.aivis_cloud_model_uuid || '';
    const ttsMode = speech._useCloud ? '✅ Cloud API 使用中' :
                   speech._useAivis ? '✅ ローカル AivisSpeech 使用中' : '❌ ブラウザTTS使用中';
    document.getElementById('aivis-status').textContent = ttsMode;

    // Drive サインイン済みなら自動保存チェックと、プリセットを更新
    if (driveSync.isSignedIn) {
      document.getElementById('drive-autosave-chk').checked = _autoSaveEnabled;
      if (Date.now() - _presetsLastRefresh > 60_000) refreshPresets();
    }
  }
});

saveSettingsBtn.addEventListener('click', () => {
  llm.endpoint     = document.getElementById('setting-endpoint').value.trim();
  llm.apiKey       = document.getElementById('setting-api-key').value.trim();
  llm.model        = document.getElementById('setting-model').value.trim();
  llm.systemPrompt = document.getElementById('setting-system-prompt').value.trim();
  llm.ttsLang      = document.getElementById('setting-tts-lang').value;

  speech.updateAivisSettings(
    document.getElementById('setting-aivis-url').value.trim(),
    document.getElementById('setting-aivis-speaker').value.trim()
  );
  speech.updateCloudSettings(
    document.getElementById('setting-cloud-api-key').value.trim(),
    document.getElementById('setting-cloud-model-uuid').value.trim()
  );

  storage.saveSettings(collectSettings()).catch(err => console.warn('設定保存失敗:', err.message));

  settingsPanel.classList.add('hidden');
  setStatus('設定を保存しました');
});

// AivisSpeech 疎通確認ボタン
document.getElementById('aivis-check-btn').addEventListener('click', async () => {
  const statusEl2 = document.getElementById('aivis-status');
  const url = document.getElementById('setting-aivis-url').value.trim();
  const speaker = document.getElementById('setting-aivis-speaker').value.trim();
  statusEl2.textContent = '確認中...';
  speech.updateAivisSettings(url, speaker);
  // 少し待ってから結果表示
  await new Promise(r => setTimeout(r, 800));
  statusEl2.textContent = speech._useAivis
    ? '✅ AivisSpeech に接続できました'
    : '❌ 接続できません。AivisSpeech が起動しているか確認してください';
});

cancelSettingsBtn.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
});

clearHistoryBtn.addEventListener('click', () => {
  llm.clearHistory();
  chatMessages.innerHTML = '';
  clearTimeout(_autoSaveTimer); // 保存待ちタイマーもリセット
  setStatus('会話履歴をクリアしました');
  settingsPanel.classList.add('hidden');
});

// ---- Google Drive 同期 ----

// 自動保存の状態（initApp で設定から復元）
let _autoSaveEnabled = false;
let _autoSaveTimer   = null;

// ---- 設定ヘルパー ----

function collectSettings() {
  return {
    ...llm.getSettings(),
    ...speech.getSettings(),
    autosave_history: String(_autoSaveEnabled),
  };
}

function applySettings(s) {
  if (!s) return;
  llm.applySettings(s);
  speech.applySettings(s);
  if (s.autosave_history !== undefined) _autoSaveEnabled = s.autosave_history === 'true';
}

function scheduleHistorySave() {
  if (!_autoSaveEnabled) return;
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(async () => {
    try {
      await storage.saveHistory(llm.history);
      setStatus('履歴を自動保存しました');
      setTimeout(() => { if (statusEl.textContent === '履歴を自動保存しました') setStatus(''); }, 3000);
    } catch (err) {
      console.warn('履歴自動保存失敗:', err.message);
    }
  }, 15_000); // 最後の返答から15秒後に保存
}

// プリセットのキャッシュ
let _cachedPresets     = [];
let _presetsLastRefresh = 0;

async function refreshPresets() {
  try {
    _cachedPresets      = await storage.loadPresets();
    _presetsLastRefresh = Date.now();
    updatePresetSelect();
  } catch (err) {
    console.warn('プリセット読み込み失敗:', err.message);
  }
}

function updatePresetSelect() {
  const sel = document.getElementById('drive-preset-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">-- プリセットを選択 --</option>';
  for (const p of _cachedPresets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

const driveAutosaveChk       = document.getElementById('drive-autosave-chk');
const driveSaveHistoryBtn    = document.getElementById('drive-save-history-btn');
const driveLoadHistoryBtn    = document.getElementById('drive-load-history-btn');
const drivePresetSelect      = document.getElementById('drive-preset-select');
const drivePresetApplyBtn    = document.getElementById('drive-preset-apply-btn');
const drivePresetDeleteBtn   = document.getElementById('drive-preset-delete-btn');
const drivePresetNameInput   = document.getElementById('drive-preset-name-input');
const drivePresetSaveBtn     = document.getElementById('drive-preset-save-btn');
const driveSigninBtn     = document.getElementById('drive-signin-btn');
const driveUiIn          = document.getElementById('drive-ui-in');
const driveSaveBtn       = document.getElementById('drive-save-btn');
const driveLoadBtn       = document.getElementById('drive-load-btn');
const driveUploadVrmBtn  = document.getElementById('drive-upload-vrm-btn');
const driveListVrmBtn    = document.getElementById('drive-list-vrm-btn');
const driveVrmSelect     = document.getElementById('drive-vrm-select');
const driveApplyVrmBtn   = document.getElementById('drive-apply-vrm-btn');
const driveSignoutBtn    = document.getElementById('drive-signout-btn');
const driveStatus        = document.getElementById('drive-status');
const driveVrmUploadInput = document.getElementById('drive-vrm-upload-input');

// Googleスタイルのイニシャルアバター用カラーパレット
const AVATAR_COLORS = [
  '#F44336','#E91E63','#9C27B0','#673AB7','#3F51B5',
  '#2196F3','#0097A7','#00897B','#43A047','#FB8C00','#F4511E',
];
function avatarColorFromName(name) {
  if (!name) return '#7a90ff';
  const code = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return AVATAR_COLORS[code % AVATAR_COLORS.length];
}
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

function updateDriveSyncUI(isSignedIn) {
  // ヘッダーのサインインボタン ↔ アバターを切り替え
  driveSigninBtn.classList.toggle('hidden', isSignedIn);
  driveUiIn.classList.toggle('hidden', !isSignedIn);

  const img      = document.getElementById('sync-avatar-img');
  const initials = document.getElementById('sync-avatar-initials');

  if (isSignedIn) {
    // イニシャルをセット（画像が読めなかった場合のフォールバック）
    const name = driveSync.name;
    initials.textContent = getInitials(name);
    initials.style.background = avatarColorFromName(name);
    initials.style.display = '';

    const pic = driveSync.picture;
    if (pic) {
      img.src = pic;
      img.onload = () => {
        img.classList.add('loaded');
        initials.style.display = 'none';
      };
      img.onerror = () => {
        img.classList.remove('loaded');
        initials.style.display = '';
      };
    }
  } else {
    img.src = '';
    img.classList.remove('loaded');
    initials.textContent = '';
    initials.style.display = '';
    driveVrmSelect.classList.add('hidden');
    driveApplyVrmBtn.classList.add('hidden');
    driveStatus.textContent = '';
  }
}

driveSync.onSignInChange = (isSignedIn) => {
  updateDriveSyncUI(isSignedIn);
  if (isSignedIn) {
    // Drive から設定・プリセットを再読み込みして適用
    storage.loadSettings().then(s => {
      applySettings(s);
      driveAutosaveChk.checked = _autoSaveEnabled;
    }).catch(() => {});
    refreshPresets();
  }
};

driveSigninBtn.addEventListener('click', () => {
  try {
    driveSync.signIn();
  } catch (err) {
    driveStatus.textContent = `❌ ${err.message}`;
  }
});

driveSignoutBtn.addEventListener('click', () => {
  driveSync.signOut();
  _cachedPresets = [];
  driveStatus.textContent = 'サインアウトしました';
});

// ---- 会話履歴 ----

driveAutosaveChk.addEventListener('change', () => {
  _autoSaveEnabled = driveAutosaveChk.checked;
  storage.saveSettings(collectSettings()).catch(() => {});
  if (!_autoSaveEnabled) clearTimeout(_autoSaveTimer);
});

driveSaveHistoryBtn.addEventListener('click', async () => {
  driveStatus.textContent = '保存中...';
  driveSaveHistoryBtn.disabled = true;
  try {
    await storage.saveHistory(llm.history);
    driveStatus.textContent = `✅ 履歴を保存しました (${llm.history.length} 件)`;
  } catch (err) {
    driveStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    driveSaveHistoryBtn.disabled = false;
  }
});

driveLoadHistoryBtn.addEventListener('click', async () => {
  driveStatus.textContent = '読み込み中...';
  driveLoadHistoryBtn.disabled = true;
  try {
    const data = await storage.loadHistory();
    if (!data?.messages?.length) {
      driveStatus.textContent = 'Drive に保存された履歴がありません';
      return;
    }
    // 現在の履歴を置き換えて表示を再構築
    llm.history = data.messages;
    chatMessages.innerHTML = '';
    for (const msg of data.messages) {
      appendMessage(msg.role, msg.content);
    }
    const date = new Date(data.savedAt).toLocaleString('ja-JP');
    driveStatus.textContent = `✅ 履歴を読み込みました (${data.messages.length} 件 / ${date})`;
  } catch (err) {
    driveStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    driveLoadHistoryBtn.disabled = false;
  }
});

// ---- キャラクタープリセット ----

drivePresetApplyBtn.addEventListener('click', () => {
  const id = drivePresetSelect.value;
  if (!id) { driveStatus.textContent = 'プリセットを選択してください'; return; }
  const preset = _cachedPresets.find(p => p.id === id);
  if (!preset) return;

  llm.systemPrompt = preset.system_prompt;
  llm.model        = preset.model;
  llm.ttsLang      = preset.tts_lang;
  speech.updateAivisSettings(speech._aivis.baseUrl, preset.aivis_speaker_id || '');
  speech.updateCloudSettings(speech._cloud.apiKey, preset.aivis_cloud_model_uuid || '');

  // フォームに反映
  document.getElementById('setting-model').value             = llm.model;
  document.getElementById('setting-system-prompt').value     = llm.systemPrompt;
  document.getElementById('setting-tts-lang').value          = llm.ttsLang;
  document.getElementById('setting-aivis-speaker').value     = preset.aivis_speaker_id || '';
  document.getElementById('setting-cloud-model-uuid').value  = preset.aivis_cloud_model_uuid || '';

  driveStatus.textContent = `✅ 「${preset.name}」を適用しました`;
});

drivePresetSaveBtn.addEventListener('click', async () => {
  const name = drivePresetNameInput.value.trim();
  if (!name) { driveStatus.textContent = 'プリセット名を入力してください'; return; }

  const newPreset = {
    id:                    `preset_${Date.now()}`,
    name,
    system_prompt:         document.getElementById('setting-system-prompt').value.trim() || llm.systemPrompt,
    model:                 document.getElementById('setting-model').value.trim()         || llm.model,
    tts_lang:              document.getElementById('setting-tts-lang').value             || llm.ttsLang,
    aivis_speaker_id:      document.getElementById('setting-aivis-speaker').value.trim(),
    aivis_cloud_model_uuid: document.getElementById('setting-cloud-model-uuid').value.trim(),
  };

  driveStatus.textContent = '保存中...';
  drivePresetSaveBtn.disabled = true;
  try {
    _cachedPresets.push(newPreset);
    await storage.savePresets(_cachedPresets);
    updatePresetSelect();
    drivePresetNameInput.value = '';
    driveStatus.textContent = `✅ 「${name}」を保存しました`;
  } catch (err) {
    _cachedPresets.pop(); // ロールバック
    driveStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    drivePresetSaveBtn.disabled = false;
  }
});

drivePresetDeleteBtn.addEventListener('click', async () => {
  const id = drivePresetSelect.value;
  if (!id) { driveStatus.textContent = 'プリセットを選択してください'; return; }
  const preset = _cachedPresets.find(p => p.id === id);
  if (!preset) return;

  driveStatus.textContent = '削除中...';
  drivePresetDeleteBtn.disabled = true;
  const prev = [..._cachedPresets];
  try {
    _cachedPresets = _cachedPresets.filter(p => p.id !== id);
    await storage.savePresets(_cachedPresets);
    updatePresetSelect();
    driveStatus.textContent = `✅ 「${preset.name}」を削除しました`;
  } catch (err) {
    _cachedPresets = prev; // ロールバック
    driveStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    drivePresetDeleteBtn.disabled = false;
  }
});

driveSaveBtn.addEventListener('click', async () => {
  driveStatus.textContent = '保存中...';
  driveSaveBtn.disabled = true;
  try {
    await storage.saveSettings(collectSettings());
    driveStatus.textContent = '✅ 設定を保存しました';
  } catch (err) {
    driveStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    driveSaveBtn.disabled = false;
  }
});

driveLoadBtn.addEventListener('click', async () => {
  driveStatus.textContent = '読み込み中...';
  driveLoadBtn.disabled = true;
  try {
    const settings = await storage.loadSettings();
    if (!settings) {
      driveStatus.textContent = '保存された設定が見つかりませんでした';
      return;
    }
    applySettings(settings);
    // 設定フォームに反映 (パネルが開いている場合)
    document.getElementById('setting-endpoint').value          = llm.endpoint;
    document.getElementById('setting-api-key').value           = llm.apiKey;
    document.getElementById('setting-model').value             = llm.model;
    document.getElementById('setting-system-prompt').value     = llm.systemPrompt;
    document.getElementById('setting-tts-lang').value          = llm.ttsLang;
    const ss = speech.getSettings();
    document.getElementById('setting-aivis-url').value         = ss.aivis_url              || '';
    document.getElementById('setting-aivis-speaker').value     = ss.aivis_speaker_id        || '';
    document.getElementById('setting-cloud-api-key').value     = ss.aivis_cloud_api_key    || '';
    document.getElementById('setting-cloud-model-uuid').value  = ss.aivis_cloud_model_uuid || '';
    driveStatus.textContent = '✅ 設定を読み込みました';
  } catch (err) {
    driveStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    driveLoadBtn.disabled = false;
  }
});

// VRM アップロード
driveUploadVrmBtn.addEventListener('click', () => driveVrmUploadInput.click());

driveVrmUploadInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  driveStatus.textContent = `アップロード中: ${file.name} ...`;
  driveUploadVrmBtn.disabled = true;
  try {
    await storage.uploadVRM(file, (pct) => {
      driveStatus.textContent = `アップロード中: ${file.name} ${pct}%`;
    });
    driveStatus.textContent = `✅ ${file.name} をアップロードしました`;
  } catch (err) {
    driveStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    driveUploadVrmBtn.disabled = false;
    driveVrmUploadInput.value = '';
  }
});

// VRM 一覧取得
driveListVrmBtn.addEventListener('click', async () => {
  driveStatus.textContent = '一覧取得中...';
  driveVrmSelect.classList.add('hidden');
  driveApplyVrmBtn.classList.add('hidden');
  driveListVrmBtn.disabled = true;
  try {
    const files = await storage.listVRMFiles();
    if (files.length === 0) {
      driveStatus.textContent = 'Drive に VRM ファイルがありません';
      return;
    }
    driveVrmSelect.innerHTML = '<option value="">-- モデルを選択 --</option>';
    for (const f of files) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      driveVrmSelect.appendChild(opt);
    }
    driveVrmSelect.classList.remove('hidden');
    driveApplyVrmBtn.classList.remove('hidden');
    driveStatus.textContent = `${files.length} 件のモデルが見つかりました`;
  } catch (err) {
    driveStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    driveListVrmBtn.disabled = false;
  }
});

// VRM 読み込み
driveApplyVrmBtn.addEventListener('click', async () => {
  const fileId   = driveVrmSelect.value;
  const fileName = driveVrmSelect.options[driveVrmSelect.selectedIndex]?.text ?? 'model.vrm';
  if (!fileId) return;

  driveStatus.textContent = `ダウンロード中: ${fileName} ...`;
  driveApplyVrmBtn.disabled = true;
  try {
    const arrayBuffer = await storage.downloadVRM(fileId);
    const file = new File([arrayBuffer], fileName, { type: 'application/octet-stream' });

    settingsPanel.classList.add('hidden');
    setStatus(`Drive から ${fileName} を読み込み中...`);
    loadVrmBtn.disabled = true;
    vrmLoadStatus.textContent = '読み込み中...';

    await viewer.loadVRM(file, (pct) => setStatus(`読み込み中... ${pct}%`));
    vrmLoadStatus.textContent = `✅ ${fileName} (Drive)`;
    setStatus('');

    try {
      await viewer.loadVRMA(import.meta.env.BASE_URL + 'vrma/VRMA_03.vrma', { loop: true, isIdle: true });
      vrmaPresetSelect.value = 'vrma/VRMA_03.vrma';
    } catch (vrmaErr) {
      console.warn('デフォルトモーション読み込み失敗:', vrmaErr.message);
    }
  } catch (err) {
    driveStatus.textContent = `❌ ${err.message}`;
    setStatus('VRM読み込みエラー');
    console.error(err);
    settingsPanel.classList.remove('hidden');
  } finally {
    driveApplyVrmBtn.disabled = false;
    loadVrmBtn.disabled = false;
  }
});

// ---- アプリ初期化 ----

async function initApp() {
  // IndexedDB を開く
  await local.init();

  // Google Drive セッション復元（完了後に onSignInChange が発火する場合がある）
  await driveSync.init().catch(err => console.warn('Drive sync init:', err));

  // サインイン状態に応じたバックエンドから設定を読み込む
  const saved = await storage.loadSettings().catch(() => null);
  applySettings(saved);

  // プリセットを読み込む
  refreshPresets();
}

initApp().catch(err => console.warn('App init error:', err));

// ---- PWA: Service Worker 登録 ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(err => console.warn('SW 登録失敗:', err));
  });
}

// ---- ウィンドウリサイズ ----
window.addEventListener('resize', () => viewer.resize());

// ---- モバイル: キーボード表示をfocus/blurで制御 ----
// visualViewport より確実。タッチデバイスのみ適用。
// キーボード開閉はfocus/blurで制御
const viewerPanel = document.getElementById('viewer-panel');
if (navigator.maxTouchPoints > 0) {
  chatInput.addEventListener('focus', () => {
    viewerPanel.style.display = 'none';
  });
  chatInput.addEventListener('blur', () => {
    // レイアウト変更前のスクロール位置（下端からの距離）を保存
    const distanceFromBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
    setTimeout(() => {
      viewerPanel.style.display = '';
      viewer.resize();
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      // iOS Safari は window.scrollTo() 後に非同期でスクロール位置をリセットするため、
      // requestAnimationFrame で次フレームまで遅延させてから復元する
      requestAnimationFrame(() => {
        if (distanceFromBottom < 80) {
          // 最下部付近だった場合は最新メッセージへスクロール
          chatMessages.scrollTop = chatMessages.scrollHeight;
        } else {
          // 上方向にスクロール中だった場合は相対位置を維持
          chatMessages.scrollTop = chatMessages.scrollHeight - chatMessages.clientHeight - distanceFromBottom;
        }
      });
    }, 300);
  });
}

// ---- ユーティリティ ----
function appendMessage(role, text, force = false) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  wrap.innerHTML = `
    <div class="message-avatar">${role === 'user' ? '👤' : '🤖'}</div>
    <div class="message-bubble">
      <div class="message-text">${escapeHtml(text)}</div>
    </div>
  `;
  chatMessages.appendChild(wrap);
  scrollToBottom(force);
  return wrap;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ユーザーが意図的に上スクロールしているか判定するしきい値 (px)
const SCROLL_THRESHOLD = 80;

function isNearBottom() {
  const el = chatMessages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setInputEnabled(enabled) {
  chatInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  micBtn.disabled = !enabled || !speech.sttSupported;
}

function autoResizeTextarea() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}
