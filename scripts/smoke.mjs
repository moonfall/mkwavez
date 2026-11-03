// Headless-Chrome smoke test: page loads without console errors; dark theme by default and
// the toggle remembers light; the wide shell (1440×900, 1180×820) fits one screen with no page
// scroll and panels in layout C; at 390px panels stack, collapse (Wavetables starts collapsed;
// a collapsed panel stops redrawing) and nothing overflows sideways; only voice 1 starts
// unmuted; voice tabs switch both the Voice and the Sequence panel; Seed (library search / ▲▼ /
// arrow keys, formula edit / revert, parameter modes, batch strip arrow keys, Add shown / Add
// batch) adds exactly the previewed tables; the worklet loads and the transport runs; the
// timeline strip tints voice windows (bands in voice order, start / end edges, muted faint),
// shows carets for unmuted voices, cycles its thumbnail view (remembered), keeps the selection
// in view and follows the newest table; "Copy to end" / Ctrl+D (only while the strip has
// focus) appends a copy of the selection, selects and reveals it; Mutate (library search /
// stepping / thumbnails, amount → preview, Linear / Log / Chain, strip arrow keys, Add shown /
// Add +N recipes, no Evolve, fits the Generate panel) while playing; Breed picks parents
// (timeline Shift-click / long-press, Add selected,
// voice window), previews and applies every operator, sweeps and generations; evicted parents
// drop out. Wavetables: the built-ins (Timeline, Last batch, Batches, Grid) exist, update on
// Seed Add shown / Add batch and show their views; no "Sets window of" checkboxes; V1 on the
// Grid shows the X/Y pad (sliders move the dot, live dot while playing), the worklet plays it,
// Step on the wavetable plays one cell; the Voice panel fits at 1440×900 / 1180×820 and 390px
// doesn't overflow; the CC map has Position Y. Keyboard shortcuts: Space (also with a button
// focused; types in text fields), [ / ], M, Shift+←/→ moves in the Timeline (ends no-op,
// one undo step, ignored in text fields); no UI text says "table" (only "wavetable").
// Wavetables editor: expand / collapse over the
// Generate row (fits 1440×900 / 1180×820, 390px no overflow), + 1D / 2D / Rows, 2D resize,
// duplicate a built-in, rename, a Live wavetable receives Seed adds, Timeline drags (mouse
// replace / insert, touch insert via synthetic pointer events), slot reorder, Delete, undo,
// built-ins refuse drops, delete moves its voice to the Timeline.
// Session: autosave survives a reload, New session, Export / Import, two tabs (one
// autosaves; take over), unrestorable save set aside and exportable, no-storage paths
// (sessionChecks).
//
// Usage: npm run smoke            (builds, then tests `vite preview` and `vite dev`)
//        CHROME=/path/to/chrome   (default /usr/bin/google-chrome)
//        SHOTS=dir                (optional: save screenshots there)
import { chromium } from 'playwright-core';
import { createServer, preview } from 'vite';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS || '';

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`  ok - ${msg}`);
}

async function run(label, url, browser) {
  console.log(`\n[${label}] ${url}`);
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#sec-generate');

  const tlCount = () => page.evaluate(() => window.mkwavez.model.timeline.length);
  assert((await tlCount()) === 5, 'starts with 5 tables');
  assert((await page.textContent('#sec-timeline .panel-head .meta')).trim() === '5 / 4096', 'timeline meta shows count / cap');
  assert((await page.textContent('#tables-status')).trim() === '5 / 4096 waveforms', 'transport status shows the waveform count');

  await themeChecks(page);
  await shellChecks(page);

  const isCollapsed = (id) => page.$eval(`#${id}`, (d) => d.classList.contains('collapsed'));
  assert((await isCollapsed('sec-wavetables')) && !(await page.isVisible('#wavetable-overview')), 'phone: Wavetables starts collapsed');
  const mutes = await page.evaluate(() => window.mkwavez.model.voices.map((v) => v.mute));
  assert(JSON.stringify(mutes) === '[false,true,true]', 'only voice 1 starts unmuted');

  // Phone: collapse / expand every panel.
  for (const id of ['sec-generate', 'sec-wavetables', 'sec-timeline', 'sec-voices', 'sec-sequences']) {
    const before = await isCollapsed(id);
    await page.click(`#${id} .panel-collapse`);
    assert((await isCollapsed(id)) === !before && (await page.isVisible(`#${id}-body`)) === before, `${id} toggles`);
    await page.click(`#${id} .panel-collapse`);
    assert((await isCollapsed(id)) === before, `${id} toggles back`);
  }

  // Tabs.
  await page.click('#tab-breed');
  assert(await page.isVisible('#panel-breed'), 'Breed tab shows');
  assert(await page.isDisabled('#breed-apply1'), 'Breed disabled without parents');
  await page.click('#tab-seed');
  assert(await page.isVisible('#panel-seed'), 'Seed tab visible again');

  // Seed: library, formula / params, preview, batch strip, adds.
  await seedChecks(page, tlCount);

  // Timeline selection by click.
  await page.$eval('#timeline-scroll', (s) => (s.scrollLeft = 0));
  await page.waitForTimeout(100);
  await page.click('#timeline-grid', { position: { x: 10, y: 10 } });
  assert((await page.evaluate(() => window.mkwavez.model.indexOf(window.mkwavez.model.selectedId))) === 0, 'clicking the first cell selects table #1');

  // Undo.
  await page.click('#undo');
  assert((await tlCount()) === 14, 'undo removes the last batch');

  // Audio: worklet loads, transport runs, tables reach the worklet.
  await page.click('#play');
  await page.waitForFunction(() => document.body.dataset.audio === 'running', null, { timeout: 10000 });
  assert(true, 'audio worklet running');
  await page.waitForFunction(() => Number(document.body.dataset.step) >= 4, null, { timeout: 10000 });
  assert(true, 'sequencer steps advance');
  await voiceTabChecks(page);
  await collapsedRedrawChecks(page);
  await page.click('#seed-add-shown');
  await page.waitForFunction(
    () => window.mkwavez.bridge.workletTableCount === window.mkwavez.model.timeline.length,
    null,
    { timeout: 5000 },
  );
  assert(true, 'worklet holds every timeline table');
  await timelineMarkerChecks(page);
  await wavetableChecks(page);
  await wavetableEditorChecks(page, tlCount);
  await timelineCopyChecks(page, tlCount);
  await shortcutChecks(page);
  await wordingCheck(page, 'after Seed / Timeline');
  await mutateChecks(page, tlCount, label);
  await wordingCheck(page, 'after Mutate');
  await breedChecks(page, tlCount);
  await wordingCheck(page, 'after Breed');
  await page.click('#add-voice');
  let vs = await page.evaluate(() => ({ n: window.mkwavez.model.voices.length, sel: window.mkwavez.ui.voiceId }));
  assert(vs.n === 4 && vs.sel === 4, 'voice added and its tab selected');
  assert(
    (await page.getAttribute('#voice-tab-4', 'aria-selected')) === 'true' && (await page.textContent('#seq-target')).includes('V4'),
    'new voice: tab selected, Sequence panel shows its sequence',
  );
  await page.click('#voice-remove');
  vs = await page.evaluate(() => ({ n: window.mkwavez.model.voices.length, sel: window.mkwavez.ui.voiceId }));
  assert(vs.n === 3 && vs.sel === 3 && !(await page.$('#voice-tab-4')), 'voice removed; the neighbouring tab is selected');
  await page.click('#voice-tab-1');
  await page.waitForTimeout(500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label}-mobile.png`, fullPage: true });
  // Stress: fill past the cap while playing; eviction keeps the cap and the worklet catches up.
  const t0 = Date.now();
  await page.evaluate(() => {
    const m = window.mkwavez.model;
    const g = m.timeline[m.timeline.length - 1];
    for (let i = 0; i < 5; i++) m.addTables(Array.from({ length: 1000 }, () => ({ data: g.data, recipe: g.recipe })));
  });
  assert((await tlCount()) === 4096, 'timeline capped at 4096 after 5000 adds');
  await page.waitForFunction(() => window.mkwavez.bridge.workletTableCount === 4096, null, { timeout: 20000 });
  assert(true, `worklet synced 4096 tables (${Date.now() - t0} ms)`);
  // At the cap, an add that doesn't select (eviction shifts the selection's index) keeps a
  // strip scrolled to the end following the newest waveform (it doesn't jump to the selection).
  {
    const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.$eval('#timeline-scroll', (s) => s.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => window.mkwavez.model.select(window.mkwavez.model.timeline[100].id));
    await frames();
    await page.$eval('#timeline-scroll', (s) => (s.scrollLeft = s.scrollWidth));
    await frames();
    const r = await page.evaluate(async () => {
      const m = window.mkwavez.model;
      const sel = m.selectedId;
      const idx0 = m.indexOf(sel);
      const g = m.timeline.at(-1);
      m.addTables([0, 1, 2].map(() => ({ data: g.data, recipe: g.recipe })), false);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const s = document.querySelector('#timeline-scroll');
      return { n: m.timeline.length, kept: m.selectedId === sel, shifted: m.indexOf(sel) !== idx0, atEnd: s.scrollLeft + s.clientWidth >= s.scrollWidth - 63 };
    });
    assert(r.n === 4096 && r.kept && r.shifted && r.atEnd, `eviction at the cap: strip follows the end, not the selection (${JSON.stringify(r)})`);
    await page.click('#undo');
  }
  await page.waitForTimeout(300);
  const ev = await page.evaluate(() => ({
    parents: window.mkwavez.model.breedParents.length,
    cards: document.querySelectorAll('#breed-parents .parent-card').length,
  }));
  assert(ev.parents === 0 && ev.cards === 0, 'evicted Breed parents drop out of the list and its cards');
  // Timeline full of waveforms wavetables use: adds are refused with a notice, buttons say so.
  const full = await page.evaluate(() => {
    const m = window.mkwavez.model;
    // Four copies of the Timeline (each keeps its newest 1024), then each given a quarter.
    const ids = m.timeline.map((t) => t.id);
    const ds = [0, 1, 2, 3].map(() => m.duplicateWavetable(0).id);
    m.wavetables = m.wavetables.map((w) => (ds.includes(w.id) ? { ...w, rows: [ids.slice(ds.indexOf(w.id) * 1024, (ds.indexOf(w.id) + 1) * 1024)] } : w));
    m.setWavetableInterp(ds[0], 'step'); // emits 'wavetables'
    const n = m.timeline.length;
    const added = m.addTables([{ data: m.timeline[0].data, recipe: m.timeline[0].recipe }]).length;
    return { ids: ds, n, added, after: m.timeline.length };
  });
  await page.waitForTimeout(100);
  const fullUi = await page.evaluate(() => ({
    notice: !document.querySelector('#notice').hidden && document.querySelector('#notice').textContent,
    copy: document.querySelector('#timeline-copy').disabled && document.querySelector('#timeline-copy').title,
  }));
  assert(
    full.n === 4096 && full.added === 0 && full.after === 4096 && String(fullUi.notice).startsWith('Timeline full: all 4096 waveforms') && String(fullUi.copy).startsWith('Timeline full'),
    `Timeline full: add refused, notice shown, Copy to end disabled (${fullUi.notice})`,
  );
  await page.evaluate((ids) => ids.forEach((id) => window.mkwavez.model.deleteWavetable(id)), full.ids);
  await page.waitForTimeout(50);
  assert(!(await page.isDisabled('#timeline-copy')), 'room again once the wavetables are deleted');
  await page.click('#play');
  assert((await page.evaluate(() => window.mkwavez.model.playing)) === false, 'transport stops');
  // Leave eight parents showing (layout / overflow / screenshots).
  await page.click('#tab-breed');
  await page.evaluate(() => {
    const m = window.mkwavez.model;
    m.setBreedParents(m.timeline.slice(0, 8).map((t) => t.id));
  });
  assert((await page.$$('#breed-parents .parent-card')).length === 8, 'eight parent cards');
  await page.waitForTimeout(200);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'no horizontal page overflow at 390px (eight parents, 4096 tables)');
  // The wide shell still fits one screen with everything loaded (Breed tab scrolls inside Generate).
  for (const [w, hh] of [
    [1440, 900],
    [1180, 820],
  ]) {
    await page.setViewportSize({ width: w, height: hh });
    await page.waitForTimeout(250);
    assert(await fitsScreen(page), `${w}×${hh}: no page scroll with 4096 tables and eight parents`);
  }
  if (SHOTS) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => window.mkwavez.setTheme(t, false), theme);
      for (const [w, hh] of [
        [1440, 900],
        [1180, 820],
        [1920, 1080],
        [390, 844],
      ]) {
        await page.setViewportSize({ width: w, height: hh });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SHOTS}/${label}-${w}x${hh}-${theme}.png`, fullPage: w < 900 });
      }
    }
    await page.evaluate(() => window.mkwavez.setTheme('dark', false));
  }
  assert(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await page.close();
}

/**
 * Generate → Seed at phone width (and a desktop layout check): compact library row,
 * search, ▲/▼ and arrow-key stepping, formula edit / error / revert, a parameter mode,
 * the batch strip (arrow keys, scroll into view), Add shown and Add batch recipes.
 * Leaves 20 tables: 5 + 1 (shown) + 8 (batch) + 6 (CA batch); Saw is selected.
 */
