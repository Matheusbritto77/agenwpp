import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { useMySQLAuthState, clearSessionCredentials } from '../db/mysql-auth-state.js';
import { getDbPool } from '../db/connection.js';
import { logWhatsAppEvent } from '../db/logger.js';
import {
  parseSpintax,
  isKnownInvalidNumber,
  markNumberAsInvalid,
  calculateTypingDuration,
  getHumanDelayMs,
  sleep,
} from './anti-ban.js';
import { publishEvent, setRedisKey, deleteRedisKey } from '../redis/client.js';

const sessions = new Map(); // tenantId -> { sock, qrCode, status, phoneNumber }

// 🤫 Completely disable Baileys internal pino logger output to prevent raw JSON traces
const logger = pino({
  level: 'silent',
  enabled: false,
});

function getFriendlyDisconnectReason(statusCode, error) {
  if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
    return 'Sessão desconectada no aparelho';
  }
  if (statusCode === DisconnectReason.connectionReplaced || String(error).includes('device_removed')) {
    return 'Sessão substituída por outra conexão ativa ou aparelho desconectado';
  }
  if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
    return 'Reinício solicitado pelo servidor do WhatsApp';
  }
  if (statusCode === DisconnectReason.timedOut || statusCode === 408) {
    return 'Tempo limite de rede esgotado';
  }
  if (statusCode === DisconnectReason.badSession) {
    return 'Chaves de sessão corrompidas ou inválidas';
  }
  if (String(error?.message || error || '').includes('Connection Failure')) {
    return 'Instabilidade temporária de conexão com o WhatsApp';
  }
  return `Conexão encerrada (código: ${statusCode || 'stream_close'})`;
}

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
      pairing_code: memSession?.pairingCode || row?.pairing_code || '',
      updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    };
  } catch (err) {
    console.error('[GetSessionStatus Error]', err.message);
    return {
      state: memSession?.status || 'disconnected',
      phone_number: memSession?.phoneNumber || '',
      tenant_id: tenantId,
      qr_code: memSession?.qrCode || '',
      pairing_code: memSession?.pairingCode || '',
      updated_at: new Date().toISOString(),
    };
  }
}

