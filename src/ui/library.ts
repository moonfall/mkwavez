import { h, icon } from './dom';

/**
 * Shared Generate library list (Seed presets, Mutate mutations): search, entries grouped
 * under headings with a tag and a thumbnail canvas, ▲/▼ and arrow-key stepping within
 * the results. Below COMPACT_LIBRARY it collapses to one row ▲ · Group › Name (pos) · ▼;
 * tapping the name opens the list inline. Thumbnails are drawn by the owner (`thumbs`).
 */
export const COMPACT_LIBRARY = '(max-width: 719px)';

const UP = 'M6 15l6-6 6 6';
const DOWN = 'M6 9l6 6 6-6';

export interface LibraryItem {
  id: string;
  group: string;
  name: string;
  /** Small tag after the name (e.g. "f(x)", "rnd"); omitted when undefined. */
  tag?: string;
  tagTitle?: string;
  /** Text the search matches (lower-cased here). */
  search: string;
}

export interface LibraryOpts {
  /** Element id prefix: `${p}-list`, `-search`, `-pos`, `-current`, `-up`, `-down`, `-empty`. */
  idPrefix: string;
  title: string;
  placeholder: string;
  items: readonly LibraryItem[];
  initial: number;
  /** The selection changed (from → to). */
  onChange(to: number, from: number): void;
  /** Thumbnails may need drawing: the list was opened, filtered or scrolled. */
  onThumbs(): void;
}

export interface Library {
  el: HTMLElement;
  /** One thumbnail canvas per item (fixed CSS size; drawn by the owner). */
  thumbs: readonly HTMLCanvasElement[];
  selected(): number;
  filtered(): readonly number[];
  select(i: number, focus?: boolean): void;
  /** The list is showing (always on the wide layout; once opened on the compact one). */
  listShown(): boolean;
  /** Filtered items at least partly inside the list's scroll viewport (plus a margin). */
  inView(margin?: number): number[];
}

