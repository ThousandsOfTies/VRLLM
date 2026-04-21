let _chatMessages;
let _statusEl;
let _chatInput;
let _sendBtn;
let _micBtn;
let _driveSync;
let _getAiAvatarUrl;
let _speech;

const SCROLL_THRESHOLD = 80;

export function initUiUtils({ chatMessages, statusEl, chatInput, sendBtn, micBtn, driveSync, getAiAvatarUrl, speech }) {
  _chatMessages = chatMessages;
  _statusEl = statusEl;
  _chatInput = chatInput;
  _sendBtn = sendBtn;
  _micBtn = micBtn;
  _driveSync = driveSync;
  _getAiAvatarUrl = getAiAvatarUrl;
  _speech = speech;
}

export function appendMessage(role, text, force = false) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  wrap.innerHTML = `
    <div class="message-avatar">${getAvatarHtml(role)}</div>
    <div class="message-bubble">
      <div class="message-text">${escapeHtml(text)}</div>
    </div>
  `;
  _chatMessages.appendChild(wrap);
  scrollToBottom(force);
  return wrap;
}

export function getAvatarHtml(role) {
  if (role === 'user') {
    const pic = _driveSync.picture;
    return pic ? `<img src="${pic}" class="avatar-img" alt="user">` : '👤';
  }
  const url = _getAiAvatarUrl();
  return url ? `<img src="${url}" class="avatar-img" alt="AI">` : '🤖';
}

export function updateUserAvatars() {
  const pic = _driveSync.picture;
  const html = pic ? `<img src="${pic}" class="avatar-img" alt="user">` : '👤';
  _chatMessages.querySelectorAll('.message.user .message-avatar')
    .forEach(el => { el.innerHTML = html; });
}

export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function isNearBottom() {
  return _chatMessages.scrollHeight - _chatMessages.scrollTop - _chatMessages.clientHeight < SCROLL_THRESHOLD;
}

export function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    _chatMessages.scrollTop = _chatMessages.scrollHeight;
  }
}

export function setStatus(text) {
  _statusEl.textContent = text;
}

export function setStatusTemp(el, text, ms = 3000) {
  el.textContent = text;
  setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, ms);
}

export function setInputEnabled(enabled) {
  _chatInput.disabled = !enabled;
  _sendBtn.disabled = !enabled;
  _micBtn.disabled = !enabled || !_speech.sttSupported;
}

export function autoResizeTextarea() {
  _chatInput.style.height = 'auto';
  const maxH = parseInt(getComputedStyle(_chatInput).maxHeight, 10) || 120;
  _chatInput.style.height = Math.min(_chatInput.scrollHeight, maxH) + 'px';
}
