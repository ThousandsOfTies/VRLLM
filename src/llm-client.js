// 感情タグ指示をシステムプロンプトに自動追加する
// ※小型モデル (llama3.2 等) が本文を省略しないよう「タグの後に本文を続ける」ことを明示
const EMOTION_INSTRUCTION = `

【出力フォーマット】
返答の先頭に感情タグを付け、その直後に通常の返答を続けてください。感情タグだけで終わらないこと。
形式: [EMO:感情名]返答本文
感情名は happy / sad / angry / surprised / relaxed / neutral のいずれか。
例: [EMO:happy]はい、その通りです！ほかにご質問はありますか？
例: [EMO:sad]それは残念でしたね。何かお力になれることはありますか？
感情タグは先頭の1回だけ。返答本文の中には入れないでください。`;

const DEFAULTS = {
  endpoint: import.meta.env.VITE_LLM_ENDPOINT || 'https://api.openai.com/v1',
  apiKey:   import.meta.env.VITE_LLM_API_KEY   || '',
  model:    import.meta.env.VITE_LLM_MODEL      || 'gpt-4o-mini',
  systemPrompt: `あなたは私の親しい友達です。タメ口で、フレンドリーにおしゃべりしてください。
AIアシスタントのような「何かお手伝いしましょうか？」といった堅苦しい発言やサポート役としての態度は禁止です。
基本的には長文になりすぎないよう、簡潔な日本語で会話を弾ませてください。`,
  ttsLang: 'ja-JP',
};

export class LLMClient {
  constructor() {
    this.endpoint     = localStorage.getItem('llm_endpoint')      || DEFAULTS.endpoint;
    this.apiKey       = localStorage.getItem('llm_api_key')       || DEFAULTS.apiKey;
    this.model        = localStorage.getItem('llm_model')         || DEFAULTS.model;
    this.systemPrompt = localStorage.getItem('llm_system_prompt') || DEFAULTS.systemPrompt;
    this.ttsLang      = localStorage.getItem('llm_tts_lang')      || DEFAULTS.ttsLang;
    this.history = [];

    /** 感情検出時に呼ばれるコールバック @type {function(string):void} */
    this.onEmotionDetected = null;
  }

  save() {
    localStorage.setItem('llm_endpoint', this.endpoint);
    localStorage.setItem('llm_api_key', this.apiKey);
    localStorage.setItem('llm_model', this.model);
    localStorage.setItem('llm_system_prompt', this.systemPrompt);
    localStorage.setItem('llm_tts_lang', this.ttsLang);
  }

  clearHistory() {
    this.history = [];
  }

  /**
   * ストリームチャット。AsyncGenerator で差分テキストを yield する。
   * @param {string} userMessage
   * @yields {string} テキストの差分チャンク
   */
  async *chat(userMessage) {
    this.history.push({ role: 'user', content: userMessage });

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: this.systemPrompt + EMOTION_INSTRUCTION },
        ...this.history.slice(-20),
      ],
      stream: true,
    };

    const headers = {
      'Content-Type': 'application/json',
    };
    // APIキーが設定されている場合のみ付ける
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(`${this.endpoint.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM API エラー ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistantMessage = '';
    let sseBuffer = '';

    // 感情タグ検出用の先頭バッファ
    let emotionParsed = false;
    let prefixBuf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // 最後の不完全行を残す

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (!delta) continue;

          if (!emotionParsed) {
            prefixBuf += delta;

            // [EMO:xxx] タグを検索
            const match = prefixBuf.match(/^\[EMO:([^\]]+)\]\s*/);
            if (match) {
              // 感情を通知
              this.onEmotionDetected?.(match[1].trim().toLowerCase());
              emotionParsed = true;
              // タグを除いた残りを出力
              const rest = prefixBuf.slice(match[0].length);
              if (rest) {
                assistantMessage += rest;
                yield rest;
              }
            } else if (prefixBuf.length > 40 || prefixBuf.includes('\n')) {
              // タグがないまま一定量溜まったらそのまま出力
              emotionParsed = true;
              assistantMessage += prefixBuf;
              yield prefixBuf;
            }
          } else {
            assistantMessage += delta;
            yield delta;
          }
        } catch {
          // JSON パース失敗は無視
        }
      }
    }

    this.history.push({ role: 'assistant', content: assistantMessage });
  }
}
