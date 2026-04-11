/**
 * TTSパイプライン
 *
 * LLMのストリームチャンクを受け取り、句読点で文を切り出して
 * AivisSpeechへの合成リクエストを並列投げしながら順番に再生する。
 *
 * フロー:
 *   LLMチャンク → 文分割 → [合成A] [合成B] [合成C] ...
 *                                ↓ 合成完了順に再生キューへ
 *                            再生A → 再生B → 再生C (直列再生)
 *                                 ↑
 *                         Aを再生している間にBを合成
 *
 * AivisSpeechが使えない場合はブラウザTTSにフォールバック。
 */
export class TTSPipeline {
  /** @param {import('./speech.js').SpeechManager} speechManager */
  constructor(speechManager) {
    this._speech = speechManager;

    // テキストバッファ（LLMチャンク蓄積）
    this._textBuf   = '';
    // フォールバック用の全文テキスト
    this._fullText  = '';
    // 合成Promiseのキュー
    this._queue     = [];
    // 再生ループ実行中フラグ
    this._loopRunning  = false;
    // done() が呼ばれたフラグ
    this._finished  = false;
    // フライト中の合成リクエスト数
    this._inFlight  = 0;
    // 停止済みフラグ
    this._stopped   = false;
    // 再生中の AudioBufferSourceNode
    this._currentSrc = null;
    // 最初の一言を再生開始したか
    this._started   = false;

    // 外部コールバック
    this.onSpeechStart = null;
    this.onSpeechEnd   = null;

    // done() が await できるよう Promise を作成
    let resolve;
    this._donePromise = new Promise(r => { resolve = r; });
    this._doneResolve = resolve;
  }

  // ---- 公開 API ----

  /**
   * LLMストリームのチャンクを受け取る
   * @param {string} chunk
   */
  push(chunk) {
    if (this._stopped) return;
    this._fullText += chunk;
    if (this._speech._useAivis || this._speech._useCloud) {
      this._textBuf += chunk;
      this._extractSentences(false);
    }
  }

  /**
   * LLM生成完了を通知し、全ての再生完了まで待機する
   * @param {{ lang?: string }} ttsOptions
   * @returns {Promise<void>}
   */
  async done(ttsOptions = {}) {
    if (this._stopped) return;

    if (this._speech._useAivis || this._speech._useCloud) {
      // 残りのバッファを強制フラッシュ
      this._extractSentences(true);
      this._finished = true;
      this._checkDone();
      await this._donePromise;
    } else {
      // ブラウザTTS: 全文をまとめて読み上げ
      const text = this._fullText.trim();
      if (!text) return;
      this._speech.onSpeechStart = () => this.onSpeechStart?.();
      this._speech.onSpeechEnd   = () => this.onSpeechEnd?.();
      await this._speech.speak(text, ttsOptions);
    }
  }

  /** 再生を中断する */
  stop() {
    this._stopped = true;
    if (this._currentSrc) {
      try { this._currentSrc.stop(); } catch { /* 停止済み */ }
      this._currentSrc = null;
    }
    this._queue   = [];
    this._inFlight = 0;
    this._speech._aivis?.stop();
    this._speech.stopSpeaking();
    this._doneResolve?.();
  }

  // ---- プライベート: 文分割 & 合成 ----

  /**
   * バッファから句読点区切りの文を取り出して合成キューに積む
   * @param {boolean} force 残り全てを強制的に処理する
   */
  _extractSentences(force) {
    // 日本語句読点・改行・英語文末を区切りとする
    const re = /[。！？\n]|[.!?](?=\s|$)/g;
    let lastEnd = 0;
    let match;

    while ((match = re.exec(this._textBuf)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this._textBuf.slice(lastEnd, end).trim();
      lastEnd = end;
      if (sentence) this._enqueueSynth(sentence);
    }
    this._textBuf = this._textBuf.slice(lastEnd);

    if (force && this._textBuf.trim()) {
      this._enqueueSynth(this._textBuf.trim());
      this._textBuf = '';
    }
  }

  /** 文をAivisSpeechまたはCloud APIで合成してキューに積み、再生ループを起動する */
  _enqueueSynth(text) {
    this._inFlight++;

    const client = this._speech._useCloud ? this._speech._cloud : this._speech._aivis;

    // 合成は即座に開始（再生を待たない）
    const audioPromise = client.synthesize(text)
      .then(buf  => { this._inFlight--; return buf; })
      .catch(err => { this._inFlight--; throw err; });

    this._queue.push(audioPromise);
    this._kickLoop();
  }

  // ---- プライベート: 再生ループ ----

  _kickLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    this._runLoop();
  }

  async _runLoop() {
    while (this._queue.length > 0) {
      const audioPromise = this._queue.shift();
      try {
        const audioBuffer = await audioPromise;
        if (this._stopped) break;

        if (!this._started) {
          this._started = true;
          this.onSpeechStart?.();
        }
        await this._playBuffer(audioBuffer);
      } catch (err) {
        console.warn('[TTSPipeline] 合成/再生エラー:', err.message);
      }
    }
    this._loopRunning = false;
    this._checkDone();
  }

  /** 全て完了したか確認し、完了していれば Promise を解決する */
  _checkDone() {
    if (
      this._finished     &&
      this._queue.length === 0 &&
      !this._loopRunning &&
      this._inFlight     === 0
    ) {
      this.onSpeechEnd?.();
      this._doneResolve?.();
      this._doneResolve = null; // 二重呼び出し防止
    }
  }

  /** AudioBuffer を再生し、終了まで待機する */
  async _playBuffer(audioBuffer) {
    const client = this._speech._useCloud ? this._speech._cloud : this._speech._aivis;
    const audioCtx = await client._getAudioCtx();
    return new Promise(resolve => {
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(client._gainNode);
      this._currentSrc = src;

      let isDone = false;
      const finish = () => {
        if (isDone) return;
        isDone = true;
        this._currentSrc = null;
        resolve();
      };

      src.onended = finish;
      src.start(0);

      // セーフティネット: iOS Safariで再生がサスペンドされ onended が来ない事態を確実に回避する
      const durationMs = audioBuffer.duration * 1000;
      setTimeout(finish, durationMs + 800);
    });
  }
}