export async function connectSession(tenantId = 'default', pairingPhoneNumber = null) {
  const existing = sessions.get(tenantId);
  if (existing && existing.sock && existing.status === 'connected') {
    return {
      status: 'connected',
      qr_code: '',
      pairing_code: '',
      message: 'Session already connected.',
    };
  }

  // If previous socket exists in non-connected state, safely destroy it before reconnecting
  if (existing && existing.sock) {
    try {
      existing.sock.ev.removeAllListeners('connection.update');
      existing.sock.ev.removeAllListeners('creds.update');
      existing.sock.ev.removeAllListeners('messages.upsert');
      existing.sock.end(undefined);
    } catch {}
    sessions.delete(tenantId);
  }

  const db = getDbPool();
  const { state, saveCreds } = await useMySQLAuthState(tenantId);
  const { version } = await fetchLatestBaileysVersion();

  const sessionObj = {
    sock: null,
    qrCode: '',
    pairingCode: '',
    status: 'connecting',
    phoneNumber: '',
  };
  sessions.set(tenantId, sessionObj);

  try {
    await db.query(
      `INSERT INTO whatsapp_sessions (tenant_id, status, qr_code, pairing_code)
       VALUES (?, 'connecting', NULL, NULL)
       ON DUPLICATE KEY UPDATE status = 'connecting', qr_code = NULL, pairing_code = NULL`,
       [tenantId]
    );
  } catch (err) {
    console.warn('[DB Warning] could not update status to connecting:', err.message);
  }

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sessionObj.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  const cleanPairingPhone = pairingPhoneNumber ? String(pairingPhoneNumber).replace(/\D/g, '') : '';

  // 🔢 Request Pairing Code if phone number is provided and device is not yet registered
  if (cleanPairingPhone && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        console.log(`[WhatsApp] Requesting Pairing Code for phone: ${cleanPairingPhone}...`);
        const code = await sock.requestPairingCode(cleanPairingPhone);
        sessionObj.pairingCode = code;
        sessionObj.status = 'pairing_ready';

        try {
          await db.query(
            `UPDATE whatsapp_sessions SET status = 'pairing_ready', pairing_code = ? WHERE tenant_id = ?`,
            [code, tenantId]
          );
        } catch (dbErr) {
          console.error('[DB Pairing Update Error]', dbErr.message);
        }

        await setRedisKey(`whatsapp:live:${tenantId}`, {
          status: 'pairing_ready',
          pairing_code: code,
          timestamp: Date.now(),
        }, 120);

        await publishEvent('whatsapp:events', {
          tenant_id: tenantId,
          type: 'pairing_ready',
          pairing_code: code,
        });

        console.log(`[WhatsApp] Pairing Code generated: ${code}`);
      } catch (pairErr) {
        console.error('[Pairing Code Error]', pairErr.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Only set QR code if pairing code was not requested
    if (qr && !cleanPairingPhone) {
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
      const errorObj = lastDisconnect?.error;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const isConflict = statusCode === DisconnectReason.connectionReplaced || String(errorObj).includes('device_removed');
      const friendlyReason = getFriendlyDisconnectReason(statusCode, errorObj);

      sessionObj.status = 'disconnected';
      sessionObj.qrCode = '';
      sessionObj.pairingCode = '';

      await deleteRedisKey(`whatsapp:live:${tenantId}`);

      if (isLoggedOut || isConflict) {
        console.log(`[WhatsApp] Sessão '${tenantId}' desconectada: ${friendlyReason} (${statusCode}). Limpando credenciais para novo pareamento.`);
        await clearSessionCredentials(tenantId);
        sessions.delete(tenantId);

        await publishEvent('whatsapp:events', {
          tenant_id: tenantId,
          type: 'disconnected',
          reason: statusCode,
          friendly_reason: friendlyReason,
        });
      } else {
        try {
          await db.query(
            `UPDATE whatsapp_sessions
             SET status = 'disconnected', qr_code = NULL, pairing_code = NULL
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
          friendly_reason: friendlyReason,
        });

        console.log(`[WhatsApp] Sessão '${tenantId}' pausada: ${friendlyReason}. Reconectando automaticamente em 4s...`);
        setTimeout(() => connectSession(tenantId), 4000);
      }
    } else if (connection === 'open') {
      const phone = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : '';
      const name = sock.user?.name || '';

      sessionObj.status = 'connected';
      sessionObj.qrCode = '';
      sessionObj.pairingCode = '';
      sessionObj.phoneNumber = phone;

      try {
        await db.query(
          `UPDATE whatsapp_sessions
           SET status = 'connected', qr_code = NULL, pairing_code = NULL, phone_number = ?, profile_name = ?, connected_at = CURRENT_TIMESTAMP
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
      await sessionObj.sock.logout().catch(() => {});
    } catch {
      try {
        sessionObj.sock.end(undefined);
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

  // 🛡️ Anti-Ban: Check if number is in blacklist cache of non-existent numbers
  if (isKnownInvalidNumber(cleanNumber)) {
    const errorMsg = `[Anti-Ban] O número ${cleanNumber} não possui conta ativa no WhatsApp. Disparo cancelado para proteger o chip.`;
    console.warn(errorMsg);
    logWhatsAppEvent({
      tenantId,
      direction: 'outbound',
      phone: cleanNumber,
      status: 'failed',
      messageBody: body,
      errorMessage: errorMsg,
      metadata: { idempotencyKey, anti_ban_blocked: true },
    }).catch(() => {});

    return {
      message_id: '',
      status: 'failed',
      error: errorMsg,
    };
  }

  // 💬 Anti-Ban: Dynamic Spintax Resolver to prevent sending identical texts in batch
  const finalBody = parseSpintax(body);

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
  }

  // 🛡️ Anti-Ban: Humanized Presence Simulation (Simular "Digitando..." por 1.2s - 3.2s)
  if (!isSelf) {
    try {
      await sessionObj.sock.sendPresenceUpdate('composing', targetJid);
      const typingDuration = calculateTypingDuration(finalBody);
      await sleep(typingDuration);
      await sessionObj.sock.sendPresenceUpdate('paused', targetJid);
      await sleep(250); // Small realistic pause between typing and hitting send
    } catch (presenceErr) {
      // Non-fatal if presence update fails
      console.warn('[Presence Update Warning]', presenceErr.message);
    }
  }

  console.log(`[WhatsApp] Sending message to ${targetJid} (tenant: ${tenantId}, isSelf: ${isSelf}): "${finalBody}"`);

  try {
    const result = await sessionObj.sock.sendMessage(targetJid, { text: finalBody });
    const messageId = result?.key?.id || idempotencyKey || `${Date.now()}`;
    console.log(`[WhatsApp] Message successfully delivered to server! ID: ${messageId}`);

    await logWhatsAppEvent({
      tenantId,
      direction: 'outbound',
      phone: cleanNumber,
      status: 'sent',
      messageId,
      messageBody: finalBody,
      metadata: { targetJid, isSelf, idempotencyKey },
    });

    // 🛡️ Anti-Ban: Human delay spacing before resolving (prevents rapid bursts)
    if (!isSelf) {
      const delay = getHumanDelayMs();
      await sleep(delay);
    }

    return {
      message_id: messageId,
      status: 'sent',
      target_jid: targetJid,
      error: '',
    };
  } catch (err) {
    console.error(`[WhatsApp] Send message error to ${targetJid}:`, err.message);

    await logWhatsAppEvent({
      tenantId,
      direction: 'outbound',
      phone: cleanNumber,
      status: 'failed',
      messageBody: finalBody,
      errorMessage: err.message || 'Failed to send message',
      metadata: { targetJid, isSelf, idempotencyKey },
    });

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
