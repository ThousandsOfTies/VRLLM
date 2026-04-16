import { defineConfig } from 'vite';

// VSCode Extension WebView 向けビルド設定
// - base: './' により全アセットパスが相対パスで出力される (WebView URI 解決に必須)
// - outDir: vscode-extension/dist に出力
// - VSCODE_BUILD フラグで SW 登録・Wake Lock をスキップ
export default defineConfig({
  base: './',
  build: {
    outDir: 'vscode-extension/dist',
    emptyOutDir: true,
  },
  define: {
    'import.meta.env.VSCODE_BUILD': 'true',
  },
});
