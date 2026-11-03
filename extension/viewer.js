const DEFAULT_SITES = ['ChatGPT', 'Gemini', 'Claude', 'Meta AI'];
const DEFAULT_LAYOUT = 4;
// Must also be in manifest host_permissions (redirect rules need host access).
const LOGIN_DOMAINS = ['accounts.google.com', 'auth.meta.com', 'accounts.x.ai'];
// Frame loads started by anything else (e.g. a site the user navigates this tab to) keep their protections.
// Subdomains are included automatically.
const FRAME_INITIATORS = [
  chrome.runtime.id,
  'chatgpt.com', 'openai.com', 'gemini.google.com', 'claude.ai', 'meta.ai', 'meta.com', 'grok.com', 'x.ai',
];

// Adapted from Lucide (ISC License), see THIRD_PARTY_NOTICES.md.
const ICONS = {
  send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  pen: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  maximize: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  minimize: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  cols2: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  cols3: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  grid: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/><path d="M3 12h18"/>',
};

const ZOOM_STEPS = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25];

const sites = {};
const panes = [];
let savedSites = [];  // site name per pane slot, kept for slots hidden by a smaller layout
let zoomBySite = {};  // user-chosen zoom per site name; falls back to sites.json "zoom", then 1
let layout = DEFAULT_LAYOUT;
const grid = document.getElementById('grid');

const icon = name =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const renderIcons = root => root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const favicon = url => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
const save = () => chrome.storage.local.set({ panes: savedSites, layout });

// Session rules for this viewer tab only (each rule's tabIds condition names its tab), and only for
// frames loaded by this page or the AI sites. background.js deletes them when this page goes away.
// - AI sites refuse to be framed (X-Frame-Options / CSP frame-ancestors): strip those headers.
// - Login pages (Google, Meta, xAI) refuse to load inside a frame: show login.html instead,
//   which opens a real login window. Google's /gsi/ path (one-tap widget) is left alone.
async function setupFrameRules() {
  const tab = await chrome.tabs.getCurrent();
  const openTabs = new Set((await chrome.tabs.query({})).map(t => t.id));
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const owner = r => r.condition.tabIds?.[0];
  const stale = rules.filter(r => owner(r) === tab.id || !openTabs.has(owner(r))).map(r => r.id);
  // Rule ids must be 32-bit ints, so they can't be derived from tab ids; just take the next free ones.
  const nextId = Math.max(0, ...rules.map(r => r.id)) + 1;
  const inThisTab = { tabIds: [tab.id], resourceTypes: ['sub_frame'], initiatorDomains: FRAME_INITIATORS };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: stale,
    addRules: [
      {
        id: nextId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: inThisTab,
      },
      {
        id: nextId + 1,
        priority: 2,
        action: { type: 'redirect', redirect: { extensionPath: '/login.html' } },
        condition: { ...inThisTab, requestDomains: LOGIN_DOMAINS },
      },
      {
        id: nextId + 2,
        priority: 3,
        action: { type: 'allow' },
        condition: { ...inThisTab, urlFilter: '||accounts.google.com/gsi/' },
      },
    ],
  });
  return [nextId, nextId + 1, nextId + 2];
}

// A port to background.js: when this page closes or the tab navigates away, the port disconnects
// and background.js removes this page's rules. The service worker may be stopped while idle, which
// also drops the port, so reconnect whenever that happens.
function keepRulesTiedToPage(ruleIds) {
  chrome.runtime.connect({ name: `viewer:${ruleIds.join(',')}` })
    .onDisconnect.addListener(() => keepRulesTiedToPage(ruleIds));
}

// Auto-growing textarea. Enter submits, Shift+Enter adds a newline; isComposing guards Korean IME input.
// onSubmit may return false to keep the text (e.g. nothing to send to).
function setupComposer(textarea, button, onSubmit, maxHeight) {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    button.disabled = !textarea.value.trim();
  };
  const submit = () => {
    const text = textarea.value.trim();
    if (!text || onSubmit(text) === false) return;
    textarea.value = '';
    resize();
  };
  textarea.addEventListener('input', resize);
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  button.addEventListener('click', submit);
  resize();
}

