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
    const r = await saveLink({ url });
    message = r.queued ? 'Shelf is closed. Saved for later.' : r.duplicate ? 'Already on your shelf' : 'Saved to Shelf';
  } catch (e) { message = e.message; }
  chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: 'Shelf', message });
});
