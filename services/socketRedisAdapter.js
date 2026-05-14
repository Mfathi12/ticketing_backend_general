/**
 * Multi-instance Socket.IO (Vercel / horizontal scaling):
 * In-memory `io` on each instance does not share connected clients. REST handlers that call
 * `io.to('user:x').emit(...)` on instance B will not reach sockets attached to instance A unless
 * rooms are synchronized via an adapter.
 *
 * Set REDIS_URL to a TCP Redis URL (e.g. rediss://… from Redis Cloud, Railway Redis, ElastiCache).
 * HTTP-only / REST Upstash keys are not compatible with this adapter — you need the native Redis protocol URL.
 *
 * Optional: DISABLE_SOCKET_REDIS_ADAPTER=1 to skip (local tests only).
 */
async function attachRedisAdapterIfConfigured(io) {
    if (!io) return;
    const disabled = String(process.env.DISABLE_SOCKET_REDIS_ADAPTER || '').trim() === '1';
    const url = String(process.env.REDIS_URL || '').trim();
    if (disabled || !url) {
        if (process.env.VERCEL && !url && !disabled) {
            // eslint-disable-next-line no-console
            console.warn(
                '[Socket.IO] Vercel without REDIS_URL: each serverless instance keeps its own Socket.IO memory. ' +
                    'Chat HTTP routes may run on an instance with no connected sockets — peers will not see ' +
                    '`new_chat_message` until refresh. Set REDIS_URL for @socket.io/redis-adapter, or run a ' +
                    'long-lived API + socket on Railway/VPS and point the frontend VITE_SOCKET_URL there.'
            );
        }
        return;
    }

    let createClient;
    let createAdapter;
    try {
        ({ createClient } = require('redis'));
        ({ createAdapter } = require('@socket.io/redis-adapter'));
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
            '[Socket.IO] Redis adapter packages missing (npm install redis @socket.io/redis-adapter):',
            err.message
        );
        return;
    }

    const pubClient = createClient({ url });
    const subClient = pubClient.duplicate();

    const onErr = (label) => (err) => {
        // eslint-disable-next-line no-console
        console.error(`[Socket.IO] Redis ${label}:`, err?.message || err);
    };
    pubClient.on('error', onErr('pub'));
    subClient.on('error', onErr('sub'));

    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    // eslint-disable-next-line no-console
    console.log('[Socket.IO] Redis adapter connected — cross-instance chat delivery enabled');
}

module.exports = { attachRedisAdapterIfConfigured };
