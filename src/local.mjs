import { localFixture } from './fixture.mjs';
import { run } from './run.mjs';

let fixture;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  abort.abort();
  fixture?.cleanup().catch(console.error);
});
try {
  fixture = await localFixture({ voters: Number(process.env.VOTERS ?? 1000), bridgeUsers: 10, signal: abort.signal });
  const report = await run({ ...fixture.config, signal: abort.signal,
    messagesPerUser: Number(process.env.MESSAGES_PER_USER ?? 10),
    windowMs: Number(process.env.WINDOW_MS ?? 25_000),
    completionTimeoutMs: Number(process.env.COMPLETION_TIMEOUT_MS ?? 900_000) });
  process.exitCode = report.passed ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await fixture?.cleanup(); }
