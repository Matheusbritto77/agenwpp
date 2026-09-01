import { getRedisClient } from './client.js';
import {
  connectSession,
  disconnectSession,
  sendMessage,
} from '../whatsapp/manager.js';

export function startRedisCommandSubscriber() {
  try {
    const redisSub = getRedisClient().duplicate();

    redisSub.subscribe('whatsapp:commands', (err) => {
      if (err) {
        console.error('[Redis Subscriber Error]', err.message);
      } else {
        console.log('[Redis Subscriber] Listening on channel "whatsapp:commands"');
      }
    });

    redisSub.on('message', async (_channel, message) => {
      try {
        const payload = JSON.parse(message);
        const { action, tenant_id: tenantId = 'default' } = payload;

        console.log(`[Redis Command Received] Action: ${action}, Tenant: ${tenantId}`);

        if (action === 'connect') {
          await connectSession(tenantId, payload.phone_number || payload.phone || null);
        } else if (action === 'disconnect') {
          await disconnectSession(tenantId);
        } else if (action === 'send_message') {
          const { to, body, idempotency_key: idempotencyKey } = payload;
          await sendMessage(tenantId, to, body, idempotencyKey);
        }
      } catch (err) {
        console.error('[Redis Command Processing Error]', err.message);
      }
    });
  } catch (err) {
    console.warn('[Redis Subscriber Warning] Could not start Redis subscriber:', err.message);
  }
}
