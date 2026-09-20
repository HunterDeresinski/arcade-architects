/* =========================================================================
   Arcade Architects — site behaviour
   Reads content/index.json + content/notes/*.html produced by tools/sync.mjs
   ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const el = {
  view: $('#view'),
  nav: $('#nav'),
  toc: $('#toc'),
  main: $('#main'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  menuBtn: $('#menuBtn'),
  themeBtn: $('#themeBtn'),
  searchBtn: $('#searchBtn'),
  palette: $('#palette'),
  q: $('#q'),
  results: $('#results'),
  navFilter: $('#navFilter'),
  progress: $('#progress'),
  lightbox: $('#lightbox'),
  lightboxImg: $('#lightboxImg'),
  footText: $('#footText'),
  stamp: $('#stamp'),
};

const state = {
  index: null,
  search: null,
  slug: null,
  cache: new Map(),
  rendered: null,
  headings: [],
  selected: 0,
  results: [],
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* ------------------------------------------------------------------- theme */

const THEME_KEY = 'aa-theme';

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f4f6fd' : '#070b1f';
}

applyTheme(readStored(THEME_KEY) || 'dark');

el.themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  writeStored(THEME_KEY, next);
});

if (navigator.platform && /mac|iphone|ipad/i.test(navigator.platform)) {
  const mod = $('#kbdMod');
  if (mod) mod.textContent = '⌘';
}

/* --------------------------------------------------------- syntax colouring */

const GD_RE = new RegExp([
  '(#[^\\n]*)',                                                  // 1 comment
  '("""[\\s\\S]*?"""|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')', // 2 string
  '(@[A-Za-z_]\\w*)',                                            // 3 annotation
  '(\\$[\\w/%.\\-]+)',                                           // 4 node path
  '\\b(and|as|assert|await|break|breakpoint|class_name|class|const|continue|elif|else|enum|export|extends|for|func|if|in|is|match|not|onready|or|pass|preload|return|self|signal|static|super|tool|var|while|yield|true|false|null)\\b', // 5 keyword
  '\\b(\\d[\\d_]*\\.?\\d*(?:e[+-]?\\d+)?)\\b',                   // 6 number
  '\\b([A-Za-z_]\\w*)(?=\\s*\\()',                               // 7 call
  '\\b([A-Z][A-Za-z0-9_]*)\\b',                                  // 8 type
].join('|'), 'g');

const PLAIN_LANGS = new Set(['text', 'plain', 'txt', 'none', 'tree', 'output', 'console', 'bash', 'sh', 'shell']);

const CLASSES = [null, 'tok-com', 'tok-str', 'tok-ann', 'tok-node', 'tok-kw', 'tok-num', 'tok-fn', 'tok-type'];

function highlight(source) {
  let out = '';
  let last = 0;
  GD_RE.lastIndex = 0;
  let m = GD_RE.exec(source);
  while (m) {
    out += escapeHtml(source.slice(last, m.index));
    let cls = null;
    for (let g = 1; g < CLASSES.length; g += 1) {
      if (m[g] !== undefined) { cls = CLASSES[g]; break; }
    }
    out += cls ? `<span class="${cls}">${escapeHtml(m[0])}</span>` : escapeHtml(m[0]);
    last = m.index + m[0].length;
    m = GD_RE.exec(source);
  }
  out += escapeHtml(source.slice(last));
  return out;
}

