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

        server.start();
        resolve(boundPort);
      }
    );
  });

  return server;
}
