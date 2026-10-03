# Lull - calm dark mode

A Chrome extension that gives every website a soft, predictable dark theme. It was designed
for autistic people and people with ADHD: no white flashes, no pure black or pure white, no
vivid colour, no movement you did not ask for, and a settings panel with few choices.

- `extension/` is the extension. It has no dependencies and no build step.
- `test/` loads it into real Chrome and checks what pages look like afterwards.
- `tools/make-assets.mjs` regenerates the icons and the curtain style sheets.
- `store/` holds the Chrome Web Store listing: screenshots, promo image, description and
  privacy policy. `tools/make-store.mjs` regenerates the pictures from the made-up site in
  `tools/store-demo/`.

## Install

1. Open `chrome://extensions`.
2. Switch on **Developer mode** (top right).
3. Choose **Load unpacked** and pick the `extension` folder.
4. Reload any tabs that were already open.

Click the moon icon for the settings. `Alt` + `Shift` + `L` switches Lull on or off for the
current site.

## What the research says, and what Lull does about it

### People

| Finding | What Lull does |
| --- | --- |
| Autistic adults describe hypersensitivity to light, motion, patterns and particular colours, with fatigue and stress as a result ([Parmar et al., 2021](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8217662/)). | The whole page, including pictures, is kept in a dim range. Pictures that are mostly white are dimmed more than others. |
| Bright, contrasting and neon colours can cause sensory overload; muted palettes are recommended ([Scope](https://business.scope.org.uk/designing-for-people-on-the-autism-spectrum/), [University of St Andrews](https://digitalcommunications.wp.st-andrews.ac.uk/2019/07/08/designing-for-users-on-the-autistic-spectrum/)). Autistic users report that saturated colours on dark themes are painful ([Discord feedback](https://support.discord.com/hc/es/community/posts/1500000996841-Oversaturation-and-Sensory-Overload)). | Every colour has its saturation capped. Hue is kept, so a warning is still reddish and a link still bluish. The cap is one slider. |
| Pure white on pure black causes halation (glowing, smeared letters), worst with astigmatism; off-white on dark grey is the usual fix ([accessibilitychecker.org](https://www.accessibilitychecker.org/blog/dark-mode-accessibility/), [ezud.com](https://ezud.com/dark-mode-accessibility-feature/)). | Backgrounds never go darker than a soft charcoal and text never goes brighter than off-white. Body text sits near 11:1 contrast by default; the slider moves it between about 8:1 and 14:1. Sites that are already dark get the same treatment. |
| Consistency and predictability reduce load ([Scope](https://business.scope.org.uk/designing-for-people-on-the-autism-spectrum/)). | Neutral greys on every site become the same palette, so pages share one background, one text colour and one border colour. |
| Animation and autoplay pull attention away and are hard to ignore for people with ADHD ([BOIA](https://www.boia.org/blog/adhd-friendly-web-design-minimizing-distractions)); autoplay and unstoppable animation are also on the autism "don't" list. | Style-sheet animations and transitions are stopped, media that starts by itself is paused, GIFs are frozen on their first frame (or hidden, if their host does not let pages read them) until you ask for them. |
| Dark mode is not better for everyone; for some readers it lowers reading speed ([overview](https://sia.hackernoon.com/in-defense-of-light-mode-research-says-its-better-for-eye-health-s7v35kh)). | Contrast is adjustable rather than fixed, and one switch turns a site back to its own colours without a reload. |
| Long text is hard to stay on ([BOIA](https://www.boia.org/blog/adhd-friendly-web-design-minimizing-distractions)). | An optional reading ruler shades everything except the lines near the pointer. |

### Existing dark-theme extensions

| Reported problem | What Lull does |
| --- | --- |
| A white flash before the theme applies (Dark Reader reviews). | A tiny style sheet is registered with the browser for `document_start`, so the page is dark before any script runs. A test records every painted frame of a slow white page and fails if any is bright. |
| Slow pages, high CPU, hangs on large sites (Dark Reader reviews and changelog). | Colours are rewritten in the page's own rules rather than per element. All reading happens first, then every change is made in one step, so the browser restyles the page once. Nothing polls. Measured on real sites below. |
| Inverted or garbled pictures, logos and QR codes ([Chrome's auto dark mode, 2025](https://piunikaweb.com/2025/10/10/chrome-141-breaks-auto-dark-mode-inverts-images/)); the "double inversion" washed-out look of filter-based extensions. | Pictures are never inverted as a group. Only dark single-colour artwork on a transparent background (logos, formulas) is flipped; dark but colourful logos get a light plate behind them instead. |
| Sites that are already dark get broken or lightened. | Each colour is mapped on its own: dark backgrounds stay dark, light text stays light. A dark site is only softened, or left completely alone if you prefer. |
| The theme needs a list of per-site fixes to look right. | No site list. Variables, `rgb(var(--x))` triplets, `oklch()`, cascade layers, nesting, shadow roots (open and closed), adopted style sheets, rules inserted by script, and style sheets on other origins are handled generically. |
| Settings bleed between a domain and its subdomains. | Site settings are stored per exact hostname. |
| Printing comes out dark. | The original colours are restored while printing. |
| Busy settings panels (Midnight Lizard). | Three sliders, three switches, four palettes. Everything else is under "More". |
| Dark-mode extensions that turn out to be adware ([examples](https://malwaretips.com/blogs/remove-dark-browse/)). | No account, analytics, remote code or server. See "Privacy and permissions". |

## How it works

1. **Curtain.** The service worker registers `content/curtain-<palette>.css` (and `hook.js`)
   as a content script for `document_start`. It paints the page in the palette until
   `<html>` gets the attribute `data-lull-ready`. Sites that are switched off are excluded
   from the registration, so they never see it.
2. **Prepare** (`theme.js`). Once the page's style sheets have loaded, every rule is read and
   every colour declaration recorded. A style sheet on another origin is first requested the
   way a page would request it; if its host does not allow that, the service worker fetches
   it under the rules in "Privacy and permissions". Nothing on the page is changed yet.
3. **Apply.** In one task: the page is sampled to see whether it was already dark, every
   recorded declaration is rewritten in place, override sheets for other-origin style sheets
   are inserted directly after the originals, inline styles get an attribute that points at
   a generated rule, and the curtain is lifted. Each record keeps the original value, which
   is how settings can change live and how switching off restores the page exactly.
4. **Colour mapping** (`color.js`) is done in OKLCH. Backgrounds are folded into a narrow
   dark band, text into a narrow light band, neutrals are tinted to the palette and chroma is
   capped. `var(--x)` in a colour property becomes `var(--lull-bg-x, var(--x))`; wherever
   `--x` is defined as a colour, Lull defines the `bg`, `fg` and `bd` variants beside it.
5. **Staying current.** `hook.js` runs in the page's own JavaScript world and reports new
   shadow roots and script-made style changes, so they are themed before they are painted.
6. **Calm features** (`media.js`): picture analysis and dimming, frozen GIFs, paused autoplay,
   stopped animations, the reading ruler.

## Tests

```bash
npm install
npm test
```

`npm test` starts two local servers (a site and a "CDN" on another origin), loads the
extension into the installed Chrome and runs 138 checks: same-origin and other-origin style
sheets, variables and triplets, layers, nesting, split shorthands, inline styles, legacy
attributes, shadow roots, late script changes, pictures, GIFs, autoplay, frames, a strict
Content-Security-Policy, live setting changes, printing, switching off and on, the
recorded-frames flash test with a control run, and what the service worker refuses to fetch
(local addresses for public pages, redirects, oversized downloads).

`node test/sites.mjs` loads real websites and prints timings; add `--off` to compare with
Lull paused. One run on this machine (long tasks over the first few seconds of the page):

| Site | Elements | Lull on | Lull paused |
| --- | --- | --- | --- |
| en.wikipedia.org/wiki/Autism | 14,900 | 187 ms | 0 ms |
| theguardian.com | 4,800 | 324 ms | 225 ms |
| github.com (repository page) | 2,300 | 249 ms | 264 ms |
| bbc.com/news | 1,400 | 70 ms | 75 ms |
| amazon.com | 3,400 | 74 ms | 0 ms |

These numbers vary between runs by tens of milliseconds; they show the size of the cost,
not a precise figure.

## What it does not do

No extension can do these, or Lull does not do them yet:

- **Browser pages and the PDF viewer** (`chrome://`, the extension store, new tab) cannot be
  changed by any extension. A new tab will still be whatever the browser shows.
- **Text printed over a photo.** If a site puts dark text on a bright picture, the text
  becomes light and can be hard to read against the picture.
- **Background pictures set in a style sheet** are shown as they are: not dimmed, and dark
  icon sprites used as backgrounds stay dark.
- **Canvas-drawn pages** (some document editors, maps). Use "Simple invert" for those sites.
- **Script-driven animation** (scroll effects, the Web Animations API) keeps running. Animated
  WebP and APNG pictures are not frozen; GIFs are.
- **Inline `!important` colours** cannot be overridden from a style sheet and are left as is.
- A picture may be requested a second time when Lull asks to read it, if the site forbids
  caching. Large photographs are only read when the host allows cross-origin reads.
- **Style sheets Lull is not willing to fetch stay unthemed**: one that redirects on a host
  that does not let pages read it, and one on a local address linked from a public page.
- **GIFs on hosts that do not let pages read them** are hidden behind a dashed outline
  rather than frozen on a frame. Alt+click shows them.
- Tabs that were open before Lull was installed need a reload.
- Tested on Chrome 154 on Windows. Other Chromium browsers should work but were not tested;
  Firefox is not supported.

## Privacy and permissions

- `<all_urls>`: needed to restyle pages. Lull reads style sheets and pictures; it does not
  read page text, forms or history.
- `storage`: settings, kept in this browser profile.
- `scripting`: registering the curtain for `document_start`.

A page chooses which style sheets and pictures it links to, so Lull treats every such
address as chosen by a stranger:

- A style sheet is only asked for once the browser has let the page load it. The first
  attempt is an ordinary cross-origin request from the page, which is subject to every
  protection the browser applies to pages.
- The service worker is the fallback. It only answers content scripts in tabs, only for
  `http(s)` addresses, never sends cookies or a referrer, does not follow redirects, and
  stops at 4 MB (style sheets), 3 MB (pictures) or 10 seconds.
- For a page on a public address it refuses addresses on this computer or the local
  network (loopback, private and link-local ranges, single-label and `.local`-style
  names), and for an `https` page it refuses `http` addresses.
- Its answer is the text of a file the server labels `text/css`, or a one-word verdict
  about a picture. Picture sizes are read from the file header and anything over 16
  megapixels, or in a format it cannot measure, is not decoded. Pixels are never returned.

Known remaining exposure: a public host name that resolves to a private address cannot be
recognised by name. The selectors and recoloured values of a cross-origin style sheet end
up in the page, where its scripts can read them. Pages can also tell that Lull is installed
from the attributes and style sheets it adds.

There is no other network activity.