/* ------------------------------------------------------------------ routing */

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw || raw === '/') return { slug: null, anchor: null };
  const [routePart, anchorPart] = raw.split('#');
  return { slug: routePart.replace(/^\//, '') || null, anchor: anchorPart || null };
}

function go(slug, anchor) {
  location.hash = anchor ? `#/${slug}#${anchor}` : `#/${slug}`;
}

/* --------------------------------------------------------------------- nav */

function countNotes(group) {
  return group.notes.length + group.groups.reduce((sum, g) => sum + countNotes(g), 0);
}

function navGroupHtml(group) {
  const kids = group.groups.map(navGroupHtml).join('');
  const links = group.notes
    .map((n) => `<a class="nav__link" href="#/${n.slug}" data-slug="${n.slug}">${escapeHtml(n.title)}</a>`)
    .join('');
  const count = countNotes(group);
  return `<div class="nav__group" data-group="${group.id}" data-open="false">
    <button class="nav__toggle" type="button" aria-expanded="false">
      <svg class="nav__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      <span class="nav__emoji" aria-hidden="true">${group.icon}</span>
      <span>${escapeHtml(group.title)}</span>
      <span class="nav__count">${count}</span>
    </button>
    <div class="nav__body">${links}${kids}</div>
  </div>`;
}

function buildNav() {
  const roots = state.index.rootNotes
    .map((n) => `<a class="nav__link" href="#/${n.slug}" data-slug="${n.slug}">${escapeHtml(n.title)}</a>`)
    .join('');
  el.nav.innerHTML = `
    <a class="nav__link" href="#/" data-slug="__home">Home</a>
    ${roots}
    <div class="nav__section-label">Curriculum</div>
    ${state.index.nav.map(navGroupHtml).join('')}`;

  $$('.nav__toggle', el.nav).forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.nav__group');
      const open = group.dataset.open === 'true';
      group.dataset.open = open ? 'false' : 'true';
      btn.setAttribute('aria-expanded', String(!open));
      const openIds = $$('.nav__group[data-open="true"]', el.nav).map((g) => g.dataset.group);
      writeStored('aa-nav-open', JSON.stringify(openIds));
    });
  });

  let stored = [];
  try { stored = JSON.parse(readStored('aa-nav-open') || '[]'); } catch { stored = []; }
  if (!stored.length) stored = state.index.nav.slice(0, 1).map((g) => g.id);
  stored.forEach((id) => {
    const group = $(`.nav__group[data-group="${CSS.escape(id)}"]`, el.nav);
    if (group) {
      group.dataset.open = 'true';
      $('.nav__toggle', group)?.setAttribute('aria-expanded', 'true');
    }
  });
}

function markActiveNav() {
  $$('.nav__link', el.nav).forEach((link) => {
    const active = link.dataset.slug === (state.slug || '__home');
    link.classList.toggle('is-active', active);
    if (active) {
      let parent = link.closest('.nav__group');
      while (parent) {
        parent.dataset.open = 'true';
        $('.nav__toggle', parent)?.setAttribute('aria-expanded', 'true');
        parent = parent.parentElement.closest('.nav__group');
      }
      const box = el.sidebar.querySelector('.sidebar__inner');
      const lr = link.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (lr.top < br.top + 8 || lr.bottom > br.bottom - 8) {
        box.scrollTop += lr.top - br.top - br.height / 2;
      }
    }
  });
}

el.navFilter.addEventListener('input', () => {
  const term = el.navFilter.value.trim().toLowerCase();
  if (!term) {
    $$('.nav__group', el.nav).forEach((g) => { g.hidden = false; });
    $$('.nav__link', el.nav).forEach((l) => { l.hidden = false; });
    $('.nav__empty', el.nav)?.remove();
    markActiveNav();
    return;
  }
  let hits = 0;
  $$('.nav__link', el.nav).forEach((link) => {
    if (link.dataset.slug === '__home') { link.hidden = true; return; }
    const match = link.textContent.toLowerCase().includes(term);
    link.hidden = !match;
    if (match) hits += 1;
  });
  $$('.nav__group', el.nav).forEach((group) => {
    const visible = $$('.nav__link', group).some((l) => !l.hidden);
    group.hidden = !visible;
    if (visible) {
      group.dataset.open = 'true';
      $('.nav__toggle', group)?.setAttribute('aria-expanded', 'true');
    }
  });
  $('.nav__empty', el.nav)?.remove();
  if (!hits) el.nav.insertAdjacentHTML('beforeend', '<p class="nav__empty">No page matches that.</p>');
});

/* -------------------------------------------------------------------- views */

function homeView() {
  const { index } = state;
  const days = (index.nav.find((g) => /daily/i.test(g.title))?.notes) || [];
  const sections = index.nav;
  const startSlug = index.home.startSlug || days[0]?.slug;
  const mapSlug = index.home.mapSlug;

  const dayCards = days.map((d, i) => {
    const meta = index.notes[d.slug];
    return `<a class="daycard" href="#/${d.slug}">
      <span class="daycard__num">Day ${i + 1}</span>
      <span class="daycard__title">${escapeHtml(d.title.replace(/^Day\s*\d+\s*[—–-]\s*/, ''))}</span>
      <span class="daycard__meta">${meta ? `${meta.minutes} min read` : ''}</span>
    </a>`;
  }).join('');

  const cards = sections.map((g) => {
    const count = countNotes(g);
    const first = g.notes[0]?.slug || g.groups[0]?.notes[0]?.slug;
    if (!first) return '';
    return `<a class="sectioncard" href="#/${first}">
      <span class="sectioncard__icon" aria-hidden="true">${g.icon}</span>
      <span class="sectioncard__title">${escapeHtml(g.title)}</span>
      <span class="sectioncard__blurb">${escapeHtml(g.blurb || '')}</span>
      <span class="sectioncard__count">${count} page${count === 1 ? '' : 's'}</span>
    </a>`;
  }).join('');

  el.view.innerHTML = `<div class="home">
    <section class="hero">
      <p class="hero__kicker">COMO Girls Who Game</p>
      <h1 class="hero__title">${escapeHtml(index.site.title)}</h1>
      <p class="hero__sub">${escapeHtml(index.site.tagline)}</p>
      <div class="hero__actions">
        ${startSlug ? `<a class="btn btn--primary" href="#/${startSlug}">Start with Day 1
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>` : ''}
        ${mapSlug ? `<a class="btn btn--ghost" href="#/${mapSlug}">See the whole map</a>` : ''}
      </div>
    </section>

    ${days.length ? `<h2>The week</h2><div class="daygrid">${dayCards}</div>` : ''}

    <h2>Everything in here</h2>
    <div class="cardgrid">${cards}</div>
  </div>`;

  document.title = index.site.title;
  el.toc.innerHTML = '';
  window.scrollTo({ top: 0 });
}

