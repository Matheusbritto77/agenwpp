import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { useMySQLAuthState, clearSessionCredentials } from '../db/mysql-auth-state.js';
import { getDbPool } from '../db/connection.js';
import { logWhatsAppEvent } from '../db/logger.js';
import { publishEvent, setRedisKey, deleteRedisKey } from '../redis/client.js';

const sessions = new Map(); // tenantId -> { sock, qrCode, status, phoneNumber }

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// 💓 Active Heartbeat loop running every 2.5 seconds
setInterval(async () => {
  const db = getDbPool();

  for (const [tenantId, session] of sessions.entries()) {
    if (session.status === 'connected' && session.sock?.user) {
      // 1. Update Redis live key with 6s TTL
      await setRedisKey(`whatsapp:live:${tenantId}`, {
        status: 'connected',
        phone_number: session.phoneNumber,
        timestamp: Date.now(),
      }, 6);

      // 2. Update DB last_activity_at
      try {
        await db.query(
          `UPDATE whatsapp_sessions SET status = 'connected', last_activity_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`,
          [tenantId]
        );
      } catch {}
    } else if (session.status === 'connecting' || session.status === 'qr_ready') {
      await setRedisKey(`whatsapp:live:${tenantId}`, {
        status: session.status,
        qr_code: session.qrCode,
        timestamp: Date.now(),
      }, 6);
    }
  }
}, 2500);

// 🛡️ Graceful process shutdown handler to instantly inform Laravel if agenwpp goes down
async function handleProcessExit() {
  const db = getDbPool();
  for (const [tenantId, session] of sessions.entries()) {
    session.status = 'disconnected';
    await deleteRedisKey(`whatsapp:live:${tenantId}`);
    try {
      await db.query(
        `UPDATE whatsapp_sessions SET status = 'disconnected', qr_code = NULL WHERE tenant_id = ?`,
        [tenantId]
      );
    } catch {}
    await publishEvent('whatsapp:events', {
      tenant_id: tenantId,
      type: 'disconnected',
      reason: 'process_exit',
    });
  }
}

