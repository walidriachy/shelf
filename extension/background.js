importScripts('shared.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'page', title: 'Save page to Shelf', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'link', title: 'Save link to Shelf', contexts: ['link'] });
  chrome.alarms.create('flush', { periodInMinutes: 2 });
});

chrome.alarms.onAlarm.addListener(a => { if (a.name === 'flush') flushQueue(); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'link' ? info.linkUrl : tab.url;
  let message;
  try {
    const r = await saveLinkWithFiles({ url }, info.menuItemId === 'link' ? null : tab);
    message = r.queued ? 'Shelf is closed. Saved for later.' : r.refreshed ? 'Updated with what you see in Chrome' : r.duplicate ? 'Already on your shelf' : 'Saved to Shelf';
  } catch (e) { message = e.message; }
  chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: 'Shelf', message });
});

// The popup hands saves to this background script, so downloading a Google file keeps going
// even if the popup closes.
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (!m || m.type !== 'save') return;
  saveLinkWithFiles(m.item, m.tab).then(r => reply({ ok: true, r }), e => reply({ ok: false, error: e.message, auth: !!e.auth }));
  return true;
});
