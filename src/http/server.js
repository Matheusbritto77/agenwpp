import http from 'node:http';
import {
  getSessionStatus,
  connectSession,
  disconnectSession,
  sendMessage,
} from '../whatsapp/manager.js';

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

export function startHttpServer({ port = 50052 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // Health Check & Test
    if (url.pathname === '/health' || url.pathname === '/ping') {
      sendJson(res, 200, {
        ok: true,
        service: 'agenwpp',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
      return;
    }

    // Get Status
    if (url.pathname === '/status' && req.method === 'GET') {
      const tenantId = url.searchParams.get('tenant_id') || 'default';
      const status = await getSessionStatus(tenantId);
      sendJson(res, 200, status);
      return;
    }

    // Connect
    if (url.pathname === '/connect' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const tenantId = body.tenant_id || 'default';
      const result = await connectSession(tenantId);
      sendJson(res, 200, result);
      return;
    }

    // Disconnect
    if (url.pathname === '/disconnect' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const tenantId = body.tenant_id || 'default';
      const result = await disconnectSession(tenantId);
      sendJson(res, 200, result);
      return;
    }

    // Send Message
    if (url.pathname === '/send-message' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const tenantId = body.tenant_id || 'default';
      const to = body.to || '';
      const messageText = body.body || body.message || '';
      const idempotencyKey = body.idempotency_key || '';

      const result = await sendMessage(tenantId, to, messageText, idempotencyKey);
      sendJson(res, result.status === 'sent' ? 200 : 400, result);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[HTTP Bridge] agenwpp HTTP API running on port ${port}`);
  });

  return server;
}
