import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import vehicleRoutes from './routes/vehicles.js';
import watchlistRoutes from './routes/watchlist.js';
import { authenticateCredentials, getRequestAccess } from './auth.js';

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
  allowHeaders: ['Content-Type', 'Authorization', 'X-VPauto-Role', 'X-VPauto-Token'],
}));

// Request logging middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  console.log(`[VPauto API] → ${method} ${path}`);
  await next();
  const ms = Date.now() - start;
  console.log(`[VPauto API] ← ${method} ${path} ${c.res.status} (${ms}ms)`);
});

app.route('/api/vehicles', vehicleRoutes);
app.route('/api/watchlist', watchlistRoutes);

app.get('/api/health', (c) => c.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } }));
app.get('/api/me', (c) => c.json({ success: true, data: getRequestAccess(c) }));
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { email?: unknown; password?: unknown };
  const session = authenticateCredentials(body.email, body.password);
  if (!session) {
    return c.json({ success: false, error: 'invalid_credentials' }, 401);
  }

  return c.json({ success: true, data: session });
});

const port = parseInt(process.env.PORT || '3456');

serve({ fetch: app.fetch, port }, () => {
  console.log(`VPauto backend running on http://localhost:${port}`);
});