function createPane(slot) {
  const el = document.getElementById('pane-tpl').content.firstElementChild.cloneNode(true);
  renderIcons(el);
  const $ = sel => el.querySelector(sel);
  const select = $('select');
  const status = $('.status');
  const iframe = $('iframe');
  let statusTimer;

  const pane = {
    el,
    iframe,
    site: null,
    included: true,
    loginWindowId: null,
    setStatus(text, kind = '') {
      clearTimeout(statusTimer);
      status.textContent = text;
      status.className = `status ${kind}`;
      if (kind === 'ok') statusTimer = setTimeout(() => pane.setStatus(''), 4000);
    },
    setSite(name) {
      pane.site = sites[name] || null;
      select.value = pane.site ? name : '';
      el.classList.toggle('empty', !pane.site);
      $('.favicon').src = pane.site ? favicon(pane.site.url) : '';
      pane.setZoom(pane.site ? zoomBySite[name] ?? pane.site.zoom ?? 1 : 1);
      pane.setStatus('');
      iframe.src = pane.site ? pane.site.url : 'about:blank';
      savedSites[slot] = pane.site?.name ?? null;
      save();
      renderTargets();
    },
    newChat() {
      if (pane.site) iframe.src = pane.site.url;
    },
    // Sites switch to a mobile layout (no sidebar) in narrow frames; zooming out makes the frame "wider".
    setZoom(z) {
      pane.zoom = z;
      iframe.style.width = iframe.style.height = `${100 / z}%`;
      iframe.style.transform = z === 1 ? '' : `scale(${z})`;
      $('.zoom-level').textContent = `${Math.round(z * 100)}%`;
    },
    changeZoom(z) {
      if (!pane.site || !z) return;
      pane.setZoom(z);
      zoomBySite[pane.site.name] = z;
      chrome.storage.local.set({ zoom: zoomBySite });
    },
    // A real browser window, where sign-in and bot checks work; reload the pane when it closes.
    async openLogin() {
      if (!pane.site) return;
      if (pane.loginWindowId) {
        chrome.windows.update(pane.loginWindowId, { focused: true });
        return;
      }
      const win = await chrome.windows.create({ url: pane.site.url, type: 'popup', width: 520, height: 720 });
      pane.loginWindowId = win.id;
      const onRemoved = id => {
        if (id !== win.id) return;
        chrome.windows.onRemoved.removeListener(onRemoved);
        pane.loginWindowId = null;
        pane.newChat();
      };
      chrome.windows.onRemoved.addListener(onRemoved);
    },
    send(text) {
      if (!pane.site) return;
      pane.setStatus('입력 중…', 'busy');
      statusTimer = setTimeout(() => pane.setStatus('응답 없음 · 로그인 상태를 확인하세요', 'warn'), 5000);
      iframe.contentWindow.postMessage(
        { type: 'aiviewer-send', text, input: pane.site.input, send: pane.site.send },
        new URL(pane.site.url).origin,
      );
    },
    toggleMax() {
      const on = !el.classList.contains('max');
      setMaximized(on ? pane : null);
    },
  };

  for (const [name, site] of Object.entries(sites)) {
    select.add(new Option(name, name));
    const card = document.createElement('button');
    card.className = 'picker-card';
    card.innerHTML = `<img alt=""><span></span>`;
    card.querySelector('img').src = favicon(site.url);
    card.querySelector('span').textContent = name;
    card.addEventListener('click', () => pane.setSite(name));
    $('.picker-grid').append(card);
  }
  select.addEventListener('change', () => pane.setSite(select.value));
  $('.login').addEventListener('click', pane.openLogin);
  $('.new-chat').addEventListener('click', pane.newChat);
  $('.maximize').addEventListener('click', pane.toggleMax);
  $('.zoom-out').addEventListener('click', () => pane.changeZoom(ZOOM_STEPS.findLast(s => s < pane.zoom - 0.001)));
  $('.zoom-in').addEventListener('click', () => pane.changeZoom(ZOOM_STEPS.find(s => s > pane.zoom + 0.001)));
  $('.zoom-level').addEventListener('click', () => pane.changeZoom(1));
  setupComposer($('.pane-composer textarea'), $('.pane-composer .send-btn'), text => pane.send(text), 120);
  return pane;
}

function setMaximized(target) {
  for (const p of panes) p.el.classList.toggle('max', p === target);
  grid.classList.toggle('has-max', !!target);
}

// Chips above the main composer: which panes receive the broadcast.
function renderTargets() {
  const box = document.getElementById('targets');
  box.innerHTML = '<span class="label">보낼 대상</span>';
  for (const pane of panes.filter(p => p.site)) {
    const chip = document.createElement('button');
    chip.className = `chip ${pane.included ? 'on' : ''}`;
    chip.title = pane.included ? '클릭하면 이 AI에는 보내지 않습니다' : '클릭하면 이 AI에도 보냅니다';
    chip.innerHTML = `<img alt=""><span></span>`;
    chip.querySelector('img').src = favicon(pane.site.url);
    chip.querySelector('span').textContent = pane.site.name;
    chip.addEventListener('click', () => {
      pane.included = !pane.included;
      renderTargets();
    });
    box.append(chip);
  }
}

function applyLayout(n) {
  layout = n;
  grid.dataset.layout = n;
  setMaximized(null);
  while (panes.length < n) {
    const slot = panes.length;
    const pane = createPane(slot);
    panes.push(pane);
    grid.append(pane.el);
    pane.setSite(savedSites[slot]);
  }
  while (panes.length > n) panes.pop().el.remove();
  document.querySelectorAll('#layout button').forEach(b => b.classList.toggle('active', +b.dataset.layout === n));
  save();
  renderTargets();
}

async function init() {
  const { sites: list } = await (await fetch('sites.json')).json();
  for (const s of list) sites[s.name] = s;
  keepRulesTiedToPage(await setupFrameRules());

  const stored = await chrome.storage.local.get(['panes', 'layout', 'zoom']);
  savedSites = stored.panes ?? [...DEFAULT_SITES];
  zoomBySite = stored.zoom ?? {};
  renderIcons(document.body);

  document.querySelectorAll('#layout button').forEach(b => b.addEventListener('click', () => applyLayout(+b.dataset.layout)));
  applyLayout(stored.layout ?? DEFAULT_LAYOUT);

  const mainInput = document.getElementById('main-input');
  setupComposer(mainInput, document.getElementById('main-send'), text => {
    const targets = panes.filter(p => p.site && p.included);
    if (!targets.length) return false;
    targets.forEach(p => p.send(text));
  }, 160);
  document.getElementById('new-all').addEventListener('click', () => panes.forEach(p => p.newChat()));

  window.addEventListener('message', e => {
    const pane = panes.find(p => p.iframe.contentWindow === e.source);
    if (!pane) return;
    if (e.data?.type === 'aiviewer-status') pane.setStatus(e.data.text, e.data.text.startsWith('전송됨') ? 'ok' : 'warn');
    else if (e.data?.type === 'aiviewer-login' && e.origin === location.origin) pane.openLogin();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') setMaximized(null);
  });
  mainInput.focus();
}

init();
