import { createApp } from './app.js';
import { readConfig } from './config.js';
import { PostgresDatabase } from './db/database.js';

const config = readConfig();
const database = new PostgresDatabase(config.databaseUrl);
const app = await createApp(config, database);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await database.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try {
  await database.query('SELECT 1 FROM schema_migrations LIMIT 1');
  await app.listen({ host: config.host, port: config.port });
} catch {
  app.log.fatal('Startup failed. Check the database configuration and apply migrations.');
  await shutdown();
  process.exitCode = 1;
}