async function seedChecks(page, tlCount) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const title = async () => (await page.textContent('#seed-title')).trim();
  const visibleIds = () => page.$$eval('#seed-list .gen-entry', (bs) => bs.filter((b) => !b.hidden).map((b) => b.dataset.id));
  const focusedId = () => M(() => document.activeElement?.dataset?.id ?? document.activeElement?.id ?? '');
  const total = (await visibleIds()).length;

  assert(await page.isVisible('#seed-current'), 'phone: library collapses to one row');
  assert(!(await page.isVisible('#seed-list')), 'phone: list hidden until opened');
  assert((await title()) === 'Shapers › Chebyshev', 'starts on Shapers › Chebyshev');
  await page.waitForFunction(() => {
    const c = document.querySelector('#seed-wave');
    return c && c.width > 1 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v);
  }, null, { timeout: 5000 });
  assert(true, 'preview waveform renders');
  assert(!(await page.isVisible('#seed-reroll')), 'no seed / Reroll for a formula without pnoise');

  // ▲ / ▼.
  await page.click('#seed-down');
  assert((await title()) === 'Shapers › Superformula', '▼ steps to the next entry');
  await page.click('#seed-up');
  await page.click('#seed-up');
  assert((await title()) === 'Shapers › Soft clip', '▲ steps back');
  assert((await page.textContent('#seed-current')).includes('Soft clip'), 'compact row names the entry');

  // Search.
  await page.click('#seed-current');
  assert(await page.isVisible('#seed-list'), 'tapping the name opens the list');
  await page.waitForTimeout(150);
  assert((await canvasInk(page, '#seed-list .gen-entry[data-id="saw"] canvas')).n > 0, 'entry thumbnails render');
  await page.fill('#seed-search', 'PERLIN');
  const ids = await visibleIds();
  assert(ids.length === 7 && ids[0] === 'drift' && ids.at(-1) === 'perlin-noise', `search matches category and name (${ids.length})`);
  await page.fill('#seed-search', 'acos');
  assert((await visibleIds()).join() === 'chebyshev', 'search matches formula text');
  await page.fill('#seed-search', 'zzzz');
  assert((await page.isVisible('#seed-empty')) && (await visibleIds()).length === 0, 'no-matches state');
  await page.press('#seed-search', 'Escape');
  assert((await visibleIds()).length === total && (await page.inputValue('#seed-search')) === '', 'Escape clears the search');

  // Arrow keys within the results.
  await page.fill('#seed-search', 'perlin');
  await page.press('#seed-search', 'ArrowDown');
  assert((await title()) === 'Perlin › Drift' && (await focusedId()) === 'drift', 'ArrowDown from search moves into the results');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert((await title()) === 'Perlin › Add octaves' && (await focusedId()) === 'add-octaves', 'ArrowDown steps; focus follows');
  await page.keyboard.press('ArrowUp');
  assert((await title()) === 'Perlin › Zoom', 'ArrowUp steps back');
  await page.keyboard.press('End');
  assert((await title()) === 'Noise & automata › Perlin noise', 'End: last result (skips non-matches)');
  assert(
    (await page.textContent('#seed-current')).includes('7 / 7') && (await page.isDisabled('#seed-down')),
    'position within results; ▼ disabled at the end',
  );
  await page.click('#seed-up');
  assert((await title()) === 'Perlin › Noisy FM', '▲ steps within the results');
  assert(await page.isVisible('#seed-reroll'), 'seed / Reroll shown for pnoise formulas');
  await page.press('#seed-search', 'Enter');
  assert(
    (await title()) === 'Perlin › Noisy FM' && !(await page.isVisible('#seed-list')) && (await focusedId()) === 'seed-current',
    'Enter keeps a matching selection and closes the phone list',
  );
  await page.click('#seed-current');
  await page.fill('#seed-search', 'gray');
  await page.press('#seed-search', 'Enter');
  assert((await title()) === 'Bits › Gray code', 'Enter selects the first match');
  await page.click('#seed-current');
  await page.press('#seed-search', 'Escape');
  const scrolled = await page.$eval('#seed-list', (l) => {
    const b = l.querySelector('.gen-entry[aria-current="true"]');
    return b.offsetTop >= l.scrollTop && b.offsetTop + b.offsetHeight <= l.scrollTop + l.clientHeight;
  });
  assert(scrolled, 'selected entry scrolled into view');
  await page.click('#seed-list .gen-entry[data-id="sine-saw"]');
  assert((await title()) === 'Math › Sine→saw' && !(await page.isVisible('#seed-list')), 'picking an entry selects it and closes the list');

  // Formula edit / error / revert.
  const preset = await page.inputValue('#seed-expr');
  assert(!(await page.isVisible('#seed-edited')), 'preset not marked edited');
  await page.fill('#seed-expr', 'sin(p');
  await page.waitForFunction(() => document.querySelector('#seed-error').textContent.startsWith('Syntax'), null, { timeout: 3000 });
  assert(await page.isDisabled('#seed-add-batch'), 'syntax error shown inline; Add disabled');
  await page.fill('#seed-expr', 'q*sin(p)');
  await page.waitForFunction(() => document.querySelector('#seed-error').textContent.startsWith('Error'), null, { timeout: 3000 });
  assert(true, 'runtime error (unknown name) shown inline');

  // Errors are per table: sin(p)/u fails only at u = 0 (#1).
  await page.fill('#seed-expr', 'sin(p)/u');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#seed-strip .gen-card.failed').length === 1 &&
      document.querySelector('#seed-strip .gen-card:nth-child(1)').classList.contains('failed') &&
      document.querySelector('#seed-error').textContent.startsWith('Error at #1'),
    null,
    { timeout: 3000 },
  );
  assert((await page.isDisabled('#seed-add-shown')) && (await page.isDisabled('#seed-add-batch')), 'failing card marked; Add shown (on it) and Add batch disabled');
  await page.click('#seed-strip .gen-card:nth-child(3)');
  await page.waitForFunction(() => !document.querySelector('#seed-add-shown').disabled, null, { timeout: 3000 });
  assert((await canvasInk(page, '#seed-strip .gen-card:nth-child(8) canvas')).n > 0, 'the other tables still compute; Add shown allowed on them');
  await page.click('#seed-strip .gen-card:nth-child(1)');

  // A runaway formula is aborted instead of freezing the page.
  const t0 = Date.now();
  await page.fill('#seed-expr', '[...Array(3000000)].reduce((s)=>s+1,0)*0+sin(p)');
  await page.waitForFunction(() => document.querySelector('#seed-error').textContent.startsWith('Stopped'), null, { timeout: 5000 });
  assert((await page.isDisabled('#seed-add-batch')) && Date.now() - t0 < 4000, `runaway formula stopped (${Date.now() - t0} ms)`);
  await page.click('#seed-revert');
  assert(
    (await page.inputValue('#seed-expr')) === preset && !(await page.isVisible('#seed-edited')) && !(await page.isDisabled('#seed-add-batch')),
    'Revert to preset restores the expression',
  );
  const edited = '(1-u)*sin(p) + u*sin(3*p)';
  await page.fill('#seed-expr', edited);
  assert((await page.isVisible('#seed-edited')) && (await page.isVisible('#seed-revert')), 'editing marks it edited');
  await page.waitForTimeout(500);

  // Batch strip: arrow keys move the shown table.
  assert((await page.$$('#seed-strip .gen-card')).length === 8, 'strip shows N = 8 cards');
  await page.focus('#seed-strip .gen-card[aria-pressed="true"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const shownTxt = async () => (await page.textContent('#seed-shown')).trim();
  assert((await shownTxt()).startsWith('#3 of 8 · n 2 · u 0.29'), `ArrowRight moves the shown table (${await shownTxt()})`);
  await page.waitForTimeout(150);
  const before = await canvasInk(page, '#seed-wave');
  await page.keyboard.press('End');
  const inView = await page.$eval('#seed-strip', (s) => {
    const c = s.querySelector('.gen-card[aria-pressed="true"]');
    const a = s.getBoundingClientRect();
    const b = c.getBoundingClientRect();
    return s.scrollLeft > 0 && b.left >= a.left - 1 && b.right <= a.right + 1 && document.activeElement === c;
  });
  assert((await shownTxt()).startsWith('#8 of 8') && inView, 'End: last card shown, focused and scrolled into view');
  await page.waitForTimeout(150);
  assert((await canvasInk(page, '#seed-wave')).sum !== before.sum, 'large view follows the shown card');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  assert((await shownTxt()).startsWith('#3 of 8'), 'ArrowLeft moves back');
  await page.click('#seed-strip .gen-card:nth-child(4)');
  assert((await shownTxt()).startsWith('#4 of 8'), 'clicking a card shows it');
  await page.keyboard.press('ArrowLeft');

  // Add shown: exactly the shown preview table (index 2 of 8).
  await page.click('#seed-add-shown');
  assert((await tlCount()) === 6, 'Add shown adds one table');
  let r = await M(() => {
    const m = window.mkwavez.model;
    const t = m.timeline.at(-1);
    return { ...t.recipe, sel: m.selectedId === t.id, end: m.voices[1].windowEnd, last: m.windowTables(m.voices[0]).map((x) => x.id).join() === String(t.id) };
  });
  assert(
    r.op === 'formula' &&
      r.params.preset === 'sine-saw' &&
      r.params.expr === edited &&
      r.params.edited === true &&
      r.batch.index === 2 &&
      r.batch.count === 8 &&
      r.sel,
    'Add shown recipe: preset, edited formula, batch index / N; selected',
  );
  assert(r.end === 5, 'single add extends a following Timeline window (V2)');
  assert(r.last, 'single add replaces Last batch: V1 plays just the new table');

  // Add batch.
  await page.click('#seed-add-batch');
  assert((await tlCount()) === 14, 'Add batch adds N = 8');
  r = await M(() => {
    const m = window.mkwavez.model;
    const b = m.timeline.slice(-8);
    const v = m.voices[0];
    return {
      idx: b.map((t) => t.recipe.batch.index).join(),
      seeds: new Set(b.map((t) => t.recipe.seed)).size,
      exprs: new Set(b.map((t) => t.recipe.params.expr)).size,
      win: [v.windowStart, v.windowEnd],
      plays: m.windowTables(v).map((t) => t.id).join() === b.map((t) => t.id).join(),
      same: b[2].data === m.timeline.at(-9).data,
      wts: {
        timeline: m.wavetable(0).rows[0].join() === m.timeline.map((t) => t.id).join(),
        last: m.wavetable(1).rows[0].join() === b.map((t) => t.id).join(),
        batches: m.wavetable(2).rows.at(-1).join() === b.map((t) => t.id).join() && m.wavetable(2).rows.at(-2).join() === String(m.timeline.at(-9).id),
        grid: m.wavetable(3).rows.flat().filter((x) => x !== null).length === Math.min(64, m.timeline.length),
      },
    };
  });
  assert(r.idx === '0,1,2,3,4,5,6,7' && r.seeds === 1 && r.exprs === 1, 'batch recipes: indices 0…7, one seed, one formula');
  assert(r.same, 'batch table #3 is the very preview table Add shown added');
  assert(r.win[0] === 0 && r.win[1] === 7 && r.plays, 'V1 on Last batch plays exactly the new batch');
  assert(Object.values(r.wts).every(Boolean), `built-ins update on Add batch (${JSON.stringify(r.wts)})`);

  // A parameter mode: cellular automaton.
  await page.click('#seed-current');
  await page.fill('#seed-search', 'cellular');
  await page.press('#seed-search', 'Enter');
  assert(
    (await title()) === 'Noise & automata › Cellular automaton' && (await page.textContent('#seed-kind')) === 'Parameters',
    'CA shows parameters',
  );
  assert(await page.isVisible('#seed-reroll'), 'CA shows seed / Reroll');
  await page.selectOption('#seed-param-rule', '110');
  await page.fill('#seed-param-start', '5');
  assert(await page.isVisible('#seed-edited'), 'changed params mark it edited');
  const seedHex = async () => (await page.textContent('#seed-seed')).trim();
  const s0 = await seedHex();
  await page.click('#seed-reroll');
  const s1 = await seedHex();
  assert(/^[0-9a-f]{8}$/.test(s1) && s1 !== s0, 'Reroll draws a new seed');
  await page.click('#seed-n-dec');
  await page.click('#seed-n-dec');
  assert(
    (await page.inputValue('#seed-n')) === '6' &&
      (await page.textContent('#seed-add-batch')) === 'Add batch (+6)' &&
      (await page.$$('#seed-strip .gen-card')).length === 6,
    'N stepper: 6 cards, Add batch (+6)',
  );
  await page.click('#seed-add-batch');
  assert((await tlCount()) === 20, 'CA Add batch adds 6');
  r = await M(() => window.mkwavez.model.timeline.slice(-6).map((t) => ({ ...t.recipe.params, seed: t.recipe.seed })));
  assert(
    r.every((p) => p.preset === 'cellular-automaton' && p.rule === 110 && p.start === 5 && p.seed === parseInt(s1, 16)) &&
      r.map((p) => p.generation).join() === '5,6,7,8,9,10',
    'CA recipes: rule, start, generations 5…10, the shown seed',
  );
  assert((await seedHex()) !== s1, 'new seed after Add batch (random mode)');
  await page.click('#seed-revert');
  assert((await page.inputValue('#seed-param-start')) === '0' && !(await page.isVisible('#seed-edited')), 'Revert to defaults');
  await page.click('#seed-n-inc');
  await page.click('#seed-n-inc');
  assert((await page.inputValue('#seed-n')) === '8', 'N back to 8');

  // Basic wave (additive), selected for later adds.
  await page.click('#seed-current');
  await page.fill('#seed-search', 'saw');
  await page.press('#seed-search', 'Enter');
  assert((await title()) === 'Basic › Saw' && (await page.textContent('#seed-kind')) === 'Basic wave', 'Saw is a basic (additive) wave');
  await page.click('#seed-as-formula');
  assert(
    (await title()) === 'Custom › Blank formula' && (await page.inputValue('#seed-expr')).includes('reduce') && (await page.isVisible('#seed-edited')),
    'Edit as formula copies the additive series into Blank formula',
  );
  await page.fill('#seed-expr', 'sin(p)*0.5');
  await page.click('#seed-current');
  await page.fill('#seed-search', 'saw');
  await page.press('#seed-search', 'Enter');
  let dialog = '';
  page.once('dialog', async (d) => {
    dialog = d.message();
    await d.dismiss();
  });
  await page.click('#seed-as-formula');
  assert(dialog.includes('Replace') && (await title()) === 'Basic › Saw', 'Edit as formula asks before replacing Blank formula edits (cancel keeps them)');
  const ov = await M(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!ov, 'Seed: no horizontal overflow at 390px');

  // Desktop layout.
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(200);
  assert(
    (await page.isVisible('#seed-list')) && !(await page.isVisible('#seed-current')) && (await page.isVisible('#seed-pos')),
    'desktop: library list in a column',
  );
  const cols = await page.$eval('#panel-seed', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert(cols === 2, 'desktop: two columns');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
}

/** Dark by default (nothing stored); the toggle switches to light, remembers it across a reload, and back. */
async function themeChecks(page) {
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert((await page.evaluate(() => localStorage.getItem('mkwavez.theme'))) === null && (await theme()) === 'dark', 'dark theme by default');
  const dark = await bg();
  await page.click('#theme-toggle');
  assert((await theme()) === 'light' && (await bg()) !== dark, 'theme toggle switches to light');
  assert((await page.evaluate(() => localStorage.getItem('mkwavez.theme'))) === 'light', 'light choice stored');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#sec-generate');
  assert((await theme()) === 'light' && (await page.getAttribute('#theme-toggle', 'aria-label')).includes('dark'), 'stored light theme respected after reload');
  await page.click('#theme-toggle');
  assert((await theme()) === 'dark' && (await bg()) === dark, 'toggle back to dark');
}

/** No page scroll (document fits the viewport) and every panel inside it. */
const fitsScreen = (page) =>
  page.evaluate(() => {
    const d = document.documentElement;
    if (d.scrollHeight > innerHeight || d.scrollWidth > innerWidth) return false;
    return [...document.querySelectorAll('.panel')].every((p) => {
      const r = p.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5;
    });
  });

/** Layout C at laptop / tablet / other sizes, then back to the phone column. */
async function shellChecks(page) {
  const rects = () =>
    page.evaluate(() =>
      Object.fromEntries(
        ['generate', 'wavetables', 'timeline', 'voices', 'sequences'].map((k) => {
          const r = document.querySelector(`#sec-${k}`).getBoundingClientRect();
          return [k, { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right }];
        }),
      ),
    );
  for (const [w, hh] of [
    [1440, 900],
    [1180, 820],
    [1280, 800],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width: w, height: hh });
    await page.waitForTimeout(200);
    assert(await fitsScreen(page), `${w}×${hh}: one screen, no page scroll`);
    const r = await rects();
    const g = r.generate;
    const ok =
      Math.abs(g.y - r.wavetables.y) < 1 &&
      g.r < r.wavetables.x &&
      g.w / (g.w + r.wavetables.w) > 0.6 &&
      g.w / (g.w + r.wavetables.w) < 0.72 &&
      r.timeline.y > g.b &&
      r.timeline.w > w * 0.95 &&
      r.timeline.h >= 95 &&
      r.timeline.h <= 130 &&
      Math.abs(r.voices.y - r.sequences.y) < 1 &&
      r.voices.y > r.timeline.b &&
      r.voices.r < r.sequences.x &&
      Math.abs(r.timeline.b + 8 - r.voices.y) < 1.5;
    assert(ok, `${w}×${hh}: layout C (Generate ${Math.round(g.w)} | Wavetables ${Math.round(r.wavetables.w)}; timeline ${Math.round(r.timeline.h)} px; Voice | Sequence)`);
    if (w === 1440) {
      assert(await page.isVisible('#wavetable-overview'), 'wide: Wavetables shown (collapse applies to the phone column only)');
      assert(!(await page.isVisible('#sec-voices .panel-collapse')), 'wide: no collapse chevrons');
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const col = await rects();
  const order = ['generate', 'wavetables', 'timeline', 'voices', 'sequences'];
  assert(
    order.every((k, i) => i === 0 || col[k].y > col[order[i - 1]].y) && order.every((k) => col[k].w <= 390),
    'phone: panels stacked in the same order',
  );
  assert(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'phone: no horizontal overflow at 390px');
}

/** Voice tabs switch both the Voice controls and the Sequence panel. */
async function voiceTabChecks(page) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const tabs = await page.$$eval('#voice-tabs [role="tab"]', (ts) => ts.map((t) => t.textContent.trim()));
  assert(JSON.stringify(tabs) === JSON.stringify(['V1', 'V2 · muted', 'V3 · muted']), `voice tabs (${tabs.join(', ')})`);
  for (const id of [2, 3, 1]) {
    await page.click(`#voice-tab-${id}`);
    const r = await M((id) => {
      const m = window.mkwavez.model;
      const v = m.voice(id);
      const seq = m.sequences.find((s) => s.voiceId === id);
      return {
        sel: window.mkwavez.ui.voiceId,
        pressed: [...document.querySelectorAll('#voice-tabs [role="tab"]')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.id),
        labelled: document.querySelector('#voice-panel').getAttribute('aria-labelledby'),
        pos: Number(document.querySelector('#voice-position').value),
        want: v.position,
        mute: document.querySelector('#voice-mute').getAttribute('aria-label'),
        target: document.querySelector('#seq-target').textContent,
        seqId: seq.id,
        len: Number(document.querySelector('#seq-length').value),
        wantLen: seq.length,
      };
    }, id);
    assert(
      r.sel === id && r.pressed.join() === `voice-tab-${id}` && r.labelled === `voice-tab-${id}` && Math.abs(r.pos - r.want) < 1e-9 && r.mute.endsWith(`V${id}`),
      `tab V${id}: Voice panel shows V${id}`,
    );
    await page.$eval('#seq-grid', (c) => c.scrollIntoView({ block: 'center' }));
    await page.waitForFunction((s) => document.querySelector('#seq-grid').dataset.sequence === String(s), r.seqId, { timeout: 3000 });
    assert(r.target.includes(`V${id}`) && r.len === r.wantLen, `tab V${id}: Sequence panel follows (seq ${r.seqId})`);
  }
  // Editing goes to the selected voice; arrow keys move between tabs.
  await page.click('#voice-tab-2');
  await page.fill('#voice-level', '0.42');
  assert((await M(() => window.mkwavez.model.voice(2).level)) === 0.42 && (await M(() => window.mkwavez.model.voice(1).level)) !== 0.42, 'slider edits the selected voice');
  assert(
    (await page.textContent('#voice-interp')).trim() === 'Blend · set on wavetable' && !(await page.$('#voice-step')),
    'voice shows the wavetable’s interpolation read-only',
  );
  await page.focus('#voice-tab-2');
  await page.keyboard.press('ArrowRight');
  assert((await M(() => window.mkwavez.ui.voiceId)) === 3, 'ArrowRight selects the next voice tab');
  await page.click('#voice-tab-1');
  // A grid click toggles a note of the selected voice's sequence.
  const before = await M(() => window.mkwavez.model.sequences.find((s) => s.voiceId === 1).steps[1]);
  const box = await page.$eval('#seq-grid', (c) => ({ w: c.clientWidth, h: c.clientHeight, len: Number(c.dataset.length) }));
  const cw = (box.w - 30) / box.len;
  await page.click('#seq-grid', { position: { x: 30 + cw * 1.5, y: box.h - box.h / 16 } });
  const after = await M(() => window.mkwavez.model.sequences.find((s) => s.voiceId === 1).steps[1]);
  assert(before !== after && after === 0, 'grid click toggles a step of the selected voice’s sequence');
  await page.click('#undo');
}

/** A collapsed panel (phone column) stops redrawing while playing, and redraws when expanded. */
async function collapsedRedrawChecks(page) {
  for (const [panel, canvas] of [
    ['sec-voices', '#voice-scope'],
    ['sec-sequences', '#seq-grid'],
  ]) {
    await page.click(`#${panel} .panel-collapse`);
    assert(!(await page.isVisible(canvas)), `${panel} collapsed: body hidden`);
    const a = (await canvasInk(page, canvas)).sum;
    await page.waitForTimeout(700);
    assert((await canvasInk(page, canvas)).sum === a, `${panel} collapsed: canvas not redrawn while playing`);
    await page.click(`#${panel} .panel-collapse`);
    await page.waitForFunction(
      ([sel, b]) => {
        const c = document.querySelector(sel);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum = (sum * 31 + d[i] + d[i + 1] * 7 + d[i + 3] * 13) % 1000000007;
        return sum !== b;
      },
      [canvas, a],
      { timeout: 5000 },
    );
    assert(true, `${panel} redraws after expanding`);
  }
}

/** Count of drawn (non-transparent) pixels and a cheap checksum of a canvas. */
const canvasInk = (page, sel) =>
  page.$eval(sel, (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]) n++;
      sum = (sum * 31 + d[i] + d[i + 1] * 7 + d[i + 3] * 13) % 1000000007;
    }
    return { n, sum };
  });

