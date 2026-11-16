import { localFixture } from './fixture.mjs';
import { run } from './run.mjs';
import { readFile } from 'node:fs/promises';

let fixture;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  abort.abort();
  fixture?.cleanup().catch(console.error);
});
try {
  const network = process.env.NETWORK_CONFIG ? JSON.parse(await readFile(process.env.NETWORK_CONFIG, 'utf8')) : undefined;
  fixture = await localFixture({ voters: Number(process.env.VOTERS ?? 1000), bridgeUsers: 10, signal: abort.signal, network });
  const report = await run({ ...fixture.config, signal: abort.signal,
    messagesPerUser: Number(process.env.MESSAGES_PER_USER ?? 10),
    windowMs: Number(process.env.WINDOW_MS ?? 25_000),
    completionTimeoutMs: Number(process.env.COMPLETION_TIMEOUT_MS ?? 900_000) });
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await fixture?.cleanup(); }
