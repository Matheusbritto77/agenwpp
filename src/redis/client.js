import Redis from 'ioredis';

let redisClient = null;
let redisPublisher = null;

const DEFAULT_REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis(DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });

    redisClient.on('error', (err) => {
      console.error('[Redis Error]', err.message);
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected successfully');
    });
  }
  return redisClient;
}

export function getRedisPublisher() {
  if (!redisPublisher) {
    redisPublisher = new Redis(DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
  }
  return redisPublisher;
}

export async function publishEvent(channel, eventData) {
  try {
    const pub = getRedisPublisher();
    const payload = JSON.stringify(eventData);
    await pub.publish(channel, payload);
  } catch (err) {
    console.error('[Redis Publish Error]', err.message);
  }
}

export async function setRedisKey(key, value, ttlSeconds = 10) {
  try {
    const client = getRedisClient();
    const payload = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (ttlSeconds > 0) {
      await client.set(key, payload, 'EX', ttlSeconds);
    } else {
      await client.set(key, payload);
    }
  } catch (err) {
    // ignore redis error
  }
}

export async function deleteRedisKey(key) {
  try {
    const client = getRedisClient();
    await client.del(key);
  } catch (err) {
    // ignore
  }
}
