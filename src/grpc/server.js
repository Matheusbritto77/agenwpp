import fs from 'node:fs';
import path from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

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
    SendMessage(call, callback) {
      const { tenant_id: tenantId, to, body, idempotency_key: idempotencyKey } = call.request;

      callback(null, {
        message_id: idempotencyKey || `${tenantId}:${to}:${Date.now()}`,
        status: body ? 'queued' : 'rejected',
      });
    },
    GetStatus(_call, callback) {
      callback(null, { state: 'starting' });
    },
    StreamEvents(call) {
      call.write({
        type: 'service.ready',
        payload_json: JSON.stringify({ ok: true, timestamp: new Date().toISOString() }),
      });
      call.end();
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
      },
    );
  });

  return server;
}

