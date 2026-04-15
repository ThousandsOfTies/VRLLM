/**
 * Web Speech API ラッパー
 * - STT (音声認識): 環境音レベルに応じて Web Speech API / Gemini Audio を自動切替
 * - TTS: Aivis Cloud API (最優先) / ローカル AivisSpeech / ブラウザ SpeechSynthesis (フォールバック)
 */
import { AivisSpeechClient, AivisCloudClient } from './aivis-speech.js';

export class SpeechManager {
  // ---- ノイズ判定定数 ----
  static NOISE_THRESHOLD    = 0.015; // RMS閾値: これを超えると騒音モード
  static NOISE_HYSTERESIS   = 0.008; // 静音復帰閾値（チャタリング防止）
  static NOISE_HISTORY_SIZE = 6;     // ローリング平均サンプル数（500ms × 6 = 3秒）

  constructor(llmClient = null) {
    this._llm = llmClient; // Gemini STT 用（endpoint / apiKey / model 参照）

    this.isListening = false;
    this.isSpeaking = false;

    /** @type {function(string):void} */
    this.onTranscript = null;
    /** @type {function():void} */
    this.onListeningEnd = null;
    /** @type {function():void} */
    this.onSpeechStart = null;
    /** @type {function():void} */
    this.onSpeechEnd = null;

    // Aivis Cloud API クライアント（最優先）
    // 設定画面または Google Drive 同期から applySettings() で設定される
    this._cloud = new AivisCloudClient('', '');
    this._useCloud = this._cloud.isAvailable();
    if (this._useCloud) console.log('[TTS] Aivis Cloud API を使用します');

    // ローカル AivisSpeech クライアント
    this._aivis = new AivisSpeechClient('http://localhost:10101', 888753760);
    this._useAivis = false; // isAvailable() で確認後に true になる
    if (!this._useCloud) this._checkAivis();

    this._recognition = null;
    this._initRecognition();

    // ---- ノイズモニタリング ----
    this._noiseStream   = null;
    this._noiseAudioCtx = null;
    this._noiseAnalyser = null;
    this._noiseHistory  = [];
    this._noiseTimer    = null;
    this.isNoisy        = false;
    /** @type {function(boolean):void} */
    this.onNoiseModeChange = null;

    // ---- Gemini STT 録音 ----
    this._mediaRecorder = null;
    this._audioChunks   = [];
    this._mimeType      = '';
  }

