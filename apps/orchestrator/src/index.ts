import { startServer } from './server.js';

startServer().catch((error: unknown) => {
  process.stderr.write(`\nStart fehlgeschlagen: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
