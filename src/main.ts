import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './core/config.js';
import { getDb } from './core/db.js';
import { getGlobalConfig } from './core/global-config.js';
import { admins } from './core/store.js';
import { loadPlugins } from './core/plugin-loader.js';
import { manager } from './mcp/manager.js';
import { adminApi } from './admin/api.js';
import { log, pruneLogs } from './core/logger.js';
import { approvals } from './core/approvals.js';
import { guard } from './core/http-guard.js';
import { pruneOAuth } from './mcp/oauth.js';

async function main() {
  getDb();
  if (admins.count() === 0) {
    if (config.initialAdminPassword) admins.create(config.initialAdminUser, config.initialAdminPassword);
    else log({ level: 'warn', category: 'system', message: 'no admin configured: open the admin UI to complete initial setup' });
  }
  await loadPlugins();
  await manager.startAll();

  const app = express();
  app.disable('x-powered-by');
  app.use(guard(config.adminHost, config.publicUrl));
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use('/api', adminApi());
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text').send('MControlProgram API is running. Build the web UI with `npm run build:web`.'));
  }
  app.listen(config.adminPort, config.adminHost, () => log({ level: 'info', category: 'system', message: `MControlProgram admin UI on http://${config.adminHost}:${config.adminPort}` }));

  const housekeeping = () => { pruneLogs(getGlobalConfig().logRetentionDays); pruneOAuth(); approvals.expire(); admins.pruneSessions(); };
  housekeeping();
  setInterval(housekeeping, 3600e3).unref();

  const shutdown = async (sig: string) => { log({ level: 'info', category: 'system', message: `${sig} received, shutting down` }); await manager.stopAll(); process.exit(0); };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => { console.error(e); process.exit(1); });
