/**
 * AivisSpeech エンジン クライアント (ローカル)
 * VOICEVOX 互換 REST API を使って高品質 TTS を実現する
 *
 * AivisSpeech はホスト PC で起動しておく必要がある
 * デフォルト: http://localhost:10101
 */

// モジュール共通: デバイスボリューム監視
// iOS Safari では <video> 要素の volumechange イベントがハードウェアボリューム変更時に発火する
const _gainNodes = new Set();

function _syncDeviceVolume() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('[data-vrllm-vol]')) return; // 二重初期化防止

  const el = document.createElement('video');
  el.dataset.vrllmVol = '1';
  el.setAttribute('playsinline', 'true');
  // opacity:0 では iOS がイベントを送らない場合があるため限りなく透明に
  el.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.001;pointer-events:none;';
  document.body.appendChild(el);

  el.addEventListener('volumechange', () => {
    for (const node of _gainNodes) {
      node.gain.value = el.volume;
    }
  });
}

export class AivisSpeechClient {
  /**
   * @param {string} baseUrl  例: 'http://localhost:10101'
   * @param {number} speakerId 話者ID (デフォルト 888753760)
   */
  constructor(baseUrl = 'http://localhost:10101', speakerId = 888753760) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.speakerId = speakerId;
    this._audioCtx = null;
    this._gainNode = null;
    this._currentSource = null;
  }

  /** AudioContext を遅延初期化（ユーザー操作後でないと使えないため） */
  async _getAudioCtx() {
    if (!this._audioCtx || this._audioCtx.state === 'closed') {
      if (this._gainNode) { _gainNodes.delete(this._gainNode); this._gainNode = null; }
      this._audioCtx = new AudioContext();
      this._gainNode = this._audioCtx.createGain();
      this._gainNode.connect(this._audioCtx.destination);
      _gainNodes.add(this._gainNode);
      _syncDeviceVolume();
    }
    if (this._audioCtx.state === 'suspended') {
      this._audioCtx.resume().catch(e => console.warn('AudioContext resume ignored:', e));
    }
    return this._audioCtx;
  }

  /**
   * AivisSpeech エンジンが起動しているか確認する
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const res = await fetch(`${this.baseUrl}/version`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * テキストを音声合成して AudioBuffer を返す
   * @param {string} text
   * @returns {Promise<AudioBuffer>}
   */
  async synthesize(text) {
    // Step1: audio_query
    const queryRes = await fetch(
      `${this.baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${this.speakerId}`,
      { method: 'POST' }
    );
    if (!queryRes.ok) {
      throw new Error(`audio_query エラー: ${queryRes.status}`);
    }
    const query = await queryRes.json();

    // Step2: synthesis → WAV バイナリ
    const synthRes = await fetch(
      `${this.baseUrl}/synthesis?speaker=${this.speakerId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      }
    );
    if (!synthRes.ok) {
      throw new Error(`synthesis エラー: ${synthRes.status}`);
    }

    const arrayBuffer = await synthRes.arrayBuffer();
    const audioCtx = await this._getAudioCtx();
    return audioCtx.decodeAudioData(arrayBuffer);
  }

  /**
   * テキストを読み上げる
   * @param {string} text
   * @param {{ onStart?: function, onEnd?: function }} callbacks
   * @returns {Promise<void>}
   */
  async speak(text, { onStart, onEnd } = {}) {
    this.stop();

    const audioBuffer = await this.synthesize(text);
    const audioCtx = await this._getAudioCtx();  // ← await に変更

    return new Promise((resolve) => {
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this._gainNode);

      this._currentSource = source;

      source.onended = () => {
        this._currentSource = null;
        onEnd?.();
        resolve();
      };

      onStart?.();
      source.start(0);
    });
  }

  /** 再生を中断する */
  stop() {
    if (this._currentSource) {
      try { this._currentSource.stop(); } catch { /* 既に停止済み */ }
      this._currentSource = null;
    }
  }
}

/**
 * Aivis Cloud API クライアント
 * https://api.aivis-project.com/v1/tts/synthesize
 * APIキーとモデルUUIDを設定するだけで、スマホ・どこからでも利用できる
 */
export class AivisCloudClient {
  /**
   * @param {string} apiKey    Aivis Cloud API キー
   * @param {string} modelUuid AivisHub のモデル UUID
   */
  constructor(apiKey = '', modelUuid = '') {
    this.apiKey    = apiKey;
    this.modelUuid = modelUuid;
    this._audioCtx      = null;
    this._gainNode      = null;
    this._currentSource = null;
  }

  /** AudioContext を遅延初期化 */
  async _getAudioCtx() {
    if (!this._audioCtx || this._audioCtx.state === 'closed') {
      if (this._gainNode) { _gainNodes.delete(this._gainNode); this._gainNode = null; }
      this._audioCtx = new AudioContext();
      this._gainNode = this._audioCtx.createGain();
      this._gainNode.connect(this._audioCtx.destination);
      _gainNodes.add(this._gainNode);
      _syncDeviceVolume();
    }
    if (this._audioCtx.state === 'suspended') {
      this._audioCtx.resume().catch(e => console.warn('AudioContext resume ignored:', e));
    }
    return this._audioCtx;
  }

  /** APIキーとモデルUUIDが設定されているか */
  isAvailable() {
    return !!(this.apiKey && this.modelUuid);
  }

  /**
   * テキストを音声合成して AudioBuffer を返す
   * @param {string} text
   * @returns {Promise<AudioBuffer>}
   */
  async synthesize(text) {
    const res = await fetch('https://api.aivis-project.com/v1/tts/synthesize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_uuid: this.modelUuid,
        text,
        use_ssml: false,
        use_volume_normalizer: true,
        output_format: 'mp3',
        leading_silence_seconds: 0.0,
        trailing_silence_seconds: 0.1,
      }),
    });

    if (res.status === 401) throw new Error('Aivis Cloud API: APIキーが無効です');
    if (res.status === 402) throw new Error('Aivis Cloud API: クレジット残高不足');
    if (!res.ok) throw new Error(`Aivis Cloud API エラー: ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const audioCtx = await this._getAudioCtx();
    return audioCtx.decodeAudioData(arrayBuffer);
  }

  /**
   * テキストを読み上げる
   * @param {string} text
   * @param {{ onStart?: function, onEnd?: function }} callbacks
   */
  async speak(text, { onStart, onEnd } = {}) {
    this.stop();
    const audioBuffer = await this.synthesize(text);
    const audioCtx    = await this._getAudioCtx();

    return new Promise((resolve) => {
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this._gainNode);
      this._currentSource = source;
      source.onended = () => {
        this._currentSource = null;
        onEnd?.();
        resolve();
      };
      onStart?.();
      source.start(0);
    });
  }

  /** 再生を中断する */
  stop() {
    if (this._currentSource) {
      try { this._currentSource.stop(); } catch { /* 既に停止済み */ }
      this._currentSource = null;
    }
  }
}
