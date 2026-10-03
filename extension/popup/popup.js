// The popup only reads and writes the stored settings. Every open page listens for the
// change and updates itself, so nothing here talks to a page except to ask what it is doing.
(async () => {
  'use strict';
  const { merge, siteKey, siteMode, PALETTES } = LULL;
  const $ = (id) => document.getElementById(id);

  let settings = merge((await chrome.storage.local.get('settings')).settings);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';
  const host = /^(https?|file):/i.test(url) ? siteKey(url) : null;

  let timer = 0;
  function save(soon) {
    clearTimeout(timer);
    const write = () => chrome.storage.local.set({ settings });
    if (soon) timer = setTimeout(write, 120);
    else write();
  }

  // Samples of each palette: its background with its own text colour.
  const SAMPLE = {
    slate: ['#1b1e23', '#d1d6dc'],
    warm: ['#221d17', '#dcd4cc'],
    dusk: ['#1f1e29', '#d5d3e3'],
    moss: ['#19201b', '#cfd8d1'],
  };
  for (const [id, palette] of Object.entries(PALETTES)) {
    const label = document.createElement('label');
    label.className = 'swatch';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'palette';
    input.value = id;
    const chip = document.createElement('span');
    chip.textContent = 'Aa';
    chip.style.background = SAMPLE[id][0];
    chip.style.color = SAMPLE[id][1];
    label.append(input, chip, palette.name);
    $('palettes').append(label);
  }

  function render() {
    const mode = host ? siteMode(settings, host) : 'off';
    const siteOff = host ? !!(settings.sites[host] && settings.sites[host].mode === 'off') : true;
    $('host').textContent = host === 'file' ? 'Files on this computer' : host || 'This page';
    $('site-on').checked = !!host && settings.enabled && !siteOff;
    $('site-on').disabled = !host || !settings.enabled;
    $('enabled').checked = settings.enabled;
    $('contrast').value = settings.contrast;
    $('saturation').value = settings.saturation;
    $('media').value = 100 - settings.mediaDim;
    $('stillness').checked = settings.stillness;
    $('pauseMedia').checked = settings.pauseMedia;
    $('ruler').checked = settings.ruler;
    for (const input of document.querySelectorAll('input[name="palette"]')) input.checked = input.value === settings.palette;
    for (const input of document.querySelectorAll('input[name="darkSites"]')) input.checked = input.value === settings.darkSites;
    for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === (mode === 'invert' ? 'invert' : 'smart');
    $('mode-field').disabled = !host || mode === 'off';
    if (!host) $('status').textContent = 'Lull cannot change this page. Browsers do not let extensions edit their own pages or the extension store.';
    else if (!settings.enabled) $('status').textContent = 'Lull is paused on every site. Switch it on under More.';
    else if (siteOff) $('status').textContent = 'Off for this site.';
    else $('status').textContent = '';
  }

  async function describePage() {
    if (!host || !settings.enabled || siteMode(settings, host) === 'off') return;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'status' }, { frameId: 0 });
      if (!res) return;
      if (res.mode === 'invert') $('status').textContent = 'Using simple invert on this site.';
      else if (res.dark && res.colors) $('status').textContent = 'This site is already dark. Lull is softening it.';
      else if (res.dark) $('status').textContent = 'This site is already dark. Its colours are left alone.';
      else if (res.mode === 'off') $('status').textContent = 'Getting ready.';
    } catch {
      $('status').textContent = 'Reload this page to start Lull on it.';
    }
  }

  function setSite(mode) {
    if (!host) return;
    if (mode) settings.sites[host] = { mode };
    else delete settings.sites[host];
  }

  $('site-on').addEventListener('change', (e) => {
    setSite(e.target.checked ? null : 'off');
    save();
    render();
    setTimeout(describePage, 400);
  });
  $('enabled').addEventListener('change', (e) => {
    settings.enabled = e.target.checked;
    save();
    render();
  });
  for (const [id, key, map] of [
    ['contrast', 'contrast', Number],
    ['saturation', 'saturation', Number],
    ['media', 'mediaDim', (v) => 100 - v],
  ]) {
    $(id).addEventListener('input', (e) => {
      settings[key] = map(e.target.value);
      save(true);
    });
  }
  for (const key of ['stillness', 'pauseMedia', 'ruler']) {
    $(key).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      save();
    });
  }
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'palette') settings.palette = t.value;
    else if (t.name === 'darkSites') settings.darkSites = t.value;
    else if (t.name === 'mode') setSite(t.value === 'invert' ? 'invert' : null);
    else return;
    save();
    render();
    setTimeout(describePage, 400);
  });
  $('options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  render();
  describePage();
})();
