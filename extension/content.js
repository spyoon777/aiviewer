// Runs inside each AI site's iframe. The viewer page posts a prompt; this fills the
// site's input box, presses send and reports back.
const VIEWER_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

const report = (text, kind) => window.parent.postMessage({ type: 'aiviewer-status', text, kind }, VIEWER_ORIGIN);
const visible = el => el && el.getClientRects().length > 0;
const find = sels => {
  for (const s of sels) for (const el of document.querySelectorAll(s)) if (visible(el)) return el;
  return null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEND_LABEL = /^(send|submit|send message|send prompt|전송|보내기|메시지 보내기|제출)$/i;

// When the configured selectors miss (sites rename buttons), look for a send-like button in the
// composer around the input: the nearest ancestor that contains one, last match wins.
function findSendNear(input) {
  for (let el = input.parentElement, depth = 0; el && depth < 12; el = el.parentElement, depth++) {
    const buttons = [...el.querySelectorAll('button, [role="button"]')].filter(b =>
      visible(b) && SEND_LABEL.test((b.getAttribute('aria-label') || b.title || '').trim()));
    if (buttons.length) return buttons.at(-1);
  }
  return null;
}

function typeText(input, text) {
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, null);
    if (!document.execCommand('insertText', false, text)) {
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
}

// Whether a file input's accept list (e.g. "image/*,.pdf") takes this file.
const accepts = (fileInput, file) => !fileInput.accept || fileInput.accept.split(',').some(a => {
  a = a.trim().toLowerCase();
  return a === '*/*' || a === file.type || (a.endsWith('/*') && file.type.startsWith(a.slice(0, -1))) ||
    (a.startsWith('.') && file.name.toLowerCase().endsWith(a));
});

// Paste the files into the editor as if the user pressed Ctrl+V; an editor that takes the paste
// cancels the event. Otherwise hand them to the site's own file input.
function attachFiles(input, files) {
  const data = new DataTransfer();
  files.forEach(f => data.items.add(f));
  const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  input.dispatchEvent(paste);
  if (paste.defaultPrevented) return true;
  const fileInput = [...document.querySelectorAll('input[type=file]')].find(el => files.every(f => accepts(el, f)));
  if (!fileInput) return false;
  fileInput.files = data.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

async function sendPrompt(text, files, inSel, sendSel) {
  const input = find(inSel) || find(['textarea', "div[contenteditable='true']"]);
  if (!input) { report('입력창을 찾지 못함', 'warn'); return; }
  input.focus();
  if (text) typeText(input, text);
  if (files.length) {
    report('파일 올리는 중…', 'busy');
    if (!attachFiles(input, files)) { report('파일을 넣지 못함 · 칸에 직접 첨부하세요', 'warn'); return; }
    await sleep(1500);  // give the site time to start the upload (and disable its send button)
  }
  // Send buttons enable a moment after the editor sees the input, or once uploads finish.
  const tries = files.length ? 600 : 30;
  let btn;
  for (let i = 0; i < tries; i++) {
    await sleep(100);
    btn = find(sendSel) || findSendNear(input);
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      report('전송됨', 'ok');
      return;
    }
  }
  // Pressing Enter mid-upload could send the text without the files, so leave that to the user.
  if (files.length) {
    report(btn ? '전송 버튼이 꺼진 상태로 남음 · 칸에서 직접 전송하세요' : '전송 버튼을 찾지 못함 · 칸에서 직접 전송하세요', 'warn');
    return;
  }
  const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent('keydown', key));
  input.dispatchEvent(new KeyboardEvent('keyup', key));
  report('전송됨 (Enter)', 'ok');
}

window.addEventListener('message', e => {
  if (e.origin !== VIEWER_ORIGIN || e.data?.type !== 'aiviewer-send') return;
  sendPrompt(e.data.text, e.data.files ?? [], e.data.input, e.data.send);
});

// Sign-in pages that only show an "embedding not supported" error inside a frame: when a pane lands
// on one, show the extension's notice there instead, with a button that opens a real login window.
// Checked on an interval because sites switch to these pages without reloading.
const SIGN_IN_PATHS = { 'claude.ai': /^\/(login|logout)\b/ };
if (window.parent === window.top && location.ancestorOrigins?.[0] === VIEWER_ORIGIN && SIGN_IN_PATHS[location.hostname]) {
  const checkSignIn = () => {
    if (SIGN_IN_PATHS[location.hostname].test(location.pathname)) location.replace(chrome.runtime.getURL('login.html?signin'));
  };
  checkSignIn();
  setInterval(checkSignIn, 1000);
}

// Cookie banners: sites store consent in SameSite=Lax cookies, which Chrome won't keep inside
// the viewer's frames, so they ask on every load. Remember the user's first answer per site
// and click the same button automatically afterwards. Only exact button labels are matched.
const CONSENT_LABELS = {
  accept: [
    'accept all', 'accept all cookies', 'allow all', 'allow all cookies',
    '모두 수락', '모두 허용', '모든 쿠키 허용', '모든 쿠키 수락', '쿠키 모두 허용', '전체 허용', '전체 수락',
  ],
  reject: [
    'reject all', 'reject all cookies', 'reject non-essential', 'decline all', 'necessary only', 'only necessary', 'essential only',
    '모두 거부', '모든 쿠키 거부', '전체 거부', '필수 쿠키만', '필수 쿠키만 허용', '필수 쿠키만 사용', '비필수 쿠키 거부',
  ],
};
const CONSENT_KEY = `consent:${location.hostname}`;
const CLICKABLE = 'button, [role="button"], a';
const consentKind = el => {
  const label = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return Object.keys(CONSENT_LABELS).find(kind => CONSENT_LABELS[kind].includes(label)) ?? null;
};

if (window !== window.top) {
  document.addEventListener('click', e => {
    if (!e.isTrusted) return;  // ignore our own automatic clicks
    const el = e.target.closest?.(CLICKABLE);
    const kind = el && consentKind(el);
    if (kind) chrome.storage.local.set({ [CONSENT_KEY]: kind });
  }, true);

  chrome.storage.local.get(CONSENT_KEY).then(({ [CONSENT_KEY]: kind }) => {
    if (!kind) return;
    const tryClick = () => {
      for (const el of document.querySelectorAll(CLICKABLE)) {
        if (visible(el) && consentKind(el) === kind) { el.click(); return true; }
      }
      return false;
    };
    if (tryClick()) return;
    // The banner may render late; watch for it for a while, checking at most once per frame.
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (tryClick()) observer.disconnect();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 20000);
  });
}
