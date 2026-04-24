import { setStatus } from './uiUtils.js';
import { getCurrentSex, getSexData, updateSexData } from './sexManager.js';

let _viewer, _storage, _llm, _canvas, _saveSettings;
let _vrmModelSelect, _vrmFileInput, _vrmLoadStatus, _vrmaPresetSelect, _loadVRMABtn, _vrmaFileInput;

let _currentVrmId     = getSexData().selectedVrmId;
let _vrmCharNames     = {};
let _vrmFileNames     = {};
let _vrmSystemPrompts = {};
let _aiAvatarUrl      = null;
let _vrmaEmotionMap   = { ...getSexData().motionMap };

export function initVRMManager({ viewer, storage, llm, canvas, saveSettings }) {
  _viewer      = viewer;
  _storage     = storage;
  _llm         = llm;
  _canvas      = canvas;
  _saveSettings = saveSettings;

  _vrmModelSelect   = document.getElementById('vrm-model-select');
  _vrmFileInput     = document.getElementById('vrm-file-input');
  _vrmLoadStatus    = document.getElementById('vrm-load-status');
  _vrmaPresetSelect = document.getElementById('vrma-preset-select');
  _loadVRMABtn      = document.getElementById('load-vrma-btn');
  _vrmaFileInput    = document.getElementById('vrma-file-input');

  _registerListeners();
}

// ---- Getters ----
export function getAiAvatarUrl()      { return _aiAvatarUrl; }
export function getCurrentVrmId()     { return _currentVrmId; }
export function getVrmCharNames()     { return _vrmCharNames; }
export function getVrmFileNames()     { return _vrmFileNames; }
export function getVrmSystemPrompts() { return _vrmSystemPrompts; }
export function getVrmaEmotionMap()   { return _vrmaEmotionMap; }

export function getVrmState() {
  return {
    currentVrmId:  _currentVrmId,
    charNames:     _vrmCharNames,
    systemPrompts: _vrmSystemPrompts,
  };
}

export function setCurrentVrmSystemPrompt(prompt) {
  _vrmSystemPrompts[_currentVrmId] = prompt;
}

// ---- Settings integration ----
export function applySettings(s) {
  if (!s) return;
  if (s.vrm_char_names) {
    try { _vrmCharNames = JSON.parse(s.vrm_char_names); } catch { _vrmCharNames = {}; }
  }
  if (s.vrm_system_prompts) {
    try { _vrmSystemPrompts = JSON.parse(s.vrm_system_prompts); } catch { _vrmSystemPrompts = {}; }
  }
  const currentSex = getCurrentSex();
  const vrmId = s.sex?.[currentSex]?.selectedVrmId ?? s.selected_vrm_id;
  if (vrmId) _currentVrmId = vrmId;
  const motionMap = s.sex?.[currentSex]?.motionMap;
  if (motionMap) Object.assign(_vrmaEmotionMap, motionMap);
}

export function applySexDataToVRM() {
  const d = getSexData();
  Object.assign(_vrmaEmotionMap, d.motionMap);
  _currentVrmId = d.selectedVrmId;
  refreshVRMList(d.selectedVrmId);
}

// ---- URL resolution ----
export function resolveVrmaUrl(path) {
  return path.startsWith('blob:') ? path : import.meta.env.BASE_URL + path;
}

// ---- VRMA ----
export async function loadDefaultVRMA(isIdle = false) {
  await _viewer.loadVRMA(resolveVrmaUrl(_vrmaEmotionMap.neutral), { loop: true, isIdle });
  _vrmaPresetSelect.value = 'neutral';
}

// ---- VRM ----
export function captureAiAvatar() {
  requestAnimationFrame(() => {
    try {
      _aiAvatarUrl = _canvas.toDataURL('image/jpeg', 0.8);
    } catch (err) {
      console.warn('AIアバター取得失敗:', err.message);
    }
  });
}

