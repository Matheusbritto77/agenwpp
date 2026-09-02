import { getDbPool } from '../db/connection.js';

let cachedDbName = null;

/**
 * Dynamically resolve the Agendae database name where appointments table lives
 */
async function resolveAgendaeDatabase(db) {
  if (cachedDbName) return cachedDbName;

  const candidates = [
    process.env.AGENDAE_DB_DATABASE,
    'agendai',
    'agendae',
    'agenda',
    process.env.DB_DATABASE,
    'adminagenda',
  ];

  for (const name of candidates) {
    if (!name) continue;
    try {
      const [rows] = await db.query(`SELECT 1 FROM \`${name}\`.appointments LIMIT 1`);
      if (rows) {
        cachedDbName = name;
        console.log(`[Interactive Approval] Successfully resolved Agendae database: \`${cachedDbName}\``);
        return cachedDbName;
      }
    } catch {}
  }

  cachedDbName = process.env.AGENDAE_DB_DATABASE || process.env.DB_DATABASE || 'agendae';
  return cachedDbName;
}

/**
 * Directly process interactive SIM/NAO WhatsApp replies with zero delay
 */
export async function processInteractiveApproval(sock, senderPhone, text, senderJid, tenantId = 'default', contextInfo = {}) {
  if (!text || typeof text !== 'string') return null;

  const rawMessage = text.trim();
  const cleanedText = rawMessage.replace(/[^\p{L}\p{N}\s#]/gu, '');

  let isApproval = false;
  let isRejection = false;
  let appointmentId = null;

  const matchApproval = cleanedText.match(/^(?:SIM|S|APROVAR|CONFIRMAR|CONFIRMADO|OK|1)\b(?:\s*#?(\d+))?/i);
  const matchRejection = cleanedText.match(/^(?:NAO|NÃO|N|RECUSAR|CANCELAR|CANCELADO|2)\b(?:\s*#?(\d+))?/i);

  if (matchApproval) {
    isApproval = true;
    if (matchApproval[1]) appointmentId = parseInt(matchApproval[1], 10);
  } else if (matchRejection) {
    isRejection = true;
    if (matchRejection[1]) appointmentId = parseInt(matchRejection[1], 10);
  }

  if (!isApproval && !isRejection) {
    return null; // Not an approval/rejection command
  }

  // 📌 If user quoted/marked the notification message, extract Appointment ID from quoted text
  if (!appointmentId && contextInfo?.quotedText) {
    const quotedMatch = contextInfo.quotedText.match(/#(\d+)/);
    if (quotedMatch && quotedMatch[1]) {
      appointmentId = parseInt(quotedMatch[1], 10);
      console.log(`[Interactive Approval] Extracted Appointment #${appointmentId} directly from Quoted Message!`);
    }
  }

  const cleanPhone = senderPhone.replace(/\D/g, '');
  const db = getDbPool();
  const agendaeDb = await resolveAgendaeDatabase(db);

  console.log(`[Interactive Approval] Intent: ${isApproval ? 'APPROVE' : 'REJECT'} from ${cleanPhone} ("${rawMessage}") | Target ID: ${appointmentId || 'Auto'} | DB: \`${agendaeDb}\``);

  try {
    let appointment = null;

    // 1. If explicit appointment ID provided or extracted from quote
    if (appointmentId) {
      const [rows] = await db.query(
        `SELECT a.*, s.name as service_name, u.name as company_name
         FROM \`${agendaeDb}\`.appointments a
         LEFT JOIN \`${agendaeDb}\`.services s ON s.id = a.service_id
         LEFT JOIN \`${agendaeDb}\`.users u ON u.id = a.user_id
         WHERE a.id = ?`,
        [appointmentId]
      );
      if (rows && rows.length > 0) appointment = rows[0];
    }

    // 2. Search by recent notification sent to this phone
    if (!appointment) {
      const last8 = cleanPhone.slice(-8);
      const [queueRows] = await db.query(
        `SELECT appointment_id FROM \`${agendaeDb}\`.whatsapp_notification_queue
         WHERE (recipient_phone LIKE ? OR recipient_phone LIKE ?)
           AND appointment_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [`%${cleanPhone}%`, `%${last8}%`]
      );

      if (queueRows && queueRows.length > 0 && queueRows[0].appointment_id) {
        const [candRows] = await db.query(
          `SELECT a.*, s.name as service_name, u.name as company_name
           FROM \`${agendaeDb}\`.appointments a
           LEFT JOIN \`${agendaeDb}\`.services s ON s.id = a.service_id
           LEFT JOIN \`${agendaeDb}\`.users u ON u.id = a.user_id
           WHERE a.id = ? AND a.status = 'pending'`,
          [queueRows[0].appointment_id]
        );
        if (candRows && candRows.length > 0) appointment = candRows[0];
      }
    }

    // 3. Search by company user or team member phone
    if (!appointment) {
      const last8 = cleanPhone.slice(-8);
      const [candRows] = await db.query(
        `SELECT a.*, s.name as service_name, u.name as company_name
         FROM \`${agendaeDb}\`.appointments a
         LEFT JOIN \`${agendaeDb}\`.services s ON s.id = a.service_id
         LEFT JOIN \`${agendaeDb}\`.users u ON u.id = a.user_id
         LEFT JOIN \`${agendaeDb}\`.team_members tm ON tm.id = a.team_member_id
         WHERE a.status = 'pending'
           AND (u.phone LIKE ? OR u.phone LIKE ? OR tm.phone LIKE ? OR tm.phone LIKE ?)
         ORDER BY a.id DESC LIMIT 1`,
        [`%${cleanPhone}%`, `%${last8}%`, `%${cleanPhone}%`, `%${last8}%`]
      );
      if (candRows && candRows.length > 0) appointment = candRows[0];
    }

    // 4. Fallback: most recent pending appointment
    if (!appointment) {
      const [fallbackRows] = await db.query(
        `SELECT a.*, s.name as service_name, u.name as company_name
         FROM \`${agendaeDb}\`.appointments a
         LEFT JOIN \`${agendaeDb}\`.services s ON s.id = a.service_id
         LEFT JOIN \`${agendaeDb}\`.users u ON u.id = a.user_id
         WHERE a.status = 'pending'
         ORDER BY a.id DESC LIMIT 1`
      );
      if (fallbackRows && fallbackRows.length > 0) appointment = fallbackRows[0];
    }

    if (!appointment) {
      console.warn(`[Interactive Approval] No pending appointment found for response from ${cleanPhone}`);
      return null;
    }

    const serviceName = appointment.service_name || 'Serviço';
    const companyName = appointment.company_name || 'Estabelecimento';
    
    // Format date and time
    let formattedDate = '';
    if (appointment.appointment_date) {
      const d = new Date(appointment.appointment_date);
      formattedDate = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }
    const formattedTime = appointment.appointment_time ? String(appointment.appointment_time).slice(0, 5) : '';

    // ==========================================
    // 🟢 APPROVAL ACTION (SIM)
    // ==========================================
    if (isApproval) {
      // 1. Update appointment status to confirmed in Agendae DB
      await db.query(`UPDATE \`${agendaeDb}\`.appointments SET status = 'confirmed' WHERE id = ?`, [appointment.id]);

      // 2. Insert flow log
      try {
        await db.query(
          `INSERT INTO \`${agendaeDb}\`.appointment_flow_logs (user_id, appointment_id, event_type, level, channel, title, description, metadata, created_at)
           VALUES (?, ?, 'status_changed', 'success', 'whatsapp', 'Agendamento Aprovado via WhatsApp (Instant Engine)', ?, ?, NOW())`,
          [
            appointment.user_id,
            appointment.id,
            `O profissional respondeu 'SIM' no WhatsApp e aprovou o agendamento de ${appointment.client_name}.`,
            JSON.stringify({ phone: cleanPhone, raw_message: rawMessage, new_status: 'confirmed' }),
          ]
        );
      } catch (logErr) {
        console.warn('[Flow Log Warning]', logErr.message);
      }

      // 3. Enqueue Customer Confirmation Notification in whatsapp_notification_queue
      if (appointment.client_phone) {
        const customerMsg = `🎉 *Agendamento Confirmado!*\n\nOlá, ${appointment.client_name}! O seu agendamento em *${companyName}* foi aprovado com sucesso:\n📅 *Data:* ${formattedDate}\n⏰ *Horário:* ${formattedTime}\n✂️ *Serviço:* ${serviceName}\n\nEsperamos por você! Obrigado pela preferência.`;
        
        try {
          await db.query(
            `INSERT INTO \`${agendaeDb}\`.whatsapp_notification_queue (user_id, appointment_id, recipient_phone, recipient_name, message_type, message_body, status, scheduled_for, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'confirmed', ?, 'pending', NOW(), NOW(), NOW())`,
            [appointment.user_id, appointment.id, appointment.client_phone, appointment.client_name, customerMsg]
          );
        } catch (queueErr) {
          console.warn('[Queue Insert Warning]', queueErr.message);
        }
      }

      // 4. Send Confirmation Receipt to the sender
      const receiptText = `✅ *Agendamento #${appointment.id} Aprovado com Sucesso!*\n\n`
        + `👤 *Cliente:* ${appointment.client_name}\n`
        + `📅 *Data:* ${formattedDate} às ${formattedTime}\n`
        + `✂️ *Serviço:* ${serviceName}\n\n`
        + `✨ O cliente foi notificado pelo WhatsApp com a confirmação!`;

      await sock.sendMessage(senderJid, { text: receiptText });
      console.log(`[Interactive Approval] Appointment #${appointment.id} CONFIRMED! Receipt sent to ${senderJid}`);

      return { action: 'approved', appointmentId: appointment.id };
    }

    // ==========================================
    // 🔴 REJECTION ACTION (NAO)
    // ==========================================
    if (isRejection) {
      await db.query(`UPDATE \`${agendaeDb}\`.appointments SET status = 'cancelled' WHERE id = ?`, [appointment.id]);

      // Cancel pending reminders
      try {
        await db.query(
          `UPDATE \`${agendaeDb}\`.whatsapp_notification_queue SET status = 'cancelled' WHERE appointment_id = ? AND message_type = 'reminder' AND status = 'pending'`,
          [appointment.id]
        );
      } catch {}

      // Insert flow log
      try {
        await db.query(
          `INSERT INTO \`${agendaeDb}\`.appointment_flow_logs (user_id, appointment_id, event_type, level, channel, title, description, metadata, created_at)
           VALUES (?, ?, 'status_changed', 'danger', 'whatsapp', 'Agendamento Recusado via WhatsApp (Instant Engine)', ?, ?, NOW())`,
          [
            appointment.user_id,
            appointment.id,
            `O profissional respondeu 'NAO' no WhatsApp e recusou o agendamento de ${appointment.client_name}.`,
            JSON.stringify({ phone: cleanPhone, raw_message: rawMessage, new_status: 'cancelled' }),
          ]
        );
      } catch {}

      // Enqueue Customer Cancellation Notification
      if (appointment.client_phone) {
        const customerMsg = `🚫 *Agendamento Cancelado*\n\nOlá, ${appointment.client_name}. Lamentamos informar que o seu pedido de agendamento em *${companyName}* para o dia ${formattedDate} às ${formattedTime} não pôde ser aceito no momento.`;
        
        try {
          await db.query(
            `INSERT INTO \`${agendaeDb}\`.whatsapp_notification_queue (user_id, appointment_id, recipient_phone, recipient_name, message_type, message_body, status, scheduled_for, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'cancelled', ?, 'pending', NOW(), NOW(), NOW())`,
            [appointment.user_id, appointment.id, appointment.client_phone, appointment.client_name, customerMsg]
          );
        } catch {}
      }

      // Send Rejection Receipt to the sender
      const receiptText = `🚫 *Agendamento #${appointment.id} Recusado.*\n\n`
        + `👤 *Cliente:* ${appointment.client_name}\n`
        + `📅 *Data:* ${formattedDate} às ${formattedTime}\n\n`
        + `O cliente foi notificado sobre o cancelamento.`;

      await sock.sendMessage(senderJid, { text: receiptText });
      console.log(`[Interactive Approval] Appointment #${appointment.id} REJECTED! Receipt sent to ${senderJid}`);

      return { action: 'rejected', appointmentId: appointment.id };
    }
  } catch (err) {
    console.warn('[Direct DB Notice] MySQL cross-db update delegated to Laravel Event Listener:', err.message);
  }

  return null;
}
