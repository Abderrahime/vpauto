import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import vehicleRoutes from './routes/vehicles.js';
import watchlistRoutes from './routes/watchlist.js';

const app = new Hono();

function resolveCorsOrigin(origin: string): string | null {
  if (!origin) {
    return null;
  }

  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
    return origin;
  }

  if (/^https:\/\/([a-z0-9-]+\.)?vpauto\.fr$/.test(origin)) {
    return origin;
  }

  if (/^http:\/\/localhost(?::\d+)?$/.test(origin)) {
    return origin;
  }

  return null;
}

app.use('*', cors({
  origin: resolveCorsOrigin,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type'],
}));

app.route('/api/vehicles', vehicleRoutes);
app.route('/api/watchlist', watchlistRoutes);

app.get('/api/health', (c) => c.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } }));

const port = parseInt(process.env.PORT || '3456');

serve({ fetch: app.fetch, port }, () => {
  console.log(`VPauto backend running on http://localhost:${port}`);
});
