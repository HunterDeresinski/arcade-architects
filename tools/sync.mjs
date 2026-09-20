#!/usr/bin/env node
/**
 * Arcade Architects — vault sync
 *
 * Reads the Arcade Architects curriculum out of the Obsidian vault, converts
 * every note to a self-contained HTML fragment, and writes the result into
 * ./content/ where the site reads it.
 *
 * Usage:
 *   node tools/sync.mjs
 *   node tools/sync.mjs --vault "/some/other/vault"
 *   AA_VAULT="/some/other/vault" node tools/sync.mjs
 *
 * Nothing here writes back to the vault. It is read-only on your notes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from './vendor/marked.esm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ------------------------------------------------------------------ config */

const config = JSON.parse(fs.readFileSync(path.join(HERE, 'sync.config.json'), 'utf8'));

const cliVault = (() => {
  const i = process.argv.indexOf('--vault');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith('--vault='));
  return eq ? eq.slice('--vault='.length) : null;
})();

const VAULT = cliVault || process.env.AA_VAULT || config.vaultPath;
const SOURCE = path.join(VAULT, config.curriculumPath);
const OUT = path.join(ROOT, 'content');
const OUT_NOTES = path.join(OUT, 'notes');
const OUT_IMAGES = path.join(OUT, 'images');

if (!fs.existsSync(SOURCE)) {
  console.error(`\n  Cannot find the curriculum folder.\n  Looked in: ${SOURCE}\n`);
  console.error('  Fix the "vaultPath" in tools/sync.config.json, or pass --vault "/path/to/vault".\n');
  process.exit(1);
}

const report = {
  notes: 0,
  images: 0,
  skipped: [],
  strippedSections: [],
  strippedLines: [],
  unresolvedLinks: [],
  missingImages: [],
  slugCollisions: [],
};

/* ----------------------------------------------------------------- helpers */

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

function slugify(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’“”]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'untitled';
}

function normalizeHeading(text) {
  return String(text)
    .replace(/[\p{Extended_Pictographic}️‍⃣]/gu, '')
    .replace(/[#*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(abs, relPath));
    else out.push({ abs, rel: relPath, name: entry.name });
  }
  return out;
}

function isExcluded(relPath) {
  return (config.excludePaths || []).some(
    (p) => relPath === p || relPath.startsWith(`${p}/`)
  );
}

/* --------------------------------------------------------- markdown prep */

function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { body: raw, tags: [] };
  const tags = [];
  const block = m[1];
  const tagBlock = /tags:\s*\n((?:\s*-\s*.+\n?)+)/.exec(block);
  if (tagBlock) {
    for (const line of tagBlock[1].split('\n')) {
      const t = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (t) tags.push(t[1]);
    }
  } else {
    const inline = /tags:\s*\[(.*?)\]/.exec(block);
    if (inline) tags.push(...inline[1].split(',').map((s) => s.trim()).filter(Boolean));
  }
  return { body: raw.slice(m[0].length), tags };
}

function stripSections(md, names, noteTitle) {
  if (!names || !names.length) return md;
  const wanted = names.map(normalizeHeading);
  const lines = md.split('\n');
  const kept = [];
  let skipLevel = 0;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel) {
        const text = normalizeHeading(h[2]);
        if (wanted.some((w) => text === w || text.startsWith(`${w} `) || text.startsWith(`${w}:`))) {
          skipLevel = level;
          report.strippedSections.push(`${noteTitle} → ${h[2].trim()}`);
          continue;
        }
      }
    }
    if (!skipLevel) kept.push(line);
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\n---\n)(\s*\n)*(?=\n*---\n)/g, '');
}

function stripLines(md, patterns, noteTitle) {
  if (!patterns || !patterns.length) return md;
  return md
    .split('\n')
    .filter((line) => {
      const hit = patterns.some((p) => line.trim() === p);
      if (hit) report.strippedLines.push(`${noteTitle} → ${line.trim()}`);
      return !hit;
    })
    .join('\n');
}

/**
 * Obsidian tolerates an unescaped pipe inside a wikilink in a table row;
 * standard markdown reads it as a new cell. Escape those pipes.
 */
