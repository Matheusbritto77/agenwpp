import path from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import {
  getSessionStatus,
  connectSession,
  disconnectSession,
  sendMessage,
} from '../whatsapp/manager.js';
import { getRedisClient } from '../redis/client.js';

const protoPath = path.resolve(process.cwd(), 'proto/whatsapp.proto');

function loadDefinition() {
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  return grpc.loadPackageDefinition(definition).whatsapp;
}

function createHandlers() {
  return {
    // 🔄 Bidirectional Streaming Handler
    ChannelStream(call) {
      console.log('[gRPC ChannelStream] New bidirectional client connected.');

      const redisSub = getRedisClient().duplicate();
      redisSub.subscribe('whatsapp:events', (err) => {
        if (err) console.error('[Redis gRPC Stream Error]', err.message);
      });

      // Stream events from Baileys / Redis directly to gRPC client
      redisSub.on('message', (_channel, message) => {
        try {
          const parsed = JSON.parse(message);
          call.write({
            tenant_id: parsed.tenant_id || 'default',
            event: parsed.type || 'status_change',
            payload_json: message,
            timestamp: Date.now(),
          });
        } catch {}
      });

      // Handle incoming messages/commands from gRPC client
      call.on('data', async (request) => {
        const { tenant_id: tenantId = 'default', action, payload_json: payloadJson } = request;
        let payload = {};
        try {
          if (payloadJson) payload = JSON.parse(payloadJson);
        } catch {}

        try {
          if (action === 'ping') {
            call.write({
              tenant_id: tenantId,
              event: 'pong',
              payload_json: JSON.stringify({ ok: true, timestamp: Date.now() }),
              timestamp: Date.now(),
            });
          } else if (action === 'get_status') {
            const status = await getSessionStatus(tenantId);
            call.write({
              tenant_id: tenantId,
              event: 'status',
              payload_json: JSON.stringify(status),
              timestamp: Date.now(),
            });
          } else if (action === 'connect') {
            const result = await connectSession(tenantId);
            call.write({
              tenant_id: tenantId,
              event: 'connect_result',
              payload_json: JSON.stringify(result),
              timestamp: Date.now(),
            });
          } else if (action === 'disconnect') {
            const result = await disconnectSession(tenantId);
            call.write({
              tenant_id: tenantId,
              event: 'disconnect_result',
              payload_json: JSON.stringify(result),
              timestamp: Date.now(),
            });
          } else if (action === 'send_message') {
            const { to, body, idempotency_key: idempotencyKey } = payload;
            const result = await sendMessage(tenantId, to, body, idempotencyKey);
            call.write({
              tenant_id: tenantId,
              event: 'send_message_result',
              payload_json: JSON.stringify(result),
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          call.write({
            tenant_id: tenantId,
            event: 'error',
            payload_json: JSON.stringify({ error: err.message }),
            timestamp: Date.now(),
          });
        }
      });

      call.on('cancelled', () => {
        console.log('[gRPC ChannelStream] Client cancelled stream.');
        redisSub.disconnect();
      });

      call.on('end', () => {
        console.log('[gRPC ChannelStream] Client ended stream.');
        redisSub.disconnect();
        call.end();
      });

      call.on('error', (err) => {
        console.warn('[gRPC ChannelStream Warning]', err.message);
        redisSub.disconnect();
      });
    },

    async GetStatus(call, callback) {
      try {
        const tenantId = call.request?.tenant_id || 'default';
        const status = await getSessionStatus(tenantId);
        callback(null, status);
      } catch (err) {
        callback(null, {
          state: 'error',
          phone_number: '',
          tenant_id: call.request?.tenant_id || 'default',
          qr_code: '',
          updated_at: new Date().toISOString(),
        });
      }
    },

    async Connect(call, callback) {
      try {
        const tenantId = call.request?.tenant_id || 'default';
        const result = await connectSession(tenantId);
        callback(null, result);
      } catch (err) {
        callback(null, {
          status: 'error',
          qr_code: '',
          message: err.message || 'Error connecting',
        });
      }
    },

    async Disconnect(call, callback) {
      try {
        const tenantId = call.request?.tenant_id || 'default';
        const result = await disconnectSession(tenantId);
        callback(null, result);
      } catch (err) {
        callback(null, {
          status: 'error',
          message: err.message || 'Error disconnecting',
        });
      }
    },

    async SendMessage(call, callback) {
      try {
        const {
          tenant_id: tenantId = 'default',
          to,
          body,
          idempotency_key: idempotencyKey,
        } = call.request;

        const result = await sendMessage(tenantId, to, body, idempotencyKey);
        callback(null, result);
      } catch (err) {
        callback(null, {
          message_id: '',
          status: 'failed',
          error: err.message || 'Error sending message',
        });
      }
    },

    StreamEvents(call) {
      const redisSub = getRedisClient().duplicate();
      redisSub.subscribe('whatsapp:events', (err) => {
        if (err) {
          console.error('[Redis Stream Sub Error]', err);
        }
      });

      redisSub.on('message', (_channel, message) => {
        try {
          const parsed = JSON.parse(message);
          call.write({
            type: parsed.type || 'event',
            payload_json: message,
          });
        } catch {
          // ignore parsing error
        }
      });

      call.on('cancelled', () => {
        redisSub.disconnect();
      });

      call.on('end', () => {
        redisSub.disconnect();
      });
    },
  };
}

export async function startGrpcServer({ port = 50051 } = {}) {
  const packageDef = loadDefinition();
  const server = new grpc.Server();

  server.addService(packageDef.WhatsAppBridge.service, createHandlers());

  await new Promise((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(boundPort);
      }
    );
  });

  return server;
}