/**
 * Generate → Mutate (while playing): library (search incl. mapping hints, ▲/▼, arrow keys,
 * thumbnails of every mutation on the source that follow amount / seed), source chip,
 * amount → preview + thumbnails, seed / Reroll only for seeded mutations, the batch strip
 * (←/→, default = last card), Linear / Log / Chain, Add shown / Add +N recipes (each
 * selects the last table added; undo restores the selection; Add uses
 * the preview tables), no Evolve; fits the Generate panel at 1440×900 and 1180×820; the
 * phone column has the compact library row and no overflow. Ends on the Seed tab at 390 px.
 */
async function mutateChecks(page, tlCount, label) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const title = async () => (await page.textContent('#mutate-title')).trim();
  const shownTxt = async () => (await page.textContent('#mutate-shown')).trim();
  const visibleIds = () => page.$$eval('#mutate-list .gen-entry', (bs) => bs.filter((b) => !b.hidden).map((b) => b.dataset.id));
  const focusedId = () => M(() => document.activeElement?.dataset?.id ?? document.activeElement?.id ?? '');
  const seedHex = async () => (await page.textContent('#mutate-seed')).trim();
  const waitChange = (sel, sum) =>
    page.waitForFunction(
      ([sel, b]) => {
        const c = document.querySelector(sel);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] + d[i + 1] * 7 + d[i + 3] * 13) % 1000000007;
        return s !== b;
      },
      [sel, sum],
      { timeout: 5000 },
    );
  const genFits = () =>
    M(() => {
      const b = document.querySelector('#sec-generate-body');
      return b.scrollHeight <= b.clientHeight + 1 && b.scrollWidth <= b.clientWidth + 1;
    });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#tab-mutate');
  assert(await page.isVisible('#panel-mutate'), 'Mutate tab visible');
  await waitInk(page, '#mutate-wave');
  assert(true, 'result-over-source view renders');
  assert(!(await page.$('#mutate-evolve')) && !(await page.textContent('#panel-mutate')).includes('Evolve'), 'no Evolve');
  assert((await genFits()) && (await fitsScreen(page)), '1440×900: Mutate fits the Generate panel, no page scroll');

  // Source chip = the Timeline selection.
  const src = await M(() => ({ id: window.mkwavez.model.selectedId, idx: window.mkwavez.model.indexOf(window.mkwavez.model.selectedId) }));
  assert((await page.textContent('#mutate-src-no')).trim() === `#${src.idx + 1}`, `source chip shows the selection (#${src.idx + 1})`);

  // Library.
  const all = await visibleIds();
  assert(all.length === 23 && !all.includes('breed'), 'library lists 23 mutations (legacy Breed hidden)');
  assert((await page.$$('#mutate-list .gen-tag')).length === 6, 'six seeded mutations tagged rnd');
  assert((await title()) === 'Waveshape › Fold' && (await page.textContent('#mutate-hint')).includes('gain 1 + 3a · 0% = unchanged'), 'Group › Name and its amount mapping');
  assert(!(await page.isVisible('#mutate-seedbox')), 'no seed / Reroll for an unseeded mutation');
  await waitInk(page, '#mutate-list .gen-entry[data-id="foldSmooth"] canvas');
  assert(true, 'library thumbnails render');
  await page.fill('#mutate-search', 'SPECTRAL');
  assert((await visibleIds()).length === 7, 'search matches the group');
  await page.fill('#mutate-search', 'seeded');
  const seededIds = await visibleIds();
  assert(seededIds.join() === 'toNoise,ring,nwarp,formant,jitter,scramble', `search matches mapping hints (${seededIds.join()})`);
  await page.fill('#mutate-search', 'zzzz');
  assert((await page.isVisible('#mutate-empty')) && !(await visibleIds()).length, 'no-matches state');
  await page.press('#mutate-search', 'Escape');
  assert((await visibleIds()).length === 23, 'Escape clears the search');
  await page.fill('#mutate-search', 'warp');
  await page.press('#mutate-search', 'ArrowDown');
  assert((await title()) === 'Waveshape › Phase warp' && (await focusedId()) === 'warp', 'ArrowDown moves into the results');
  await page.keyboard.press('ArrowDown');
  assert((await title()) === 'Waveshape › Noise warp' && (await page.isVisible('#mutate-seedbox')), 'ArrowDown steps; seeded → seed / Reroll shown');
  assert(await page.isDisabled('#mutate-down'), '▼ disabled at the end of the results');
  await page.click('#mutate-up');
  assert((await title()) === 'Waveshape › Phase warp', '▲ steps back');
  await page.press('#mutate-search', 'Escape');
  await page.click('#mutate-list .gen-entry[data-id="fold"]');
  await page.click('#mutate-down');
  await page.click('#mutate-up');
  assert((await title()) === 'Waveshape › Fold', '▼ / ▲ step through the full list');

  // Amount: preview and thumbnails follow.
  await page.waitForTimeout(300);
  const wave0 = await canvasInk(page, '#mutate-wave');
  const thumb0 = await canvasInk(page, '#mutate-list .gen-entry[data-id="foldSmooth"] canvas');
  await page.fill('#mutate-amount', '0.6');
  await waitChange('#mutate-wave', wave0.sum);
  await waitChange('#mutate-list .gen-entry[data-id="foldSmooth"] canvas', thumb0.sum);
  assert((await page.textContent('#mutate-amount-val')).trim() === '60%', 'amount change updates the preview and the thumbnails');

  // Batch strip: default shows the last card (= a single Apply at A); ←/→ move.
  assert((await page.$$('#mutate-strip .gen-card')).length === 8, 'strip shows N = 8 cards');
  assert((await shownTxt()) === '#8 of 8 · amount 60%', `last card shown by default (${await shownTxt()})`);
  assert((await page.textContent('#mutate-strip .gen-card:nth-child(1)')).trim() === 'a 7.5%', 'linear card labels a = A·i/N');
  await page.focus('#mutate-strip .gen-card[aria-pressed="true"]');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert((await shownTxt()) === '#6 of 8 · amount 45%', `ArrowLeft moves the shown card (${await shownTxt()})`);
  await page.waitForTimeout(150);
  const w6 = await canvasInk(page, '#mutate-wave');
  await page.keyboard.press('ArrowRight');
  assert((await shownTxt()).startsWith('#7 of 8'), 'ArrowRight moves back');
  await waitChange('#mutate-wave', w6.sum);
  assert(true, 'large view follows the shown card');
  await page.click('#mutate-strip .gen-card:nth-child(6)');
  assert((await shownTxt()).startsWith('#6 of 8'), 'clicking a card shows it');

  let chainSrc = null;
  // Each batch mode: Add +N adds exactly the batch and selects its last table (the next source).
  for (const mode of ['lin', 'log', 'chain']) {
    await page.click(`#mutate-mode-${mode}`);
    assert(
      (await page.getAttribute(`#mutate-mode-${mode}`, 'aria-pressed')) === 'true' && (await page.getAttribute(`#mutate-mode-${mode}`, 'title')).length > 20,
      `${mode}: mode pressed, formula tooltip`,
    );
    const first = (await page.textContent('#mutate-strip .gen-card:nth-child(1)')).trim();
    assert(first === { lin: 'a 7.5%', log: 'a 0.9%', chain: 'step 1' }[mode], `${mode}: card labels (${first})`);
    await page.waitForTimeout(100);
    const sel = await M(() => window.mkwavez.model.selectedId);
    const n = await tlCount();
    await M(() => (document.querySelector('#timeline-scroll').scrollLeft = 0));
    await page.click('#mutate-add-batch');
    assert((await tlCount()) === n + 8, `${mode}: Add +8 adds 8`);
    const r = await M(() => {
      const m = window.mkwavez.model;
      const b = m.timeline.slice(-8);
      const v = m.voices[0];
      return {
        amounts: b.map((t) => t.recipe.params.amount),
        modes: [...new Set(b.map((t) => t.recipe.params.mode))],
        muts: [...new Set(b.map((t) => t.recipe.params.mutation))],
        idx: b.map((t) => t.recipe.batch.index).join(),
        parents: [...new Set(b.map((t) => t.recipe.parents[0]))],
        plays: m.windowTables(v).map((t) => t.id).join() === b.map((t) => t.id).join(),
        len: m.timeline.length,
        sel: m.selectedId,
        lastId: b[7].id,
      };
    });
    const exp = { lin: [0.075, 0.6], log: [0.6 / 64, 0.6], chain: [0.6, 0.6] }[mode];
    assert(
      r.modes.join() === mode && r.muts.join() === 'fold' && r.idx === '0,1,2,3,4,5,6,7' && Math.abs(r.amounts[0] - exp[0]) < 1e-9 && Math.abs(r.amounts[7] - exp[1]) < 1e-9,
      `${mode}: recipes (amounts ${r.amounts[0].toFixed(4)} … ${r.amounts[7]}, indices 0…7)`,
    );
    assert(r.parents.length === 1 && r.parents[0] === sel, `${mode}: one source (the selection)`);
    assert(r.sel === r.lastId, `${mode}: Add +8 selects the last table added`);
    assert(r.plays, `${mode}: the batch is the Last batch V1 plays`);
    await page.waitForFunction((t) => document.querySelector('#mutate-src-no').textContent === t, `#${r.len}`, { timeout: 3000 });
    assert(true, `${mode}: source chip follows to the end of the batch`);
    await page.waitForFunction(
      () => {
        const m = window.mkwavez.model;
        const s = document.querySelector('#timeline-scroll');
        const left = m.indexOf(m.selectedId) * 63;
        return left >= s.scrollLeft && left + 62 <= s.scrollLeft + s.clientWidth;
      },
      null,
      { timeout: 3000 },
    );
    assert(true, `${mode}: the new selection is scrolled into view in the Timeline`);
    chainSrc = sel;
  }
  assert((await shownTxt()) === '#6 of 8 · amount 60% × 6', `chain header (${await shownTxt()})`);
  const chainB6 = await M(() => Array.from(window.mkwavez.model.timeline.at(-3).data));

  // Undo restores the selection to the source of the undone batch.
  await page.click('#undo');
  assert((await M(() => window.mkwavez.model.selectedId)) === chainSrc, 'undo of Add +8 restores the previous selection');

  // Add shown: the shown card's preview table (same data as that card of the batch).
  let n = await tlCount();
  const srcBefore = await M(() => window.mkwavez.model.selectedId);
  await page.click('#mutate-add-shown');
  let r = await M((b6) => {
    const m = window.mkwavez.model;
    const t = m.timeline.at(-1);
    return { ...t.recipe, id: t.id, sel: m.selectedId, same: t.data.length === b6.length && t.data.every((v, i) => v === b6[i]), idx: m.indexOf(t.id) };
  }, chainB6);
  assert((await tlCount()) === n + 1, 'Add shown adds one table');
  assert(
    r.op === 'mutate' && r.params.mode === 'chain' && r.batch.index === 5 && r.batch.count === 8 && r.parents[0] === srcBefore && r.same,
    'Add shown = the shown preview table (chain step 6 of 8, same data as the batch)',
  );
  assert(r.sel === r.id, 'Add shown selects the new table (it becomes the source)');
  await page.waitForFunction((t) => document.querySelector('#mutate-src-no').textContent === t, `#${r.idx + 1}`, { timeout: 3000 });
  assert(true, 'source chip follows the selection');
  await page.click('#undo');
  assert((await M(() => window.mkwavez.model.selectedId)) === srcBefore && (await tlCount()) === n, 'undo of Add shown restores the previous selection');
  await page.click('#mutate-add-shown');
  assert((await M(() => window.mkwavez.model.selectedId)) === (await M(() => window.mkwavez.model.timeline.at(-1).id)), 'Add shown again selects it');

  // Seeded mutation: Reroll changes the seed, preview and its thumbnail; Add draws a new seed.
  await page.click('#mutate-mode-lin');
  await page.click('#mutate-list .gen-entry[data-id="jitter"]');
  assert(await page.isVisible('#mutate-reroll'), 'seeded mutation shows seed / Reroll');
  await page.waitForTimeout(400);
  const s0 = await seedHex();
  const jt = await canvasInk(page, '#mutate-list .gen-entry[data-id="jitter"] canvas');
  const jw = await canvasInk(page, '#mutate-wave');
  await page.click('#mutate-reroll');
  const s1 = await seedHex();
  assert(/^[0-9a-f]{8}$/.test(s1) && s1 !== s0, 'Reroll draws a new seed');
  await waitChange('#mutate-wave', jw.sum);
  await waitChange('#mutate-list .gen-entry[data-id="jitter"] canvas', jt.sum);
  assert(true, 'Reroll updates the preview and the seeded thumbnail');
  n = await tlCount();
  const selSeeded = await M(() => window.mkwavez.model.selectedId);
  await page.click('#mutate-add-batch');
  r = await M(() => window.mkwavez.model.timeline.slice(-8).map((t) => t.recipe.seed));
  assert((await tlCount()) === n + 8 && r.every((s) => s === parseInt(s1, 16)), 'Add +8 uses the shown seed');
  assert((await M(() => window.mkwavez.model.selectedId === window.mkwavez.model.timeline.at(-1).id)), 'Add +8 selects the last table added');
  assert((await seedHex()) !== s1, 'new seed after Add (seeded mutation)');
  await page.click('#undo');
  assert((await tlCount()) === n && (await M(() => window.mkwavez.model.selectedId)) === selSeeded, 'undo removes the batch and restores the selection');

  // N stepper: fewer cards, the last stays shown.
  await page.click('#mutate-n-dec');
  assert(
    (await page.$$('#mutate-strip .gen-card')).length === 7 && (await page.textContent('#mutate-add-batch')).trim() === 'Add +7',
    'N stepper: 7 cards, Add +7',
  );
  await page.click('#mutate-n-inc');
  assert((await page.inputValue('#mutate-n')) === '8', 'N back to 8');

  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(250);
  assert((await genFits()) && (await fitsScreen(page)), '1180×820: Mutate fits the Generate panel, no page scroll');
  if (SHOTS) {
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => window.mkwavez.setTheme(t, false), theme);
      for (const [w, hh] of [
        [1440, 900],
        [1180, 820],
        [390, 844],
      ]) {
        await page.setViewportSize({ width: w, height: hh });
        await page.waitForTimeout(300);
        if (w < 900) await page.$eval('#sec-generate', (s) => s.scrollIntoView());
        await page.screenshot({ path: `${SHOTS}/${label}-mutate-${w}x${hh}-${theme}.png` });
      }
    }
    await page.evaluate(() => window.mkwavez.setTheme('dark', false));
  }

  // Phone: compact library row, no overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert((await page.isVisible('#mutate-current')) && !(await page.isVisible('#mutate-list')), 'phone: library collapses to one row');
  await page.click('#mutate-current');
  assert(await page.isVisible('#mutate-list'), 'phone: tapping the name opens the list');
  await page.click('#mutate-list .gen-entry[data-id="smooth"]');
  assert((await title()) === 'Spectral › Smooth' && !(await page.isVisible('#mutate-list')), 'phone: picking closes the list');
  assert(!(await M(() => document.documentElement.scrollWidth > window.innerWidth)), 'Mutate: no horizontal overflow at 390px');
  await page.click('#tab-seed');
}

