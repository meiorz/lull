(async () => {
  'use strict';
  const { merge, DEFAULTS } = LULL;
  const LABEL = { off: 'Lull is off here', invert: 'Simple invert' };
  let settings = merge((await chrome.storage.local.get('settings')).settings);

  function render() {
    const list = document.getElementById('sites');
    const hosts = Object.keys(settings.sites).sort();
    list.textContent = '';
    document.getElementById('empty').hidden = hosts.length > 0;
    for (const host of hosts) {
      const row = document.createElement('div');
      row.className = 'site';
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = host === 'file' ? 'Files on this computer' : host;
      const mode = document.createElement('small');
      mode.className = 'quiet';
      mode.textContent = LABEL[settings.sites[host].mode] || settings.sites[host].mode;
      text.append(name, mode);
      const button = document.createElement('button');
      button.textContent = 'Use Smart theme';
      button.addEventListener('click', () => {
        delete settings.sites[host];
        chrome.storage.local.set({ settings });
      });
      row.append(text, button);
      list.append(row);
    }
  }

  document.getElementById('reset').addEventListener('click', () => {
    if (confirm('Reset every Lull setting and forget the site list?')) chrome.storage.local.set({ settings: DEFAULTS });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = merge(changes.settings.newValue);
    render();
  });

  render();
})();