async function loadNote(slug) {
  if (state.cache.has(slug)) return state.cache.get(slug);
  const res = await fetch(`content/notes/${encodeURIComponent(slug)}.html`);
  if (!res.ok) throw new Error(`Missing note: ${slug}`);
  const html = await res.text();
  state.cache.set(slug, html);
  return html;
}

function prefetch(slug) {
  if (!slug || state.cache.has(slug)) return;
  loadNote(slug).catch(() => {});
}

async function noteView(slug, anchor) {
  const meta = state.index.notes[slug];
  if (!meta) return notFound(slug);

  let html;
  try {
    html = await loadNote(slug);
  } catch {
    return notFound(slug);
  }

  const crumbs = ['<a href="#/">Home</a>', ...meta.path.map((p) => `<span>${escapeHtml(p)}</span>`)]
    .join('<span aria-hidden="true">/</span>');

  const backlinks = meta.backlinks.length
    ? `<section class="backlinks"><h2>Linked from</h2><ul>${meta.backlinks
      .map((b) => `<li><a href="#/${b.slug}">${escapeHtml(b.title)}</a></li>`).join('')}</ul></section>`
    : '';

  const pager = (meta.prev || meta.next)
    ? `<nav class="pager" aria-label="Previous and next page">
        ${meta.prev ? `<a class="pager__link" href="#/${meta.prev.slug}">
          <span class="pager__dir">← Previous</span>
          <span class="pager__title">${escapeHtml(meta.prev.title)}</span></a>` : '<span></span>'}
        ${meta.next ? `<a class="pager__link pager__link--next" href="#/${meta.next.slug}">
          <span class="pager__dir">Next →</span>
          <span class="pager__title">${escapeHtml(meta.next.title)}</span></a>` : ''}
      </nav>`
    : '';

  el.view.innerHTML = `<article class="article">
    <div class="crumbs">${crumbs}</div>
    <h1 class="article__title">${escapeHtml(meta.title)}<span class="accentbar" aria-hidden="true"></span></h1>
    <div class="article__meta">
      <span class="chip"><span aria-hidden="true">${meta.sectionIcon}</span> ${escapeHtml(meta.section)}</span>
      <span>${meta.minutes} min read</span>
      ${meta.tags.map((t) => `<span class="chip">#${escapeHtml(t)}</span>`).join('')}
    </div>
    <div class="body">${html}</div>
    ${backlinks}
    ${pager}
  </article>`;

  state.rendered = slug;
  document.title = `${meta.title} · ${state.index.site.title}`;
  enhance();
  buildToc(meta);
  prefetch(meta.next?.slug);
  prefetch(meta.prev?.slug);

  if (anchor) {
    const target = document.getElementById(anchor);
    if (target) {
      requestAnimationFrame(() => target.scrollIntoView({ block: 'start', behavior: 'auto' }));
      return;
    }
  }
  window.scrollTo({ top: 0 });
}

function notFound(slug) {
  el.view.innerHTML = `<article class="article">
    <h1 class="article__title">Page not found<span class="accentbar" aria-hidden="true"></span></h1>
    <p>There is no page called <code>${escapeHtml(slug || '')}</code> on this site.</p>
    <p>It may be a note that lives in the vault but is not published here. Try the
      <a href="#/">home page</a> or press <kbd>/</kbd> to search.</p>
  </article>`;
  el.toc.innerHTML = '';
}

/* ------------------------------------------------------- article enhancers */

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4 10-10"/></svg>';

function enhance() {
  $$('.codeblock', el.view).forEach((block) => {
    const code = $('code', block);
    const lang = (code?.className.match(/lang-([\w+-]+)/) || [])[1] || 'text';
    if (code && !PLAIN_LANGS.has(lang)) code.innerHTML = highlight(code.textContent);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copybtn';
    btn.innerHTML = `${COPY_ICON}<span>Copy</span>`;
    btn.addEventListener('click', async () => {
      const text = code ? code.textContent : '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btn.classList.add('is-done');
      btn.innerHTML = `${DONE_ICON}<span>Copied</span>`;
      setTimeout(() => {
        btn.classList.remove('is-done');
        btn.innerHTML = `${COPY_ICON}<span>Copy</span>`;
      }, 1600);
    });
    block.appendChild(btn);
  });

  $$('[data-zoom]', el.view).forEach((btn) => {
    btn.addEventListener('click', () => {
      const img = $('img', btn);
      if (!img) return;
      el.lightboxImg.src = img.src;
      el.lightboxImg.alt = img.alt;
      el.lightbox.hidden = false;
      document.body.style.overflow = 'hidden';
    });
  });

  $$('a.wikilink', el.view).forEach((link) => {
    link.addEventListener('mouseenter', () => prefetch(link.dataset.note), { once: true });
  });
}

function buildToc(meta) {
  state.headings = [];
  if (!meta.toc.length) { el.toc.innerHTML = ''; return; }
  el.toc.innerHTML = `<div class="toc__title">On this page</div>
    ${meta.toc.map((h) => `<a class="lvl-${h.level}" href="#/${state.slug}#${h.id}" data-id="${h.id}">${escapeHtml(h.text)}</a>`).join('')}`;
  state.headings = meta.toc
    .map((h) => ({ id: h.id, node: document.getElementById(h.id) }))
    .filter((h) => h.node);
}

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    el.progress.style.width = `${max > 0 ? Math.min(100, (doc.scrollTop / max) * 100) : 0}%`;

    if (!state.headings.length) return;
    let current = state.headings[0].id;
    for (const h of state.headings) {
      if (h.node.getBoundingClientRect().top <= 130) current = h.id;
      else break;
    }
    $$('a', el.toc).forEach((a) => a.classList.toggle('is-current', a.dataset.id === current));
  });
}
window.addEventListener('scroll', onScroll, { passive: true });

/* ------------------------------------------------------------------ search */

async function ensureSearch() {
  if (state.search) return state.search;
  const res = await fetch('content/search.json');
  state.search = await res.json();
  return state.search;
}

function snippet(text, terms) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 70);
  const raw = `${start > 0 ? '…' : ''}${text.slice(start, start + 190)}${text.length > start + 190 ? '…' : ''}`;
  let out = escapeHtml(raw);
  for (const term of terms) {
    if (term.length < 2) continue;
    out = out.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  }
  return out;
}

function fuzzyHit(haystack, needle) {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return false;
}

function runSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const note of state.search) {
    const title = note.t.toLowerCase();
    const body = note.b.toLowerCase();
    let score = 0;

    if (title === q) score += 900;
    else if (title.startsWith(q)) score += 420;
    else if (title.includes(q)) score += 240;
    else if (fuzzyHit(title, q.replace(/\s+/g, ''))) score += 70;

    score += note.h.filter((h) => h.toLowerCase().includes(q)).length * 55;

    const at = body.indexOf(q);
    if (at !== -1) score += 70 + Math.max(0, 25 - Math.floor(at / 600));

    for (const term of terms) {
      if (title.includes(term)) score += 45;
      else if (note.h.some((h) => h.toLowerCase().includes(term))) score += 22;
      else if (body.includes(term)) score += 14;
      else score -= 34;
    }

    if (score > 0) scored.push({ note, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.note.t.localeCompare(b.note.t))
    .slice(0, 30)
    .map(({ note }) => ({
      slug: note.s,
      title: note.t,
      section: note.c,
      snippet: snippet(note.b, terms),
    }));
}

function renderResults() {
  if (!state.results.length) {
    el.results.innerHTML = el.q.value.trim()
      ? '<p class="palette__empty">Nothing matches that. Try a node name, a mechanic, or a day.</p>'
      : '<p class="palette__empty">Start typing — lessons, node names, mechanics, glossary terms.</p>';
    return;
  }
  el.results.innerHTML = state.results.map((r, i) => `
    <a class="res${i === state.selected ? ' is-sel' : ''}" href="#/${r.slug}" data-i="${i}">
      <span class="res__top">
        <span class="res__title">${escapeHtml(r.title)}</span>
        <span class="res__sec">${escapeHtml(r.section)}</span>
      </span>
      <span class="res__snip">${r.snippet}</span>
    </a>`).join('');
  $$('.res', el.results).forEach((node) => {
    node.addEventListener('mousemove', () => {
      state.selected = Number(node.dataset.i);
      $$('.res', el.results).forEach((n) => n.classList.toggle('is-sel', n === node));
    });
    node.addEventListener('click', closePalette);
  });
}

async function openPalette() {
  el.palette.hidden = false;
  document.body.style.overflow = 'hidden';
  el.q.value = '';
  state.results = [];
  state.selected = 0;
  renderResults();
  el.q.focus();
  await ensureSearch();
}

function closePalette() {
  el.palette.hidden = true;
  document.body.style.overflow = '';
}

el.searchBtn.addEventListener('click', openPalette);
$$('[data-close]', el.palette).forEach((node) => node.addEventListener('click', closePalette));

el.q.addEventListener('input', () => {
  state.results = state.search ? runSearch(el.q.value) : [];
  state.selected = 0;
  renderResults();
});

el.q.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!state.results.length) return;
    state.selected = (state.selected + (event.key === 'ArrowDown' ? 1 : -1) + state.results.length) % state.results.length;
    renderResults();
    $('.res.is-sel', el.results)?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const hit = state.results[state.selected];
    if (hit) { go(hit.slug); closePalette(); }
  }
});

/* --------------------------------------------------------------- shortcuts */

document.addEventListener('keydown', (event) => {
  const typing = /^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable;

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    el.palette.hidden ? openPalette() : closePalette();
    return;
  }
  if (event.key === '/' && !typing && el.palette.hidden) {
    event.preventDefault();
    openPalette();
    return;
  }
  if (event.key === 'Escape') {
    if (!el.palette.hidden) closePalette();
    if (!el.lightbox.hidden) closeLightbox();
    closeDrawer();
    return;
  }
  if (typing || !el.palette.hidden) return;

  const meta = state.slug ? state.index?.notes[state.slug] : null;
  if (event.key === 'ArrowLeft' && event.altKey && meta?.prev) go(meta.prev.slug);
  if (event.key === 'ArrowRight' && event.altKey && meta?.next) go(meta.next.slug);
});

/* ---------------------------------------------------------------- lightbox */

function closeLightbox() {
  el.lightbox.hidden = true;
  el.lightboxImg.src = '';
  document.body.style.overflow = '';
}
el.lightbox.addEventListener('click', closeLightbox);

/* ------------------------------------------------------------ mobile drawer */

function openDrawer() {
  el.sidebar.classList.add('is-open');
  el.scrim.hidden = false;
  el.menuBtn.setAttribute('aria-expanded', 'true');
}
function closeDrawer() {
  el.sidebar.classList.remove('is-open');
  el.scrim.hidden = true;
  el.menuBtn.setAttribute('aria-expanded', 'false');
}
el.menuBtn.addEventListener('click', () => {
  el.sidebar.classList.contains('is-open') ? closeDrawer() : openDrawer();
});
el.scrim.addEventListener('click', closeDrawer);

/* -------------------------------------------------------------------- boot */

async function route() {
  const { slug, anchor } = parseHash();
  closeDrawer();

  // already on this page: just move to the section, keep the DOM
  if (slug && slug === state.rendered && state.slug === slug) {
    const target = anchor ? document.getElementById(anchor) : null;
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  state.slug = slug;
  if (!slug) { state.rendered = null; homeView(); }
  else await noteView(slug, anchor);
  markActiveNav();
  onScroll();
}

async function boot() {
  try {
    const res = await fetch('content/index.json');
    if (!res.ok) throw new Error('index missing');
    state.index = await res.json();
  } catch {
    el.view.innerHTML = `<article class="article">
      <h1 class="article__title">No content yet<span class="accentbar" aria-hidden="true"></span></h1>
      <p>This site has not been built from the vault yet. From the repository folder, run:</p>
      <div class="codeblock" data-lang="Terminal"><pre><code>npm run sync</code></pre></div>
      <p>That reads the curriculum out of your Obsidian vault and fills <code>content/</code>.
      If you are opening <code>index.html</code> straight from disk, start a local server instead:
      <code>npm start</code>.</p>
    </article>`;
    return;
  }

  el.footText.textContent = state.index.site.footer || '';
  const built = new Date(state.index.generatedAt);
  el.stamp.textContent = `updated ${built.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;

  buildNav();
  window.addEventListener('hashchange', route);
  await route();
}

boot();
