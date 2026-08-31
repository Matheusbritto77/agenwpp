import 'dotenv/config';
import { initDbTables } from './db/connection.js';
import { startGrpcServer } from './grpc/server.js';

async function main() {
  const port = Number(process.env.GRPC_PORT || 50051);

  try {
    await initDbTables();
    console.log('[MySQL] Session tables initialized or checked successfully.');
  } catch (err) {
    console.warn('[MySQL Warning] Could not auto-initialize tables:', err.message);
  }

  await startGrpcServer({ port });
  console.log(`[gRPC] agenwpp running on port ${port}`);
}

main().catch((error) => {
  console.error('[Fatal Error]', error);
  process.exit(1);
});
