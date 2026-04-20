import { initUiUtils, appendMessage, setStatusTemp, updateUserAvatars } from './uiUtils.js';
import {
  initVRMManager, getAiAvatarUrl, loadInitialVRM,
} from './vrmManager.js';
import { initChatManager, sendMessage } from './chatManager.js';
import { initVoiceManager } from './voiceManager.js';
import { initSettingsManager, applySettings, saveSettings } from './settingsManager.js';
import { initHistorySync, getAutoSaveEnabled, scheduleHistorySave } from './historySync.js';
import { initLocationManager, applyLocationIfEnabled, getLocationEnabled } from './locationManager.js';
import { initDriveUI, showReauthToast, updateDriveSyncUI } from './driveUI.js';
import { initPlatformUtils } from './platformUtils.js';
import { getVrmaEmotionMap, resolveVrmaUrl } from './vrmManager.js';

export async function initApp({ viewer, llm, speech, lipSync, driveSync, storage, local, canvas }) {
  const chatMessages = document.getElementById('chat-messages');
  const statusEl     = document.getElementById('status-indicator');
  const chatInput    = document.getElementById('chat-input');
  const sendBtn      = document.getElementById('send-btn');
  const micBtn       = document.getElementById('mic-btn');

  // ---- モジュール初期化 ----
  initUiUtils({ chatMessages, statusEl, chatInput, sendBtn, micBtn, driveSync, getAiAvatarUrl, speech });

  initHistorySync({ llm, storage });

  initLocationManager({ llm, saveSettings });

  initVRMManager({ viewer, storage, llm, canvas, saveSettings });

  initChatManager({
    viewer, llm, speech, lipSync, driveSync,
    scheduleHistorySave, getVrmaEmotionMap, resolveVrmaUrl,
  });

  initVoiceManager({ speech, llm, micBtn, sendMessage });

  initSettingsManager({ viewer, llm, speech, driveSync, storage });

  initDriveUI({ driveSync, storage, llm, speech, viewer });

  initPlatformUtils({ viewer });

  // ---- 起動シーケンス ----
  await local.init();

  // Drive 初期化中に onSignInChange が発火しても UI のみ更新し、
  // 設定読み込みは initApp 側で一元管理する（二重読み込みの競合を防ぐ）
  const _postInitCallback = driveSync.onSignInChange;
  driveSync.onSignInChange = (isSignedIn) => {
    updateDriveSyncUI(isSignedIn);
    if (isSignedIn) updateUserAvatars();
  };

  await driveSync.init().catch(err => console.warn('Drive sync init:', err));

  driveSync.onSignInChange = _postInitCallback;

  // サイレント復元が失敗し、過去のアカウント情報がある場合は再ログインを促す
  if (!driveSync.isSignedIn && driveSync.email) {
    showReauthToast(driveSync.email);
  }

  // 設定を読み込んで全モジュールに適用
  const saved = await storage.loadSettings().catch(() => null);
  applySettings(saved);

  // プロファイルと会話履歴の非同期ロード（UIをブロックしない）
  (async () => {
    try {
      console.log('[HistorySync] 起動時: プロファイル読み込み処理を開始します...');
      const profileInfo = typeof storage._b?.loadUserProfile === 'function'
        ? await storage._b.loadUserProfile()
        : await driveSync.loadUserProfile().catch(() => null);
      if (profileInfo && Array.isArray(profileInfo)) {
        llm.userProfile = profileInfo;
        console.log('[HistorySync] 起動時: プロファイルを復元しました', profileInfo);
      } else {
        console.log('[HistorySync] 起動時: 保存されたプロファイルは見つかりませんでした');
      }
    } catch (e) {
      console.error('[HistorySync] 起動時: プロファイル読み込みエラー', e);
    }

    if (getAutoSaveEnabled()) {
      try {
        console.log('[HistorySync] 起動時: 会話履歴の読み込み処理を開始します...');
        const hist = await storage.loadHistory();
        if (hist && Array.isArray(hist.messages)) {
          console.log(`[HistorySync] 起動時: 会話履歴を受信しました (API取得件数: ${hist.messages.length}件)`);
          const pastMsgs = hist.messages.filter(m => m.role === 'user' || m.role === 'assistant');
          if (pastMsgs.length > 0) {
            llm.history = [...pastMsgs, ...llm.history];
            chatMessages.innerHTML = '';
            for (const msg of llm.history) appendMessage(msg.role, msg.content, true);
            console.log(`[HistorySync] 起動時: 会話履歴をUIへマージ・反映完了 (最終件数: ${llm.history.length}件)`);
          } else {
            console.log('[HistorySync] 起動時: 受信したデータに有効な発言が含まれていませんでした');
          }
        } else {
          console.log('[HistorySync] 起動時: クラウドまたはローカルに保存された履歴データが存在しませんでした');
        }
      } catch (e) {
        console.error('[HistorySync] 起動時: 会話履歴読み込みエラー', e);
      }
    } else {
      console.log('[HistorySync] 起動時: 自動保存設定がOFFのため、履歴の復元をスキップします');
    }
  })();

  applyLocationIfEnabled();
  document.getElementById('location-chk').checked = getLocationEnabled();

  if (driveSync.isSignedIn) {
    document.getElementById('drive-autosave-chk').checked = getAutoSaveEnabled();
    const driveStatus = document.getElementById('drive-status');
    if (saved) {
      setStatusTemp(driveStatus, '✅ Drive から設定を読み込みました');
    } else {
      driveStatus.textContent = '⚠️ Drive に設定がまだ保存されていません';
    }
  }

  // VRM を起動時にロード
  await loadInitialVRM();
}
