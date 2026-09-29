const { redis } = require('./redis');

// Each IP gets 100 API requests per 60-second window.
const rateLimitMax = 100;
const rateLimitWindowMs = 60_000;
const rateLimitPrefix = (process.env.REDIS_KEY_PREFIX || 'gather:lock:') + 'rate-limit:';

async function rateLimiter(req, res, next) {
  res.set('Cache-Control', 'no-store');
  try {
    // Count and set the expiry together so simultaneous requests share one window.
    const [count, ttl] = await redis.eval(`
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
      end
      return { count, redis.call('PTTL', KEYS[1]) }
    `, 1, rateLimitPrefix + req.ip, rateLimitWindowMs);
    if (count > rateLimitMax) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(ttl / 1000))));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  } catch (error) { next(error); }
}

module.exports = rateLimiter;
