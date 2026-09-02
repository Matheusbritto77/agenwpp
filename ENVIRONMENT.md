# ⚙️ agenwpp — Variáveis de Ambiente & Configurações

Guia completo de variáveis de ambiente para deploy e execução local do microserviço **agenwpp**.

---

## 📋 Lista de Variáveis

| Variável | Tipo | Padrão | Descrição |
| :--- | :--- | :--- | :--- |
| `GRPC_PORT` | Número | `50051` | Porta TCP para o servidor gRPC responder às requisições do Laravel (`adminagenda`). |
| `DB_HOST` | String | `127.0.0.1` | Host do banco de dados MySQL compartilhado com o `adminagenda`. |
| `DB_PORT` | Número | `3306` | Porta do banco de dados MySQL. |
| `DB_DATABASE` | String | `adminagenda` | Nome do banco de dados onde as sessões do WhatsApp são armazenadas. |
| `DB_USERNAME` | String | `mysql` | Usuário do MySQL. |
| `DB_PASSWORD` | String | `""` | Senha do usuário do MySQL. |
| `REDIS_URL` | String | `redis://127.0.0.1:6379` | URL de conexão com o Redis para eventos em tempo real e fila. |
| `AGENDAE_WEBHOOK_URL` | String | `http://127.0.0.1:8000/api/webhooks/whatsapp/inbound` | URL da API do Agendae para processar respostas interativas (ex: SIM/NAO). |
| `LOG_LEVEL` | String | `info` | Nível de log (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). |

---

## 🚀 Exemplo de Configuração (.env) para Produção (Dokploy / Docker)

```env
# gRPC
GRPC_PORT=50051

# Banco MySQL Compartilhado
DB_HOST=agenda-adminagenda-jpvhry
DB_PORT=3306
DB_DATABASE=adminagenda
DB_USERNAME=mysql
DB_PASSWORD=9tlLfZDeRAb7v1noxlCe

# Redis
REDIS_URL=redis://default:4tyz8V2cjAHsmQ5rOkTM@agenda-wppreddis-qykpeh:6379

# Webhook do Agendae para Aprovações Interativas SIM/NAO
AGENDAE_WEBHOOK_URL=http://agenda-backend:8000/api/webhooks/whatsapp/inbound

# Log
LOG_LEVEL=info
```

---

## 🗄️ Tabelas no MySQL Criadas Automaticamente

1. **`whatsapp_sessions`**:
   - `id`: Identificador numérico.
   - `tenant_id`: Identificador da instância/tenant (`default`).
   - `status`: Estado da conexão (`disconnected`, `connecting`, `qr_ready`, `connected`).
   - `phone_number`: Número do WhatsApp conectado.
   - `profile_name`: Nome de perfil do WhatsApp.
   - `qr_code`: Data URL do QR Code gerado para leitura.
   - `creds`: Credenciais base serializadas do Baileys.
   - `connected_at`, `disconnected_at`, `created_at`, `updated_at`.

2. **`whatsapp_auth_keys`**:
   - Armazena as chaves criptográficas de sincronização multi-device do Baileys (`pre-key`, `session`, `app-state-sync-key`, etc.).

---

## 📡 Canais de Eventos no Redis

- **`whatsapp:events`**: Notificações de mudança de estado (`connected`, `disconnected`, `qr_ready`).
- **`whatsapp:messages`**: Mensagens recebidas em tempo real (`messages.upsert`).
