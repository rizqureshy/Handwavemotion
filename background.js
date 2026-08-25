// Clicking the toolbar icon opens the Handwave side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The grant page asks to be closed once the camera permission is secured —
// closing via the sender's tab id is reliable where window.close() is not.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.hw && msg.t === 'closeMe' && sender.tab?.id !== undefined) {
    chrome.tabs.remove(sender.tab.id).catch(() => {});
  }
});
