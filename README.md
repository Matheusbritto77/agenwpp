# agenwpp

Service de WhatsApp baseado em Baileys, separado do painel Laravel.

Objetivo:

- manter a conexão WhatsApp isolada em um processo Node
- expor comandos via gRPC para o Laravel
- receber eventos do WhatsApp e repassar para o backend

Estrutura base:

- `src/index.js` - bootstrap do serviço
- `src/grpc/server.js` - servidor gRPC
- `proto/whatsapp.proto` - contrato entre Laravel e Node

## Próximos passos

1. Implementar a sessão Baileys com persistência.
2. Conectar o Laravel ao serviço via gRPC.
3. Adicionar fila, retries e idempotência.

