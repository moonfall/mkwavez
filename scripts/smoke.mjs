// Headless-Chrome smoke test: page loads without console errors; dark theme by default and
// the toggle remembers light; the wide shell (1440×900, 1180×820) fits one screen with no page
// scroll and panels in layout C; at 390px panels stack, collapse (Wavetables starts collapsed;
// a collapsed panel stops redrawing) and nothing overflows sideways; only voice 1 starts
// unmuted; voice tabs switch both the Voice and the Sequence panel; Seed (library search / ▲▼ /
// arrow keys, formula edit / revert, parameter modes, batch strip arrow keys, Add shown / Add
// batch) adds exactly the previewed tables; the worklet loads and the transport runs; the
// timeline strip tints voice windows (bands in voice order, start / end edges, muted faint),
// shows carets for unmuted voices, cycles its thumbnail view (remembered), keeps the selection
// in view and follows the newest table; Mutate (library search / stepping / thumbnails, amount
// → preview, Linear / Log / Chain, strip arrow keys, Add shown / Add +N recipes, no Evolve, fits
// the Generate panel) while playing; Breed picks parents (timeline Shift-click / long-press, Add selected,
// voice window), previews and applies every operator, sweeps and generations; evicted parents
// drop out.
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
  assert((await page.textContent('#tables-status')).trim() === '5 / 4096 tables', 'transport status shows the table count');

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
  await mutateChecks(page, tlCount, label);
  await breedChecks(page, tlCount);
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
    for (let i = 0; i < 5; i++) m.addTables(Array.from({ length: 1000 }, () => ({ data: g.data, recipe: g.recipe })), 'batch');
  });
  assert((await tlCount()) === 4096, 'timeline capped at 4096 after 5000 adds');
  await page.waitForFunction(() => window.mkwavez.bridge.workletTableCount === 4096, null, { timeout: 20000 });
  assert(true, `worklet synced 4096 tables (${Date.now() - t0} ms)`);
  await page.waitForTimeout(300);
  const ev = await page.evaluate(() => ({
    parents: window.mkwavez.model.breedParents.length,
    cards: document.querySelectorAll('#breed-parents .parent-card').length,
  }));
  assert(ev.parents === 0 && ev.cards === 0, 'evicted Breed parents drop out of the list and its cards');
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
    return { ...t.recipe, sel: m.selectedId === t.id, end: m.voices[0].windowEnd };
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
  assert(r.end === 5, 'single add extends a following window');

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
      same: b[2].data === m.timeline.at(-9).data,
    };
  });
  assert(r.idx === '0,1,2,3,4,5,6,7' && r.seeds === 1 && r.exprs === 1, 'batch recipes: indices 0…7, one seed, one formula');
  assert(r.same, 'batch table #3 is the very preview table Add shown added');
  assert(r.win[0] === 6 && r.win[1] === 13, 'batch sets the targeted voice window to the batch');

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
  await page.click('#voice-step');
  assert((await M(() => window.mkwavez.model.voice(2).interp)) === 'step', 'Step applies to the selected voice');
  await page.click('#voice-blend');
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
 * (←/→, default = last card), Linear / Log / Chain, Add shown / Add +N recipes (Add uses
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

  // Each batch mode: Add +N adds exactly the batch (source stays selected).
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
        win: [v.windowStart, v.windowEnd],
        len: m.timeline.length,
        sel: m.selectedId,
      };
    });
    const exp = { lin: [0.075, 0.6], log: [0.6 / 64, 0.6], chain: [0.6, 0.6] }[mode];
    assert(
      r.modes.join() === mode && r.muts.join() === 'fold' && r.idx === '0,1,2,3,4,5,6,7' && Math.abs(r.amounts[0] - exp[0]) < 1e-9 && Math.abs(r.amounts[7] - exp[1]) < 1e-9,
      `${mode}: recipes (amounts ${r.amounts[0].toFixed(4)} … ${r.amounts[7]}, indices 0…7)`,
    );
    assert(r.parents.length === 1 && r.parents[0] === sel && r.sel === sel, `${mode}: one source, which stays selected`);
    assert(r.win[0] === r.len - 8 && r.win[1] === r.len - 1, `${mode}: batch sets the targeted voice window`);
  }
  assert((await shownTxt()) === '#6 of 8 · amount 60% × 6', `chain header (${await shownTxt()})`);

  // Add shown: the shown card's very preview table (same object as the batch just added).
  let n = await tlCount();
  const srcBefore = await M(() => window.mkwavez.model.selectedId);
  await page.click('#mutate-add-shown');
  let r = await M(() => {
    const m = window.mkwavez.model;
    const t = m.timeline.at(-1);
    return { ...t.recipe, id: t.id, sel: m.selectedId, same: t.data === m.timeline.at(-4).data, idx: m.indexOf(t.id) };
  });
  assert((await tlCount()) === n + 1, 'Add shown adds one table');
  assert(
    r.op === 'mutate' && r.params.mode === 'chain' && r.batch.index === 5 && r.batch.count === 8 && r.parents[0] === srcBefore && r.same,
    'Add shown = the shown preview table (chain step 6 of 8, same data as the batch)',
  );
  assert(r.sel === r.id, 'Add shown selects the new table (it becomes the source)');
  await page.waitForFunction((t) => document.querySelector('#mutate-src-no').textContent === t, `#${r.idx + 1}`, { timeout: 3000 });
  assert(true, 'source chip follows the selection');

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
  await page.click('#mutate-add-batch');
  r = await M(() => window.mkwavez.model.timeline.slice(-8).map((t) => t.recipe.seed));
  assert((await tlCount()) === n + 8 && r.every((s) => s === parseInt(s1, 16)), 'Add +8 uses the shown seed');
  assert((await seedHex()) !== s1, 'new seed after Add (seeded mutation)');
  await page.click('#undo');
  assert((await tlCount()) === n, 'undo removes the batch');

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
      { windowStart: 0, windowEnd: 5, position: 0.5, lfoDepth: 1, lfoRate: 3, mute: false },
      { windowStart: 2, windowEnd: 4, position: 0.5, lfoDepth: 0, mute: false },
      { windowStart: 1, windowEnd: 3, position: 0.5, lfoDepth: 0.5, mute: true },
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
      m.addTables(Array.from({ length: n }, () => ({ data: t.data, recipe: t.recipe })), 'batch', false);
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
    const v = m.voices[0];
    const len = v.windowEnd - v.windowStart + 1;
    const n = Math.min(8, len);
    return Array.from({ length: n }, (_, i) => m.timeline[v.windowStart + (n > 1 ? Math.round((i * (len - 1)) / (n - 1)) : 0)].id);
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
    return { biases: b.map((t) => t.recipe.params.bias), seeds: [...new Set(b.map((t) => t.recipe.seed))], win: [v.windowStart, v.windowEnd], len: m.timeline.length };
  });
  assert((await tlCount()) === n + 8, 'Breed N (sweep) adds 8');
  assert(
    r.biases.every((b, i) => Math.abs(b - (0.3 * (i + 1)) / 8) < 1e-12) && r.seeds.length === 1 && r.seeds[0] === seed,
    'sweep biases 0.3·i/8, one seed',
  );
  assert(r.win[0] === r.len - 8 && r.win[1] === r.len - 1, 'sweep sets the targeted voice window');

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
  const dev = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  servers.push(dev);
  await dev.listen();
  await run('dev', dev.resolvedUrls.local[0], browser);
  await midiChecks('dev', dev.resolvedUrls.local[0], browser);
  console.log('\nsmoke: PASS');
} catch (e) {
  failed = true;
  console.error('\nsmoke: FAIL\n', e);
} finally {
  await browser.close();
  for (const s of servers) await (s.close?.() ?? s.httpServer?.close());
}
process.exit(failed ? 1 : 0);
