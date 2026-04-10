import './style.css';
import { VRMViewer } from './vrm-viewer.js';
import { LLMClient } from './llm-client.js';
import { SpeechManager } from './speech.js';
import { LipSync } from './lip-sync.js';
import { TTSPipeline } from './tts-pipeline.js';

// ---- インスタンス生成 ----
const canvas = document.getElementById('vrm-canvas');
const viewer = new VRMViewer(canvas);
const llm = new LLMClient();
const speech = new SpeechManager();
const lipSync = new LipSync(viewer);

// ---- DOM 参照 ----
const loadVrmBtn = document.getElementById('load-vrm-btn');
const vrmFileInput = document.getElementById('vrm-file-input');
const loadVRMABtn = document.getElementById('load-vrma-btn');
const vrmaFileInput = document.getElementById('vrma-file-input');
const vrmaPresetSelect = document.getElementById('vrma-preset-select');
const stopVRMABtn = document.getElementById('stop-vrma-btn');
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
const bgPickerBtn = document.getElementById('bg-picker-btn');
const bgPickerPanel = document.getElementById('bg-picker-panel');

// ---- 背景ピッカー ----
const viewerPanel = document.getElementById('viewer-panel');
const BG_PRESETS = ['dark', 'sky', 'sunset', 'night', 'aurora', 'forest', 'sakura', 'transparent'];

function applyBg(bg) {
  BG_PRESETS.forEach(b => viewerPanel.classList.remove(`bg-${b}`));
  document.documentElement.classList.remove('transparent-mode');
  if (bg === 'transparent') {
    document.documentElement.classList.add('transparent-mode');
  } else if (bg !== 'dark') {
    viewerPanel.classList.add(`bg-${bg}`);
  }
  document.querySelectorAll('.bg-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bg === bg);
  });
  bgPickerBtn.classList.toggle('active', bg !== 'dark');
  localStorage.setItem('bg_preset', bg);
}

bgPickerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  bgPickerPanel.classList.toggle('hidden');
});

document.querySelectorAll('.bg-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyBg(btn.dataset.bg);
    bgPickerPanel.classList.add('hidden');
  });
});

document.addEventListener('click', () => bgPickerPanel.classList.add('hidden'));
bgPickerPanel.addEventListener('click', e => e.stopPropagation());

// 保存済み背景を復元
applyBg(localStorage.getItem('bg_preset') ?? 'dark');

// ---- クロマキー (OBS緑背景) トグル ----
const chromaKeyBtn = document.getElementById('chroma-key-btn');
chromaKeyBtn.addEventListener('click', () => {
  const isChroma = document.documentElement.classList.toggle('chroma-key-mode');
  chromaKeyBtn.classList.toggle('active', isChroma);
  chromaKeyBtn.title = isChroma ? '緑背景を解除' : 'OBSクロマキー用グリーンバック';
});

// ---- VRM 読み込み ----
loadVrmBtn.addEventListener('click', () => vrmFileInput.click());

async function loadBuiltinVRM() {
  setStatus('モデルを読み込み中...');
  loadVrmBtn.disabled = true;
  try {
    await viewer.loadVRM(import.meta.env.BASE_URL + 'vrm/Lilym.vrm', (pct) => setStatus(`読み込み中... ${pct}%`));
    setStatus('デフォルトモーション適用中...');
    await viewer.loadVRMA(import.meta.env.BASE_URL + 'vrma/VRMA_03.vrma', { loop: true, isIdle: true });
    stopVRMABtn.classList.remove('hidden');
    vrmaPresetSelect.value = '';
    setStatus('準備完了');
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
  setStatus('VRMを読み込み中...');
  loadVrmBtn.disabled = true;
  try {
    await viewer.loadVRM(file, (pct) => setStatus(`読み込み中... ${pct}%`));
    setStatus('準備完了');
  } catch (err) {
    setStatus(`読み込みエラー: ${err.message}`);
    console.error(err);
    loadVrmBtn.disabled = false;
    vrmFileInput.value = '';
    return;
  }
  // デフォルトモーション (失敗してもVRM読み込み自体は成功扱い)
  try {
    setStatus('デフォルトモーション適用中...');
    const vrmaUrl = import.meta.env.BASE_URL + 'vrma/VRMA_03.vrma';
    await viewer.loadVRMA(vrmaUrl, { loop: true });
    stopVRMABtn.classList.remove('hidden');
    vrmaPresetSelect.value = 'vrma/VRMA_03.vrma';
    setStatus('準備完了');
  } catch (vrmaErr) {
    console.warn('デフォルトモーション読み込み失敗:', vrmaErr.message);
    setStatus('準備完了');
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
    stopVRMABtn.classList.remove('hidden');
  } catch (err) {
    setStatus(`VRMAエラー: ${err.message}`);
    console.error(err);
  } finally {
    loadVRMABtn.disabled = false;
    vrmaFileInput.value = '';
  }
});