process.on('SIGINT', async () => {
  await handleProcessExit();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await handleProcessExit();
  process.exit(0);
});

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

        await setRedisKey(`whatsapp:live:${tenantId}`, {
          status: 'qr_ready',
          qr_code: qrDataUrl,
          timestamp: Date.now(),
        }, 30);

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

      await deleteRedisKey(`whatsapp:live:${tenantId}`);

      if (isLoggedOut || isConflict) {
        console.log(`[WhatsApp] Session ${tenantId} logged out or device removed (${statusCode}). Clearing credentials for clean pairing.`);
        await clearSessionCredentials(tenantId);
        sessions.delete(tenantId);

        await publishEvent('whatsapp:events', {
          tenant_id: tenantId,
          type: 'disconnected',
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

      await setRedisKey(`whatsapp:live:${tenantId}`, {
        status: 'connected',
        phone_number: phone,
        name,
        timestamp: Date.now(),
      }, 10);

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

      logWhatsAppEvent({
        tenantId,
        direction: 'system',
        phone,
        status: 'connected',
        messageBody: `WhatsApp conectado com sucesso como ${phone}`,
        metadata: { phone, name },
      }).catch(() => {});
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    // Log inbound messages to database
    for (const msg of m.messages || []) {
      if (msg.key?.fromMe) continue;
      const senderJid = msg.key?.remoteJid || '';
      if (!senderJid || senderJid.includes('@g.us')) continue; // Skip group messages
      const senderPhone = senderJid.split('@')[0];
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (text) {
        logWhatsAppEvent({
          tenantId,
          direction: 'inbound',
          phone: senderPhone,
          status: 'received',
          messageId: msg.key?.id,
          messageBody: text,
          metadata: { pushName: msg.pushName || null, jid: senderJid },
        }).catch(() => {});
      }
    }

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
  await deleteRedisKey(`whatsapp:live:${tenantId}`);
  await clearSessionCredentials(tenantId);

  logWhatsAppEvent({
    tenantId,
    direction: 'system',
    status: 'disconnected',
    messageBody: `Sessão desconectada manualmente pelo usuário`,
    metadata: { manual: true },
  }).catch(() => {});

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
    const errorMsg = 'WhatsApp is not connected.';
    logWhatsAppEvent({
      tenantId,
      direction: 'outbound',
      phone: to,
      status: 'failed',
      messageBody: body,
      errorMessage: errorMsg,
      metadata: { idempotencyKey },
    }).catch(() => {});

    return {
      message_id: '',
      status: 'error',
      error: errorMsg,
    };
  }

  const cleanNumber = to.replace(/\D/g, '');
  if (!cleanNumber) {
    const errorMsg = 'Número de telefone inválido.';
    logWhatsAppEvent({
      tenantId,
      direction: 'outbound',
      phone: to,
      status: 'failed',
      messageBody: body,
      errorMessage: errorMsg,
      metadata: { idempotencyKey },
    }).catch(() => {});

    return {
      message_id: '',
      status: 'error',
      error: errorMsg,
    };
  }

  let targetJid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

  // 📱 Detect Self-Chat / Mensagem para si mesmo (número próprio)
  const myJid = sessionObj.sock.user?.id ? jidNormalizedUser(sessionObj.sock.user.id) : null;
  const myPhoneNumber = sessionObj.phoneNumber || (sessionObj.sock.user?.id ? sessionObj.sock.user.id.split(':')[0].split('@')[0] : '');

  const isSelf = Boolean(
    myPhoneNumber && (
      cleanNumber === myPhoneNumber ||
      myPhoneNumber.endsWith(cleanNumber) ||
      cleanNumber.endsWith(myPhoneNumber) ||
      (myJid && targetJid === myJid)
    )
  );

  if (isSelf && myJid) {
    targetJid = myJid;
    console.log(`[WhatsApp] Self-message detected! Sending directly to own JID: ${targetJid}`);
  } else {
    // 🔎 Automatically query WhatsApp server for the exact registered JID (handling Brazilian 9th digit)
    try {
      const check = await sessionObj.sock.onWhatsApp(cleanNumber);
      if (check && check.length > 0 && check[0].exists) {
        targetJid = check[0].jid;
      } else if (cleanNumber.startsWith('55') && cleanNumber.length === 13) {
        // Try without 9th digit (55 + DDD + 8 digits)
        const without9 = cleanNumber.slice(0, 4) + cleanNumber.slice(5);
        const checkWithout9 = await sessionObj.sock.onWhatsApp(without9);
        if (checkWithout9 && checkWithout9.length > 0 && checkWithout9[0].exists) {
          targetJid = checkWithout9[0].jid;
        }
      } else if (cleanNumber.startsWith('55') && cleanNumber.length === 12) {
        // Try with 9th digit (55 + DDD + 9 + 8 digits)
        const with9 = cleanNumber.slice(0, 4) + '9' + cleanNumber.slice(4);
        const checkWith9 = await sessionObj.sock.onWhatsApp(with9);
        if (checkWith9 && checkWith9.length > 0 && checkWith9[0].exists) {
          targetJid = checkWith9[0].jid;
        }
      }
    } catch (checkErr) {
      console.warn('[onWhatsApp check warning]', checkErr.message);
    }
  }

  console.log(`[WhatsApp] Sending message to ${targetJid} (tenant: ${tenantId}, isSelf: ${isSelf}): "${body}"`);

  try {
    const result = await sessionObj.sock.sendMessage(targetJid, { text: body });
    const messageId = result?.key?.id || idempotencyKey || `${Date.now()}`;
    console.log(`[WhatsApp] Message successfully delivered to server! ID: ${messageId}`);

    logWhatsAppEvent({
      tenantId,
      direction: 'outbound',
      phone: cleanNumber,
      status: 'sent',
      messageId,
      messageBody: body,
      metadata: { targetJid, isSelf, idempotencyKey },
    }).catch(() => {});

    return {
      message_id: messageId,
      status: 'sent',
      target_jid: targetJid,
      error: '',
    };
  } catch (err) {
    console.error(`[WhatsApp] Send message error to ${targetJid}:`, err.message);

    logWhatsAppEvent({
      tenantId,
      direction: 'outbound',
      phone: cleanNumber,
      status: 'failed',
      messageBody: body,
      errorMessage: err.message || 'Failed to send message',
      metadata: { targetJid, isSelf, idempotencyKey },
    }).catch(() => {});

    return {
      message_id: '',
      status: 'failed',
      error: err.message || 'Failed to send message',
    };
  }
}

/**
 * Automatically inspects the shared database on startup and restores all existing connected sessions
 */
export async function restoreSavedSessions() {
  const db = getDbPool();
  try {
    const [rows] = await db.query(
      'SELECT tenant_id, creds, status, phone_number FROM whatsapp_sessions WHERE creds IS NOT NULL'
    );

    for (const row of rows) {
      if (row.creds) {
        console.log(`[Auto-Restore] Found stored session for tenant '${row.tenant_id}'. Connecting automatically...`);
        connectSession(row.tenant_id).catch((err) => {
          console.warn(`[Auto-Restore Warning] Could not restore session ${row.tenant_id}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.warn('[Auto-Restore Warning] Error querying saved sessions:', err.message);
  }
}