/**
 * Timeline strip (wide shell, while playing): a caret for each unmuted voice and none for
 * muted ones, moving with the LFO; window tints split into bands in voice order (top to
 * bottom), solid edges at window start / end, muted voices faint; the thumbnail view
 * cycles (and is remembered); a changed selection is scrolled into view and the strip
 * follows the newest table when it was at the end.
 */
async function timelineMarkerChecks(page) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  await page.setViewportSize({ width: 1440, height: 900 });
  const saved = await M(() => window.mkwavez.model.voices.map((v) => ({ ...v })));
  const ids = saved.map((v) => v.id);
  // Known state: voice 1 sweeping 0–5, voice 2 still on 2–4, voice 3 muted on 1–3.
  await M((ids) => {
    const m = window.mkwavez.model;
    const set = [
      { wavetableId: 0, windowStart: 0, windowEnd: 5, position: 0.5, lfoDepth: 1, lfoRate: 3, mute: false },
      { wavetableId: 0, windowStart: 2, windowEnd: 4, position: 0.5, lfoDepth: 0, mute: false },
      { wavetableId: 0, windowStart: 1, windowEnd: 3, position: 0.5, lfoDepth: 0.5, mute: true },
    ];
    ids.forEach((id, i) => m.updateVoice(id, set[i] ?? { mute: true }));
    m.endGesture();
    m.select(m.timeline[10].id);
  }, ids);
  // Waveform view for the pixel checks.
  for (let i = 0; i < 3 && (await page.getAttribute('#timeline-view', 'data-view')) !== '0'; i++) await page.click('#timeline-view');
  await page.waitForTimeout(100);
  await M(() => (document.querySelector('#timeline-scroll').scrollLeft = 0));
  const markers = () =>
    M(() =>
      (document.querySelector('#timeline-markers').dataset.markers || '')
        .split(' ')
        .filter(Boolean)
        .map((s) => s.split(':').map(Number)),
    );
  // Wait for the worklet's position report to reflect the new params.
  await page.waitForFunction(
    () => {
      const m = (document.querySelector('#timeline-markers').dataset.markers || '').split(' ').map((s) => Number(s.split(':')[1]));
      return m.length === 2 && m[0] <= 5 && Math.abs(m[1] - 3) < 1e-3;
    },
    null,
    { timeout: 3000 },
  );
  const a = await markers();
  assert(
    JSON.stringify(a.map((m) => m[0])) === JSON.stringify(ids.slice(0, 2)),
    `timeline carets for unmuted voices only (${a.map((m) => `V${m[0]}@${m[1]}`).join(', ')})`,
  );
  assert(a[0][1] >= 0 && a[0][1] <= 5 && Math.abs(a[1][1] - 3) < 1e-3, 'carets sit inside their windows');
  const inked = await M(() => {
    const c = document.querySelector('#timeline-markers');
    return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v);
  });
  assert(inked, 'caret overlay has ink');
  await page.waitForTimeout(250);
  const b = await markers();
  assert(Math.abs(b[0][1] - a[0][1]) > 0.01, `LFO moves the live caret (${a[0][1]} → ${b[0][1]})`);

  // Tints: classify pixels against each voice colour blended over the cell background.
  const px = await M(() => {
    const PITCH = 63;
    const g = document.querySelector('#timeline-grid');
    const d = g.width / g.clientWidth;
    const H = g.clientHeight;
    const ctx = g.getContext('2d');
    const probe = document.createElement('canvas').getContext('2d');
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n);
    const rgb = (c) => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = c;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const bg = rgb(css('--bg'));
    const m = window.mkwavez.model;
    const vc = m.voices.slice(0, 3).map((v) => rgb(css(`--v${(v.id - 1) % 8}`)));
    const mix = (c, a) => c.map((x, i) => bg[i] * (1 - a) + x * a);
    // Candidates: V1 strong, V2 strong, V3 faint (muted), V3 strong.
    const cands = [mix(vc[0], 0.38), mix(vc[1], 0.38), mix(vc[2], 0.14), mix(vc[2], 0.38)];
    const at = (x, y) => [...ctx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data.slice(0, 3)];
    const dist = (p, c) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    const classify = (x0, y0, y1) => {
      const votes = [0, 0, 0, 0];
      for (let x = x0 + 8; x < x0 + 56; x += 3)
        for (let y = y0 + 2; y < y1 - 2; y += 2) {
          const p = at(x, y);
          const ds = cands.map((c) => dist(p, c));
          const k = ds.indexOf(Math.min(...ds));
          if (ds[k] < 12) votes[k]++;
        }
      return votes.indexOf(Math.max(...votes));
    };
    // Cell 2 is inside all three windows: three bands, voice order top to bottom.
    const bands = [0, 1, 2].map((k) => classify(2 * PITCH, Math.max(13, (k * H) / 3), ((k + 1) * H) / 3));
    // Cell 5 holds only V1 (one band); cell 4 holds V1 + V2 (two bands).
    const one = classify(5 * PITCH, 13, H);
    const two = [classify(4 * PITCH, 13, H / 2), classify(4 * PITCH, H / 2, H)];
    // Edges: V1 ends at 5 (right edge, solid), V2 starts at 2 (left edge, middle band).
    const solid = (p, c) => dist(p, c) < 40;
    const edges = {
      v1End: solid(at(5 * PITCH + 60.25, H * 0.6), vc[0]),
      v2Start: solid(at(2 * PITCH + 1, H / 2), vc[1]),
      noEdge: !solid(at(3 * PITCH + 1, H / 2), vc[1]),
    };
    return { bands, one, two, edges, order: g.dataset.bandOrder, ids: m.voices.map((v) => v.id).join(',') };
  });
  assert(px.order === px.ids, `window bands ordered by voice (${px.order})`);
  assert(JSON.stringify(px.bands) === '[0,1,2]', `overlapping windows: bands top to bottom are V1, V2, V3 (muted faint) (${px.bands})`);
  assert(px.one === 0 && JSON.stringify(px.two) === '[0,1]', `bands only for the voices whose window holds the table (${px.one} / ${px.two})`);
  assert(px.edges.v1End && px.edges.v2Start && px.edges.noEdge, `solid edges at window start / end only (${JSON.stringify(px.edges)})`);

  // View cycling: Waveform → Spectral → Waveform + Spectral → Waveform, remembered.
  const sumGrid = () => canvasInk(page, '#timeline-grid');
  let prev = (await sumGrid()).sum;
  for (const [v, name] of [
    ['1', 'Spectral'],
    ['2', 'Waveform + Spectral'],
    ['0', 'Waveform'],
  ]) {
    await page.click('#timeline-view');
    await page.waitForFunction((v) => document.querySelector('#timeline-grid').dataset.view === v, v, { timeout: 3000 });
    const s = (await sumGrid()).sum;
    assert(
      (await page.textContent('#timeline-view')).trim() === name &&
        (await M(() => localStorage.getItem('mkwavez.timelineView'))) === v &&
        s !== prev,
      `view cycles to ${name} (redrawn, remembered)`,
    );
    prev = s;
  }

  // Scrolling: adding tables while scrolled to the start keeps the position; at the end it follows.
  const sc = () => M(() => {
    const s = document.querySelector('#timeline-scroll');
    return { left: s.scrollLeft, atEnd: s.scrollLeft + s.clientWidth >= s.scrollWidth - 1, w: s.clientWidth, sw: s.scrollWidth };
  });
  const add = (n) =>
    M((n) => {
      const m = window.mkwavez.model;
      const t = m.timeline[0];
      m.addTables(Array.from({ length: n }, () => ({ data: t.data, recipe: t.recipe })), false);
    }, n);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await add(40);
  await frames();
  await M(() => (document.querySelector('#timeline-scroll').scrollLeft = 0));
  await frames();
  await add(5);
  await frames();
  let s = await sc();
  assert(s.left === 0 && s.sw > s.w * 1.5, 'adding while scrolled to the start keeps the strip there');
  await M(() => {
    const el = document.querySelector('#timeline-scroll');
    el.scrollLeft = el.scrollWidth;
  });
  await frames();
  await add(5);
  await frames();
  s = await sc();
  assert(s.atEnd && s.left > 0, 'at the end, the strip follows the newest table');
  await M(() => window.mkwavez.model.select(window.mkwavez.model.timeline[1].id));
  await frames();
  assert((await sc()).left <= 63, 'a changed selection is scrolled into view');
  // Wide shell: a vertical wheel over the strip scrolls it sideways.
  const box = await page.$eval('#timeline-scroll', (s) => {
    const r = s.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  const l0 = (await sc()).left;
  await page.mouse.wheel(0, 300);
  await page.waitForFunction((l0) => document.querySelector('#timeline-scroll').scrollLeft > l0, l0, { timeout: 2000 });
  assert(true, 'wide: vertical wheel scrolls the strip sideways');
  // Phone column: the wheel keeps scrolling the page, not the strip.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const p = await M(() => {
    const s = document.querySelector('#timeline-scroll');
    s.scrollLeft = 0;
    s.scrollIntoView({ block: 'center' });
    const r = s.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, y0: scrollY };
  });
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, 300);
  await page.waitForFunction((y0) => scrollY > y0, p.y0, { timeout: 2000 });
  assert((await sc()).left === 0, 'phone: the wheel over the strip scrolls the page, not the strip');
  assert(await page.isVisible('#timeline-hint'), 'phone: long-press Breed-parent hint visible');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  await page.click('#undo');
  await page.click('#undo');
  await page.click('#undo');
  await M((saved) => {
    const m = window.mkwavez.model;
    for (const v of saved) m.updateVoice(v.id, v);
    m.endGesture();
  }, saved);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
}

/**
 * Timeline "Copy to end": the header button and Ctrl+D (only while the strip has focus)
 * append a copy of the selected table (new id, same data, copyOf = source), select it and
 * scroll it into view; undo removes it.
 */
async function timelineCopyChecks(page, tlCount) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  const n0 = await tlCount();
  const srcId = await M(() => {
    const m = window.mkwavez.model;
    m.select(m.timeline[2].id);
    return m.selectedId;
  });
  await frames();
  await M(() => (document.querySelector('#timeline-scroll').scrollLeft = 0));
  await frames();
  await page.click('#timeline-copy');
  await frames();
  const r = await M((srcId) => {
    const m = window.mkwavez.model;
    const t = m.timeline.at(-1);
    const s = document.querySelector('#timeline-scroll');
    const left = (m.timeline.length - 1) * 63;
    return {
      n: m.timeline.length,
      sameData: t.data === m.table(srcId).data,
      copyOf: t.recipe.params.copyOf,
      newId: t.id > srcId && !m.timeline.slice(0, -1).some((x) => x.id === t.id),
      selected: m.selectedId === t.id,
      inView: left >= s.scrollLeft && left + 62 <= s.scrollLeft + s.clientWidth,
      label: document.querySelector('#timeline-selected').textContent,
    };
  }, srcId);
  assert(
    r.n === n0 + 1 && r.sameData && r.copyOf === srcId && r.newId && r.selected && r.inView && r.label.includes(`copy of id ${srcId}`),
    `Copy to end appends a copy of the selection, selects and reveals it (${JSON.stringify({ ...r, label: undefined })})`,
  );
  await page.click('#undo');
  assert((await tlCount()) === n0, 'undo removes the copy');
  // Ctrl+D elsewhere on the page is not taken over.
  await M(() => document.activeElement?.blur());
  await page.keyboard.press('Control+d');
  await frames();
  assert((await tlCount()) === n0, 'Ctrl+D outside the Timeline does nothing');
  // Clicking a cell focuses the strip; Ctrl+D then copies the clicked table.
  await M(() => (document.querySelector('#timeline-scroll').scrollLeft = 0));
  await frames();
  await page.click('#timeline-grid', { position: { x: 63 + 31, y: 30 } });
  const focused = await M(() => document.activeElement?.id);
  await page.keyboard.press('Control+d');
  await frames();
  const k = await M(() => {
    const m = window.mkwavez.model;
    const t = m.timeline.at(-1);
    return { n: m.timeline.length, copyOf: t.recipe.params.copyOf, src: m.timeline[1].id, selected: m.selectedId === t.id };
  });
  assert(
    focused === 'timeline-scroll' && k.n === n0 + 1 && k.copyOf === k.src && k.selected,
    `Ctrl+D in the focused strip copies the selected table to the end (focus ${focused})`,
  );
  // Auto-repeat (keys held) doesn't add more copies.
  await M(() =>
    document
      .querySelector('#timeline-scroll')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, repeat: true, bubbles: true })),
  );
  assert((await tlCount()) === n0 + 1, 'Ctrl+D auto-repeat is ignored');
  await page.click('#undo');
  assert((await tlCount()) === n0, 'undo removes the Ctrl+D copy');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
}

/**
 * UI copy calls a single cycle a "waveform": no text node, aria-label, title, placeholder or
 * aria-description anywhere in the page (hidden tabs included) contains the word "table(s)"
 * on its own ("wavetable" is fine).
 */
async function wordingCheck(page, where) {
  const hits = await page.evaluate(() => {
    const re = /\btables?\b/i;
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const tag = n.parentElement?.tagName;
      if (tag !== 'SCRIPT' && tag !== 'STYLE' && re.test(n.textContent)) out.push(`${tag}: ${n.textContent.trim()}`);
    }
    for (const el of document.querySelectorAll('*')) {
      for (const a of ['aria-label', 'title', 'placeholder', 'aria-description', 'alt']) {
        const v = el.getAttribute(a);
        if (v && re.test(v)) out.push(`${el.tagName}#${el.id}[${a}]: ${v}`);
      }
    }
    return out;
  });
  assert(hits.length === 0, `no UI text says "table" (${where})${hits.length ? `: ${hits.join(' | ')}` : ''}`);
}