function fixTablePipes(md) {
  return md
    .split('\n')
    .map((line) => (/^\s*\|/.test(line)
      ? line.replace(/\[\[[^\]\n]*\]\]/g, (m) => m.replace(/(?<!\\)\|/g, '\\|'))
      : line))
    .join('\n');
}

function stripProjectTags(md) {
  return md.replace(/[ \t]*#project\/[\w-]+/g, '');
}

function pullTitle(md, fallback) {
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) {
      lines.splice(i, 1);
      return { title: h1[1].trim(), md: lines.join('\n').replace(/^\s*\n/, '') };
    }
    break;
  }
  return { title: fallback, md };
}

function toPlainText(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, ' ')
    .replace(/\[\[([^\]|#]+)(#[^\]|]+)?(\|([^\]]+))?\]\]/g, (_m, tgt, _h, _p, alias) => alias || tgt)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?\[![\w-]+\][+-]?/gm, ' ')
    .replace(/^[>#\-*+|]+/gm, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------- pass one */

const files = walk(SOURCE).filter((f) => {
  if (isExcluded(f.rel)) {
    if (f.name.endsWith('.md')) report.skipped.push(f.rel);
    return false;
  }
  return true;
});

const mdFiles = files.filter((f) => f.name.endsWith('.md'));
const imageFiles = files.filter((f) => IMAGE_EXT.test(f.name));

const excludeNotes = new Set((config.excludeNotes || []).map((n) => n.toLowerCase()));

const notes = [];
const byTitle = new Map(); // lowercase note name -> note
const usedSlugs = new Map();

for (const file of mdFiles) {
  const name = file.name.replace(/\.md$/, '');
  if (excludeNotes.has(name.toLowerCase())) {
    report.skipped.push(file.rel);
    continue;
  }

  let slug = slugify(name);
  if (usedSlugs.has(slug)) {
    report.slugCollisions.push(`${name} and ${usedSlugs.get(slug)}`);
    slug = `${slug}-${usedSlugs.size}`;
  }
  usedSlugs.set(slug, name);

  const dirs = file.rel.split('/').slice(0, -1);
  const note = {
    file: file.abs,
    rel: file.rel,
    name,
    slug,
    dirs,
    raw: fs.readFileSync(file.abs, 'utf8'),
  };
  notes.push(note);
  byTitle.set(name.toLowerCase(), note);
}

// image name -> web filename
const imageMap = new Map();
const usedImageNames = new Set();
for (const img of imageFiles) {
  const ext = path.extname(img.name).toLowerCase();
  let web = `${slugify(path.basename(img.name, path.extname(img.name)))}${ext}`;
  let n = 2;
  while (usedImageNames.has(web)) {
    web = `${slugify(path.basename(img.name, path.extname(img.name)))}-${n}${ext}`;
    n += 1;
  }
  usedImageNames.add(web);
  imageMap.set(img.name.toLowerCase(), { web, abs: img.abs });
}

// prepare bodies, collect headings for cross-note anchor links
for (const note of notes) {
  const { body, tags } = splitFrontmatter(note.raw);
  let md = fixTablePipes(stripProjectTags(body));
  md = stripSections(md, config.stripSections, note.name);
  md = stripLines(md, config.stripLines, note.name);
  const pulled = pullTitle(md, note.name);
  note.title = pulled.title;
  note.md = pulled.md;
  note.tags = tags;
  note.plain = toPlainText(pulled.md);
  note.words = note.plain ? note.plain.split(/\s+/).length : 0;

  note.headingIndex = new Map();
  const used = new Set();
  let inFence = false;
  for (const line of note.md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!h) continue;
    let id = slugify(h[2]);
    let n = 2;
    while (used.has(id)) { id = `${slugify(h[2])}-${n}`; n += 1; }
    used.add(id);
    note.headingIndex.set(normalizeHeading(h[2]), id);
  }
}

/* --------------------------------------------------------- link resolving */

function resolveNote(target) {
  const clean = target.trim().replace(/\.md$/i, '');
  const direct = byTitle.get(clean.toLowerCase());
  if (direct) return direct;
  const base = clean.split('/').pop();
  return byTitle.get(String(base).toLowerCase()) || null;
}

function linkFor(targetNote, heading) {
  let href = `#/${targetNote.slug}`;
  if (heading) {
    const id = targetNote.headingIndex.get(normalizeHeading(heading));
    if (id) href += `#${id}`;
  }
  return href;
}

/* ------------------------------------------------------------ marked setup */

const CALLOUTS = {
  tip: { cls: 'tip', icon: '\u{1F4A1}', label: 'Tip' },
  hint: { cls: 'tip', icon: '\u{1F4A1}', label: 'Tip' },
  note: { cls: 'note', icon: '\u{1F5D2}️', label: 'Note' },
  info: { cls: 'note', icon: 'ℹ️', label: 'Info' },
  todo: { cls: 'note', icon: '✅', label: 'To do' },
  warning: { cls: 'warning', icon: '⚠️', label: 'Watch out' },
  caution: { cls: 'warning', icon: '⚠️', label: 'Watch out' },
  attention: { cls: 'warning', icon: '⚠️', label: 'Watch out' },
  danger: { cls: 'danger', icon: '\u{1F6D1}', label: 'Danger' },
  error: { cls: 'danger', icon: '\u{1F6D1}', label: 'Error' },
  bug: { cls: 'danger', icon: '\u{1F41B}', label: 'Bug' },
  important: { cls: 'important', icon: '❗', label: 'Important' },
  success: { cls: 'success', icon: '✔️', label: 'Done' },
  check: { cls: 'success', icon: '✔️', label: 'Done' },
  question: { cls: 'question', icon: '❓', label: 'Question' },
  faq: { cls: 'question', icon: '❓', label: 'FAQ' },
  example: { cls: 'example', icon: '\u{1F9EA}', label: 'Example' },
  quote: { cls: 'quote', icon: '\u{1F4AC}', label: 'Quote' },
  abstract: { cls: 'note', icon: '\u{1F4CB}', label: 'Summary' },
  summary: { cls: 'note', icon: '\u{1F4CB}', label: 'Summary' },
};

// render-time context, set per note
let ctx = null;

const calloutExtension = {
  name: 'callout',
  level: 'block',
  start(src) {
    const m = /^ {0,3}> *\[!/m.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const rule = /^ {0,3}> *\[!([\w-]+)\]([+-])?[ \t]*([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/;
    const m = rule.exec(src);
    if (!m) return undefined;
    const body = (m[4] || '').replace(/^ {0,3}> ?/gm, '');
    const token = {
      type: 'callout',
      raw: m[0],
      variant: m[1].toLowerCase(),
      fold: m[2] || '',
      titleText: (m[3] || '').trim(),
      tokens: [],
      titleTokens: [],
    };
    token.tokens = this.lexer.blockTokens(body, []);
    if (token.titleText) token.titleTokens = this.lexer.inlineTokens(token.titleText);
    return token;
  },
  renderer(token) {
    const meta = CALLOUTS[token.variant] || { cls: 'note', icon: '\u{1F5D2}️', label: token.variant };
    const title = token.titleTokens.length
      ? this.parser.parseInline(token.titleTokens)
      : escapeHtml(meta.label);
    const body = this.parser.parse(token.tokens);
    const foldable = token.fold ? ' callout--foldable' : '';
    const open = token.fold === '-' ? '' : ' open';
    if (token.fold) {
      return `<details class="callout callout--${meta.cls}${foldable}"${open}>`
        + `<summary class="callout__head"><span class="callout__icon">${meta.icon}</span>`
        + `<span class="callout__title">${title}</span></summary>`
        + `<div class="callout__body">${body}</div></details>`;
    }
    return `<div class="callout callout--${meta.cls}">`
      + `<div class="callout__head"><span class="callout__icon">${meta.icon}</span>`
      + `<span class="callout__title">${title}</span></div>`
      + `<div class="callout__body">${body}</div></div>`;
  },
};

const embedExtension = {
  name: 'wikiembed',
  level: 'inline',
  start(src) {
    const i = src.indexOf('![[');
    return i === -1 ? undefined : i;
  },
  tokenizer(src) {
    const m = /^!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/.exec(src);
    if (!m) return undefined;
    return { type: 'wikiembed', raw: m[0], target: m[1].trim(), opts: (m[2] || '').trim() };
  },
  renderer(token) {
    const key = path.basename(token.target).toLowerCase();
    const found = imageMap.get(key);
    if (!found) {
      if (IMAGE_EXT.test(token.target)) report.missingImages.push(`${ctx.name} → ${token.target}`);
      else report.unresolvedLinks.push(`${ctx.name} → embed ${token.target}`);
      return `<span class="missing-embed">${escapeHtml(token.target)}</span>`;
    }
    ctx.images.add(key);
    const alt = escapeHtml(path.basename(token.target, path.extname(token.target)));
    const width = /^\d+$/.test(token.opts) ? ` style="max-width:${token.opts}px"` : '';
    return `<span class="shot"><button type="button" class="shot__btn" data-zoom aria-label="Enlarge screenshot">`
      + `<img src="content/images/${found.web}" alt="${alt}" loading="lazy" decoding="async"${width}>`
      + `</button></span>`;
  },
};

const wikilinkExtension = {
  name: 'wikilink',
  level: 'inline',
  start(src) {
    const m = /(^|[^!])\[\[/.exec(src);
    if (!m) return undefined;
    return m.index + (m[1] ? m[1].length : 0);
  },
  tokenizer(src) {
    const m = /^\[\[([^\]|#]+?)(#[^\]|]+)?(?:\|([^\]]*))?\]\]/.exec(src);
    if (!m) return undefined;
    return {
      type: 'wikilink',
      raw: m[0],
      target: m[1].trim(),
      heading: m[2] ? m[2].slice(1).trim() : '',
      alias: (m[3] || '').trim(),
    };
  },
  renderer(token) {
    const target = resolveNote(token.target);
    const label = escapeHtml(token.alias || (token.heading ? `${token.target} → ${token.heading}` : token.target));
    if (!target) {
      report.unresolvedLinks.push(`${ctx.name} → [[${token.target}]]`);
      return `<span class="link-missing" title="Not published on this site">${label}</span>`;
    }
    ctx.links.add(target.slug);
    return `<a class="wikilink" href="${linkFor(target, token.heading)}" data-note="${target.slug}">${label}</a>`;
  },
};

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ extensions: [calloutExtension, embedExtension, wikilinkExtension] });

marked.use({
  renderer: {
    heading(token) {
      const text = this.parser.parseInline(token.tokens);
      const plain = normalizeHeading(token.text);
      let id = slugify(token.text);
      let n = 2;
      while (ctx.usedIds.has(id)) { id = `${slugify(token.text)}-${n}`; n += 1; }
      ctx.usedIds.add(id);
      ctx.headings.push({ id, text: token.text.replace(/[*_`]/g, '').trim(), level: token.depth, plain });
      return `<h${token.depth} id="${id}" class="heading">`
        + `<a class="heading__anchor" href="#/${ctx.slug}#${id}" aria-label="Link to this section">#</a>`
        + `${text}</h${token.depth}>`;
    },
    code(token) {
      const lang = (token.lang || '').trim().split(/\s+/)[0] || 'text';
      const label = lang === 'gdscript' ? 'GDScript' : lang.toUpperCase();
      return `<div class="codeblock" data-lang="${escapeHtml(label)}">`
        + `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(token.text)}</code></pre></div>`;
    },
    table(token) {
      const header = token.header
        .map((cell, i) => `<th${align(token.align[i])}>${this.parser.parseInline(cell.tokens)}</th>`)
        .join('');
      const body = token.rows
        .map((row) => `<tr>${row
          .map((cell, i) => `<td${align(token.align[i])}>${this.parser.parseInline(cell.tokens)}</td>`)
          .join('')}</tr>`)
        .join('');
      return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
    },
    link(token) {
      const href = token.href || '';
      const text = this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      if (/^https?:\/\//i.test(href)) {
        return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer" class="extlink">${text}</a>`;
      }
      return `<a href="${escapeHtml(href)}"${title}>${text}</a>`;
    },
    image(token) {
      const src = token.href || '';
      const local = imageMap.get(path.basename(src).toLowerCase());
      const url = local ? `content/images/${local.web}` : src;
      if (local) ctx.images.add(path.basename(src).toLowerCase());
      return `<span class="shot"><button type="button" class="shot__btn" data-zoom aria-label="Enlarge image">`
        + `<img src="${escapeHtml(url)}" alt="${escapeHtml(token.text || '')}" loading="lazy" decoding="async"></button></span>`;
    },
    checkbox(token) {
      return `<span class="task-box${token.checked ? ' task-box--done' : ''}" aria-hidden="true"></span>`;
    },
  },
});

function align(a) {
  return a ? ` style="text-align:${a}"` : '';
}

/* ------------------------------------------------------------- pass two */

rmrf(OUT_NOTES);
rmrf(OUT_IMAGES);
fs.mkdirSync(OUT_NOTES, { recursive: true });
fs.mkdirSync(OUT_IMAGES, { recursive: true });

for (const note of notes) {
  ctx = {
    name: note.name,
    slug: note.slug,
    headings: [],
    usedIds: new Set(),
    links: new Set(),
    images: new Set(),
  };
  note.html = marked.parse(note.md);
  note.toc = ctx.headings.filter((h) => h.level === 2 || h.level === 3);
  note.links = [...ctx.links];
  note.usedImages = [...ctx.images];
  fs.writeFileSync(path.join(OUT_NOTES, `${note.slug}.html`), note.html);
  report.notes += 1;
}

// copy only the images actually referenced
const referenced = new Set(notes.flatMap((n) => n.usedImages));
for (const key of referenced) {
  const img = imageMap.get(key);
  if (!img) continue;
  fs.copyFileSync(img.abs, path.join(OUT_IMAGES, img.web));
  report.images += 1;
}
const unusedImages = [...imageMap.keys()].filter((k) => !referenced.has(k));

/* ------------------------------------------------------------- nav tree */

function sectionMeta(folderName) {
  const meta = (config.sections || {})[folderName] || {};
  return {
    title: meta.title || folderName.replace(/^\d+\s*-\s*/, ''),
    icon: meta.icon || '\u{1F4C1}',
    blurb: meta.blurb || '',
  };
}

function buildTree(list) {
  const root = { children: new Map(), notes: [] };
  for (const note of list) {
    let cursor = root;
    for (const dir of note.dirs) {
      if (!cursor.children.has(dir)) {
        cursor.children.set(dir, { name: dir, children: new Map(), notes: [] });
      }
      cursor = cursor.children.get(dir);
    }
    cursor.notes.push(note);
  }
  return root;
}

function sortNotes(list) {
  return [...list].sort((a, b) => {
    const da = /^Day (\d+)/.exec(a.name);
    const db = /^Day (\d+)/.exec(b.name);
    if (da && db) return Number(da[1]) - Number(db[1]);
    const ia = /index$/i.test(a.name);
    const ib = /index$/i.test(b.name);
    if (ia !== ib) return ia ? -1 : 1;
    return a.title.localeCompare(b.title, 'en');
  });
}

function serializeTree(node, depth = 0) {
  const groups = [];
  const dirNames = [...node.children.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const dirName of dirNames) {
    const child = node.children.get(dirName);
    const meta = sectionMeta(dirName);
    groups.push({
      type: 'group',
      id: slugify(dirName),
      title: meta.title,
      icon: meta.icon,
      blurb: meta.blurb,
      depth,
      notes: sortNotes(child.notes).map((n) => ({ slug: n.slug, title: n.title })),
      groups: serializeTree(child, depth + 1),
    });
  }
  return groups;
}

const tree = buildTree(notes);
const rootNotes = sortNotes(tree.notes).map((n) => ({ slug: n.slug, title: n.title }));
const navGroups = serializeTree(tree);

// reading order for prev / next
const order = [];
for (const n of rootNotes) order.push(n.slug);
(function flatten(groups) {
  for (const g of groups) {
    for (const n of g.notes) order.push(n.slug);
    flatten(g.groups);
  }
})(navGroups);

/* ------------------------------------------------------------- backlinks */

const backlinks = new Map();
for (const note of notes) {
  for (const target of note.links) {
    if (target === note.slug) continue;
    if (!backlinks.has(target)) backlinks.set(target, new Set());
    backlinks.get(target).add(note.slug);
  }
}

/* ---------------------------------------------------------------- output */

const bySlug = new Map(notes.map((n) => [n.slug, n]));
const notesOut = {};
for (const note of notes) {
  const pos = order.indexOf(note.slug);
  const prevSlug = pos > 0 ? order[pos - 1] : null;
  const nextSlug = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : null;
  const sectionDir = note.dirs[note.dirs.length - 1];
  notesOut[note.slug] = {
    title: note.title,
    section: sectionDir ? sectionMeta(sectionDir).title : 'Overview',
    sectionIcon: sectionDir ? sectionMeta(sectionDir).icon : '\u{1F3AF}',
    path: note.dirs.map((d) => sectionMeta(d).title),
    tags: note.tags.filter((t) => t !== 'girls-who-game' && t !== 'girlswhogame'),
    toc: note.toc.map((h) => ({ id: h.id, text: h.text, level: h.level })),
    words: note.words,
    minutes: Math.max(1, Math.round(note.words / 190)),
    links: note.links,
    backlinks: [...(backlinks.get(note.slug) || [])]
      .map((s) => ({ slug: s, title: bySlug.get(s)?.title || s }))
      .sort((a, b) => a.title.localeCompare(b.title, 'en')),
    prev: prevSlug ? { slug: prevSlug, title: bySlug.get(prevSlug)?.title } : null,
    next: nextSlug ? { slug: nextSlug, title: bySlug.get(nextSlug)?.title } : null,
  };
}

const homeNote = resolveNote(config.homeNote || '');
const startNote = resolveNote(config.startHereNote || '');

const index = {
  generatedAt: new Date().toISOString(),
  site: {
    title: config.siteTitle,
    tagline: config.siteTagline,
    footer: config.siteFooter,
  },
  home: {
    mapSlug: homeNote ? homeNote.slug : null,
    startSlug: startNote ? startNote.slug : null,
  },
  rootNotes,
  nav: navGroups,
  order,
  notes: notesOut,
  counts: { notes: notes.length, images: report.images },
};

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));

const search = notes.map((n) => ({
  s: n.slug,
  t: n.title,
  c: notesOut[n.slug].section,
  h: n.toc.map((h) => h.text),
  b: n.plain,
}));
fs.writeFileSync(path.join(OUT, 'search.json'), JSON.stringify(search));

/* ---------------------------------------------------------------- report */

const line = (n) => `  ${n}`;
console.log(`\n  Arcade Architects — sync complete`);
console.log(line(`source   ${SOURCE}`));
console.log(line(`notes    ${report.notes} published`));
console.log(line(`images   ${report.images} copied${unusedImages.length ? `, ${unusedImages.length} unused` : ''}`));

if (report.skipped.length) {
  console.log(`\n  Held back (not published):`);
  for (const s of report.skipped) console.log(line(`- ${s}`));
}
if (report.strippedSections.length) {
  console.log(`\n  Instructor sections removed:`);
  for (const s of report.strippedSections) console.log(line(`- ${s}`));
}
if (report.strippedLines.length) {
  console.log(`\n  Placeholder lines removed:`);
  for (const s of report.strippedLines) console.log(line(`- ${s}`));
}
if (report.unresolvedLinks.length) {
  console.log(`\n  Links with no published target (shown as plain text):`);
  for (const s of [...new Set(report.unresolvedLinks)]) console.log(line(`- ${s}`));
}
if (report.missingImages.length) {
  console.log(`\n  Images referenced but not found in the vault:`);
  for (const s of [...new Set(report.missingImages)]) console.log(line(`- ${s}`));
}
if (report.slugCollisions.length) {
  console.log(`\n  Note names that collided (second one got a suffix):`);
  for (const s of report.slugCollisions) console.log(line(`- ${s}`));
}
if (unusedImages.length) {
  console.log(`\n  Images in the vault that no published note uses:`);
  for (const s of unusedImages) console.log(line(`- ${s}`));
}
console.log(`\n  Output in ${path.relative(process.cwd(), OUT) || 'content'}/ — commit and push to update the site.\n`);
