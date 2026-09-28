const Redis = require('ioredis');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ quiet: true });

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 1,
  commandTimeout: 3000,
});
redis.on('error', () => console.error('Redis unavailable. Check REDIS_URL and the Redis server.'));
const keyPrefix = process.env.REDIS_KEY_PREFIX || 'gather:lock:';

// Only one request can hold a seat's lock. The lock expires after 10 seconds.
async function lockSeat(seatId) {
  const token = randomUUID();
  const result = await redis.set(keyPrefix + seatId, token, 'PX', 10000, 'NX');
  return result === 'OK' ? token : null;
}

// Check the token and delete together, so an old request cannot delete a newer lock.
async function unlockSeat(seatId, token) {
  await redis.eval(`
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `, 1, keyPrefix + seatId, token);
}

module.exports = { redis, lockSeat, unlockSeat };