export async function refreshVRMList(selectId = undefined) {
  let files = [];
  try {
    files = await _storage.listVRMFiles();
  } catch (err) {
    console.warn('VRMリスト取得失敗:', err.message);
  }
  _vrmFileNames = {};
  _vrmModelSelect.innerHTML = '';

  const builtinOpt = document.createElement('option');
  const sex = getCurrentSex();
  if (sex === 'male') {
    builtinOpt.value = '__builtin_male__';
    builtinOpt.textContent = 'ロイド (デフォルト)';
  } else {
    builtinOpt.value = '__builtin__';
    builtinOpt.textContent = 'リリム (デフォルト)';
  }
  _vrmModelSelect.appendChild(builtinOpt);

  for (const f of files) {
    _vrmFileNames[f.id] = f.name;
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = _vrmCharNames[f.id] || f.name;
    _vrmModelSelect.appendChild(opt);
  }

  if (selectId !== undefined) {
    _vrmModelSelect.value = selectId;
    _currentVrmId = selectId;
  } else if (_currentVrmId && _vrmModelSelect.querySelector(`option[value="${_currentVrmId}"]`)) {
    _vrmModelSelect.value = _currentVrmId;
  }
  _updateVrmEditRow();
}

export async function loadBuiltinVRM() {
  setStatus('モデルを読み込み中...');
  _vrmModelSelect.disabled = true;
  try {
    const sex = getCurrentSex();
    if (sex === 'male') {
      try {
        await _viewer.loadVRM(import.meta.env.BASE_URL + 'vrm/Roid.vrm', (pct) => setStatus(`読み込み中... ${pct}%`));
      } catch {
        await _viewer.loadVRM(import.meta.env.BASE_URL + 'vrm/Lilym.vrm', (pct) => setStatus(`読み込み中... ${pct}%`));
      }
    } else {
      await _viewer.loadVRM(import.meta.env.BASE_URL + 'vrm/Lilym.vrm', (pct) => setStatus(`読み込み中... ${pct}%`));
    }
    setStatus('デフォルトモーション適用中...');
    await loadDefaultVRMA(true);
    _vrmaPresetSelect.value = 'neutral';
    setStatus('');
    captureAiAvatar();
  } catch (err) {
    setStatus(`モデル読み込みエラー: ${err.message}`);
    console.error(err);
  } finally {
    _vrmModelSelect.disabled = false;
  }
}

export async function loadInitialVRM() {
  _currentVrmId = getSexData().selectedVrmId;
  if (_currentVrmId === '__builtin__' || _currentVrmId === '__builtin_male__') {
    _llm.systemPrompt = _vrmSystemPrompts[_currentVrmId] ?? _vrmSystemPrompts['__builtin__'] ?? _llm.systemPrompt;
    await loadBuiltinVRM();
  } else {
    setStatus('モデルを読み込み中...');
    _vrmModelSelect.disabled = true;
    try {
      const files = await _storage.listVRMFiles();
      const f = files.find(f => f.id === _currentVrmId);
      if (!f) throw new Error('保存されたモデルが見つかりません');
      _vrmFileNames[f.id] = f.name;
      _llm.systemPrompt = _vrmSystemPrompts[_currentVrmId] ?? _llm.systemPrompt;
      const buf = await _storage.downloadVRM(_currentVrmId);
      const file = new File([buf], f.name, { type: 'application/octet-stream' });
      await _viewer.loadVRM(file, (pct) => setStatus(`読み込み中... ${pct}%`));
      setStatus('デフォルトモーション適用中...');
      await loadDefaultVRMA(true);
      setStatus('');
      captureAiAvatar();
    } catch (err) {
      console.warn('前回のモデル読み込み失敗、ビルトインに戻します:', err.message);
      _currentVrmId = getCurrentSex() === 'male' ? '__builtin_male__' : '__builtin__';
      updateSexData(getCurrentSex(), { selectedVrmId: _currentVrmId });
      _llm.systemPrompt = _vrmSystemPrompts[_currentVrmId] ?? _vrmSystemPrompts['__builtin__'] ?? _llm.systemPrompt;
      await loadBuiltinVRM();
    } finally {
      _vrmModelSelect.disabled = false;
    }
  }
}

