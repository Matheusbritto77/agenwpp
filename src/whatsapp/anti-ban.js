/**
 * Anti-Ban Protection Suite for Baileys Multi-Tenant WhatsApp Engine
 */

/**
 * Spintax Resolver: Converts "{Olá|Oi|E aí}, {nome}!" into randomized natural variations
 */
export function parseSpintax(text) {
  if (!text || typeof text !== 'string') return text;
  const regex = /\{([^{}]+)\}/g;
  let matches;
  while ((matches = regex.exec(text)) !== null) {
    const choices = matches[1].split('|');
    const randomChoice = choices[Math.floor(Math.random() * choices.length)];
    text = text.replace(matches[0], randomChoice);
    regex.lastIndex = 0;
  }
  return text;
}

/**
 * In-memory blacklist cache for numbers that do not have active WhatsApp accounts
 * Prevents spamming non-existent numbers which degrades chip reputation
 */
const invalidNumbers = new Set();

export function isKnownInvalidNumber(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  return invalidNumbers.has(clean);
}

export function markNumberAsInvalid(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (clean) {
    invalidNumbers.add(clean);
    console.warn(`[Anti-Ban] Phone number ${clean} marked as invalid in cache. Future attempts will be blocked.`);
  }
}

/**
 * Calculate humanized typing duration based on message length with random jitter
 */
export function calculateTypingDuration(text) {
  const length = (text || '').length;
  // Base typing speed ~25ms/char with minimum 1.2s and maximum 3.2s
  const base = Math.min(3200, Math.max(1200, length * 20));
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

/**
 * Random human pause between consecutive message processing (1.2s to 2.5s)
 */
export function getHumanDelayMs() {
  return Math.floor(1200 + Math.random() * 1300);
}

/**
 * Sleep helper
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
