import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { useMySQLAuthState, clearSessionCredentials } from '../db/mysql-auth-state.js';
import { getDbPool } from '../db/connection.js';
import { publishEvent } from '../redis/client.js';

const sessions = new Map(); // tenantId -> { sock, qrCode, status, phoneNumber }

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

export async function getSessionStatus(tenantId = 'default') {
  const memSession = sessions.get(tenantId);
  const db = getDbPool();

  try {
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
  } catch (err) {
    console.error('[GetSessionStatus Error]', err.message);
    return {
      state: memSession?.status || 'disconnected',
      phone_number: memSession?.phoneNumber || '',
      tenant_id: tenantId,
      qr_code: memSession?.qrCode || '',
      updated_at: new Date().toISOString(),
    };
  }
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

  // If previous socket exists in non-connected state, safely destroy it before reconnecting
  if (existing && existing.sock) {
    try {
      existing.sock.ev.removeAllListeners('connection.update');
      existing.sock.ev.removeAllListeners('creds.update');
      existing.sock.ev.removeAllListeners('messages.upsert');
      existing.sock.end(new Error('Starting new session'));
    } catch {}
    sessions.delete(tenantId);
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

  try {
    await db.query(
      `INSERT INTO whatsapp_sessions (tenant_id, status, qr_code)
       VALUES (?, 'connecting', NULL)
       ON DUPLICATE KEY UPDATE status = 'connecting'`,
      [tenantId]
    );
  } catch (err) {
    console.warn('[DB Warning] could not update status to connecting:', err.message);
  }

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    browser: ['Agendae Admin', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
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

        try {
          await db.query(
            `UPDATE whatsapp_sessions SET status = 'qr_ready', qr_code = ? WHERE tenant_id = ?`,
            [qrDataUrl, tenantId]
          );
        } catch (dbErr) {
          console.error('[DB QR Update Error]', dbErr.message);
        }

        await publishEvent('whatsapp:events', {
          tenant_id: tenantId,
          type: 'qr_ready',
          qr_code: qrDataUrl,
        });
      } catch (err) {
        console.error('[QR Generation Error]', err.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const isConflict = statusCode === DisconnectReason.connectionReplaced || String(lastDisconnect?.error).includes('device_removed');

      sessionObj.status = 'disconnected';
      sessionObj.qrCode = '';

      if (isLoggedOut || isConflict) {
        console.log(`[WhatsApp] Session ${tenantId} logged out or device removed (${statusCode}). Clearing credentials for clean pairing.`);
        await clearSessionCredentials(tenantId);
        sessions.delete(tenantId);

        await publishEvent('whatsapp:events', {
          tenant_id: tenantId,
          type: 'logged_out',
          reason: statusCode,
        });
      } else {
        try {
          await db.query(
            `UPDATE whatsapp_sessions
             SET status = 'disconnected', qr_code = NULL
             WHERE tenant_id = ?`,
            [tenantId]
          );
        } catch (dbErr) {
          console.error('[DB Disconnect Update Error]', dbErr.message);
        }

        await publishEvent('whatsapp:events', {
          tenant_id: tenantId,
          type: 'disconnected',
          reason: statusCode,
        });

        console.log(`[WhatsApp] Reconnecting session ${tenantId} after stream close (status: ${statusCode || 'reconnecting'})...`);
        setTimeout(() => connectSession(tenantId), 4000);
      }
    } else if (connection === 'open') {
      const phone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
      const name = sock.user?.name || '';

      sessionObj.status = 'connected';
      sessionObj.qrCode = '';
      sessionObj.phoneNumber = phone;

      try {
        await db.query(
          `UPDATE whatsapp_sessions
           SET status = 'connected', qr_code = NULL, phone_number = ?, profile_name = ?, connected_at = CURRENT_TIMESTAMP
           WHERE tenant_id = ?`,
          [phone, name, tenantId]
        );
      } catch (dbErr) {
        console.error('[DB Connected Update Error]', dbErr.message);
      }

      await publishEvent('whatsapp:events', {
        tenant_id: tenantId,
        type: 'connected',
        phone_number: phone,
        name,
      });

      // Keep presence unavailable so mobile phone keeps receiving notifications
      try {
        await sock.sendPresenceUpdate('unavailable');
      } catch {}

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
      sessionObj.sock.ev.removeAllListeners('connection.update');
      sessionObj.sock.ev.removeAllListeners('creds.update');
      sessionObj.sock.ev.removeAllListeners('messages.upsert');
      await sessionObj.sock.logout();
    } catch {
      try {
        sessionObj.sock.end(new Error('Manual disconnect'));
      } catch {}
    }
  }

  sessions.delete(tenantId);
  await clearSessionCredentials(tenantId);

  await publishEvent('whatsapp:events', {
    tenant_id: tenantId,
    type: 'disconnected',
    manual: true,
  });

  return {
    status: 'disconnected',
    message: 'Session disconnected and cleared successfully.',
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