// ---- Private helpers ----
function _updateVrmEditRow() {
  const val = _vrmModelSelect.value;
  const editRow = document.getElementById('vrm-edit-row');
  const charNameInput = document.getElementById('vrm-char-name');
  if (val && val !== '__add__' && val !== '__builtin__' && val !== '__builtin_male__') {
    editRow.classList.remove('hidden');
    charNameInput.value = _vrmCharNames[val] || '';
    charNameInput.placeholder = _vrmFileNames[val] || '表示名を入力';
  } else {
    editRow.classList.add('hidden');
  }
}

function _applyVrmSystemPrompt(vrmId) {
  const prompt = _vrmSystemPrompts[vrmId] ?? _llm.systemPrompt;
  _llm.systemPrompt = prompt;
  const el = document.getElementById('setting-system-prompt');
  if (el) el.value = prompt;
}

async function _handleVrmSelect(val) {
  const promptEl = document.getElementById('setting-system-prompt');
  if (promptEl && _currentVrmId) {
    _vrmSystemPrompts[_currentVrmId] = promptEl.value.trim();
  }

  if (val === '__builtin__' || val === '__builtin_male__') {
    _currentVrmId = val;
    updateSexData(getCurrentSex(), { selectedVrmId: val });
    _updateVrmEditRow();
    _applyVrmSystemPrompt(val);
    await loadBuiltinVRM();
    _saveSettings();
    return;
  }
  _currentVrmId = val;
  updateSexData(getCurrentSex(), { selectedVrmId: val });
  _updateVrmEditRow();
  _applyVrmSystemPrompt(val);
  _vrmModelSelect.disabled = true;
  _vrmLoadStatus.textContent = '読み込み中...';
  try {
    const buf = await _storage.downloadVRM(val);
    const fname = _vrmFileNames[val] || val;
    const file = new File([buf], fname, { type: 'application/octet-stream' });
    await _viewer.loadVRM(file, (pct) => { _vrmLoadStatus.textContent = `読み込み中... ${pct}%`; });
    _vrmLoadStatus.textContent = `✅ ${_vrmCharNames[val] || fname}`;
    setStatus('');
    _saveSettings();
    try {
      await loadDefaultVRMA();
    } catch (vrmaErr) {
      console.warn('デフォルトモーション読み込み失敗:', vrmaErr.message);
    }
    captureAiAvatar();
  } catch (err) {
    _vrmLoadStatus.textContent = `❌ ${err.message}`;
    console.error(err);
  } finally {
    _vrmModelSelect.disabled = false;
  }
}