/**
 * Keyboard shortcuts (wide shell, transport running): Space plays / stops even with a button
 * focused (without clicking it) but types in a text field; [ / ] step through the voice tabs
 * (wrapping); M mutes the selected voice; Shift+← / → move the selected waveform in the
 * Timeline (Timeline wavetable in step, Timeline windows unchanged, strip reveals it, one
 * undo step, no-op at the ends, ignored in text fields, not taken by the batch strip);
 * extra modifiers are ignored; the controls advertise their shortcuts.
 */
async function shortcutChecks(page) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const playing = () => M(() => window.mkwavez.model.playing);
  const blur = () => M(() => document.activeElement?.blur());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#tab-seed');
  await page.waitForTimeout(150);

  // Advertised shortcuts.
  const ks = await M(() =>
    Object.fromEntries(
      ['play', 'voice-mute', 'voice-tabs', 'timeline-scroll', 'timeline-copy'].map((id) => [id, document.getElementById(id).getAttribute('aria-keyshortcuts')]),
    ),
  );
  assert(
    ks.play === 'Space' &&
      ks['voice-mute'] === 'M' &&
      ks['voice-tabs'] === '[ ]' &&
      ks['timeline-scroll'].includes('Shift+ArrowLeft') &&
      ks['timeline-copy'].includes('Control+D'),
    `controls carry aria-keyshortcuts (${JSON.stringify(ks)})`,
  );
  assert(
    (await page.getAttribute('#play', 'title')).includes('(Space)') && (await page.getAttribute('#voice-mute', 'title')).includes('(M)'),
    'tooltips name the shortcuts',
  );

  // Space with a button focused: toggles the transport, doesn't click the button.
  assert(await playing(), 'transport running before the Space checks');
  const theme = () => M(() => document.documentElement.dataset.theme ?? '');
  const theme0 = await theme();
  await page.focus('#theme-toggle');
  await page.keyboard.press('Space');
  assert(!(await playing()), 'Space stops the transport with a button focused');
  assert((await theme()) === theme0 && (await M(() => document.activeElement.id)) === 'theme-toggle', 'Space did not click the focused button');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.mkwavez.model.playing, null, { timeout: 5000 });
  assert((await theme()) === theme0, 'Space starts the transport again (button still not clicked)');
  // Space in a text field types (the search is restored at the end).
  const search0 = await page.inputValue('#seed-search');
  await page.fill('#seed-search', '');
  await page.focus('#seed-search');
  await page.keyboard.press('Space');
  const typed = await page.inputValue('#seed-search');
  assert((await playing()) && typed === ' ', `Space in a text input types a space, transport untouched (${JSON.stringify(typed)}, ${await playing()})`);
  await page.press('#seed-search', 'Escape');
  // Extra modifiers are ignored.
  await blur();
  await page.keyboard.press('Control+Space');
  assert(await playing(), 'Ctrl+Space is not play / stop');

  // [ / ]: voice tabs, wrapping.
  await page.click('#voice-tab-1');
  await blur();
  const sel = () => M(() => window.mkwavez.ui.voiceId);
  const seq = [];
  for (const k of [']', ']', ']', '[']) {
    await page.keyboard.press(k);
    seq.push(await sel());
  }
  assert(seq.join() === '2,3,1,3', `] / [ step through the voice tabs, wrapping (${seq.join()})`);
  assert(
    (await page.getAttribute('#voice-tab-3', 'aria-selected')) === 'true' && (await page.textContent('#seq-target')).includes('V3'),
    '[ / ] switch the Voice and Sequence panels',
  );
  await page.focus('#voice-tab-3');
  await page.keyboard.press(']');
  assert((await sel()) === 1 && (await M(() => document.activeElement.id)) === 'voice-tab-1', '] from a focused tab moves focus to the new tab');
  await page.focus('#seed-search');
  await page.keyboard.press(']');
  assert((await sel()) === 1 && (await page.inputValue('#seed-search')) === ']', '] in a text input types');
  await page.press('#seed-search', 'Escape');

  // M: mute / unmute the selected voice.
  await blur();
  const mute = (id) => M((id) => window.mkwavez.model.voice(id).mute, id);
  await page.keyboard.press('m');
  assert((await mute(1)) && (await page.getAttribute('#voice-mute', 'aria-label')) === 'Unmute V1', 'M mutes the selected voice');
  await page.keyboard.press('Alt+m');
  await page.keyboard.press('Control+m');
  assert(await mute(1), 'Alt+M / Ctrl+M are ignored');
  await page.keyboard.press('m');
  assert(!(await mute(1)), 'M unmutes it');
  const m2 = await mute(2);
  await page.keyboard.press(']');
  await page.keyboard.press('m');
  assert((await mute(2)) === !m2 && (await mute(1)) === false, 'M acts on the newly selected voice (V2)');
  await page.keyboard.press('m');
  assert((await mute(2)) === m2, 'M toggles V2 back');
  // Other layouts: AltGr+8 / 9 type [ / ] (Ctrl+Alt on Windows); non-Latin layouts fall back
  // to the physical key (e.code).
  const key = (init) => M((init) => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })), init);
  await key({ key: '[', code: 'Digit8', ctrlKey: true, altKey: true, modifierAltGraph: true });
  assert((await sel()) === 1, 'AltGr+[ (Ctrl+Alt+AltGraph) steps the voice tab');
  await key({ key: '[', code: 'BracketLeft', ctrlKey: true });
  assert((await sel()) === 1, 'Ctrl+[ is ignored');
  await key({ key: 'х', code: 'BracketLeft' });
  assert((await sel()) === 3, 'non-Latin layout: the [ key (e.code) steps back');
  await key({ key: 'ъ', code: 'BracketRight' });
  assert((await sel()) === 1, 'non-Latin layout: the ] key (e.code) steps forward');
  await key({ key: 'ь', code: 'KeyM' });
  assert(await mute(1), 'non-Latin layout: the M key (e.code) mutes');
  await key({ key: 'ь', code: 'KeyM' });
  assert(!(await mute(1)), 'non-Latin layout: and unmutes');
  // A Space keyup lost to a window switch doesn't leave the next keyup swallowed.
  const spaceUp = () => M(() => document.body.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true })));
  await key({ key: ' ', code: 'Space' });
  assert(!(await playing()), 'synthetic Space stops the transport');
  await M(() => window.dispatchEvent(new Event('blur')));
  assert(await spaceUp(), 'after a window blur the Space keyup is not swallowed');
  await key({ key: ' ', code: 'Space' });
  await page.waitForFunction(() => window.mkwavez.model.playing, null, { timeout: 5000 });
  await page.focus('#seed-search');
  await page.keyboard.down('Space'); // typed (not handled): drops the pending swallow
  assert(await spaceUp(), 'an unhandled Space keydown drops the keyup swallow');
  await page.keyboard.up('Space');
  await page.press('#seed-search', 'Escape');
  await blur();
  assert((await sel()) === 1, 'back on V1');

  // Shift+← / →: move the selected waveform.
  const state = () =>
    M(() => {
      const m = window.mkwavez.model;
      const s = document.querySelector('#timeline-scroll');
      const idx = m.indexOf(m.selectedId);
      const left = idx * 63;
      return {
        ids: m.timeline.map((t) => t.id).join(),
        row: m.wavetable(0).rows[0].join(),
        sel: m.selectedId,
        idx,
        undo: m.undoDepth,
        windows: m.voices.map((v) => `${v.wavetableId}:${v.windowStart}-${v.windowEnd}`).join(' '),
        inView: left >= s.scrollLeft && left + 62 <= s.scrollLeft + s.clientWidth,
        label: document.querySelector('#timeline-selected').textContent,
      };
    });
  const select = (i) => M((i) => window.mkwavez.model.select(window.mkwavez.model.timeline.at(i).id), i);
  await select(3);
  await frames();
  const s0 = await state();
  await page.keyboard.press('Shift+ArrowRight');
  await frames();
  const s1 = await state();
  const swapped = s0.ids.split(',');
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert(
    s1.sel === s0.sel &&
      s1.idx === 4 &&
      s1.ids === swapped.join() &&
      s1.row === s1.ids &&
      s1.windows === s0.windows &&
      s1.undo === s0.undo + 1 &&
      s1.label.startsWith('#5 '),
    'Shift+→ moves the selected waveform one later (Timeline wavetable follows, windows unchanged, one undo step)',
  );
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
  await frames();
  const s2 = await state();
  assert(s2.idx === 1 && s2.row === s2.ids && s2.undo === s0.undo + 1, `consecutive moves coalesce into one undo step (index ${s2.idx}, steps ${s2.undo - s0.undo})`);
  await page.click('#undo');
  await frames();
  const s3 = await state();
  assert(s3.ids === s0.ids && s3.row === s0.ids && s3.sel === s0.sel && s3.undo === s0.undo, 'one undo restores the order');
  // Ends: no-op.
  await select(0);
  await blur();
  await page.keyboard.press('Shift+ArrowLeft');
  let e = await state();
  assert(e.ids === s0.ids && e.undo === s0.undo, 'Shift+← on the first waveform does nothing');
  await select(-1);
  await page.keyboard.press('Shift+ArrowRight');
  e = await state();
  assert(e.ids === s0.ids && e.undo === s0.undo, 'Shift+→ on the last waveform does nothing');
  // The strip reveals the moved waveform (phone width, so the strip scrolls).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.$eval('#timeline-scroll', (s) => s.scrollIntoView({ block: 'center' }));
  await frames();
  await page.$eval('#timeline-scroll', (s) => (s.scrollLeft = 0));
  await frames();
  assert(!(await state()).inView, 'last waveform scrolled out of view');
  await page.keyboard.press('Shift+ArrowLeft');
  await frames();
  await frames();
  e = await state();
  assert(e.idx === e.ids.split(',').length - 2 && e.inView, 'Shift+← scrolls the strip to the moved waveform');
  await page.click('#undo');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  // Ignored in a text field.
  await page.focus('#seed-search');
  await page.keyboard.press('Shift+ArrowLeft');
  e = await state();
  assert(e.ids === s0.ids && e.undo === s0.undo, 'Shift+arrows in a text input do not move waveforms');
  await page.press('#seed-search', 'Escape');
  // The batch strip keeps plain arrows; Shift+arrows there move the waveform, not the strip.
  await select(2);
  await page.focus('#seed-strip .gen-card[aria-pressed="true"]');
  await page.keyboard.press('Home');
  const shown = async () => (await page.textContent('#seed-shown')).trim();
  const shown0 = await shown();
  await page.keyboard.press('Shift+ArrowRight');
  e = await state();
  assert(e.idx === 3 && (await shown()) === shown0, 'Shift+→ in the batch strip moves the waveform, not the strip');
  await page.keyboard.press('ArrowRight');
  assert((await shown()) !== shown0 && (await state()).idx === 3, 'plain → still steps the batch strip');
  await page.click('#undo');
  assert((await state()).ids === s0.ids, 'undo restores the order');
  await page.fill('#seed-search', search0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
}

/**
 * Wavetables phase 1 (wide shell, transport running): the built-ins and their compact
 * views; no "Sets window of" checkboxes; a voice switched to the Grid shows the X/Y pad
 * and paired sliders, its X / Y sliders move the dot, audio keeps running; interpolation
 * is switched on the wavetable; the Voice panel still fits; Position Y is in the CC map.
 */
