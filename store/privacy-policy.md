# Lull privacy policy

Effective 3 October 2026

Lull is a browser extension that gives websites a soft dark theme and reduces movement on them.

## Short version

Lull does not collect, send, sell or share any personal data. It has no account, no analytics, no advertising and no server of its own. Nothing about you or the pages you visit is sent to the developer or to anyone else.

## What Lull stores

Lull stores your settings: the palette, the three sliders, the switches, and the list of sites for which you chose a different setting (their host names, for example `example.org`).

These are kept in the browser's local extension storage on your device. They are not synced, not uploaded and not readable by websites. Removing the extension deletes them.

## What Lull reads

To recolour a page, Lull reads the page's style sheets, the style attributes of its elements, and its pictures. This happens inside your browser. The results are not kept and not sent anywhere.

Lull looks at the address of the current tab only to know which site a per-site setting belongs to.

Lull does not read what you type, passwords, form contents, cookies or your browsing history.

## Network requests

A page may use style sheets and pictures that live on a different address from the page itself, and a browser does not let a page read the colours of those files directly. To read them, Lull may request the same file again.

- These requests go only to addresses the page you are on already uses.
- Requests to other sites carry no cookies.
- The site that receives the request sees an ordinary request for a file it already serves, as it did when the page loaded that file.
- Lull's background worker refuses addresses on your computer or local network when the page is a public website, and it does not follow redirects.

Lull makes no other network requests.

## Permissions

- **Access to all websites**: needed to restyle whichever site you visit.
- **Storage**: keeps your settings in the browser.
- **Scripting**: lets Lull make a page dark before it first appears.

## Third parties

There are none. Lull contains no third-party code, trackers or services.

## Changes

If this policy changes, the new version will be published at the same address with a new date.

## Contact

Questions and reports: https://github.com/meiorz/lull/issues