export function buildLibrary(opts: LibraryOpts): Library {
  const { idPrefix: p, items } = opts;
  const compactMq = matchMedia(COMPACT_LIBRARY);
  let sel = opts.initial;
  let filtered: number[] = items.map((_, i) => i);
  let open = false;

  const hay = items.map((e) => e.search.toLowerCase());
  const list = h('div', { id: `${p}-list`, class: 'gen-lib-list', role: 'group', 'aria-label': opts.title });
  const buttons: HTMLButtonElement[] = [];
  const thumbs: HTMLCanvasElement[] = [];
  const groupTitles = new Map<string, HTMLElement>();
  items.forEach((e, i) => {
    if (!groupTitles.has(e.group)) {
      const t = h('div', { class: 'gen-lib-group' }, e.group);
      groupTitles.set(e.group, t);
      list.append(t);
    }
    const thumb = h('canvas', { class: 'gen-thumb', 'aria-hidden': 'true' });
    const b = h(
      'button',
      { class: 'gen-entry', 'data-id': e.id, tabindex: -1, onclick: () => pick(i) },
      h('span', { class: 'gen-entry-name' }, e.name),
      e.tag !== undefined ? h('span', { class: 'gen-tag', title: e.tagTitle }, e.tag) : null,
      thumb,
    );
    buttons.push(b);
    thumbs.push(thumb);
    list.append(b);
  });
  const empty = h('p', { class: 'gen-lib-empty', id: `${p}-empty`, hidden: true });
  list.append(empty);
  list.addEventListener('scroll', () => opts.onThumbs(), { passive: true });
  // A taller list (window resize, list opened) reveals entries whose thumbnails need drawing.
  new ResizeObserver(() => opts.onThumbs()).observe(list);

  const search = h('input', {
    type: 'search',
    id: `${p}-search`,
    class: 'gen-lib-search',
    placeholder: opts.placeholder,
    'aria-label': `Search ${opts.title.toLowerCase()}`,
    'aria-controls': `${p}-list`,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
  });
  const pos = h('span', { class: 'gen-lib-pos', id: `${p}-pos` });
  const curGroup = h('span', { class: 'gen-cur-cat' });
  const curName = h('span', { class: 'gen-cur-name' });
  const curPos = h('span', { class: 'gen-cur-pos' });
  const currentBtn = h(
    'button',
    {
      id: `${p}-current`,
      class: 'gen-lib-current',
      'aria-expanded': 'false',
      'aria-controls': `${p}-lib-body`,
      onclick: () => setOpen(!open),
    },
    curGroup,
    curName,
    curPos,
  );
  const upBtn = h('button', { id: `${p}-up`, class: 'gen-lib-step', 'aria-label': 'Previous entry', onclick: () => step(-1, false) }, icon(UP));
  const downBtn = h('button', { id: `${p}-down`, class: 'gen-lib-step', 'aria-label': 'Next entry', onclick: () => step(1, false) }, icon(DOWN));
  const body = h('div', { class: 'gen-lib-body', id: `${p}-lib-body` }, h('div', { class: 'gen-lib-search-wrap' }, search), list);
  const el = h(
    'nav',
    { class: 'gen-lib', 'aria-label': opts.title },
    h('div', { class: 'gen-lib-head' }, h('span', { class: 'gen-lib-title' }, opts.title), pos, upBtn, currentBtn, downBtn),
    body,
  );

  const setOpen = (o: boolean) => {
    open = o;
    el.classList.toggle('open', o);
    currentBtn.setAttribute('aria-expanded', String(o));
    if (o) {
      opts.onThumbs();
      requestAnimationFrame(() => scrollIntoView(sel));
    }
  };

  const applyFilter = () => {
    const tokens = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = [];
    const groupsShown = new Set<string>();
    items.forEach((e, i) => {
      const m = tokens.every((t) => hay[i].includes(t));
      buttons[i].hidden = !m;
      if (m) {
        filtered.push(i);
        groupsShown.add(e.group);
      }
    });
    for (const [g, t] of groupTitles) t.hidden = !groupsShown.has(g);
    empty.hidden = filtered.length > 0;
    empty.textContent = `No matches for “${search.value.trim()}”`;
    sync();
    scrollIntoView(sel);
    opts.onThumbs();
  };

  const closeCompact = () => {
    if (open && compactMq.matches) {
      setOpen(false);
      currentBtn.focus();
    }
  };

  search.addEventListener('input', applyFilter);
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (!filtered.length) return;
      if (!filtered.includes(sel)) select(filtered[0], false);
      closeCompact();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (filtered.length) select(filtered.includes(sel) ? sel : filtered[0], true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (search.value) {
        search.value = '';
        applyFilter();
      } else if (open) {
        setOpen(false);
        currentBtn.focus();
      }
    }
  });
  list.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      step(ev.key === 'ArrowDown' ? 1 : -1, true);
    } else if ((ev.key === 'Home' || ev.key === 'End') && filtered.length) {
      ev.preventDefault();
      select(ev.key === 'Home' ? filtered[0] : filtered[filtered.length - 1], true);
    } else if (ev.key === 'Escape' && open) {
      setOpen(false);
      currentBtn.focus();
    }
  });

  /** Step to the next / previous item within the search results. */
  const step = (d: number, focus: boolean) => {
    if (!filtered.length) return;
    const next =
      d > 0
        ? (filtered.find((i) => i > sel) ?? filtered[filtered.length - 1])
        : ([...filtered].reverse().find((i) => i < sel) ?? filtered[0]);
    select(next, focus);
  };

  const pick = (i: number) => {
    select(i, false);
    if (open) {
      setOpen(false);
      if (compactMq.matches) currentBtn.focus();
    }
  };

  const select = (i: number, focus = false) => {
    if (i !== sel) {
      const from = sel;
      sel = i;
      opts.onChange(i, from);
    }
    sync();
    scrollIntoView(i);
    if (focus) buttons[i].focus({ preventScroll: true });
  };

  /** aria-current, roving tabindex, position counter and the compact label. */
  const sync = () => {
    const k = filtered.indexOf(sel);
    const tabStop = k >= 0 ? sel : (filtered[0] ?? -1);
    buttons.forEach((b, i) => {
      b.setAttribute('aria-current', String(i === sel));
      b.tabIndex = i === tabStop ? 0 : -1;
    });
    const at = `${k >= 0 ? k + 1 : '–'} / ${filtered.length}`;
    pos.textContent = at;
    curPos.textContent = at;
    curGroup.textContent = `${items[sel].group} ›`;
    curName.textContent = items[sel].name;
    upBtn.disabled = !filtered.length || filtered[0] >= sel;
    downBtn.disabled = !filtered.length || filtered[filtered.length - 1] <= sel;
  };

  /** Scroll the list (only) so item i is visible. */
  const scrollIntoView = (i: number) => {
    const b = buttons[i];
    if (b.hidden || !list.clientHeight) return;
    const prev = b.previousElementSibling;
    const top = b.offsetTop - (prev?.classList.contains('gen-lib-group') ? (prev as HTMLElement).offsetHeight + 6 : 4);
    const bottom = b.offsetTop + b.offsetHeight + 4;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  };

  const listShown = () => body.offsetParent !== null && list.clientHeight > 0;

  const inView = (margin = 40): number[] => {
    if (!listShown()) return [];
    const top = list.scrollTop - margin;
    const bottom = list.scrollTop + list.clientHeight + margin;
    return filtered.filter((i) => {
      const b = buttons[i];
      return b.offsetTop + b.offsetHeight >= top && b.offsetTop <= bottom;
    });
  };

  compactMq.addEventListener('change', () => opts.onThumbs());
  applyFilter();

  return {
    el,
    thumbs,
    selected: () => sel,
    filtered: () => filtered,
    select,
    listShown,
    inView,
  };
}
