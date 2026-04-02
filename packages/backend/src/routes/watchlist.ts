import { Hono } from 'hono';
import { prisma } from '../db.js';
import type { ApiResponse } from '@vpauto/shared';

const app = new Hono();

app.get('/', async (c) => {
  const items = await prisma.watchlist.findMany({
    include: {
      vehicle: {
        include: {
          snapshots: { orderBy: { scrapedAt: 'desc' }, take: 1 },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return c.json<ApiResponse<typeof items>>({ success: true, data: items });
});

app.post('/:vehicleId', async (c) => {
  const vehicleId = parseInt(c.req.param('vehicleId'));
  const body = await c.req.json().catch(() => ({}));

  const existing = await prisma.watchlist.findUnique({ where: { vehicleId } });
  if (existing) {
    return c.json<ApiResponse<null>>({ success: false, error: 'Already in watchlist' }, 409);
  }

  const item = await prisma.watchlist.create({
    data: {
      vehicleId,
      notes: body.notes || null,
      alertOnPrice: body.alertOnPrice ?? true,
      alertOnReappear: body.alertOnReappear ?? true,
    },
  });

  return c.json<ApiResponse<typeof item>>({ success: true, data: item });
});

app.delete('/:vehicleId', async (c) => {
  const vehicleId = parseInt(c.req.param('vehicleId'));
  await prisma.watchlist.delete({ where: { vehicleId } }).catch(() => null);
  return c.json<ApiResponse<null>>({ success: true });
});

export default app;
