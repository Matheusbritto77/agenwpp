import 'dotenv/config';
import { startGrpcServer } from './grpc/server.js';

async function main() {
  const port = Number(process.env.GRPC_PORT || 50051);

  await startGrpcServer({ port });

  console.log(`agenwpp running on gRPC port ${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

