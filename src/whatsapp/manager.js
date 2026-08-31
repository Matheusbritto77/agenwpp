import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { useMySQLAuthState } from '../db/mysql-auth-state.js';
import { getDbPool } from '../db/connection.js';
import { publishEvent } from '../redis/client.js';

const sessions = new Map(); // tenantId -> { sock, qrCode, status, phoneNumber }

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

export async function getSessionStatus(tenantId = 'default') {
  const memSession = sessions.get(tenantId);
  const db = getDbPool();

  const [rows] = await db.query(
    'SELECT * FROM whatsapp_sessions WHERE tenant_id = ? LIMIT 1',
    [tenantId]
  );

  const row = rows[0] || null;

  return {
    state: memSession?.status || row?.status || 'disconnected',
    phone_number: memSession?.phoneNumber || row?.phone_number || '',
    tenant_id: tenantId,
    qr_code: memSession?.qrCode || row?.qr_code || '',
    updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
}

export async function connectSession(tenantId = 'default') {
  const existing = sessions.get(tenantId);
  if (existing && existing.sock && existing.status === 'connected') {
    return {
      status: 'connected',
      qr_code: '',
      message: 'Session already connected.',
    };
  }

  const db = getDbPool();
  const { state, saveCreds } = await useMySQLAuthState(tenantId);
  const { version } = await fetchLatestBaileysVersion();

  const sessionObj = {
    sock: null,
    qrCode: '',
    status: 'connecting',
    phoneNumber: '',
  };
  sessions.set(tenantId, sessionObj);

  await db.query(
    `INSERT INTO whatsapp_sessions (tenant_id, status, qr_code)
     VALUES (?, 'connecting', NULL)
     ON DUPLICATE KEY UPDATE status = 'connecting'`,
    [tenantId]
  );

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: true,
    browser: ['Agendae Admin', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sessionObj.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
        sessionObj.qrCode = qrDataUrl;
        sessionObj.status = 'qr_ready';

        await db.query(
          `UPDATE whatsapp_sessions SET status = 'qr_ready', qr_code = ? WHERE tenant_id = ?`,
          [qrDataUrl, tenantId]
        );

        await publishEvent('whatsapp:events', {
          tenant_id: tenantId,
          type: 'qr_ready',
          qr_code: qrDataUrl,
        });
      } catch (err) {
        console.error('[QR Generation Error]', err);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      sessionObj.status = 'disconnected';
      sessionObj.qrCode = '';

      await db.query(
        `UPDATE whatsapp_sessions
         SET status = 'disconnected', qr_code = NULL, disconnected_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ?`,
        [tenantId]
      );

      await publishEvent('whatsapp:events', {
        tenant_id: tenantId,
        type: 'disconnected',
        reason: statusCode,
      });

      if (shouldReconnect) {
        console.log(`[WhatsApp] Reconnecting session ${tenantId}...`);
        setTimeout(() => connectSession(tenantId), 5000);
      } else {
        console.log(`[WhatsApp] Session ${tenantId} logged out.`);
        sessions.delete(tenantId);
      }
    } else if (connection === 'open') {
      const phone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
      const name = sock.user?.name || '';

      sessionObj.status = 'connected';
      sessionObj.qrCode = '';
      sessionObj.phoneNumber = phone;

      await db.query(
        `UPDATE whatsapp_sessions
         SET status = 'connected', qr_code = NULL, phone_number = ?, profile_name = ?, connected_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ?`,
        [phone, name, tenantId]
      );

      await publishEvent('whatsapp:events', {
        tenant_id: tenantId,
        type: 'connected',
        phone_number: phone,
        name,
      });

      console.log(`[WhatsApp] Session ${tenantId} connected successfully as ${phone}!`);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    await publishEvent('whatsapp:messages', {
      tenant_id: tenantId,
      messages: m.messages,
      type: m.type,
    });
  });

  return {
    status: sessionObj.status,
    qr_code: sessionObj.qrCode,
    message: 'Connecting to WhatsApp...',
  };
}

export async function disconnectSession(tenantId = 'default') {
  const sessionObj = sessions.get(tenantId);
  if (sessionObj && sessionObj.sock) {
    try {
      await sessionObj.sock.logout();
    } catch {
      sessionObj.sock.end(new Error('Manual disconnect'));
    }
  }

  sessions.delete(tenantId);
  const db = getDbPool();

  await db.query(
    `UPDATE whatsapp_sessions
     SET status = 'disconnected', qr_code = NULL, disconnected_at = CURRENT_TIMESTAMP
     WHERE tenant_id = ?`,
    [tenantId]
  );

  await publishEvent('whatsapp:events', {
    tenant_id: tenantId,
    type: 'disconnected',
    manual: true,
  });

  return {
    status: 'disconnected',
    message: 'Session disconnected successfully.',
  };
}

export async function sendMessage(tenantId = 'default', to, body, idempotencyKey = '') {
  const sessionObj = sessions.get(tenantId);
  if (!sessionObj || !sessionObj.sock || sessionObj.status !== 'connected') {
    return {
      message_id: '',
      status: 'error',
      error: 'WhatsApp is not connected.',
    };
  }

  // Format destination jid
  let jid = to.replace(/\D/g, '');
  if (!jid.includes('@s.whatsapp.net')) {
    jid = `${jid}@s.whatsapp.net`;
  }

  try {
    const result = await sessionObj.sock.sendMessage(jid, { text: body });
    return {
      message_id: result?.key?.id || idempotencyKey || `${Date.now()}`,
      status: 'sent',
      error: '',
    };
  } catch (err) {
    return {
      message_id: '',
      status: 'failed',
      error: err.message || 'Failed to send message',
    };
  }
}
