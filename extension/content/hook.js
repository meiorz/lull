// Runs in the page's own JavaScript world (everything else in Lull runs in an isolated one).
// Its only job is to tell Lull when page script adds a shadow root or edits a style sheet,
// so those changes can be themed before they are painted instead of being polled for.
// It reads nothing from the page and stays silent until Lull switches it on.
(() => {
  'use strict';
  let active = false;
  const pending = new Set();
  let queued = false;

  function fire(target, type) {
    try {
      target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    } catch {}
  }

  function flush() {
    queued = false;
    for (const target of pending) fire(target, 'lull:css');
    pending.clear();
  }

  function changed(target) {
    if (!active) return;
    pending.add(target && target.isConnected ? target : document);
    if (!queued) {
      queued = true;
      queueMicrotask(flush);
    }
  }

  // A Proxy keeps the wrapped function looking native to the page.
  function after(proto, name, fn) {
    const original = proto && proto[name];
    if (typeof original !== 'function') return;
    proto[name] = new Proxy(original, {
      apply(target, self, args) {
        const out = Reflect.apply(target, self, args);
        try {
          fn(self, out);
        } catch {}
        return out;
      },
    });
  }

  after(Element.prototype, 'attachShadow', (host) => {
    if (active) fire(host.isConnected ? host : document, 'lull:shadow');
  });

  const sheetChanged = (sheet) => changed(sheet && sheet.ownerNode);
  for (const name of ['insertRule', 'deleteRule', 'replaceSync', 'addRule', 'removeRule']) {
    after(CSSStyleSheet.prototype, name, sheetChanged);
  }
  after(CSSStyleSheet.prototype, 'replace', (sheet, promise) => {
    Promise.resolve(promise).then(() => sheetChanged(sheet), () => {});
  });
  for (const name of ['insertRule', 'deleteRule']) {
    after(globalThis.CSSGroupingRule && CSSGroupingRule.prototype, name, (rule) => sheetChanged(rule.parentStyleSheet));
  }

  for (const proto of [Document.prototype, ShadowRoot.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    if (!desc || !desc.set) continue;
    Object.defineProperty(proto, 'adoptedStyleSheets', {
      ...desc,
      set: new Proxy(desc.set, {
        apply(target, self, args) {
          const out = Reflect.apply(target, self, args);
          changed(self.host || document);
          return out;
        },
      }),
    });
  }

  document.addEventListener('lull:on', () => {
    active = true;
    fire(document, 'lull:pong');
  });
  document.addEventListener('lull:off', () => {
    active = false;
  });
})();
