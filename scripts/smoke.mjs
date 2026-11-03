// Headless-Chrome smoke test: page loads without console errors, sections collapse and
// expand (Wavetables starts collapsed; voice / sequence cards collapse individually and stop
// redrawing), only voice 1 starts unmuted, Seed (library search / ▲▼ / arrow keys, formula edit /
// revert, parameter modes, batch strip arrow keys, Add shown / Add batch) adds exactly the
// previewed tables, the worklet loads and the transport runs,
// Mutate previews / applies / sweeps / chains / rerolls / evolves while playing,
// Breed picks parents (timeline Shift-click / long-press, Add selected, voice window),
// previews and applies every operator, sweeps and generations; evicted parents drop out.
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
  assert((await page.textContent('#sec-timeline > summary .meta')).trim() === '5 / 4096', 'timeline meta shows count / cap');

  assert((await page.$eval('#sec-wavetables', (d) => d.open)) === false, 'Wavetables starts collapsed');
  const mutes = await page.evaluate(() => window.mkwavez.model.voices.map((v) => v.mute));
  assert(JSON.stringify(mutes) === '[false,true,true]', 'only voice 1 starts unmuted');

  // Collapse / expand every section.
  for (const id of ['sec-generate', 'sec-timeline', 'sec-wavetables', 'sec-voices', 'sec-sequences']) {
    const open = () => page.$eval(`#${id}`, (d) => d.open);
    const before = await open();
    await page.click(`#${id} > summary`);
    assert((await open()) === !before, `${id} toggles`);
    await page.click(`#${id} > summary`);
    assert((await open()) === before, `${id} toggles back`);
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
  await page.$eval('.tl-scroll', (s) => (s.scrollTop = 0));
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
  await cardCollapseChecks(page);
  await page.click('#seed-add-shown');
  await page.waitForFunction(
    () => window.mkwavez.bridge.workletTableCount === window.mkwavez.model.timeline.length,
    null,
    { timeout: 5000 },
  );
  assert(true, 'worklet holds every timeline table');
  await timelineMarkerChecks(page);
  await mutateChecks(page, tlCount);
  await breedChecks(page, tlCount);
  await page.click('#add-voice');
  assert((await page.evaluate(() => window.mkwavez.model.voices.length)) === 4, 'voice added');
  await page.click('#voice-4 .card-head button[aria-label^="Remove"]');
  assert((await page.evaluate(() => window.mkwavez.model.voices.length)) === 3, 'voice removed');
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

  if (SHOTS) {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${label}-desktop.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${label}-dark.png`, fullPage: false });
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'no horizontal page overflow');
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
  const visibleIds = () => page.$$eval('.seed-entry', (bs) => bs.filter((b) => !b.hidden).map((b) => b.dataset.id));
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
  assert((await canvasInk(page, '.seed-entry[data-id="saw"] canvas')).n > 0, 'entry thumbnails render');
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
  await page.fill('#seed-search', 'gray');
  await page.press('#seed-search', 'Enter');
  assert((await title()) === 'Bits › Gray code', 'Enter selects the first match');
  await page.press('#seed-search', 'Escape');
  const scrolled = await page.$eval('#seed-list', (l) => {
    const b = l.querySelector('.seed-entry[aria-current="true"]');
    return b.offsetTop >= l.scrollTop && b.offsetTop + b.offsetHeight <= l.scrollTop + l.clientHeight;
  });
  assert(scrolled, 'selected entry scrolled into view');
  await page.click('.seed-entry[data-id="sine-saw"]');
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
  await page.click('#seed-revert');
  assert(
    (await page.inputValue('#seed-expr')) === preset && !(await page.isVisible('#seed-edited')) && !(await page.isDisabled('#seed-add-batch')),
    'Revert to preset restores the expression',
  );
  const edited = '(1-u)*sin(p) + u*sin(3*p)';
  await page.fill('#seed-expr', edited);
  assert((await page.isVisible('#seed-edited')) && (await page.isVisible('#seed-revert')), 'editing marks it edited');
  await page.waitForTimeout(200);

  // Batch strip: arrow keys move the shown table.
  assert((await page.$$('#seed-strip .seed-card')).length === 8, 'strip shows N = 8 cards');
  await page.focus('#seed-strip .seed-card[aria-pressed="true"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const shownTxt = async () => (await page.textContent('#seed-shown')).trim();
  assert((await shownTxt()).startsWith('#3 of 8 · n 2 · u 0.29'), `ArrowRight moves the shown table (${await shownTxt()})`);
  await page.waitForTimeout(150);
  const before = await canvasInk(page, '#seed-wave');
  await page.keyboard.press('End');
  const inView = await page.$eval('#seed-strip', (s) => {
    const c = s.querySelector('.seed-card[aria-pressed="true"]');
    const a = s.getBoundingClientRect();
    const b = c.getBoundingClientRect();
    return s.scrollLeft > 0 && b.left >= a.left - 1 && b.right <= a.right + 1 && document.activeElement === c;
  });
  assert((await shownTxt()).startsWith('#8 of 8') && inView, 'End: last card shown, focused and scrolled into view');
  await page.waitForTimeout(150);
  assert((await canvasInk(page, '#seed-wave')).sum !== before.sum, 'large view follows the shown card');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  assert((await shownTxt()).startsWith('#3 of 8'), 'ArrowLeft moves back');
  await page.click('#seed-strip .seed-card:nth-child(4)');
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
  await page.press('#seed-search', 'Escape');
  await page.click('#seed-current');
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
      (await page.$$('#seed-strip .seed-card')).length === 6,
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
  await page.press('#seed-search', 'Escape');
  await page.click('#seed-current');
  assert((await title()) === 'Basic › Saw' && (await page.textContent('#seed-kind')) === 'Basic wave', 'Saw is a basic (additive) wave');
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

/** Voice / sequence cards collapse to their header and stop redrawing (transport running). */
async function cardCollapseChecks(page) {
  for (const [card, canvas] of [
    ['#voice-1', '#voice-1 canvas'],
    ['#sequence-1', '#sequence-1 canvas.seq-grid'],
  ]) {
    const btn = `${card} .card-head .card-collapse`;
    assert((await page.getAttribute(btn, 'aria-expanded')) === 'true', `${card} starts expanded`);
    await page.click(btn);
    assert((await page.getAttribute(btn, 'aria-expanded')) === 'false', `${card} collapses`);
    assert(!(await page.isVisible(canvas)) && (await page.isVisible(`${card} .card-head .name`)), `${card} collapsed: body hidden, header visible`);
    const a = (await canvasInk(page, canvas)).sum;
    await page.waitForTimeout(700);
    assert((await canvasInk(page, canvas)).sum === a, `${card} collapsed: canvas not redrawn while playing`);
    await page.click(btn);
    assert(await page.isVisible(canvas), `${card} expands`);
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
    assert(true, `${card} redraws after expanding`);
  }
  await page.click('#voice-2 .card-head .card-collapse');
  assert((await page.$eval('#voice-1 .card-body', (b) => b.hidden)) === false, 'cards collapse independently');
  await page.click('#voice-2 .card-head .card-collapse');
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

async function mutateChecks(page, tlCount) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const seedText = async () => (await page.textContent('#mutate-seed')).replace('seed ', '').trim();
  await page.click('#tab-mutate');
  assert(await page.isVisible('#panel-mutate'), 'Mutate tab visible');
  await page.waitForFunction(() => {
    const c = document.querySelector('#mutate-pv-wave');
    return c && c.width > 1 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v);
  }, null, { timeout: 5000 });
  assert(true, 'preview renders');
  const srcId = await M(() => window.mkwavez.model.selectedId);
  assert((await page.textContent('#mutate-src-label')).includes(`id ${srcId}`), 'source label names the selected table');
  assert((await canvasInk(page, '#mutate-src-wave')).n > 0, 'source canvas renders');

  // Live preview: changing mutation / amount redraws.
  const before = await canvasInk(page, '#mutate-pv-wave');
  await page.selectOption('#mutate-op', 'fold');
  await page.fill('#mutate-amount', '0.5');
  await page.waitForFunction(
    (b) => {
      const c = document.querySelector('#mutate-pv-wave');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum = (sum * 31 + d[i] + d[i + 1] * 7 + d[i + 3] * 13) % 1000000007;
      return sum !== b;
    },
    before.sum,
    { timeout: 5000 },
  );
  assert(true, 'preview updates when mutation and amount change');

  // Reroll.
  const s0 = await seedText();
  assert(/^[0-9a-f]{8}$/.test(s0), `seed shown (${s0})`);
  await page.click('#mutate-reroll');
  const s1 = await seedText();
  assert(s1 !== s0, 'Reroll draws a new seed');

  // Apply single.
  let n = await tlCount();
  await page.click('#mutate-apply1');
  assert((await tlCount()) === n + 1, 'Apply adds one table');
  let r = await M(() => {
    const m = window.mkwavez.model;
    const t = m.timeline.at(-1);
    return { ...t.recipe, id: t.id, sel: m.selectedId };
  });
  assert(
    r.op === 'mutate' && r.params.mutation === 'fold' && r.params.amount === 0.5 && r.parents[0] === srcId && r.seed === parseInt(s1, 16),
    'Apply recipe records mutation, amount, seed and parent',
  );
  assert(r.sel === r.id, 'Apply selects the new table (next Apply mutates it)');
  assert((await seedText()) !== s1, 'new seed after Apply');

  // Apply N in each batch mode (N = 8).
  for (const mode of ['lin', 'log', 'chain']) {
    await page.selectOption('#mutate-mode', mode);
    const seed = parseInt(await seedText(), 16);
    const sel = await M(() => window.mkwavez.model.selectedId);
    n = await tlCount();
    await page.click('#mutate-applyN');
    assert((await tlCount()) === n + 8, `Apply N (${mode}) adds 8`);
    r = await M(() => {
      const m = window.mkwavez.model;
      const b = m.timeline.slice(-8);
      const v = m.voices[0];
      return {
        amounts: b.map((t) => t.recipe.params.amount),
        modes: [...new Set(b.map((t) => t.recipe.params.mode))],
        seeds: [...new Set(b.map((t) => t.recipe.seed))],
        parents: [...new Set(b.map((t) => t.recipe.parents[0]))],
        win: [v.windowStart, v.windowEnd],
        len: m.timeline.length,
        sel: m.selectedId,
      };
    });
    const exp =
      mode === 'lin'
        ? [0.0625, 0.5]
        : mode === 'log'
          ? [0.5 / 64, 0.5]
          : [0.5, 0.5];
    assert(
      r.modes.length === 1 && r.modes[0] === mode && Math.abs(r.amounts[0] - exp[0]) < 1e-9 && Math.abs(r.amounts[7] - exp[1]) < 1e-9,
      `${mode} amounts ${r.amounts[0].toFixed(4)} … ${r.amounts[7]}`,
    );
    assert(r.seeds.length === 1 && r.seeds[0] === seed && r.parents.length === 1 && r.parents[0] === sel, `${mode}: one seed, one source`);
    assert(r.win[0] === r.len - 8 && r.win[1] === r.len - 1, `${mode}: batch sets the targeted voice window`);
    assert(r.sel === sel, `${mode}: source stays selected`);
  }
  n = await tlCount();
  await page.click('#undo');
  assert((await tlCount()) === n - 8, 'undo removes the chain batch');

  // The legacy Breed mutation is superseded by the Breed tab.
  assert(!(await page.$('#mutate-op option[value="breed"]')), 'Mutate no longer offers Breed');

  // Evolve.
  await page.selectOption('#mutate-op', 'jitter');
  n = await tlCount();
  await page.click('#mutate-evolve');
  await page.waitForFunction((k) => window.mkwavez.model.timeline.length >= k + 2, n, { timeout: 5000 });
  await page.click('#mutate-evolve');
  const n2 = await tlCount();
  await page.waitForTimeout(900);
  assert((await tlCount()) === n2, 'Evolve adds tables until stopped');

  // Evolve pauses while the Mutate tab is hidden, and undo stops it.
  await page.click('#mutate-evolve');
  await page.click('#tab-seed');
  n = await tlCount();
  await page.waitForTimeout(1000);
  assert((await tlCount()) === n, 'Evolve pauses while the Mutate tab is hidden');
  await page.click('#tab-mutate');
  await page.waitForFunction((k) => window.mkwavez.model.timeline.length >= k + 1, n, { timeout: 5000 });
  await page.click('#undo');
  assert((await page.getAttribute('#mutate-evolve', 'aria-pressed')) === 'false', 'undo stops Evolve');
  n = await tlCount();
  await page.waitForTimeout(900);
  assert((await tlCount()) === n, 'no Evolve ticks after undo');
  await page.click('#tab-seed');
}

/**
 * Timeline (while playing): a play-position marker for each unmuted voice and none for
 * muted ones, moving with the LFO; window bars stacked in voice order (voice 1 on top).
 */
async function timelineMarkerChecks(page) {
  const M = (fn, arg) => page.evaluate(fn, arg);
  const saved = await M(() => window.mkwavez.model.voices.map((v) => ({ ...v })));
  const ids = saved.map((v) => v.id);
  // Known state: windows in the first row, voice 1 sweeping, voice 2 still, voice 3 muted.
  await M((ids) => {
    const m = window.mkwavez.model;
    const set = [
      { windowStart: 0, windowEnd: 5, position: 0.5, lfoDepth: 1, lfoRate: 3, mute: false },
      { windowStart: 2, windowEnd: 4, position: 0.5, lfoDepth: 0, mute: false },
      { windowStart: 1, windowEnd: 3, position: 0.5, lfoDepth: 0.5, mute: true },
    ];
    ids.forEach((id, i) => m.updateVoice(id, set[i] ?? { mute: true }));
    m.endGesture();
    document.querySelector('#sec-timeline').scrollIntoView();
    document.querySelector('.tl-scroll').scrollTop = 0;
  }, ids);
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
    `timeline markers for unmuted voices only (${a.map((m) => `V${m[0]}@${m[1]}`).join(', ')})`,
  );
  assert(a[0][1] >= 0 && a[0][1] <= 5 && Math.abs(a[1][1] - 3) < 1e-3, 'markers sit inside their windows');
  const inked = await M(() => {
    const c = document.querySelector('#timeline-markers');
    return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v);
  });
  assert(inked, 'marker overlay has ink');
  await page.waitForTimeout(250);
  const b = await markers();
  assert(Math.abs(b[0][1] - a[0][1]) > 0.01, `LFO moves the live marker (${a[0][1]} → ${b[0][1]})`);
  // Bars: voice order top to bottom; check the pixels in cell 2 (inside all three windows).
  const bars = await M(() => {
    const g = document.querySelector('#timeline-grid');
    const s = document.querySelector('.tl-scroll');
    const cols = Math.max(4, Math.floor(s.clientWidth / 56));
    const cw = s.clientWidth / cols;
    const d = g.width / g.clientWidth;
    const probe = document.createElement('canvas').getContext('2d');
    const rgb = (css) => {
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const m = window.mkwavez.model;
    const cols3 = m.voices.slice(0, 3).map((v) => rgb(getComputedStyle(document.documentElement).getPropertyValue(`--v${(v.id - 1) % 8}`)));
    const ctx = g.getContext('2d');
    // Rows from the top of the bar stack (3 voices: y = 33, 36, 39 within a 42 px cell).
    const n = m.voices.length;
    const found = [];
    for (let k = 0; k < n; k++) {
      const y = 42 - 1 - 2 - (n - 1 - k) * 3 + 1;
      const px = [...ctx.getImageData(Math.round((2 * cw + cw / 2) * d), Math.round(y * d), 1, 1).data.slice(0, 3)];
      const dist = cols3.map((c) => Math.hypot(c[0] - px[0], c[1] - px[1], c[2] - px[2]));
      found.push(dist.indexOf(Math.min(...dist)));
    }
    return { order: g.dataset.barOrder, ids: m.voices.map((v) => v.id).join(','), found: found.slice(0, 3) };
  });
  assert(bars.order === bars.ids, `window bars ordered by voice (${bars.order})`);
  assert(JSON.stringify(bars.found) === '[0,1,2]', `bar pixels top to bottom are voices 1, 2, 3 (${bars.found})`);
  await M((saved) => {
    const m = window.mkwavez.model;
    for (const v of saved) m.updateVoice(v.id, v);
    m.endGesture();
  }, saved);
}

/** Centre of timeline cell i, relative to the grid canvas (grid scrolled to the top). */
const cellPos = (page, i) =>
  page.evaluate((i) => {
    const s = document.querySelector('.tl-scroll');
    s.scrollTop = 0;
    const w = s.clientWidth;
    const cols = Math.max(4, Math.floor(w / 56));
    const cw = w / cols;
    return { x: (i % cols) * cw + cw / 2, y: Math.floor(i / cols) * 42 + 21 };
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
  const dev = await createServer({ server: { port: 0 }, logLevel: 'warn' });
  servers.push(dev);
  await dev.listen();
  await run('dev', dev.resolvedUrls.local[0], browser);
  console.log('\nsmoke: PASS');
} catch (e) {
  failed = true;
  console.error('\nsmoke: FAIL\n', e);
} finally {
  await browser.close();
  for (const s of servers) await (s.close?.() ?? s.httpServer?.close());
}
process.exit(failed ? 1 : 0);