  get sttSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
        || !!(navigator.mediaDevices && window.MediaRecorder);
  }

  /** AivisSpeech の疎通確認（非同期・バックグラウンド） */
  async _checkAivis() {
    this._useAivis = await this._aivis.isAvailable();
    if (this._useAivis) console.log('[TTS] ローカル AivisSpeech を使用します');
    else console.log('[TTS] ブラウザ SpeechSynthesis を使用します');
  }

  /**
   * Cloud API 設定を更新する
   * @param {string} apiKey
   * @param {string} modelUuid
   */
  updateCloudSettings(apiKey, modelUuid) {
    this._cloud.apiKey    = apiKey;
    this._cloud.modelUuid = modelUuid;
    this._useCloud = this._cloud.isAvailable();
    if (this._useCloud) {
      console.log('[TTS] Aivis Cloud API に切り替えました');
    } else if (!this._useAivis) {
      this._checkAivis();
    }
  }

  /**
   * AivisSpeech 接続設定を更新して再チェックする
   * @param {string} url
   * @param {number} speakerId
   */
  updateAivisSettings(url, speakerId) {
    this._aivis.baseUrl = url.replace(/\/$/, '');
    this._aivis.speakerId = Number(speakerId);
    this._checkAivis();
  }

  /** 設定を一括適用する */
  applySettings(s) {
    if (s.aivis_url || s.aivis_speaker_id) {
      this.updateAivisSettings(
        s.aivis_url        || this._aivis.baseUrl,
        s.aivis_speaker_id || this._aivis.speakerId
      );
    }
    if (s.aivis_cloud_api_key || s.aivis_cloud_model_uuid) {
      this.updateCloudSettings(
        s.aivis_cloud_api_key    || this._cloud.apiKey,
        s.aivis_cloud_model_uuid || this._cloud.modelUuid
      );
    }
  }

  /** 現在の設定をオブジェクトとして返す */
  getSettings() {
    return {
      aivis_url:              this._aivis.baseUrl,
      aivis_speaker_id:       String(this._aivis.speakerId),
      aivis_cloud_api_key:    this._cloud.apiKey,
      aivis_cloud_model_uuid: this._cloud.modelUuid,
    };
  }

  // ---- Web Speech API 初期化 ----

  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    this._recognition = new SR();
    this._recognition.lang = 'ja-JP';
    this._recognition.continuous = false;
    this._recognition.interimResults = false;

    this._recognition.onresult = (e) => {
      clearTimeout(this._recognitionTimer);
      const text = e.results[0][0].transcript;
      this.isListening = false;
      this.onTranscript?.(text);
    };

    this._recognition.onend = () => {
      clearTimeout(this._recognitionTimer);
      this.isListening = false;
      this.onListeningEnd?.();
    };

    this._recognition.onerror = (e) => {
      clearTimeout(this._recognitionTimer);
      console.error('STT エラー:', e.error);
      this.isListening = false;
    };
  }

  setLang(lang) {
    if (this._recognition) this._recognition.lang = lang;
  }

  // ---- ノイズモニタリング ----

  /** 環境音レベルの常時計測を開始する（最初のユーザー操作後に呼ぶ） */
  async startNoiseMonitoring() {
    if (this._noiseStream) return; // 既に起動済み
    try {
      this._noiseStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this._noiseAudioCtx = new AudioContext();
      this._noiseAnalyser = this._noiseAudioCtx.createAnalyser();
      this._noiseAnalyser.fftSize = 2048;
      this._noiseAudioCtx.createMediaStreamSource(this._noiseStream)
        .connect(this._noiseAnalyser);
      this._noiseHistory = [];
      this._noiseTimer = setInterval(() => this._measureNoise(), 500);
    } catch (e) {
      console.warn('[NoiseMonitor] getUserMedia 失敗:', e.message);
    }
  }

  /** ノイズモニタリングを停止してリソースを解放する */
  stopNoiseMonitoring() {
    clearInterval(this._noiseTimer);
    this._noiseTimer = null;
    this._noiseStream?.getTracks().forEach(t => t.stop());
    this._noiseStream = null;
    this._noiseAudioCtx?.close();
    this._noiseAudioCtx = null;
    this._noiseAnalyser = null;
    this._noiseHistory  = [];
  }

  /** 500ms ごとに呼ばれてノイズレベルを計測・isNoisy を更新する */
  _measureNoise() {
    if (!this._noiseAnalyser) return;
    const buf = new Uint8Array(this._noiseAnalyser.fftSize);
    this._noiseAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const n = (v - 128) / 128; sum += n * n; }
    const rms = Math.sqrt(sum / buf.length);

    this._noiseHistory.push(rms);
    if (this._noiseHistory.length > SpeechManager.NOISE_HISTORY_SIZE)
      this._noiseHistory.shift();

    const avg = this._noiseHistory.reduce((a, b) => a + b, 0) / this._noiseHistory.length;
    // ヒステリシス: 騒音→静音は低い閾値を使ってチャタリングを防ぐ
    const threshold = this.isNoisy
      ? SpeechManager.NOISE_HYSTERESIS
      : SpeechManager.NOISE_THRESHOLD;

    const nowNoisy = avg > threshold;
    if (nowNoisy !== this.isNoisy) {
      this.isNoisy = nowNoisy;
      this.onNoiseModeChange?.(this.isNoisy);
    }
  }

  // ---- Gemini Audio STT ----

  async _startGemini() {
    if (this._mediaRecorder) return;
    this._mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : 'audio/webm';
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
    } catch (e) {
      console.error('[Gemini STT] getUserMedia 失敗:', e.message);
      this.isListening = false;
      this.onListeningEnd?.();
      return;
    }
    this._audioChunks = [];
    this._mediaRecorder = new MediaRecorder(stream, { mimeType: this._mimeType });
    this._mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this._audioChunks.push(e.data); };
    this._mediaRecorder.onstop = () => { stream.getTracks().forEach(t => t.stop()); this._transcribeGemini(); };
    this._mediaRecorder.start();
    this.isListening = true;
    clearTimeout(this._recognitionTimer);
    this._recognitionTimer = setTimeout(() => {
      if (this.isListening) {
        console.warn('[Gemini STT] タイムアウトにより強制停止');
        this.stopListening();
      }
    }, 15000);
  }

  _stopGemini() {
    clearTimeout(this._recognitionTimer);
    if (!this._mediaRecorder) return;
    this._mediaRecorder.stop();
    this._mediaRecorder = null;
    this.isListening = false;
  }

  async _transcribeGemini() {
    const ext  = this._mimeType.includes('ogg') ? 'ogg' : 'webm';
    const blob = new Blob(this._audioChunks, { type: this._mimeType });
    this._audioChunks = [];
    // base64 変換
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    const model  = this._llm?.model  || 'gemini-2.0-flash';
    const apiKey = this._llm?.apiKey || '';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{ parts: [
        { inline_data: { mime_type: this._mimeType.split(';')[0], data: base64 } },
        { text: '以下の音声を正確に書き起こしてください。書き起こしたテキストのみを出力してください。' },
      ]}],
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Gemini STT ${res.status}`);
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) this.onTranscript?.(text);
      else this.onListeningEnd?.();
    } catch (e) {
      console.error('[Gemini STT] 転写エラー:', e.message);
      this.onListeningEnd?.();
    }
  }

  // ---- STT 制御（環境音で自動切替） ----

  async startListening() {
    if (this.isListening) return;
    if (this.isNoisy) {
      await this._startGemini();
      return;
    }
    // Web Speech API パス
    if (!this._recognition) return;
    this._recognition.start();
    this.isListening = true;
    clearTimeout(this._recognitionTimer);
    this._recognitionTimer = setTimeout(() => {
      if (this.isListening) {
        console.warn('[STT] 無音タイムアウトにより強制終了');
        this.stopListening();
      }
    }, 15000);
  }

  stopListening() {
    if (!this.isListening) return;
    if (this._mediaRecorder) { this._stopGemini(); return; }
    // Web Speech API パス
    clearTimeout(this._recognitionTimer);
    this._recognition.stop();
    this.isListening = false;
  }

  /**
   * テキストを読み上げる（Cloud API > AivisSpeech > ブラウザTTS の優先順位）
   * @param {string} text
   * @param {{ lang?: string, rate?: number, pitch?: number }} options
   * @returns {Promise<void>}
   */
  async speak(text, options = {}) {
    this.isSpeaking = true;

    // --- Aivis Cloud API (最優先) ---
    if (this._useCloud) {
      try {
        await this._cloud.speak(text, {
          onStart: () => this.onSpeechStart?.(),
          onEnd: () => {
            this.isSpeaking = false;
            this.onSpeechEnd?.();
          },
        });
        return;
      } catch (err) {
        console.warn('[Aivis Cloud] 読み上げ失敗:', err.message);
        // Cloud API エラーの場合はフォールバックしない（クレジット切れ等を通知するため）
        this.isSpeaking = false;
        this.onSpeechEnd?.();
        throw err;
      }
    }

    // --- ローカル AivisSpeech ---
    if (this._useAivis) {
      try {
        await this._aivis.speak(text, {
          onStart: () => this.onSpeechStart?.(),
          onEnd: () => {
            this.isSpeaking = false;
            this.onSpeechEnd?.();
          },
        });
        return;
      } catch (err) {
        console.warn('[AivisSpeech] 読み上げ失敗、ブラウザTTSにフォールバック:', err);
        this._useAivis = false;
      }
    }

    // --- ブラウザ SpeechSynthesis フォールバック ---
    return new Promise((resolve, reject) => {
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = options.lang || 'ja-JP';
      utterance.rate = options.rate ?? 1.0;
      utterance.pitch = options.pitch ?? 1.05;
      utterance.volume = options.volume ?? 1.0;

      const trySpeak = () => {
        const voices = window.speechSynthesis.getVoices();
        const match = voices.find((v) => v.lang.startsWith(utterance.lang.slice(0, 2)));
        if (match) utterance.voice = match;

        let fallbackTimer = null;

        utterance.onstart = () => {
          this.isSpeaking = true;
          this.onSpeechStart?.();

          // iOS Safari の onend 発火漏れバグ回避策 (speakingフラグもバグる事があるため時間経過で強制終了)
          const guessedDuration = Math.max(3000, utterance.text.length * 350 + 1000);
          clearTimeout(fallbackTimer);
          fallbackTimer = setTimeout(() => {
            if (this.isSpeaking) {
              console.warn('[TTS] onend fired by fallback timer (timeout)');
              this.isSpeaking = false;
              this.onSpeechEnd?.();
              resolve();
            }
          }, guessedDuration);
        };
        utterance.onend = () => {
          clearTimeout(fallbackTimer);
          if (this.isSpeaking) {
            this.isSpeaking = false;
            this.onSpeechEnd?.();
            resolve();
          }
        };
        utterance.onerror = (e) => {
          clearTimeout(fallbackTimer);
          this.isSpeaking = false;
          this.onSpeechEnd?.();
          if (e.error !== 'interrupted') reject(e);
          else resolve();
        };
        window.speechSynthesis.speak(utterance);
      };

      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        trySpeak();
      } else {
        window.speechSynthesis.onvoiceschanged = () => {
          window.speechSynthesis.onvoiceschanged = null;
          trySpeak();
        };
      }
    });
  }

  /**
   * ブラウザのユーザーゲスチャー（クリック等）の瞬間にAudioContextを生成/再開し、
   * iOS Safari 等での再生ブロック（無音状態のまま onended が来ないバグ）を回避する
   */
  async unlockAudio() {
    if (this._useCloud) await this._cloud._getAudioCtx();
    else if (this._useAivis) await this._aivis._getAudioCtx();
  }

  stopSpeaking() {
    this._aivis.stop();
    window.speechSynthesis.cancel();
    this.isSpeaking = false;
  }
}
