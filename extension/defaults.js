// Settings shared by the service worker, the content scripts, the popup and the options page.
(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    palette: 'slate', // slate | warm | dusk | moss
    contrast: 60, // 0-100: how bright text is against the background
    saturation: 45, // 0-100: how strong colours are allowed to be
    mediaDim: 12, // 0-50: percent that pictures and video are dimmed
    stillness: true, // stop animations and smooth scrolling
    pauseMedia: true, // pause autoplaying video/audio and freeze GIFs
    ruler: false, // reading ruler that follows the pointer
    darkSites: 'soften', // soften | leave: what to do with sites that are already dark
    sites: {}, // hostname -> { mode: 'off' | 'invert' }
  };

  const PALETTES = {
    slate: { name: 'Slate', hue: 255, tint: 0.01, base: 0.235, link: 245 },
    warm: { name: 'Warm', hue: 70, tint: 0.014, base: 0.235, link: 215 },
    dusk: { name: 'Dusk', hue: 290, tint: 0.022, base: 0.24, link: 275 },
    moss: { name: 'Moss', hue: 155, tint: 0.014, base: 0.235, link: 200 },
  };

  function merge(stored) {
    const s = { ...DEFAULTS, ...(stored || {}) };
    s.sites = { ...(stored && stored.sites) };
    if (!PALETTES[s.palette]) s.palette = DEFAULTS.palette;
    return s;
  }

  // The key a site's own settings are stored under. Exact hostname, so a subdomain never
  // inherits or leaks settings from its parent domain.
  function siteKey(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return 'file';
      return u.hostname || null;
    } catch {
      return null;
    }
  }

  function siteMode(settings, host) {
    if (!settings.enabled) return 'off';
    const site = host && settings.sites[host];
    return (site && site.mode) || 'smart';
  }

  globalThis.LULL = { DEFAULTS, PALETTES, merge, siteKey, siteMode };
})();
