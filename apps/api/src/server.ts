import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadEnvFile } from './shared/config/env-file.js';

// Ahead of every read below, and of the container, which reads the environment
// when it is built rather than when it is imported.
loadEnvFile();

const PORT = Number(process.env['PORT'] ?? 3000);
const SHUTDOWN_GRACE_MS = 10_000;

const container = createContainer();
const server = createApp(container).listen(PORT, () => {
  container.log.info({ port: PORT }, 'api listening');
});

const shutdown = (signal: string): void => {
  container.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
  force.unref();

  server.close(() => {
    void container.db.$disconnect().then(() => process.exit(0));
  });
};

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => shutdown(signal));
}