async function wavetableChecks(page) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const setPlay = async (on) => {
    if ((await M(() => window.mkwavez.model.playing)) !== on) await page.click('#play');
  };
  const wasPlaying = await M(() => window.mkwavez.model.playing);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  const chips = await page.$$eval('#wt-chips [role="option"]', (bs) => bs.map((b) => b.textContent.trim()));
  assert(chips.join() === 'Timeline,Last batch,Batches,Grid', `built-in wavetables (${chips.join(', ')})`);
  assert(
    !(await page.$('.gen-targets')) && !(await M(() => document.body.textContent.includes('Sets window of'))),
    'no "Sets window of" checkboxes',
  );
  assert(!(await page.isDisabled('#wt-edit')) && !(await page.isDisabled('#wt-new')), 'Edit / + enabled');
  const shapes = {};
  for (const [id, shape, label] of [
    [0, '1d', '1D'],
    [1, '1d', '1D'],
    [2, 'rows', 'Rows'],
    [3, '2d', '2D · 8×8'],
  ]) {
    await page.click(`#wt-chip-${id}`);
    await page.waitForFunction((id) => document.querySelector('#wavetable-overview').dataset.wavetable === String(id), id, { timeout: 2000 });
    const ink = await canvasInk(page, '#wavetable-overview');
    const r = await M(() => ({ shape: document.querySelector('#wavetable-overview').dataset.shape, text: document.querySelector('#wt-summary').textContent }));
    shapes[id] = r.shape === shape && r.text.includes(label) && r.text.includes('Live') && ink.n > 0;
  }
  assert(Object.values(shapes).every(Boolean), `wavetable views and summaries (${JSON.stringify(shapes)})`);
  assert((await page.textContent('#wt-used')).trim() === 'not used', 'Grid not used yet');
  // V1 → Grid.
  await page.click('#voice-tab-1');
  await page.selectOption('#voice-wavetable', '3');
  let r = await M(() => {
    const v = window.mkwavez.model.voice(1);
    return { v: [v.wavetableId, v.windowStart, v.windowEnd, v.windowStartY, v.windowEndY], used: document.querySelector('#wt-used').dataset.voices };
  });
  assert(r.v.join() === '3,0,7,0,7' && r.used === '1', `V1 on the Grid: whole 8×8 window, "used by V1" (${r.v})`);
  assert(
    (await page.isVisible('#voice-pad')) && (await page.isVisible('#voice-px')) && !(await page.isVisible('#voice-window-start')),
    'Grid voice: X/Y pad and paired sliders replace the 1D controls',
  );
  await page.waitForFunction(() => !!document.querySelector('#voice-pad').dataset.dot, null, { timeout: 2000 });
  // Static dot (transport stopped) moves with the X / Y position sliders.
  await setPlay(false);
  const dot = () => M(() => document.querySelector('#voice-pad').dataset.dot.split(',').map(Number));
  await page.fill('#voice-dx', '0');
  await page.fill('#voice-dy', '0');
  await page.fill('#voice-px', '0');
  await page.fill('#voice-py', '0');
  await page.waitForTimeout(100);
  const d0 = await dot();
  await page.fill('#voice-px', '1');
  await page.waitForTimeout(100);
  const d1 = await dot();
  await page.fill('#voice-py', '1');
  await page.waitForTimeout(100);
  const d2 = await dot();
  assert(d1[0] > d0[0] + 50 && Math.abs(d1[1] - d0[1]) < 0.5 && d2[1] > d1[1] + 30 && Math.abs(d2[0] - d1[0]) < 0.5, `X / Y sliders move the dot (${d0} → ${d1} → ${d2})`);
  // Window edits on Y; the rectangle clamps and pushes the other handle.
  await page.fill('#voice-wy0', '5');
  await page.fill('#voice-wy1', '2');
  r = await M(() => {
    const v = window.mkwavez.model.voice(1);
    return [v.windowStartY, v.windowEndY];
  });
  assert(r.join() === '2,2', `Y window handles push each other (${r})`);
  await page.fill('#voice-wy0', '0');
  await page.fill('#voice-wy1', '7');
  await page.fill('#voice-px', '0.4');
  await page.fill('#voice-py', '0.6');
  await page.fill('#voice-dx', '0.5');
  await page.fill('#voice-dy', '0.5');
  // Audio: the voice plays the Grid with a moving 2D position.
  await setPlay(true);
  await page.waitForFunction(() => window.mkwavez.model.playing && window.mkwavez.bridge.status.voices.some((s) => s.id === 1 && s.y > 0), null, { timeout: 5000 });
  const a = await M(() => window.mkwavez.bridge.status.voices.find((s) => s.id === 1));
  await page.waitForTimeout(400);
  const b = await M(() => window.mkwavez.bridge.status.voices.find((s) => s.id === 1));
  assert(
    a.index >= 0 && a.index <= 7 && a.y >= 0 && a.y <= 7 && (a.pos !== b.pos || a.posY !== b.posY),
    `worklet plays the Grid voice, LFOs move X / Y (${a.index.toFixed(2)}, ${a.y.toFixed(2)} → ${b.index.toFixed(2)}, ${b.y.toFixed(2)})`,
  );
  const live1 = (await dot()).join();
  await page.waitForTimeout(300);
  assert((await dot()).join() !== live1, 'pad dot follows the live position while playing');
  // Interpolation lives on the wavetable.
  await page.click('#wt-chip-3');
  await page.click('#wt-step');
  assert(
    (await M(() => window.mkwavez.model.wavetable(3).interp)) === 'step' && (await page.textContent('#voice-interp')).startsWith('Step'),
    'Step set on the wavetable; the voice shows it',
  );
  await page.waitForTimeout(300);
  const st = await M(() => window.mkwavez.bridge.status.voices.find((s) => s.id === 1));
  assert(Number.isInteger(st.index) && Number.isInteger(st.y), `Step on 2D plays one cell (${st.index}, ${st.y})`);
  await page.click('#wt-blend');
  // Rows: Batches.
  await page.selectOption('#voice-wavetable', '2');
  assert((await page.isDisabled('#voice-wx0')) && (await page.isVisible('#voice-pad')), 'Rows voice: pad shown, X window disabled (rows align)');
  // Layout budget with the paired controls.
  for (const [w, hh] of [
    [1440, 900],
    [1180, 820],
  ]) {
    await page.setViewportSize({ width: w, height: hh });
    await page.waitForTimeout(250);
    const fit = await M(() => {
      const b = document.querySelector('#sec-voices-body');
      return b.scrollHeight <= b.clientHeight + 1;
    });
    assert((await fitsScreen(page)) && fit, `${w}×${hh}: one screen, Voice panel fits with the X/Y pad`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/wavetables-${w}x${hh}.png` });
  }
  await page.selectOption('#voice-wavetable', '3');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert(!(await M(() => document.documentElement.scrollWidth > innerWidth)), '390px: no horizontal overflow with the X/Y pad');
  // CC map: position Y target, unassigned by default.
  assert((await page.$('#midi-cc-positionY')) && (await page.inputValue('#midi-cc-positionY')) === '', 'CC map has an unassigned Position Y');
  // Back to Last batch (as at start) and stop.
  await page.selectOption('#voice-wavetable', '1');
  await setPlay(wasPlaying);
  await M(() => window.mkwavez.model.endGesture());
}

/** Centre of timeline cell i, relative to the strip canvas (strip scrolled to the start). */
const cellPos = (page, i) =>
  page.evaluate((i) => {
    document.querySelector('#timeline-scroll').scrollLeft = 0;
    return { x: i * 63 + 31, y: document.querySelector('#timeline-grid').clientHeight / 2 };
  }, i);

const waitInk = (page, sel) =>
  page.waitForFunction(
    (sel) => {
      const c = document.querySelector(sel);
      return c && c.width > 1 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v);
    },
    sel,
    { timeout: 5000 },
  );

async function breedChecks(page, tlCount) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const seedOf = async () => parseInt((await page.textContent('#breed-seed')).replace('seed ', '').trim(), 16);
  const parents = () => M(() => [...window.mkwavez.model.breedParents]);
  const same = async (want) => JSON.stringify(await parents()) === JSON.stringify(want);
  const ids = (from, to) => M(([a, b]) => window.mkwavez.model.timeline.slice(a, b).map((t) => t.id), [from, to]);
  await page.click('#tab-breed');
  await M(() => window.mkwavez.model.setBreedParents([]));
  assert(await page.isDisabled('#breed-apply1'), 'Breed disabled with no parents');

  // Timeline: Shift-click toggles parents without changing the selection.
  const sel0 = await M(() => window.mkwavez.model.selectedId);
  await page.click('#timeline-grid', { position: await cellPos(page, 1), modifiers: ['Shift'] });
  await page.click('#timeline-grid', { position: await cellPos(page, 2), modifiers: ['Shift'] });
  const [t1, t2, t3] = await ids(1, 4);
  assert(await same([t1, t2]), 'Shift-click adds timeline tables as parents A, B');
  assert((await M(() => window.mkwavez.model.selectedId)) === sel0, 'Shift-click leaves the selection alone');
  assert((await page.$$('#breed-parents .parent-card')).length === 2, 'two parent cards');
  await waitInk(page, '#breed-parents .parent-card canvas');
  assert(true, 'parent thumbnails render');

  // Touch long-press toggles a parent and swallows the click.
  const p3 = await cellPos(page, 3);
  await page.evaluate(({ x, y }) => {
    const g = document.querySelector('#timeline-grid');
    const r = g.getBoundingClientRect();
    g.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: r.left + x, clientY: r.top + y, bubbles: true }));
  }, p3);
  await page.waitForTimeout(600);
  await page.evaluate(({ x, y }) => {
    const g = document.querySelector('#timeline-grid');
    const r = g.getBoundingClientRect();
    const o = { clientX: r.left + x, clientY: r.top + y, bubbles: true };
    g.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerType: 'touch' }));
    g.dispatchEvent(new MouseEvent('click', o));
  }, p3);
  assert(await same([t1, t2, t3]), 'long-press adds parent C');
  assert((await M(() => window.mkwavez.model.selectedId)) === sel0, 'long-press does not select');

  // Remove, reorder, Add selected.
  await page.click('button[aria-label="Remove parent C"]');
  assert(await same([t1, t2]), '× removes a parent');
  await page.click('button[aria-label="Move A later"]');
  assert(await same([t2, t1]), '› reorders parents');
  await page.click('button[aria-label="Move B earlier"]');
  await page.click('#timeline-grid', { position: await cellPos(page, 3) });
  await page.click('#breed-add-selected');
  assert(await same([t1, t2, t3]), 'Add selected appends the selection');
  assert(await page.isDisabled('#breed-add-selected'), 'Add selected disabled when already a parent');

  // Use a voice's window.
  const win = await M(() => {
    const m = window.mkwavez.model;
    const t = m.windowTables(m.voices[0]);
    const n = Math.min(8, t.length);
    return Array.from({ length: n }, (_, i) => t[n > 1 ? Math.round((i * (t.length - 1)) / (n - 1)) : 0].id);
  });
  await page.selectOption('#breed-window-voice', { index: 0 });
  await page.click('#breed-use-window');
  assert(await same(win), `Use window takes the voice window (${win.length} parents)`);

  // Back to tri + saw for the operator pass; preview renders and follows Bias.
  await M((ps) => window.mkwavez.model.setBreedParents(ps), [t1, t2]);
  await waitInk(page, '#breed-pv-wave');
  const before = await canvasInk(page, '#breed-pv-wave');
  await page.fill('#breed-bias', '0.3');
  await page.waitForFunction(
    (b) => {
      const c = document.querySelector('#breed-pv-wave');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum = (sum * 31 + d[i] + d[i + 1] * 7 + d[i + 3] * 13) % 1000000007;
      return sum !== b;
    },
    before.sum,
    { timeout: 5000 },
  );
  assert(true, 'preview renders and updates with Bias');
  assert((await page.textContent('#breed-weights')).includes('A 70'), 'weights readout shows A 70 · B 30');
  const s0 = await seedOf();
  await page.click('#breed-reroll');
  assert((await seedOf()) !== s0, 'Reroll draws a new seed');

  // Every operator: Breed adds one selected child with a full recipe.
  const opIds = await page.$$eval('#breed-op option', (os) => os.map((o) => o.value));
  assert(opIds.length >= 7, `${opIds.length} operators`);
  for (const op of opIds) {
    await page.selectOption('#breed-op', op);
    await page.waitForTimeout(80);
    const seed = await seedOf();
    const n = await tlCount();
    await page.click('#breed-apply1');
    const r = await M(() => {
      const m = window.mkwavez.model;
      const t = m.timeline.at(-1);
      return { ...t.recipe, id: t.id, sel: m.selectedId, peak: Math.max(...t.data.map(Math.abs)) };
    });
    assert(
      (await tlCount()) === n + 1 &&
        r.op === 'breed' &&
        r.params.breed === op &&
        r.params.bias === 0.3 &&
        r.seed === seed &&
        JSON.stringify(r.parents) === JSON.stringify([t1, t2]) &&
        r.sel === r.id &&
        Math.abs(r.peak - 1) < 1e-4,
      `Breed (${op}) adds one child with its recipe`,
    );
    assert((await seedOf()) !== seed, `${op}: new seed after Breed`);
  }

  // Breed N: sweep, then a generation.
  await page.selectOption('#breed-op', 'spectral');
  await page.selectOption('#breed-mode', 'sweep');
  let n = await tlCount();
  let seed = await seedOf();
  await page.click('#breed-applyN');
  let r = await M(() => {
    const m = window.mkwavez.model;
    const b = m.timeline.slice(-8);
    const v = m.voices[0];
    return { biases: b.map((t) => t.recipe.params.bias), seeds: [...new Set(b.map((t) => t.recipe.seed))], plays: m.windowTables(v).map((t) => t.id).join() === b.map((t) => t.id).join() };
  });
  assert((await tlCount()) === n + 8, 'Breed N (sweep) adds 8');
  assert(
    r.biases.every((b, i) => Math.abs(b - (0.3 * (i + 1)) / 8) < 1e-12) && r.seeds.length === 1 && r.seeds[0] === seed,
    'sweep biases 0.3·i/8, one seed',
  );
  assert(r.plays, 'sweep is the Last batch V1 plays');

  await page.selectOption('#breed-op', 'genetic');
  await page.selectOption('#breed-mode', 'gen');
  n = await tlCount();
  await page.click('#breed-applyN');
  r = await M(() => {
    const b = window.mkwavez.model.timeline.slice(-8);
    const distinct = new Set(b.map((t) => Array.from(t.data.slice(0, 64), (v) => v.toFixed(5)).join())).size;
    return { biases: [...new Set(b.map((t) => t.recipe.params.bias))], modes: [...new Set(b.map((t) => t.recipe.params.mode))], distinct };
  });
  assert((await tlCount()) === n + 8 && r.biases.length === 1 && r.modes[0] === 'gen', 'Breed N (generation) adds 8 at one bias');
  assert(r.distinct > 1, `generation children differ (${r.distinct} distinct)`);
  await page.click('#undo');
  assert((await tlCount()) === n, 'undo removes the generation');

  // Generation of a deterministic operator without mutation is disabled.
  await page.selectOption('#breed-op', 'mix');
  await page.fill('#breed-rate', '0');
  assert(await page.isDisabled('#breed-applyN'), 'generation of Crossfade at 0% mutation is disabled');
  await page.fill('#breed-rate', '0.05');
  assert(!(await page.isDisabled('#breed-applyN')), 're-enabled with mutation');
  // A generation at a pure parent (path stop on B of three) would be copies even for a seeded operator.
  await page.selectOption('#breed-op', 'genetic');
  await M((ps) => window.mkwavez.model.setBreedParents(ps), [t1, t2, t3]);
  await page.fill('#breed-bias', '0.5');
  assert(await page.isDisabled('#breed-applyN'), 'generation at a pure parent is disabled');
  await M((ps) => window.mkwavez.model.setBreedParents(ps), [t1, t2]);
  assert(!(await page.isDisabled('#breed-applyN')), 'generation between two parents enabled');
  await page.selectOption('#breed-mode', 'sweep');
  await page.fill('#breed-bias', '0');
  assert(await page.isDisabled('#breed-applyN'), 'sweep at bias 0 is disabled');
  await page.fill('#breed-bias', '0.3');
  assert(!(await page.isDisabled('#breed-applyN')), 'sweep re-enabled above bias 0');

  // Custom weights.
  await page.selectOption('#breed-walk', 'weights');
  assert(await page.isVisible('#breed-parents .pc-weight'), 'custom weights show per-parent sliders');
  await page.fill('#breed-parents .parent-card:nth-child(2) .pc-weight', '0.5');
  await page.click('#breed-apply1');
  r = await M(() => window.mkwavez.model.timeline.at(-1).recipe.params);
  assert(r.walk === 'weights' && r.weights === '1,0.5', `custom weights recorded (${r.weights})`);
  await page.selectOption('#breed-walk', 'path');
  await page.click('#tab-seed');
}

/**
 * Fake Web MIDI (init script): navigator.requestMIDIAccess resolves to a mock MIDIAccess
 * with one input ("Fake Keys"); window.__midi fires messages, hot-plugs and unplugs inputs.
 */
function installFakeMidi() {
  class FakeInput {
    constructor(id, name) {
      Object.assign(this, { id, name, manufacturer: 'Test', type: 'input', state: 'connected', connection: 'closed', onmidimessage: null });
    }
    fire(bytes) {
      this.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp: performance.now() });
    }
  }
  const inputs = new Map();
  const access = { inputs, outputs: new Map(), sysexEnabled: false, onstatechange: null };
  const m = {
    access,
    requests: 0,
    add(id, name) {
      const i = new FakeInput(id, name);
      inputs.set(id, i);
      access.onstatechange?.({ port: i });
    },
    unplug(id) {
      const i = inputs.get(id);
      i.state = 'disconnected';
      access.onstatechange?.({ port: i });
    },
    fire: (id, bytes) => inputs.get(id).fire(bytes),
    /** Inputs the app is listening to. */
    open: () => [...inputs.values()].filter((i) => i.state === 'connected' && i.onmidimessage).map((i) => i.id),
  };
  m.add('in-1', 'Fake Keys');
  window.__midi = m;
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: () => {
      m.requests++;
      return Promise.resolve(access);
    },
  });
}

/**
 * Web MIDI with a mocked MIDIAccess: no permission request until an input is chosen;
 * channel routing, note on / off / velocity 0 / held-note return / all-notes-off reaching
 * the engine; CC1 → position (slider follows); Omni → selected tab; learn (persisted);
 * hot-plug and unplug (releases held notes); the remembered input reconnects on reload;
 * layout still fits. Then the unsupported and permission-denied paths.
 */
async function midiChecks(label, url, browser) {
  console.log(`\n[${label}] Web MIDI`);
  const errors = [];
  const watch = (page) => {
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
  };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page);
  await page.addInitScript(installFakeMidi);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#midi-input');
  const E = (fn, arg) => page.evaluate(fn, arg);
  assert((await E(() => window.__midi.requests)) === 0 && (await page.inputValue('#midi-input')) === 'off', 'MIDI off by default: no access request');
  assert(await fitsScreen(page), '1440×900: one screen with the MIDI controls');

  await page.selectOption('#midi-input', 'all');
  await page.waitForFunction(() => window.__midi.open().length === 1, null, { timeout: 3000 });
  const opts = await page.$$eval('#midi-input option', (os) => os.map((o) => o.textContent));
  assert(opts.includes('Fake Keys') && opts.includes('All MIDI inputs') && opts.includes('MIDI off'), `picker lists Off, All and the input (${opts.join(', ')})`);
  assert((await page.getAttribute('#midi-led', 'data-state')) === 'on', 'LED shows a connected input');
  await page.waitForFunction(() => document.body.dataset.audio === 'running', null, { timeout: 10000 });
  assert(!(await E(() => window.mkwavez.model.playing)), 'choosing an input starts audio, not the transport');

  const fire = (bytes, id = 'in-1') => E(([b, i]) => window.__midi.fire(i, b), [bytes, id]);
  const waitNote = (voice, note, msg) =>
    page
      .waitForFunction(([v, n]) => window.mkwavez.bridge.status.voices.find((x) => x.id === v)?.note === n, [voice, note], { timeout: 3000 })
      .then(() => assert(true, msg));

  await fire([0x90, 69, 100]);
  assert(await page.$eval('#midi-led', (l) => l.classList.contains('blink')), 'activity LED blinks');
  await waitNote(1, 69, 'channel 1 note-on reaches voice 1 in the engine');
  await fire([0x91, 72, 90]);
  await waitNote(2, 72, 'channel 2 → voice 2');
  await fire([0x95, 40, 90]);
  await page.waitForTimeout(100);
  assert(!(await E(() => window.mkwavez.bridge.status.voices.some((v) => v.note === 40))), 'channel 5 (no voice 5) is ignored');
  await fire([0x80, 69, 0]);
  await waitNote(1, -1, 'note-off releases voice 1');
  await fire([0x91, 72, 0]);
  await waitNote(2, -1, 'note-on with velocity 0 releases');
  await fire([0x90, 60, 100]);
  await fire([0x90, 64, 100]);
  await waitNote(1, 64, 'last note wins');
  await fire([0x80, 64, 0]);
  await waitNote(1, 60, 'releasing it returns to the held note');
  await fire([0xb0, 123, 0]);
  await waitNote(1, -1, 'all-notes-off (CC 123) releases held notes');

  // A knob sweep: the engine gets each move (voice/patch); the model / sliders catch up per frame.
  const waitParam = (voice, key, value, msg) =>
    page
      .waitForFunction(([v, k, x]) => window.mkwavez.model.voice(v)[k] === x, [voice, key, value], { timeout: 2000 })
      .then(() => assert(true, msg));
  const sweep = await E(() => {
    let events = 0;
    const off = window.mkwavez.model.on('voices', () => events++);
    for (let v = 0; v <= 127; v++) window.__midi.fire('in-1', [0xb0, 1, v]);
    return new Promise((res) => setTimeout(() => (off(), res(events)), 100));
  });
  assert(sweep >= 1 && sweep <= 3, `a 128-step CC sweep makes ${sweep} model update(s), not 128`);
  await waitParam(1, 'position', 1, 'CC1 (mod wheel) moves voice 1 position');
  await page.waitForFunction(() => document.querySelector('#voice-position').value === '1', null, { timeout: 2000 });
  assert(true, 'the position slider follows');
  await fire([0xb0, 1, 0]);
  await waitParam(1, 'position', 0, 'CC1 at 0 → position 0');

  // Omni → the selected voice tab.
  await page.click('#voice-tab-3');
  await page.click('#midi-settings');
  assert(await page.isVisible('#midi-pop'), 'MIDI popover opens');
  assert(await fitsScreen(page), 'popover open: still no page scroll');
  await page.check('#midi-omni');
  assert((await page.textContent('#midi-omni-label')).includes('V3'), 'Omni label names the selected voice');
  await fire([0x9a, 62, 100]);
  await waitNote(3, 62, 'Omni: channel 11 plays the selected voice (V3)');
  await fire([0x8a, 62, 0]);
  await waitNote(3, -1, 'Omni note-off');

  // Learn.
  await page.click('#midi-learn-lfoDepth');
  assert((await page.getAttribute('#midi-learn-lfoDepth', 'aria-pressed')) === 'true', 'learn armed');
  await fire([0xb2, 74, 0]);
  await page.waitForFunction(() => document.querySelector('#midi-cc-lfoDepth').value === '74', null, { timeout: 2000 });
  assert((await page.getAttribute('#midi-learn-lfoDepth', 'aria-pressed')) === 'false', 'learn assigns CC 74 to LFO depth and disarms');
  await waitParam(3, 'lfoDepth', 0, 'the learned move applies (V3 LFO depth 0)');
  await fire([0xb2, 74, 127]);
  await waitParam(3, 'lfoDepth', 1, 'learned CC drives LFO depth');
  await page.fill('#midi-cc-level', '7');
  await page.press('#midi-cc-level', 'Enter');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert(!(await page.isVisible('#midi-pop')), 'Escape closes the popover');
  const stored = await E(() => JSON.parse(localStorage.getItem('mkwavez.midi')));
  assert(
    stored.input === 'all' && stored.omni === true && stored.cc.lfoDepth === 74 && stored.cc.level === 7 && stored.cc.position === 1,
    'settings persisted',
  );

  // Hot-plug / unplug.
  const optionTexts = () => page.$$eval('#midi-input option', (os) => os.map((o) => o.textContent));
  await E(() => window.__midi.add('in-2', 'Second Keys'));
  await page.waitForFunction(() => window.__midi.open().length === 2, null, { timeout: 2000 });
  assert((await optionTexts()).includes('Second Keys'), 'hot-plugged input listed and heard (All inputs)');
  await fire([0x90, 50, 100], 'in-2');
  await waitNote(3, 50, 'second input plays');
  await E(() => window.__midi.unplug('in-2'));
  await waitNote(3, -1, 'unplugging an input releases its held notes');
  assert(!(await optionTexts()).includes('Second Keys'), 'unplugged input leaves the picker');

  // Remembered input reconnects on reload (fake MIDI re-installed by the init script).
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__midi.open().length === 1, null, { timeout: 3000 });
  assert((await E(() => window.__midi.requests)) === 1 && (await page.inputValue('#midi-input')) === 'all', 'stored input reconnects on load');
  await page.click('#midi-settings');
  assert((await page.inputValue('#midi-cc-lfoDepth')) === '74' && (await page.isChecked('#midi-omni')), 'CC map and Omni restored');
  await page.keyboard.press('Escape');
  // A chosen input that is unplugged stays selected as "not connected" (reconnects on hot-plug).
  await page.selectOption('#midi-input', 'in-1');
  await E(() => window.__midi.unplug('in-1'));
  await page.waitForFunction(() => window.__midi.open().length === 0, null, { timeout: 2000 });
  assert((await page.$eval('#midi-input', (s) => s.selectedOptions[0].textContent)).includes('not connected'), 'unplugged chosen input shown as not connected');
  assert((await page.textContent('#midi-status')).trim() === 'No input', 'status says no input');
  for (const [w, hh] of [
    [1440, 900],
    [1180, 820],
  ]) {
    await page.setViewportSize({ width: w, height: hh });
    await page.waitForTimeout(150);
    const bar = await E(() => {
      const t = document.querySelector('.transport');
      return t.scrollWidth <= t.clientWidth + 1;
    });
    assert((await fitsScreen(page)) && bar, `${w}×${hh}: one screen, transport bar not overflowing`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const phone = await E(() => {
    const t = document.querySelector('.transport');
    const b = document.querySelector('#midi-settings').getBoundingClientRect();
    const th = document.querySelector('#theme-toggle').getBoundingClientRect();
    return { page: document.documentElement.scrollWidth <= innerWidth, bar: t.scrollWidth <= t.clientWidth + 1, apart: b.right <= th.left, w: b.width };
  });
  assert(phone.page && phone.bar && phone.apart && phone.w > 40, `390px: transport bar fits with the MIDI button (${JSON.stringify(phone)})`);
  // On a phone the picker lives in the popover.
  await page.click('#midi-settings');
  assert(await page.isVisible('#midi-input-pop'), '390px: input picker in the popover');
  await page.selectOption('#midi-input-pop', 'all');
  assert((await page.inputValue('#midi-input')) === 'all', 'popover picker and bar picker stay in sync');
  await page.keyboard.press('Escape');
  if (SHOTS) {
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.click('#midi-settings');
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/${label}-midi-1180x820.png` });
  }
  await ctx.close();

  // Unsupported browser (no requestMIDIAccess) with a remembered input: clear, non-blocking status.
  const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p2 = await ctx2.newPage();
  watch(p2);
  await p2.addInitScript(() => {
    localStorage.setItem('mkwavez.midi', JSON.stringify({ input: 'all' }));
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: undefined });
  });
  await p2.goto(url, { waitUntil: 'load' });
  await p2.waitForFunction(() => document.querySelector('#midi-status').textContent !== '', null, { timeout: 3000 });
  assert(
    (await p2.textContent('#midi-status')) === 'No Web MIDI' &&
      (await p2.isDisabled('#midi-input')) &&
      (await p2.getAttribute('#midi-led', 'data-state')) === 'error',
    'unsupported browser: "No Web MIDI" status, picker disabled',
  );
  await p2.click('#midi-settings');
  assert((await p2.textContent('#midi-message')).includes('Safari'), 'popover explains (Safari / other browsers)');
  await p2.keyboard.press('Escape');
  await p2.click('#play');
  await p2.waitForFunction(() => document.body.dataset.audio === 'running', null, { timeout: 10000 });
  assert(await fitsScreen(p2), 'app still plays and fits without MIDI');
  await ctx2.close();

  // Permission denied.
  const ctx3 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p3 = await ctx3.newPage();
  watch(p3);
  await p3.addInitScript(() => {
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    });
  });
  await p3.goto(url, { waitUntil: 'load' });
  await p3.selectOption('#midi-input', 'all');
  await p3.waitForFunction(() => document.querySelector('#midi-status').textContent === 'MIDI blocked', null, { timeout: 3000 });
  assert(!(await p3.isDisabled('#midi-input')), 'permission denied: "MIDI blocked", picker still usable to retry');
  await ctx3.close();

  assert(errors.length === 0, `no console errors (MIDI)${errors.length ? `: ${errors.join(' | ')}` : ''}`);
}

