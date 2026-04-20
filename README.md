# AI-LiveTalk

**https://thousandsofties.github.io/VRLLM/**

VRM キャラクターと LLM を組み合わせたリアルタイム AI コンパニオン Web アプリです。
ブラウザだけで動作し、スマートフォンからも利用できます。

## 機能

- **VRM モデル表示** — VRoid Studio などで作成した `.vrm` ファイルを読み込んで表示
- **LLM チャット** — OpenAI 互換 API（OpenAI / Gemini / Ollama など）でキャラクターと会話
- **感情表現** — LLM の返答に応じてキャラクターの表情が変化
- **音声合成 (TTS)** — AivisSpeech（ローカル）/ Aivis Cloud API / ブラウザ TTS にフォールバック
- **音声入力 (STT)** — マイクからの音声入力に対応
- **Google Drive 同期** — 設定・会話履歴・プリセット・VRM ファイルを Google Drive に保存・同期
- **オフライン対応** — Google Drive 未使用時は IndexedDB にローカル保存

## セットアップ

### 必要なもの

- モダンブラウザ（Chrome / Edge / Safari）
- OpenAI 互換 API のエンドポイントと API キー

### 設定手順

1. アプリを開き、右上の **⚙️ 設定** をクリック
2. **LLM タブ** で APIエンドポイント・APIキー・モデル名を入力して保存
3. （任意）**音声タブ** で AivisSpeech または Aivis Cloud API を設定
4. （任意）ヘッダーの **☁ サインイン** から Google アカウントでサインインすると設定が自動同期

### LLM 設定例

| サービス | エンドポイント | モデル名 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` |
| Ollama (ローカル) | `http://localhost:11434/v1` | `llama3.2` など |

## ローカル開発

```bash
npm install
npm run dev        # Vite dev server (localhost:3000)
npm run dev:server # Express server (localhost:3003)
```

### 環境変数 (`.env`)

```env
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id
```

Google OAuth クライアント ID は [Google Cloud Console](https://console.cloud.google.com/) で取得してください。
承認済みの JavaScript 生成元に `http://localhost:3000` と本番 URL を追加してください。

## デプロイ

GitHub Actions で `main` ブランチへの push 時に GitHub Pages へ自動デプロイされます。

GitHub リポジトリの Secrets に以下を設定してください：

| Secret | 内容 |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth クライアント ID |

## 技術スタック

- [Three.js](https://threejs.org/) + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) — VRM レンダリング
- [Vite](https://vitejs.dev/) — ビルドツール
- Google Identity Services — OAuth 2.0 認証
- Google Drive API — クラウド同期
- IndexedDB — ローカルストレージ
