import 'dotenv/config';
import { initDbTables } from './db/connection.js';
import { startGrpcServer } from './grpc/server.js';
import { startHttpServer } from './http/server.js';
import { startRedisCommandSubscriber } from './redis/subscriber.js';

async function main() {
  const grpcPort = Number(process.env.GRPC_PORT || 50051);
  const httpPort = Number(process.env.HTTP_PORT || 50052);

  try {
    await initDbTables();
    console.log('[MySQL] Session tables initialized or checked successfully.');
  } catch (err) {
    console.warn('[MySQL Warning] Could not auto-initialize tables:', err.message);
  }

  // 1. Start gRPC Server
  await startGrpcServer({ port: grpcPort });
  console.log(`[gRPC] agenwpp running on port ${grpcPort}`);

  // 2. Start HTTP Bridge Server for Health Checks & REST fallback
  startHttpServer({ port: httpPort });

  // 3. Start Redis Command Subscriber
  startRedisCommandSubscriber();
}

main().catch((error) => {
  console.error('[Fatal Error]', error);
  process.exit(1);
});
