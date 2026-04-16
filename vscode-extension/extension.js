// VRLLM Mascot - VSCode Extension Host (CommonJS)
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

class MascotViewProvider {
  static viewType = 'vrllm.mascotView';

  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      // dist/ 以下のリソースのみ WebView からの読み込みを許可
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist')],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // WebView から 'ready' メッセージを受け取ったら現在のエディターコンテキストを送信
    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'ready') this._sendEditorContext();
    });
  }

  _sendEditorContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this._view) return;
    this._view.webview.postMessage({
      type: 'editorContext',
      fileName: path.basename(editor.document.fileName),
      languageId: editor.document.languageId,
      selection: editor.document.getText(editor.selection) || null,
    });
  }

  _getHtml(webview) {
    const distDir = vscode.Uri.joinPath(this._extensionUri, 'dist');
    const distFsPath = path.join(this._extensionUri.fsPath, 'dist');

    let html = fs.readFileSync(path.join(distFsPath, 'index.html'), 'utf8');

    // Vite が base:'./' で出力した ./assets/... などの相対パスを
    // vscode-resource URI に変換する
    html = html.replace(/(src|href)="(\.\/[^"]+)"/g, (_, attr, rel) => {
      const uri = webview.asWebviewUri(
        vscode.Uri.joinPath(distDir, rel.slice(2)) // './' を除去してパス結合
      );
      return `${attr}="${uri}"`;
    });

    // nonce 生成（CSP で inline script を許可するため）
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
        Math.floor(Math.random() * 62)
      ]
    ).join('');

    // Content Security Policy
    // - connect-src https: で任意の LLM エンドポイントへの fetch を許可
    // - http://localhost:* でローカル AivisSpeech / Ollama を許可
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource} https://accounts.google.com`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: blob: https:`,
      `font-src ${webview.cspSource}`,
      `connect-src https: http://localhost:* http://127.0.0.1:*`,
      `media-src blob:`,
      `worker-src blob:`,
    ].join('; ');

    html = html.replace(
      '<head>',
      `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`
    );

    // Vite が出力する <script type="module"> に nonce を付与
    html = html.replace(/<script type="module"/g, `<script type="module" nonce="${nonce}"`);

    // PWA manifest リンクは WebView では不要なので除去
    html = html.replace(/<link rel="manifest"[^>]*>/g, '');

    return html;
  }
}

function activate(context) {
  const provider = new MascotViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MascotViewProvider.viewType,
      provider,
      // Three.js レンダラーを保持するため、パネルが隠れても WebView を破棄しない
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // エディター変更をデバウンスして WebView へ送信 (300ms)
  let debounceTimer;
  const sendContext = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => provider._sendEditorContext(), 300);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('vrllm.sendEditorContext', () =>
      provider._sendEditorContext()
    ),
    vscode.window.onDidChangeActiveTextEditor(sendContext),
    vscode.window.onDidChangeTextEditorSelection(sendContext)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
