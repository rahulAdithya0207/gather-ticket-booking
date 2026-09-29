const { redis } = require('./redis');

// Each IP can burst up to 100 requests; one token refills every 600 ms.
const bucketCapacity = 100;
const refillPeriodMs = 60_000;
const rateLimitPrefix = (process.env.REDIS_KEY_PREFIX || 'gather:lock:') + 'token-bucket:';

async function rateLimiter(req, res, next) {
  res.set('Cache-Control', 'no-store');
  try {
    // Redis's clock and one atomic script keep concurrent requests in sync.
    const [allowed, retryAfterMs] = await redis.eval(`
      local capacity = tonumber(ARGV[1])
      local refillPeriod = tonumber(ARGV[2])
      local refillRate = capacity / refillPeriod
      local time = redis.call('TIME')
      local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
      local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
      local tokens = tonumber(bucket[1]) or capacity
      local updatedAt = tonumber(bucket[2]) or now
      now = math.max(now, updatedAt)
      tokens = math.min(capacity, tokens + (now - updatedAt) * refillRate)

      local allowed = 0
      local retryAfter = 0
      if tokens >= 1 then
        tokens = tokens - 1
        allowed = 1
      else
        retryAfter = math.ceil((1 - tokens) / refillRate)
      end

      redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
      redis.call('PEXPIRE', KEYS[1], refillPeriod)
      return { allowed, retryAfter }
    `, 1, rateLimitPrefix + req.ip, bucketCapacity, refillPeriodMs);
    if (!allowed) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  } catch (error) { next(error); }
}

module.exports = rateLimiter;
