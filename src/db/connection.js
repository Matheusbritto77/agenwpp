import mysql from 'mysql2/promise';

let pool = null;

export function getDbPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USERNAME || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_DATABASE || 'adminagenda',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return pool;
}

export async function initDbTables() {
  const db = getDbPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL UNIQUE,
      status VARCHAR(32) NOT NULL DEFAULT 'disconnected',
      phone_number VARCHAR(32) NULL,
      profile_name VARCHAR(255) NULL,
      qr_code LONGTEXT NULL,
      creds LONGTEXT NULL,
      connected_at TIMESTAMP NULL,
      last_activity_at TIMESTAMP NULL,
      disconnected_at TIMESTAMP NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // Ensure any missing columns exist if table was created previously
  const columns = [
    { name: 'phone_number', def: 'VARCHAR(32) NULL' },
    { name: 'profile_name', def: 'VARCHAR(255) NULL' },
    { name: 'qr_code', def: 'LONGTEXT NULL' },
    { name: 'pairing_code', def: 'VARCHAR(32) NULL' },
    { name: 'creds', def: 'LONGTEXT NULL' },
    { name: 'connected_at', def: 'TIMESTAMP NULL' },
    { name: 'last_activity_at', def: 'TIMESTAMP NULL' },
    { name: 'disconnected_at', def: 'TIMESTAMP NULL' },
  ];

  for (const col of columns) {
    try {
      await db.query(`ALTER TABLE whatsapp_sessions ADD COLUMN ${col.name} ${col.def}`);
    } catch {
      // Column already exists, safe to ignore
    }
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL,
      category VARCHAR(64) NOT NULL,
      key_id VARCHAR(191) NOT NULL,
      value LONGTEXT NOT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_tenant_cat_key (tenant_id, category, key_id),
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
      direction VARCHAR(20) NOT NULL DEFAULT 'outbound',
      phone VARCHAR(64) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'sent',
      message_id VARCHAR(191) NULL,
      message_body LONGTEXT NULL,
      error_message LONGTEXT NULL,
      metadata JSON NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant_status (tenant_id, status),
      INDEX idx_phone (phone),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}
