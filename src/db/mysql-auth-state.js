import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { getDbPool } from './connection.js';

export async function useMySQLAuthState(tenantId = 'default') {
  const db = getDbPool();

  // 1. Load or initialize base creds
  const [rows] = await db.query(
    'SELECT creds FROM whatsapp_sessions WHERE tenant_id = ? LIMIT 1',
    [tenantId]
  );

  let creds;
  if (rows.length > 0 && rows[0].creds) {
    try {
      creds = JSON.parse(rows[0].creds, BufferJSON.reviver);
    } catch (e) {
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
    await db.query(
      `INSERT INTO whatsapp_sessions (tenant_id, status, creds)
       VALUES (?, 'disconnected', ?)
       ON DUPLICATE KEY UPDATE creds = VALUES(creds)`,
      [tenantId, JSON.stringify(creds, BufferJSON.replacer)]
    );
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          if (!ids || ids.length === 0) return {};
          const placeholders = ids.map(() => '?').join(',');
          const [keyRows] = await db.query(
            `SELECT key_id, value FROM whatsapp_auth_keys
             WHERE tenant_id = ? AND category = ? AND key_id IN (${placeholders})`,
            [tenantId, type, ...ids]
          );

          const result = {};
          for (const row of keyRows) {
            try {
              result[row.key_id] = JSON.parse(row.value, BufferJSON.reviver);
            } catch {
              result[row.key_id] = null;
            }
          }
          return result;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const keyId in data[category]) {
              const value = data[category][keyId];
              if (value) {
                const serialized = JSON.stringify(value, BufferJSON.replacer);
                tasks.push(
                  db.query(
                    `INSERT INTO whatsapp_auth_keys (tenant_id, category, key_id, value)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
                    [tenantId, category, keyId, serialized]
                  )
                );
              } else {
                tasks.push(
                  db.query(
                    `DELETE FROM whatsapp_auth_keys
                     WHERE tenant_id = ? AND category = ? AND key_id = ?`,
                    [tenantId, category, keyId]
                  )
                );
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      const serialized = JSON.stringify(creds, BufferJSON.replacer);
      await db.query(
        `INSERT INTO whatsapp_sessions (tenant_id, creds)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE creds = VALUES(creds)`,
        [tenantId, serialized]
      );
    },
  };
}
