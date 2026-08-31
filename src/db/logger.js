import { getDbPool } from './connection.js';

/**
 * Persist WhatsApp logs directly to MySQL database
 */
export async function logWhatsAppEvent({
  tenantId = 'default',
  direction = 'outbound', // 'outbound' | 'inbound' | 'system'
  phone = null,
  status = 'sent',        // 'sent' | 'received' | 'failed' | 'error' | 'connected' | 'disconnected'
  messageId = null,
  messageBody = null,
  errorMessage = null,
  metadata = null,
}) {
  try {
    const db = getDbPool();
    const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
    const metaJson = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;

    await db.query(
      `INSERT INTO whatsapp_logs (tenant_id, direction, phone, status, message_id, message_body, error_message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        tenantId || 'default',
        direction,
        cleanPhone,
        status,
        messageId,
        messageBody,
        errorMessage,
        metaJson,
      ]
    );
  } catch (err) {
    console.error('[logWhatsAppEvent] Failed to write log to MySQL:', err.message);
  }
}
