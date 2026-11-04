// Entry point for `npm run eval:harmonics`: loads the TypeScript evaluation through Vite's
// module runner (the repo's own toolchain; no extra dependency) and runs it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const main = fileURLToPath(new URL('./main.ts', import.meta.url));
const { module } = await runnerImport(main, { configFile: false, logLevel: 'error' });
await module.main(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
});
