import { getDbPool, getAgendaeDbPool } from '../db/connection.js';

let cachedDbName = null;

/**
 * Dynamically resolve the Agendae database name where appointments table lives
 */
async function resolveAgendaeDatabase(db) {
  if (cachedDbName !== null) return cachedDbName;

  // First check if appointments table is directly accessible on current db
  try {
    const [rows] = await db.query(`SELECT 1 FROM appointments LIMIT 1`);
    if (rows) {
      cachedDbName = '';
      console.log('[Interactive Approval] Appointments table accessible directly without schema prefix.');
      return cachedDbName;
    }
  } catch {}

  const candidates = [
    process.env.AGENDAE_DB_DATABASE,
    'agendai',
    'agendae',
    'agenda',
    process.env.DB_DATABASE,
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

  cachedDbName = process.env.AGENDAE_DB_DATABASE || 'agendai';
  return cachedDbName;
}

/**
 * Directly process interactive SIM/NAO WhatsApp replies with zero delay
 */
export async function processInteractiveApproval(sock, senderPhone, text, senderJid, tenantId = 'default', contextInfo = {}) {
  if (!text || typeof text !== 'string') return null;

  const rawMessage = text.trim();
  const cleanedText = rawMessage.replace(/[^\p{L}\p{N}\s#]/gu, '').trim();

  // 🛑 Anti-Loop Guard: Commands are short ("SIM", "SIM 37", "NAO"). Long messages (like receipts) are NEVER commands!
  if (cleanedText.length > 25) {
    return null;
  }

  let isApproval = false;
  let isRejection = false;
  let isReschedule = false;
  let appointmentId = null;

  const matchApproval = cleanedText.match(/^(?:SIM|S|APROVAR|OK|1)\b(?:\s*#?(\d+))?$/i);
  const matchRejection = cleanedText.match(/^(?:NAO|NÃO|N|RECUSAR|CANCELAR|2)\b(?:\s*#?(\d+))?$/i);
  const matchReschedule = cleanedText.match(/^(?:REMARCAR|REAGENDAR|REMARCA|3)\b(?:\s*#?(\d+))?$/i);

  if (matchApproval) {
    isApproval = true;
    if (matchApproval[1]) appointmentId = parseInt(matchApproval[1], 10);
  } else if (matchRejection) {
    isRejection = true;
    if (matchRejection[1]) appointmentId = parseInt(matchRejection[1], 10);
  } else if (matchReschedule) {
    isReschedule = true;
    if (matchReschedule[1]) appointmentId = parseInt(matchReschedule[1], 10);
  }

  if (!isApproval && !isRejection && !isReschedule) {
    return null; // Not an approval/rejection/reschedule command
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
  let db = null;
  try {
    db = getAgendaeDbPool();
  } catch {
    db = getDbPool();
  }

  const agendaeDb = await resolveAgendaeDatabase(db);
  const p = agendaeDb ? `\`${agendaeDb}\`.` : '';

  console.log(`[Interactive Approval] Intent: ${isApproval ? 'APPROVE' : 'REJECT'} from ${cleanPhone} ("${rawMessage}") | Target ID: ${appointmentId || 'Auto'} | Prefix: "${p}"`);

  try {
    let appointment = null;

    // 1. If explicit appointment ID provided or extracted from quote
    if (appointmentId) {
      const [rows] = await db.query(
        `SELECT a.*, s.name as service_name, u.name as company_name
         FROM ${p}appointments a
         LEFT JOIN ${p}services s ON s.id = a.service_id
         LEFT JOIN ${p}users u ON u.id = a.user_id
         WHERE a.id = ?`,
        [appointmentId]
      );
      if (rows && rows.length > 0) appointment = rows[0];
    }

    // 2. Search by recent notification sent to this phone
    if (!appointment) {
      const last8 = cleanPhone.slice(-8);
      const [queueRows] = await db.query(
        `SELECT appointment_id FROM ${p}whatsapp_notification_queue
         WHERE (recipient_phone LIKE ? OR recipient_phone LIKE ?)
           AND appointment_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [`%${cleanPhone}%`, `%${last8}%`]
      );

      if (queueRows && queueRows.length > 0 && queueRows[0].appointment_id) {
        const [candRows] = await db.query(
          `SELECT a.*, s.name as service_name, u.name as company_name
           FROM ${p}appointments a
           LEFT JOIN ${p}services s ON s.id = a.service_id
           LEFT JOIN ${p}users u ON u.id = a.user_id
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
         FROM ${p}appointments a
         LEFT JOIN ${p}services s ON s.id = a.service_id
         LEFT JOIN ${p}users u ON u.id = a.user_id
         LEFT JOIN ${p}team_members tm ON tm.id = a.team_member_id
         WHERE a.status = 'pending'
           AND (u.phone LIKE ? OR u.phone LIKE ? OR tm.phone LIKE ? OR tm.phone LIKE ?)
         ORDER BY a.id DESC LIMIT 1`,
        [`%${cleanPhone}%`, `%${last8}%`, `%${cleanPhone}%`, `%${last8}%`]
      );
      if (candRows && candRows.length > 0) appointment = candRows[0];
    }

    if (!appointment) {
      console.log(`[Interactive Approval] No specific pending appointment matches response from ${cleanPhone}. Doing nothing.`);
      return null;
    }

    // 🛑 Anti-Loop Guard: If already confirmed/cancelled, STOP immediately!
    if (appointment.status !== 'pending') {
      console.log(`[Interactive Approval] Appointment #${appointment.id} is already in status '${appointment.status}'. Halting duplicate execution.`);
      return { action: 'already_processed', appointmentId: appointment.id };
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
      await db.query(`UPDATE ${p}appointments SET status = 'confirmed' WHERE id = ?`, [appointment.id]);

      // 2. Insert flow log
      try {
        await db.query(
          `INSERT INTO ${p}appointment_flow_logs (user_id, appointment_id, event_type, level, channel, title, description, metadata, created_at)
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
            `INSERT INTO ${p}whatsapp_notification_queue (user_id, appointment_id, recipient_phone, recipient_name, message_type, message_body, status, scheduled_for, created_at, updated_at)
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
      await db.query(`UPDATE ${p}appointments SET status = 'cancelled' WHERE id = ?`, [appointment.id]);

      // Cancel pending reminders
      try {
        await db.query(
          `UPDATE ${p}whatsapp_notification_queue SET status = 'cancelled' WHERE appointment_id = ? AND message_type = 'reminder' AND status = 'pending'`,
          [appointment.id]
        );
      } catch {}

      // Insert flow log
      try {
        await db.query(
          `INSERT INTO ${p}appointment_flow_logs (user_id, appointment_id, event_type, level, channel, title, description, metadata, created_at)
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
            `INSERT INTO ${p}whatsapp_notification_queue (user_id, appointment_id, recipient_phone, recipient_name, message_type, message_body, status, scheduled_for, created_at, updated_at)
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

    // ==========================================
    // 🔄 RESCHEDULE ACTION (REMARCAR)
    // ==========================================
    if (isReschedule) {
      await db.query(
        `UPDATE ${p}appointments SET status = 'cancelled', notes = CONCAT(COALESCE(notes, ''), ' [Remarcação solicitada via WhatsApp]') WHERE id = ?`,
        [appointment.id]
      );

      // Cancel pending reminders
      try {
        await db.query(
          `UPDATE ${p}whatsapp_notification_queue SET status = 'cancelled' WHERE appointment_id = ? AND message_type = 'reminder' AND status = 'pending'`,
          [appointment.id]
        );
      } catch {}

      const publicBaseUrl = process.env.APP_PUBLIC_URL || 'https://agenda-app-d2lmgn-e3defc-209-126-81-68.sslip.io';
      const bookingUrl = appointment.subdomain ? `${publicBaseUrl}/${appointment.subdomain}` : publicBaseUrl;

      // Insert flow log
      try {
        await db.query(
          `INSERT INTO ${p}appointment_flow_logs (user_id, appointment_id, event_type, level, channel, title, description, metadata, created_at)
           VALUES (?, ?, 'status_changed', 'warning', 'whatsapp', 'Agendamento - Remarcação Solicitada via WhatsApp', ?, ?, NOW())`,
          [
            appointment.user_id,
            appointment.id,
            `O profissional respondeu 'REMARCAR' no WhatsApp. O cliente ${appointment.client_name} foi convidado a escolher um novo horário.`,
            JSON.stringify({ phone: cleanPhone, raw_message: rawMessage, new_status: 'cancelled', booking_url: bookingUrl }),
          ]
        );
      } catch {}

      // Enqueue Customer Reschedule Notification
      if (appointment.client_phone) {
        const customerMsg = `🔄 *Solicitação de Remarcação - ${companyName}*\n\n`
          + `Olá, ${appointment.client_name}! ✨\n\n`
          + `O estabelecimento informou que precisará remarcar o seu agendamento inicial:\n`
          + `📅 *Data anterior:* ${formattedDate} às ${formattedTime}\n`
          + `✂️ *Serviço:* ${serviceName}\n\n`
          + `👉 *Por favor, escolha um novo dia e horário de sua preferência no link abaixo:*\n`
          + `🔗 ${bookingUrl}\n\n`
          + `Agradecemos muito pela compreensão!`;
        
        try {
          await db.query(
            `INSERT INTO ${p}whatsapp_notification_queue (user_id, appointment_id, recipient_phone, recipient_name, message_type, message_body, status, scheduled_for, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'cancelled', ?, 'pending', NOW(), NOW(), NOW())`,
            [appointment.user_id, appointment.id, appointment.client_phone, appointment.client_name, customerMsg]
          );
        } catch {}
      }

      // Send Reschedule Receipt to the sender
      const receiptText = `🔄 *Solicitação de Remarcação Enviada!*\n\n`
        + `👤 *Cliente:* ${appointment.client_name}\n`
        + `📅 *Agendamento:* #${appointment.id}\n\n`
        + `📲 Enviamos uma mensagem no WhatsApp do cliente com o link da sua empresa para que ele escolha um novo horário:\n`
        + `🔗 ${bookingUrl}`;

      await sock.sendMessage(senderJid, { text: receiptText });
      console.log(`[Interactive Approval] Appointment #${appointment.id} RESCHEDULE requested! Receipt sent to ${senderJid}`);

      return { action: 'rescheduled', appointmentId: appointment.id, bookingUrl };
    }
  } catch (err) {
    console.warn('[Direct DB Notice] MySQL cross-db update delegated to Laravel Event Listener:', err.message);
  }

  return null;
}
