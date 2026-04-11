/**
 * Web Speech API ラッパー
 * - STT (音声認識): SpeechRecognition
 * - TTS: Aivis Cloud API (最優先) / ローカル AivisSpeech / ブラウザ SpeechSynthesis (フォールバック)
 */
import { AivisSpeechClient, AivisCloudClient } from './aivis-speech.js';

export class SpeechManager {
  constructor() {
    this.isListening = false;
    this.isSpeaking = false;

    /** @type {function(string):void} */
    this.onTranscript = null;
    /** @type {function():void} */
    this.onSpeechStart = null;
    /** @type {function():void} */
    this.onSpeechEnd = null;

    // Aivis Cloud API クライアント（最優先）
    // localStorageに設定済みなら優先、なければ環境変数（ビルド時埋め込み）を使用
    const cloudApiKey    = localStorage.getItem('aivis_cloud_api_key')
                        || import.meta.env.VITE_AIVIS_CLOUD_API_KEY
                        || '';
    const cloudModelUuid = localStorage.getItem('aivis_cloud_model_uuid')
                        || import.meta.env.VITE_AIVIS_CLOUD_MODEL_UUID
                        || '';
    this._cloud = new AivisCloudClient(cloudApiKey, cloudModelUuid);
    this._useCloud = this._cloud.isAvailable();
    if (this._useCloud) console.log('[TTS] Aivis Cloud API を使用します');

    // ローカル AivisSpeech クライアント
    this._aivis = new AivisSpeechClient(
      localStorage.getItem('aivis_url') || 'http://localhost:10101',
      Number(localStorage.getItem('aivis_speaker_id') || 888753760)
    );
    this._useAivis = false; // isAvailable() で確認後に true になる
    if (!this._useCloud) this._checkAivis();

    this._recognition = null;
    this._initRecognition();
  }


  get sttSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
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

  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    this._recognition = new SR();
    this._recognition.lang = 'ja-JP';
    this._recognition.continuous = false;
    this._recognition.interimResults = false;

    this._recognition.onresult = (e) => {
      const text = e.results[0][0].transcript;
      this.isListening = false;
      this.onTranscript?.(text);
    };

    this._recognition.onend = () => {
      this.isListening = false;
    };

    this._recognition.onerror = (e) => {
      console.error('STT エラー:', e.error);
      this.isListening = false;
    };
  }

  setLang(lang) {
    if (this._recognition) this._recognition.lang = lang;
  }

  startListening() {
    if (!this._recognition || this.isListening) return;
    this._recognition.start();
    this.isListening = true;
  }

  stopListening() {
    if (!this._recognition || !this.isListening) return;
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
