import { Router } from 'express';
import type { HealthResponse, ReadyResponse } from '@pfm/contracts';
import { pingDb, type Db } from '../../shared/db/prisma.js';

export const healthRoutes = (db: Db): Router => {
  const router = Router();

  router.get('/health', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
    };
    res.json(body);
  });

  router.get('/ready', async (_req, res) => {
    const up = await pingDb(db);
    const body: ReadyResponse = {
      status: up ? 'ready' : 'not_ready',
      checks: { database: up ? 'up' : 'down' },
    };
    res.status(up ? 200 : 503).json(body);
  });

  return router;
};
