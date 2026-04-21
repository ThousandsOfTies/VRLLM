import { setStatus } from './uiUtils.js';
import { setOnPipelineEnd } from './chatManager.js';

let _speech, _llm, _micBtn, _sendMessage;
let autoListenMode    = false;
let _longPressTimer   = null;
let _longPressTriggered = false;

export function initVoiceManager({ speech, llm, micBtn, sendMessage }) {
  _speech      = speech;
  _llm         = llm;
  _micBtn      = micBtn;
  _sendMessage = sendMessage;

  if (!speech.sttSupported) {
    micBtn.disabled = true;
    micBtn.title    = 'このブラウザは音声認識に非対応です';
  }

  // 会話モード: TTS終了後に自動でマイクON
  setOnPipelineEnd(() => {
    if (autoListenMode && !_speech.isListening) {
      startListeningOnce();
    }
  });

  speech.onNoiseModeChange = (isNoisy) => {
    micBtn.classList.toggle('noisy-mode', isNoisy);
    micBtn.textContent = isNoisy ? '✦' : '🎤';
    micBtn.title = isNoisy
      ? 'Gemini 音声認識（騒音モード自動切替中）'
      : '音声入力 (クリックで開始/停止)';
  };

  _registerListeners();
}

export async function startListeningOnce() {
  _speech.setLang(_llm.ttsLang);
  await _speech.startListening();
  _micBtn.classList.add('active');
  setStatus(_speech.isNoisy ? '✦ 高精度認識中...' : '🎤 聞いています...');

  const chatInput = document.getElementById('chat-input');
  chatInput.classList.add('recording');

  _speech.onInterimTranscript = (text) => {
    chatInput.value = text;
    chatInput.dispatchEvent(new Event('input'));
  };

  _speech.onTranscript = (text) => {
    _micBtn.classList.remove('active');
    if (autoListenMode) {
      chatInput.classList.remove('recording');
      _sendMessage(text);
    } else {
      chatInput.value = text;
      chatInput.dispatchEvent(new Event('input'));
      chatInput.focus();
      setStatus('');
      // .recording を維持してユーザーが全文を確認できる状態に
    }
  };

  _speech.onListeningEnd = () => {
    _micBtn.classList.remove('active');
    chatInput.classList.remove('recording');
    if (autoListenMode && !chatInput.disabled) {
      startListeningOnce();
    } else if (!autoListenMode) {
      setStatus('');
    }
  };
}

async function _enterAutoListen() {
  autoListenMode = true;
  _micBtn.classList.add('auto-listen');
  _micBtn.title = '会話モード中 (長押しで終了)';
  setStatus('会話モード ON');
  const chatInput = document.getElementById('chat-input');
  if (!_speech.isListening && !chatInput.disabled) {
    await startListeningOnce();
  }
}

function _exitAutoListen() {
  autoListenMode = false;
  _micBtn.classList.remove('auto-listen');
  _micBtn.title = _speech.isNoisy
    ? 'Gemini 音声認識（騒音モード自動切替中）'
    : '音声入力 (クリックで開始/停止)';
  if (_speech.isListening) {
    _speech.stopListening();
    _micBtn.classList.remove('active');
  }
  setStatus('');
}

function _registerListeners() {
  _micBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  // iOS Safari の絵文字長押し（文字情報・コールアウト）を抑制し pointercancel を防ぐ
  _micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); }, { passive: false });

  _micBtn.addEventListener('pointerdown', () => {
    if (_micBtn.disabled) return;
    _speech.startNoiseMonitoring();
    _longPressTriggered = false;
    _longPressTimer = setTimeout(() => {
      _longPressTimer     = null;
      _longPressTriggered = true;
      if (autoListenMode) _exitAutoListen();
      else _enterAutoListen();
    }, 600);
  });

  _micBtn.addEventListener('pointerup', () => {
    if (_longPressTimer !== null) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    if (_longPressTriggered) return;
    if (autoListenMode) { _exitAutoListen(); return; }
    if (_speech.isListening) {
      _speech.stopListening();
      _micBtn.classList.remove('active');
      setStatus('');
      return;
    }
    startListeningOnce().catch(console.error);
  });

  _micBtn.addEventListener('pointerleave', () => {
    if (_longPressTimer !== null) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  });

  _micBtn.addEventListener('pointercancel', () => {
    if (_longPressTimer !== null) { clearTimeout(_longPressTimer); _longPressTimer = null; }
  });
}
