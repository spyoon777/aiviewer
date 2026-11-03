// Runs inside each AI site's iframe. The viewer page posts a prompt; this fills the
// site's input box, presses send and reports back.
const VIEWER_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

const report = msg => window.parent.postMessage({ type: 'aiviewer-status', text: msg }, VIEWER_ORIGIN);
const visible = el => el && el.getClientRects().length > 0;
const find = sels => {
  for (const s of sels) for (const el of document.querySelectorAll(s)) if (visible(el)) return el;
  return null;
};

async function sendPrompt(text, inSel, sendSel) {
  const input = find(inSel) || find(['textarea', "div[contenteditable='true']"]);
  if (!input) { report('입력창을 찾지 못함'); return; }
  input.focus();
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
  // Send buttons usually enable a moment after the editor sees the input.
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    const btn = find(sendSel);
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      btn.click();
      report('전송됨');
      return;
    }
  }
  const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent('keydown', key));
  input.dispatchEvent(new KeyboardEvent('keyup', key));
  report('전송됨 (Enter)');
}

window.addEventListener('message', e => {
  if (e.origin !== VIEWER_ORIGIN || e.data?.type !== 'aiviewer-send') return;
  sendPrompt(e.data.text, e.data.input, e.data.send);
});

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
