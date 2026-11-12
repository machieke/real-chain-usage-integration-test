import { readFile } from 'node:fs/promises';
import { run } from './run.mjs';

try {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run test:live -- /path/to/private-config.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  const result = await run(config);
  process.exitCode = result.passed ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
