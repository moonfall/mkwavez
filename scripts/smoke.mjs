// Headless-Chrome smoke test: page loads without console errors, sections collapse and
// expand, Seed adds tables to the timeline, the worklet loads and the transport runs.
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
  await page.click('#tab-mutate');
  assert(await page.isVisible('#panel-mutate'), 'Mutate tab shows placeholder');
  await page.click('#tab-seed');
  assert(await page.isVisible('#panel-seed'), 'Seed tab visible again');

  // Seed: single adds.
  await page.click('button[data-wave="sine"]');
  assert((await tlCount()) === 6, 'Sine adds one table');
  await page.click('button[data-wave="noise"]');
  await page.click('#formula-add1');
  await page.click('#perlin-add1');
  await page.click('#ca-add1');
  assert((await tlCount()) === 10, 'noise, formula, perlin, CA +1 each add a table');
  const v1End = await page.evaluate(() => window.mkwavez.model.voices[0].windowEnd);
  assert(v1End === 9, 'single add extends a following window');

  // Seed: batches (default N = 8).
  await page.click('[aria-label="Add a batch of formula tables"]');
  assert((await tlCount()) === 18, 'formula +N adds 8');
  const w = await page.evaluate(() => {
    const v = window.mkwavez.model.voices[0];
    return [v.windowStart, v.windowEnd];
  });
  assert(w[0] === 10 && w[1] === 17, 'batch sets the targeted voice window to the batch');
  await page.click('[aria-label="Add a batch of Perlin tables"]');
  await page.click('[aria-label="Add N CA generations"]');
  assert((await tlCount()) === 34, 'perlin and CA batches add 8 each');

  // Formula error path.
  await page.fill('#panel-seed input[type="text"]', 'sin(p');
  await page.click('#formula-add1');
  assert((await page.textContent('#panel-seed .error')).length > 0, 'bad formula shows an error');
  assert((await tlCount()) === 34, 'bad formula adds nothing');

  // Timeline selection by click.
  await page.$eval('.tl-scroll', (s) => (s.scrollTop = 0));
  await page.waitForTimeout(100);
  await page.click('#timeline-grid', { position: { x: 10, y: 10 } });
  assert((await page.evaluate(() => window.mkwavez.model.indexOf(window.mkwavez.model.selectedId))) === 0, 'clicking the first cell selects table #1');

  // Undo.
  await page.click('#undo');
  assert((await tlCount()) === 26, 'undo removes the last batch');

  // Audio: worklet loads, transport runs, tables reach the worklet.
  await page.click('#play');
  await page.waitForFunction(() => document.body.dataset.audio === 'running', null, { timeout: 10000 });
  assert(true, 'audio worklet running');
  await page.waitForFunction(() => Number(document.body.dataset.step) >= 4, null, { timeout: 10000 });
  assert(true, 'sequencer steps advance');
  await page.click('button[data-wave="saw"]');
  await page.waitForFunction(
    () => window.mkwavez.bridge.workletTableCount === window.mkwavez.model.timeline.length,
    null,
    { timeout: 5000 },
  );
  assert(true, 'worklet holds every timeline table');
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
  await page.click('#play');
  assert((await page.evaluate(() => window.mkwavez.model.playing)) === false, 'transport stops');

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
