# What we built: a minimal PWA (Phase 3)

**PWA** just means "a website that can act a bit like an app": added to
your home screen with its own icon, opened in its own window without
browser address bars, and still showing a screen (not your live tasks) with no signal.

Three new pieces make that happen:

- **`manifest.webmanifest`** — a small JSON file telling the phone the
  app's name, icon, and colours, so "Install app" has something to work
  from.
- **`icons/`** — the icon images, built by `tools/make-icons.mjs`, a
  script (see its comments for how a PNG gets made from scratch).
- **`sw.js`** — the **service worker**: a script the browser keeps
  running in the background whose job is answering "what do I do with
  this network request?"

## Why "network-first"

For the page and its JS/CSS, the service worker always tries the real
network first, only falling back to its saved copy if that fails. That's
the opposite of "cache forever" on purpose: the next time you open the
app after a code change ships, you get the new version straight away —
the offline copy is strictly a safety net.

## Installing it

- **Pixel / Android (Chrome):** open the site, tap **⋮** → **Install app**
  (or you may see a banner offering this automatically).
- **iPad (Safari):** tap **Share** → **Add to Home Screen**. iOS has no
  automatic install prompt, which is why Settings shows a text hint there
  instead of a button.

## A gotcha worth knowing

The **manifest** is only re-read when the app gets **installed**, not on
every visit like the page's own code. Change it or the icons, and an
already-installed copy won't notice until you **remove it from the home
screen and add it again**. The app's own code still updates normally —
no reinstall needed for that.