stopVRMABtn.addEventListener('click', () => {
  viewer.stopVRMA();
  stopVRMABtn.classList.add('hidden');
  vrmaPresetSelect.value = '';
  setStatus('準備完了');
});

// ---- VRMAプリセット選択 ----
vrmaPresetSelect.addEventListener('change', async () => {
  const path = vrmaPresetSelect.value;
  if (!path) return;
  setStatus('モーション読み込み中...');
  try {
    await viewer.loadVRMA(import.meta.env.BASE_URL + path);
    setStatus('アニメーション再生中');
    stopVRMABtn.classList.remove('hidden');
  } catch (err) {
    setStatus(`VRMAエラー: ${err.message}`);
    vrmaPresetSelect.value = '';
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

  chatInput.value = '';
  autoResizeTextarea();

  appendMessage('user', text);

  const assistantEl = appendMessage('assistant', '');
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
    setStatus('準備完了');
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
      setStatus('準備完了');
      return;
    }
    textNode.textContent = spokenText;

    // LLM完了 → パイプラインの残りを流して全再生完了まで待つ
    await pipeline.done({ lang: llm.ttsLang });

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
    chatInput.focus();
  }
}

sendBtn.addEventListener('click', () => sendMessage(chatInput.value));

// ---- ジェスチャーボタン ----
document.querySelectorAll('.gesture-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    viewer.playGesture(btn.dataset.gesture);
  });
});

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

micBtn.addEventListener('click', () => {
  if (speech.isListening) {
    speech.stopListening();
    micBtn.classList.remove('active');
    setStatus('準備完了');
    return;
  }

  speech.setLang(llm.ttsLang);
  speech.startListening();
  micBtn.classList.add('active');
  setStatus('聞いています...');

  speech.onTranscript = (text) => {
    micBtn.classList.remove('active');
    sendMessage(text);
  };
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
    document.getElementById('setting-aivis-url').value =
      localStorage.getItem('aivis_url') || 'http://localhost:10101';
    document.getElementById('setting-aivis-speaker').value =
      localStorage.getItem('aivis_speaker_id') || '888753760';
    document.getElementById('setting-cloud-api-key').value =
      localStorage.getItem('aivis_cloud_api_key') || '';
    document.getElementById('setting-cloud-model-uuid').value =
      localStorage.getItem('aivis_cloud_model_uuid') || '';
    const ttsMode = speech._useCloud ? '✅ Cloud API 使用中' :
                   speech._useAivis ? '✅ ローカル AivisSpeech 使用中' : '❌ ブラウザTTS使用中';
    document.getElementById('aivis-status').textContent = ttsMode;
  }
});

saveSettingsBtn.addEventListener('click', () => {
  llm.endpoint = document.getElementById('setting-endpoint').value.trim();
  llm.apiKey = document.getElementById('setting-api-key').value.trim();
  llm.model = document.getElementById('setting-model').value.trim();
  llm.systemPrompt = document.getElementById('setting-system-prompt').value.trim();
  llm.ttsLang = document.getElementById('setting-tts-lang').value;
  llm.save();

  const aivisUrl = document.getElementById('setting-aivis-url').value.trim();
  const aivisSpeaker = document.getElementById('setting-aivis-speaker').value.trim();
  localStorage.setItem('aivis_url', aivisUrl);
  localStorage.setItem('aivis_speaker_id', aivisSpeaker);
  speech.updateAivisSettings(aivisUrl, aivisSpeaker);

  const cloudApiKey    = document.getElementById('setting-cloud-api-key').value.trim();
  const cloudModelUuid = document.getElementById('setting-cloud-model-uuid').value.trim();
  localStorage.setItem('aivis_cloud_api_key', cloudApiKey);
  localStorage.setItem('aivis_cloud_model_uuid', cloudModelUuid);
  speech.updateCloudSettings(cloudApiKey, cloudModelUuid);

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
  setStatus('会話履歴をクリアしました');
  settingsPanel.classList.add('hidden');
});

// ---- ウィンドウリサイズ ----
window.addEventListener('resize', () => viewer.resize());

// ---- ユーティリティ ----
function appendMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  wrap.innerHTML = `
    <div class="message-avatar">${role === 'user' ? '👤' : '🤖'}</div>
    <div class="message-bubble">
      <div class="message-text">${escapeHtml(text)}</div>
    </div>
  `;
  chatMessages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
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