/**
 * Autosave / restore: changes survive a reload (timeline count, selection, voices incl. a
 * 2D one, wavetables, sequences, BPM, voice tab, Generate tab); playback works after a
 * restore; Export → New session (clears the autosave) → Import round-trips; a bad file is
 * refused with a notice; an unreadable save falls back to a fresh session (kept for
 * debugging); without IndexedDB the app runs with autosave off and a notice.
 */
async function sessionChecks(label, url, browser) {
  console.log(`\n[${label}] session autosave / restore`);
  const errors = [];
  const watch = (page) => {
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
  };
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page);
  const E = (fn, arg) => page.evaluate(fn, arg);
  const load = async (reload = true) => {
    if (reload) await page.reload({ waitUntil: 'load' });
    else await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#sec-generate');
  };
  const saved = () =>
    page.waitForFunction(() => window.mkwavez.saver.status === 'saved' && window.mkwavez.saver.lastSaved, null, { timeout: 10000 }).catch(async (e) => {
      const st = await E(() => ({ status: window.mkwavez.saver.status, error: window.mkwavez.saver.lastError, vis: document.visibilityState }));
      throw new Error(`autosave didn't finish: ${JSON.stringify(st)} (${e.message})`);
    });
  const snap = () =>
    E(() => {
      const { model: m, ui } = window.mkwavez;
      return JSON.stringify({
        ids: m.timeline.map((t) => t.id),
        recipes: m.timeline.map((t) => t.recipe),
        data: m.timeline.map((t) => Array.from(t.data.subarray(0, 64))),
        selectedId: m.selectedId,
        bpm: m.bpm,
        voices: m.voices,
        wavetables: m.wavetables,
        sequences: m.sequences,
        voiceTab: ui.voiceId,
      });
    });
  await load(false);
  assert((await E(() => window.mkwavez.model.timeline.length)) === 5 && (await page.isVisible('#session-menu')), 'fresh session: 5 waveforms, Session menu in the transport bar');
  await saved();
  assert(true, 'fresh session autosaved');

  // Make changes through the UI and the model.
  await page.click('#seed-add-shown');
  await page.click('#seed-add-batch');
  await E(() => {
    const { model: m, ui } = window.mkwavez;
    m.copyToEnd(m.timeline[2].id);
    m.setTransport({ bpm: 111 });
    m.updateVoice(2, { mute: false, position: 0.42, lfoDepth: 0.1 });
    m.addVoice({ wavetableId: 3, windowStart: 1, windowEnd: 4, windowStartY: 0, windowEndY: 1, positionY: 0.8 });
    m.setWavetableInterp(3, 'step');
    m.updateSequence(1, { gate: 0.7, length: 12 });
    m.select(m.timeline[3].id);
    ui.setVoice(2);
  });
  await page.click('#tab-mutate');
  const before = await snap();
  const n = await E(() => window.mkwavez.model.timeline.length);
  await saved();
  const t0 = Date.now();
  await load();
  assert((await snap()) === before, `reload restores the session (${n} waveforms, selection, voices, wavetables, sequences, BPM; ${Date.now() - t0} ms)`);
  assert(
    (await page.getAttribute('#tab-mutate', 'aria-selected')) === 'true' && (await page.getAttribute('#voice-tab-2', 'aria-selected')) === 'true',
    'reload restores the Generate tab and the voice tab',
  );
  assert((await page.inputValue('#bpm')) === '111' && (await E(() => window.mkwavez.model.undoDepth)) === 0, 'BPM control shows the restored tempo; undo history starts empty');

  // Playback after restore.
  await page.click('#play');
  await page.waitForFunction(() => document.body.dataset.audio === 'running', null, { timeout: 10000 });
  await page.waitForFunction(() => window.mkwavez.bridge.workletTableCount === window.mkwavez.model.timeline.length && Number(document.body.dataset.step) >= 2, null, { timeout: 10000 });
  assert(true, 'restored session plays (worklet holds every waveform, sequencer runs)');

  // Export.
  await page.click('#session-menu');
  assert(await page.isVisible('#session-pop'), 'Session menu opens');
  assert((await page.textContent('#session-status')).includes('Autosave on'), 'menu shows autosave status');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#session-export')]);
  const file = await dl.path();
  assert(dl.suggestedFilename().endsWith('.mkwz') && file, `export downloads ${dl.suggestedFilename()}`);

  // New session (confirm), while playing: clears the autosave too.
  page.once('dialog', (d) => d.accept());
  await page.click('#session-menu').catch(() => {});
  if (!(await page.isVisible('#session-new'))) await page.click('#session-menu');
  await page.click('#session-new');
  await page.waitForFunction(() => window.mkwavez.model.timeline.length === 5 && window.mkwavez.model.bpm === 132, null, { timeout: 5000 });
  await page.waitForFunction(() => window.mkwavez.bridge.workletTableCount === 5, null, { timeout: 5000 });
  assert(true, 'New session: back to the default (worklet follows)');
  await page.click('#play');
  await saved();
  await load();
  assert((await E(() => window.mkwavez.model.timeline.length)) === 5 && (await E(() => window.mkwavez.model.bpm)) === 132, 'New session cleared the autosave (reload stays fresh)');

  // Import (confirm) round-trips the exported session.
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#session-file', file);
  await page.waitForFunction((k) => window.mkwavez.model.timeline.length === k, n, { timeout: 10000 });
  assert((await snap()) === before, 'import restores the exported session exactly');
  await saved();
  await load();
  assert((await snap()) === before, 'imported session survives a reload');

  // A bad file is refused.
  await page.setInputFiles('#session-file', { name: 'bad.mkwz', mimeType: 'application/octet-stream', buffer: Buffer.from('not a session at all') });
  await page.waitForSelector('#session-notice:not([hidden])', { timeout: 3000 });
  assert((await page.textContent('#session-notice')).includes('Couldn’t import'), 'bad file: notice, session unchanged');
  assert((await snap()) === before, 'session unchanged after a bad import');

  // Two tabs: the second one restores the save but autosave is paused there; it can take over.
  const pageB = await ctx.newPage();
  watch(pageB);
  await pageB.goto(url, { waitUntil: 'load' });
  await pageB.waitForSelector('#sec-generate');
  // It renders at once (autosave paused) and gives up waiting for the lock after ~1.5 s.
  await pageB.waitForFunction(() => document.querySelector('#session-notice')?.textContent.includes('open in another tab'), null, { timeout: 5000 });
  assert(
    (await pageB.evaluate(() => window.mkwavez.saver.status)) === 'paused' &&
      (await pageB.textContent('#session-notice')).includes('open in another tab') &&
      (await pageB.evaluate(() => window.mkwavez.model.timeline.length)) === n,
    'second tab: restores the save, autosave paused, notice',
  );
  await pageB.evaluate(() => window.mkwavez.model.setTransport({ bpm: 77 }));
  await pageB.waitForTimeout(2000);
  await E(() => window.mkwavez.model.setTransport({ bpm: 112 }));
  await saved();
  const storedBpm = () =>
    E(
      () =>
        new Promise((res) => {
          const r = indexedDB.open('mkwavez');
          r.onsuccess = () => {
            const g = r.result.transaction('meta').objectStore('meta').get('session');
            g.onsuccess = () => {
              r.result.close();
              res(g.result?.bpm);
            };
          };
        }),
    );
  assert((await storedBpm()) === 112, 'paused tab writes nothing; the owning tab keeps saving');
  pageB.once('dialog', (d) => d.accept());
  await pageB.click('#session-notice button:not(.session-notice-close)');
  await pageB.waitForFunction(() => window.mkwavez.saver.status === 'saved' && window.mkwavez.saver.isActive, null, { timeout: 10000 });
  await page.waitForFunction(() => window.mkwavez.saver.status === 'paused', null, { timeout: 5000 });
  assert((await storedBpm()) === 77 && (await page.textContent('#session-notice')).includes('open in another tab'), 'take over: the second tab saves, the first one pauses');
  await pageB.close();
  // The first tab takes it back (via the Session menu).
  page.once('dialog', (d) => d.accept());
  await page.click('#session-menu');
  await page.click('#session-takeover');
  await page.waitForFunction(() => window.mkwavez.saver.status === 'saved' && window.mkwavez.saver.isActive, null, { timeout: 10000 });
  assert((await storedBpm()) === 112, 'Session menu: take over again');
  await page.keyboard.press('Escape');

  // An unreadable save: set aside intact (meta + waveforms), fresh session, notice.
  const storedCount = await E(() => window.mkwavez.model.timeline.length);
  const maxStored = await E(() => Math.max(...window.mkwavez.model.timeline.map((t) => t.id)));
  await E(
    () =>
      new Promise((res, rej) => {
        const r = indexedDB.open('mkwavez');
        r.onsuccess = () => {
          const tx = r.result.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ format: 'mkwavez-session', version: 99, timeline: [] }, 'session');
          tx.oncomplete = () => {
            r.result.close();
            res();
          };
          tx.onerror = rej;
        };
        r.onerror = rej;
      }),
  );
  await load();
  assert((await E(() => window.mkwavez.model.timeline.length)) === 5, 'unrestorable save: starts a fresh session');
  assert((await page.textContent('#session-notice')).includes('newer version'), 'unrestorable save: notice says why');
  const kept = await E(
    () =>
      new Promise((res) => {
        const r = indexedDB.open('mkwavez');
        r.onsuccess = () => {
          const tx = r.result.transaction(['kept', 'keptWaveforms']);
          const g = tx.objectStore('kept').getAll();
          const c = tx.objectStore('keptWaveforms').count();
          tx.oncomplete = () => {
            r.result.close();
            const last = g.result.at(-1);
            res({ version: last?.meta?.version, records: last?.count === c.result ? c.result : -1 });
          };
        };
      }),
  );
  assert(kept.version === 99 && kept.records >= storedCount, `unrestorable save kept intact (meta + ${kept.records} waveforms)`);
  await page.click('#seed-add-shown');
  assert((await E(() => window.mkwavez.model.selectedId)) > maxStored, 'new waveform ids never collide with the kept session');
  const [dlKept] = await Promise.all([page.waitForEvent('download'), page.click('#session-notice button:not(.session-notice-close)')]);
  assert(dlKept.suggestedFilename().includes('unrestored') && (await dlKept.path()), 'kept session can be exported');
  await page.click('#session-menu');
  assert(await page.isVisible('#session-kept'), 'Session menu lists the kept session');
  page.once('dialog', (d) => d.accept());
  await page.click('#session-kept-discard');
  await page.waitForFunction(() => document.querySelector('#session-kept').hidden, null, { timeout: 3000 });
  assert(true, 'kept session discarded');
  await ctx.close();

  // No IndexedDB (blocked / private mode): runs normally, autosave off, notice.
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx2.newPage();
  watch(p2);
  await p2.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined });
  });
  await p2.goto(url, { waitUntil: 'load' });
  await p2.waitForSelector('#sec-generate');
  assert((await p2.evaluate(() => window.mkwavez.model.timeline.length)) === 5, 'no storage: app starts normally');
  assert((await p2.textContent('#session-notice')).includes('Autosave is off'), 'no storage: non-blocking notice');
  assert((await p2.getAttribute('#session-menu', 'data-state')) === 'off', 'no storage: Session menu shows autosave off');
  await p2.click('#seed-add-shown');
  assert((await p2.evaluate(() => window.mkwavez.model.timeline.length)) === 6, 'no storage: adds still work');
  const bar = await p2.evaluate(() => {
    const t = document.querySelector('.transport');
    return t.scrollWidth <= t.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
  });
  assert(bar, '390px: transport bar fits with the Session button');
  await ctx2.close();

  assert(errors.length === 0, `no console errors (session)${errors.length ? `: ${errors.join(' | ')}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
let failed = false;
const servers = [];
try {
  const prev = await preview({ preview: { port: 0, strictPort: false }, logLevel: 'warn' });
  servers.push(prev);
  await run('preview', prev.resolvedUrls.local[0], browser);
  await midiChecks('preview', prev.resolvedUrls.local[0], browser);
  await sessionChecks('preview', prev.resolvedUrls.local[0], browser);
  const dev = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  servers.push(dev);
  await dev.listen();
  await run('dev', dev.resolvedUrls.local[0], browser);
  await midiChecks('dev', dev.resolvedUrls.local[0], browser);
  await sessionChecks('dev', dev.resolvedUrls.local[0], browser);
  console.log('\nsmoke: PASS');
} catch (e) {
  failed = true;
  console.error('\nsmoke: FAIL\n', e);
} finally {
  await browser.close();
  for (const s of servers) await (s.close?.() ?? s.httpServer?.close());
}
process.exit(failed ? 1 : 0);

/**
 * Wavetables editor (phase 2): Edit expands it over the Generate row (Generate hidden, the
 * Timeline stays) and Collapse returns; it fits 1440×900 / 1180×820 and 390px doesn't
 * overflow; + 1D / 2D / Rows create user wavetables (2D resized to X × Y); a built-in
 * duplicates into an editable copy; rename; a Live 1D receives Seed adds at its write head
 * (next-write markers shown); mouse drags from the Timeline replace and insert, a touch
 * drag (synthetic pointer events) inserts, a slot drag reorders, Delete empties a slot,
 * undo reverts, built-ins refuse drops; delete (confirmed) moves its voice to the Timeline.
 */
async function wavetableEditorChecks(page, tlCount) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const last = () => M(() => window.mkwavez.model.wavetables.at(-1));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  const n0 = await M(() => window.mkwavez.model.wavetables.length);

  // Expand / fit.
  await page.click('#wt-edit');
  await page.waitForTimeout(150);
  const fitEditor = () =>
    M(() => {
      const b = document.querySelector('#sec-wavetables-body');
      const s = document.querySelector('#sec-wavetables').getBoundingClientRect();
      return {
        editing: document.querySelector('.shell').classList.contains('wt-editing'),
        gen: getComputedStyle(document.querySelector('#sec-generate')).display,
        editor: !document.querySelector('#wt-editor').hidden,
        compact: !document.querySelector('#wavetable-overview').closest('.wt-box').hidden,
        wide: s.width / innerWidth,
        fits: b.scrollHeight <= b.clientHeight + 1,
        timeline: document.querySelector('#sec-timeline').getBoundingClientRect().top > s.bottom,
      };
    });
  for (const [w, hh] of [
    [1440, 900],
    [1180, 820],
  ]) {
    await page.setViewportSize({ width: w, height: hh });
    await page.waitForTimeout(250);
    const f = await fitEditor();
    assert(
      f.editing && f.gen === 'none' && f.editor && !f.compact && f.wide > 0.95 && f.fits && f.timeline && (await fitsScreen(page)),
      `${w}×${hh}: editor over the Generate row, Timeline below, fits one screen (${JSON.stringify(f)})`,
    );
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-${w}x${hh}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);

  // Create each shape.
  for (const [btn, shape] of [
    ['#wte-new-1d', '1d'],
    ['#wte-new-2d', '2d'],
    ['#wte-new-rows', 'rows'],
  ]) {
    await page.click(btn);
    await page.waitForTimeout(50);
    const wt = await last();
    const r = await M((id) => ({ sel: document.querySelector(`#wte-item-${id}`)?.getAttribute('aria-selected'), shape: document.querySelector('#wte-canvas').dataset.shape }), wt.id);
    assert(wt.shape === shape && !wt.builtin && !wt.live && r.sel === 'true' && r.shape === shape, `${btn}: new ${shape} wavetable “${wt.name}”, selected`);
  }
  assert((await M(() => window.mkwavez.model.wavetables.length)) === n0 + 3, 'three user wavetables');
  // 2D: X × Y.
  const g2 = (await M(() => window.mkwavez.model.wavetables.at(-2))).id;
  await page.click(`#wte-item-${g2}`);
  await page.fill('#wte-w', '4');
  await page.press('#wte-w', 'Tab');
  await page.fill('#wte-h', '3');
  await page.press('#wte-h', 'Tab');
  const dims = await M((id) => window.mkwavez.model.wavetable(id).rows.map((r) => r.length).join(), g2);
  assert(dims === '4,4,4', `2D resized to 4 × 3 (${dims})`);

  // Duplicate a built-in (the primary action there), then rename it.
  await page.click('#wte-item-3');
  assert((await page.getAttribute('#wte-duplicate', 'class')).includes('primary') && (await page.isHidden('#wte-delete')), 'built-in: Duplicate is primary, no Delete');
  await page.click('#wte-duplicate');
  let d = await last();
  const grid = await M(() => window.mkwavez.model.wavetable(3));
  assert(d.name === 'Grid copy' && !d.builtin && d.pins && JSON.stringify(d.rows) === JSON.stringify(grid.rows), 'Duplicate of Grid: editable copy with its slots');
  await page.click('#wte-rename');
  await page.fill('#wte-name-input', 'Bells');
  await page.press('#wte-name-input', 'Enter');
  d = await last();
  assert(d.name === 'Bells' && (await page.textContent(`#wte-item-${d.id}`)).includes('Bells') && (await page.textContent('#wte-name')) === 'Bells', 'renamed inline');

  // A Live 1D receives Seed adds at its write head.
  const a = (await M(() => window.mkwavez.model.wavetables.find((w) => w.name === 'Wavetable 1'))).id;
  await page.click(`#wte-item-${a}`);
  await page.click('#wte-live');
  await page.waitForTimeout(150);
  const writes = await page.getAttribute('#wte-canvas', 'data-writes');
  assert((await M((id) => window.mkwavez.model.wavetable(id).live, a)) && writes.startsWith('append'), `Live: next writes marked (${writes})`);
  await page.click('#wt-collapse');
  assert(!(await page.isHidden('#sec-generate')) && (await page.isVisible('#wavetable-overview')), 'Collapse: Generate and the compact panel are back');
  const before = await tlCount();
  await page.click('#tab-seed');
  await page.click('#seed-add-batch');
  const added = await M((n) => window.mkwavez.model.timeline.slice(n).map((t) => t.id), before);
  const rowsA = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(added.length > 1 && rowsA.join() === added.join(), `Live 1D received the Seed batch (${rowsA.length})`);
  await page.click('#wt-edit');
  await page.click(`#wte-item-${a}`);
  await page.click('#wte-frozen');
  await page.waitForTimeout(150);

  // Drags from the Timeline (mouse): onto slot 1 = replace, at slot 3's left edge = insert.
  const geo = () =>
    M(() => {
      const s = document.querySelector('#wte-scroll');
      s.scrollLeft = 0;
      document.querySelector('#timeline-scroll').scrollLeft = 0;
      const r = s.getBoundingClientRect();
      const t = document.querySelector('#timeline-grid').getBoundingClientRect();
      return { vx: r.left + 1 + 8, vy: r.top + 60, tx: t.left, ty: t.top + t.height / 2 };
    });
  const slotX = (g, x, dx = 33) => g.vx + x * 72 + dx;
  const dragFromTimeline = async (cell, toX, toY) => {
    const g = await geo();
    await page.waitForTimeout(50);
    await page.mouse.move(g.tx + cell * 63 + 31, g.ty);
    await page.mouse.down();
    await page.mouse.move(g.tx + cell * 63 + 31, g.ty - 12, { steps: 2 });
    await page.mouse.move(toX, toY, { steps: 8 });
    await page.waitForTimeout(80);
    const label = await page.textContent('#wave-drag-ghost .wdrag-label');
    await page.mouse.up();
    await page.waitForTimeout(50);
    return label;
  };
  const tid = (i) => M((i) => window.mkwavez.model.timeline[i].id, i);
  let g = await geo();
  let label = await dragFromTimeline(0, slotX(g, 1), g.vy);
  let row = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(row[1] === (await tid(0)) && row.length === rowsA.length && label.startsWith('replace'), `drag onto a slot replaces it (“${label}”)`);
  label = await dragFromTimeline(1, slotX(g, 3, 4), g.vy);
  row = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(row[3] === (await tid(1)) && row.length === rowsA.length + 1 && label.startsWith('insert'), `drag between slots inserts (“${label}”)`);
  assert(!(await page.$('#wave-drag-ghost')) && (await page.getAttribute('#wte-canvas', 'data-drop')) === '', 'drag ghost and drop indicator cleared');

  // Touch: synthetic pointer events, a vertical move out of the strip.
  g = await geo();
  const parents0 = await M(() => window.mkwavez.model.breedParents.length);
  await M(
    ({ g, to }) => {
      const el = document.querySelector('#timeline-grid');
      const ev = (type, x, y) =>
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: y }));
      const x0 = g.tx + 2 * 63 + 31;
      ev('pointerdown', x0, g.ty);
      ev('pointermove', x0, g.ty - 6);
      ev('pointermove', x0, g.ty - 20);
      ev('pointermove', to.x, to.y);
      ev('pointerup', to.x, to.y);
    },
    { g, to: { x: slotX(g, 0, 4), y: g.vy } },
  );
  row = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(row[0] === (await tid(2)) && row.length === rowsA.length + 2, 'touch drag (synthetic pointer events) inserts');
  await page.waitForTimeout(500);
  assert((await M(() => window.mkwavez.model.breedParents.length)) === parents0, 'the touch drag did not toggle a Breed parent');

  // Reorder by dragging a slot; Delete empties the selected slot; undo.
  g = await geo();
  const first = row[0];
  await page.mouse.move(slotX(g, 0), g.vy);
  await page.mouse.down();
  await page.mouse.move(slotX(g, 0) + 10, g.vy, { steps: 2 });
  await page.mouse.move(slotX(g, 2, 64), g.vy, { steps: 6 });
  await page.waitForTimeout(50);
  await page.mouse.up();
  await page.waitForTimeout(50);
  row = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(row[2] === first && row.length === rowsA.length + 2, `dragging a slot moves it (reorder: ${row.slice(0, 4)})`);
  await page.mouse.click(slotX(g, 1), g.vy);
  await page.keyboard.press('Delete');
  row = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(row[1] === null && (await page.textContent('#wte-slot-info')).includes('empty'), 'Delete empties the selected slot');
  await page.click('#undo');
  row = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(row[1] !== null, 'undo restores the slot');
  // Shift+→ in the focused view moves the slot (not the waveform in the Timeline).
  const order = () => M(() => window.mkwavez.model.timeline.map((t) => t.id).join());
  const ord0 = await order();
  await page.mouse.click(slotX(g, 1), g.vy);
  await page.keyboard.press('Shift+ArrowRight');
  const row2 = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(row2[2] === row[1] && row2[1] === row[2] && (await order()) === ord0, 'Shift+→ in the editor moves the selected slot; the Timeline is unchanged');
  // During a drag no shortcut acts; Esc cancels it.
  g = await geo();
  await page.mouse.move(g.tx + 31, g.ty);
  await page.mouse.down();
  await page.mouse.move(g.tx + 31, g.ty - 12, { steps: 2 });
  await page.mouse.move(slotX(g, 0), g.vy, { steps: 4 });
  const playing0 = await M(() => window.mkwavez.model.playing);
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const row3 = await M((id) => window.mkwavez.model.wavetable(id).rows[0], a);
  assert(
    (await order()) === ord0 && (await M(() => window.mkwavez.model.playing)) === playing0 && row3.join() === row2.join() && !(await page.$('#wave-drag-ghost')),
    'during a drag Shift+→ / Space do nothing; Esc cancels the drop',
  );
  // Built-ins refuse drops.
  await page.click('#wte-item-1');
  g = await geo();
  label = await dragFromTimeline(0, g.vx + 30, g.vy);
  assert(label.includes('read-only'), `built-in: drop refused (“${label}”)`);

  // Delete (confirmed): its voice falls back to the Timeline.
  await M((id) => window.mkwavez.model.updateVoice(2, { wavetableId: id }), d.id);
  await page.click(`#wte-item-${d.id}`);
  page.once('dialog', (dlg) => dlg.accept());
  await page.click('#wte-delete');
  const v2 = await M(() => window.mkwavez.model.voice(2).wavetableId);
  assert(!(await M((id) => !!window.mkwavez.model.wavetable(id), d.id)) && v2 === 0 && !(await page.$(`#wte-item-${d.id}`)), 'Delete: gone, its voice on the Timeline');

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert(!(await M(() => document.documentElement.scrollWidth > innerWidth)) && (await page.isVisible('#wte-scroll')), '390px: editor shown, no horizontal overflow');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/editor-390.png`, fullPage: true });
  await page.click('#wt-collapse');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  // Leave no user wavetables (they would pin waveforms through the later eviction checks).
  await M(() => {
    const m = window.mkwavez.model;
    for (const w of m.wavetables.filter((w) => !w.builtin)) m.deleteWavetable(w.id);
  });
}
