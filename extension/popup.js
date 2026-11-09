const $ = (s) => document.querySelector(s);
let tab;

function show(setup) { $('#main').classList.toggle('hidden', setup); $('#setup').classList.toggle('hidden', !setup); }
function msg(el, text, cls = '') { el.textContent = text; el.className = 'msg ' + cls; }

async function loadCategories() {
  try {
    const r = await shelfFetch('/categories');
    for (const c of r.categories) $('#cat').append(new Option(c, c));
    const sent = await flushQueue();
    if (sent) msg($('#msg'), `Sent ${sent} saved-for-later link${sent > 1 ? 's' : ''}.`, 'ok');
  } catch (e) {
    if (e.auth) return show(true);
    msg($('#msg'), 'Shelf app is closed. Links you save now will be sent when it opens.');
  }
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#title').textContent = tab.title || tab.url;
  $('#url').textContent = tab.url;
  if (tab.favIconUrl) $('#fav').src = tab.favIconUrl; else $('#fav').style.display = 'none';
  if (!(await getKey())) return show(true);
  loadCategories();
  $('#note').focus();
})();

$('#save').addEventListener('click', async () => {
  $('#save').disabled = true;
  try {
    const r = await saveLink({ url: tab.url, note: $('#note').value.trim(), category: $('#cat').value || undefined });
    msg($('#msg'), r.queued ? 'Saved for later. It will reach Shelf when the app is open.' : r.duplicate ? 'Already on your shelf.' : 'Saved ✓', 'ok');
    if (!r.queued) setTimeout(() => window.close(), 900);
  } catch (e) {
    if (e.auth) show(true);
    msg($('#msg'), e.message, 'err');
  }
  $('#save').disabled = false;
});

$('#gear').addEventListener('click', async () => { $('#key').value = await getKey(); show(true); });
$('#back').addEventListener('click', () => show(false));
$('#connect').addEventListener('click', async () => {
  await chrome.storage.local.set({ key: $('#key').value.trim() });
  try {
    await shelfFetch('/categories');
    msg($('#smsg'), 'Connected ✓', 'ok');
    setTimeout(() => { show(false); loadCategories(); }, 600);
  } catch (e) { msg($('#smsg'), e.auth ? e.message : 'Saved. Open the Shelf app to finish connecting.', e.auth ? 'err' : ''); }
});
