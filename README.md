# Arcade Architects

The camp curriculum as a website. Notes are written in Obsidian; a build script reads them out of the vault and turns them into a static site that GitHub Pages can serve.

The vault stays the single source of truth. Nothing here writes back to it.

---

## Everyday use

```bash
npm run sync     # read the vault, rebuild content/
npm start        # preview at http://localhost:4321
npm run dev      # both at once
```

Then commit and push. GitHub Pages picks up the change within a minute or two.

No dependencies to install. Node 18 or newer is the only requirement, and the markdown parser is vendored in `tools/vendor/`.

---

## First-time setup

1. Open `tools/sync.config.json` and check `vaultPath` points at your vault. On this machine it is already set to `/home/phantumdev/Documents/Obsidian Vaults/My Vault`. On a different computer, either edit that line or run `node tools/sync.mjs --vault "/path/to/vault"`.
2. Run `npm run sync`. Read the report it prints (see below).
3. Run `npm start` and click around.
4. Push to GitHub, then in the repository go to **Settings → Pages** and set **Source** to *Deploy from a branch*, branch `main`, folder `/ (root)`.

The site uses relative paths and hash-based routing, so it works at `username.github.io/arcade-architects/` and at a custom domain without any configuration.

---

## What the sync script does

Reads every note under `02 - Projects/Girls Who Game/Curriculum Development/Arcade Architects` and writes:

| Output | What it is |
|---|---|
| `content/index.json` | Nav tree, page metadata, table of contents, backlinks, reading order |
| `content/notes/*.html` | One rendered fragment per note |
| `content/search.json` | Full-text search index, loaded only when someone searches |
| `content/images/*` | Only the images a published note actually uses |

Along the way it converts Obsidian syntax the browser does not understand:

- `[[Wikilinks]]`, `[[Note|aliases]]`, and `[[Note#Heading]]` become real links
- `![[screenshot.png]]` embeds become click-to-enlarge images
- `> [!tip]` callouts become styled callout boxes
- Task checkboxes, tables, and GDScript blocks get proper markup

A link pointing at a note that is not published renders as plain grey text rather than a dead link, and the sync report names every one of them.

### The report

Every run prints what it did and what it decided to leave out. Worth a glance:

- **Held back** — notes excluded by config, so you can confirm nothing student-facing was dropped
- **Instructor sections removed** — every heading stripped, by note
- **Links with no published target** — usually a note that lives outside this folder
- **Images referenced but not found** — a broken embed in the vault
- **Images no published note uses** — dead weight, safe to delete from the vault

---

## Configuration

`tools/sync.config.json`:

| Key | What it controls |
|---|---|
| `vaultPath` | Where the vault lives on this computer |
| `curriculumPath` | Folder inside the vault to publish |
| `excludePaths` | Folders never published. `3 - Instructor Guides` is here by default |
| `excludeNotes` | Individual notes to hold back, by note name |
| `stripSections` | Headings removed wherever they appear, along with everything under them until the next heading of the same level |
| `stripLines` | Exact lines to drop, for placeholders like `INSERT IMAGE HERE!` |
| `sections` | Display name, emoji, and blurb for each vault folder |
| `homeNote` / `startHereNote` | The two buttons on the home page |

Renaming a folder in the vault will not break the build. It will show up under its raw folder name in the sidebar until you add it to `sections`.

---

## Publishing decisions baked in

The instructor guide folder is not published, and instructor-only sections are stripped from the notes that remain. Before making the repository public, run a sync and read the **Instructor sections removed** list to confirm it caught what you expect. Anything it names is gone from the site; anything it does not name is live.

---

## Layout

```
index.html            the page shell
assets/css/site.css   theme and layout
assets/js/app.js      routing, search, nav, syntax colouring
content/              generated — do not hand-edit, sync overwrites it
tools/sync.mjs        the build
tools/serve.mjs       local preview server
tools/vendor/         marked (MIT), vendored so the build needs no install
```

`content/` is committed on purpose. GitHub Pages serves files straight from the branch, so the built output has to be in the repository.

---

## Keyboard shortcuts

| Key | Does |
|---|---|
| `Ctrl/⌘ K` or `/` | Search |
| `↑` `↓` `↵` | Move through results and open one |
| `Alt ←` / `Alt →` | Previous and next page |
| `Esc` | Close search, image, or the mobile menu |
