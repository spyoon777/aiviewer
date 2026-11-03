chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

// The viewer page holds a port named "viewer:<rule ids>" open while it is showing. When it
// disconnects because the page closed or navigated away, remove exactly those framing rules so
// they can't apply to another site. A reloaded viewer has already made new rules with new ids.
// (If the disconnect is only this worker being stopped, the viewer reconnects and nothing runs here.)
chrome.runtime.onConnect.addListener(port => {
  const [kind, ids] = port.name.split(':');
  if (kind !== 'viewer') return;
  port.onDisconnect.addListener(() => {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids.split(',').map(Number) });
  });
});