function _registerListeners() {
  document.getElementById('vrm-char-name').addEventListener('change', async (e) => {
    if (!_currentVrmId || _currentVrmId === '__builtin__') return;
    const name = e.target.value.trim();
    if (name) {
      _vrmCharNames[_currentVrmId] = name;
    } else {
      delete _vrmCharNames[_currentVrmId];
    }
    await refreshVRMList(_currentVrmId);
    _saveSettings();
  });

  document.getElementById('vrm-delete-btn').addEventListener('click', async () => {
    if (!_currentVrmId || _currentVrmId === '__builtin__' || _currentVrmId === '__builtin_male__') return;
    const dispName = _vrmCharNames[_currentVrmId] || _vrmFileNames[_currentVrmId] || _currentVrmId;
    if (!confirm(`「${dispName}」を削除しますか？`)) return;
    try {
      await _storage.deleteVRM(_currentVrmId);
      delete _vrmCharNames[_currentVrmId];
      delete _vrmFileNames[_currentVrmId];
      delete _vrmSystemPrompts[_currentVrmId];
      _vrmLoadStatus.textContent = '';
      const fallbackId = getCurrentSex() === 'male' ? '__builtin_male__' : '__builtin__';
      updateSexData(getCurrentSex(), { selectedVrmId: fallbackId });
      await refreshVRMList(fallbackId);
      _applyVrmSystemPrompt(fallbackId);
      await loadBuiltinVRM();
      _saveSettings();
    } catch (err) {
      _vrmLoadStatus.textContent = `❌ ${err.message}`;
      console.error(err);
    }
  });

  _vrmModelSelect.addEventListener('change', (e) => {
    _handleVrmSelect(e.target.value);
  });

  document.getElementById('vrm-add-btn').addEventListener('click', () => {
    _vrmFileInput.click();
  });

  _loadVRMABtn.addEventListener('click', () => _vrmaFileInput.click());

  _vrmaFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const emotion = _vrmaPresetSelect.value || 'neutral';
    setStatus(`「${_vrmaPresetSelect.options[_vrmaPresetSelect.selectedIndex].text}」のモーションを置き換え中...`);
    _loadVRMABtn.disabled = true;
    try {
      const blobUrl = URL.createObjectURL(file);
      _vrmaEmotionMap[emotion] = blobUrl;
      await _viewer.loadVRMA(blobUrl, { loop: true, isIdle: emotion === 'neutral' });
      setStatus(`✅ ${_vrmaPresetSelect.options[_vrmaPresetSelect.selectedIndex].text} のモーションを更新しました`);
    } catch (err) {
      setStatus(`VRMAエラー: ${err.message}`);
      console.error(err);
    } finally {
      _loadVRMABtn.disabled = false;
      _vrmaFileInput.value = '';
    }
  });

  _vrmaPresetSelect.addEventListener('change', async () => {
    const emotion = _vrmaPresetSelect.value;
    const prevEmotion = _vrmaPresetSelect.dataset.current ?? 'neutral';
    setStatus('モーション読み込み中...');
    try {
      const url = resolveVrmaUrl(_vrmaEmotionMap[emotion] || _vrmaEmotionMap.neutral);
      await _viewer.loadVRMA(url, { loop: true, isIdle: emotion === 'neutral' });
      _vrmaPresetSelect.dataset.current = emotion;
      setStatus('アニメーション再生中');
    } catch (err) {
      setStatus(`VRMAエラー: ${err.message}`);
      _vrmaPresetSelect.value = prevEmotion;
      console.error(err);
    }
  });

  _vrmFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    _vrmModelSelect.disabled = true;
    _vrmLoadStatus.textContent = '保存中...';
    try {
      await _storage.uploadVRM(file, () => {});
      _vrmLoadStatus.textContent = '読み込み中...';
      await _viewer.loadVRM(file, (pct) => { _vrmLoadStatus.textContent = `読み込み中... ${pct}%`; });
      _vrmLoadStatus.textContent = `✅ ${file.name}`;
      setStatus('');
    } catch (err) {
      _vrmLoadStatus.textContent = `❌ ${err.message}`;
      console.error(err);
      _vrmModelSelect.disabled = false;
      _vrmFileInput.value = '';
      return;
    }
    await refreshVRMList();
    const found = Array.from(_vrmModelSelect.options).find(
      o => o.value !== '__add__' && o.value !== '__builtin__' && _vrmFileNames[o.value] === file.name
    );
    if (found) {
      _vrmSystemPrompts[found.value] = _vrmSystemPrompts['__builtin__'] ?? _llm.systemPrompt;
      _vrmModelSelect.value = found.value;
      _currentVrmId = found.value;
      _updateVrmEditRow();
      _applyVrmSystemPrompt(found.value);
    }
    try {
      await _viewer.loadVRMA(import.meta.env.BASE_URL + 'vrma/VRMA_03.vrma', { loop: true });
      _vrmaPresetSelect.value = 'vrma/VRMA_03.vrma';
    } catch (vrmaErr) {
      console.warn('デフォルトモーション読み込み失敗:', vrmaErr.message);
    } finally {
      _vrmModelSelect.disabled = false;
      _vrmFileInput.value = '';
    }
  });
}
