/**
 * Repeatable HTTP latency harness for key ticket/notification endpoints.
 *
 * Usage:
 *   BASE_URL=http://localhost:9091 \
 *   AUTH_TOKEN='Bearer <jwt>' \
 *   X_COMPANY_ID='<company ObjectId>' \
 *   node scripts/performance-benchmark.js
 *
 * Optional: ITERATIONS=50 CONCURRENCY=5
 */
require('dotenv').config();

const http = require('http');
const https = require('https');

const BASE_URL = process.env.BASE_URL || 'http://localhost:9091';
const AUTH = process.env.AUTH_TOKEN || '';
const COMPANY_ID = process.env.X_COMPANY_ID || '';
const ITERATIONS = Math.max(1, parseInt(process.env.ITERATIONS || '30', 10));
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '5', 10));

const endpoints = [
    { name: 'GET /api/tickets/my-tickets', path: '/api/tickets/my-tickets', method: 'GET' },
    { name: 'GET /api/tickets/my-active-tickets', path: '/api/tickets/my-active-tickets', method: 'GET' },
    { name: 'GET /api/notifications', path: '/api/notifications?page=1&limit=20', method: 'GET' },
    { name: 'GET /api/notifications/unread-count', path: '/api/notifications/unread-count', method: 'GET' }
];

const parseUrl = (base, path) => {
    const u = new URL(path, base);
    return u;
};

const requestOnce = (path, method = 'GET') =>
    new Promise((resolve, reject) => {
        const u = parseUrl(BASE_URL, path);
        const lib = u.protocol === 'https:' ? https : http;
        const start = process.hrtime.bigint();
        const req = lib.request(
            {
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method,
                headers: {
                    ...(AUTH ? { Authorization: AUTH.startsWith('Bearer ') ? AUTH : `Bearer ${AUTH}` } : {}),
                    ...(COMPANY_ID ? { 'x-company-id': COMPANY_ID } : {}),
                    Accept: 'application/json'
                }
            },
            (res) => {
                res.resume();
                const end = process.hrtime.bigint();
                const ms = Number(end - start) / 1e6;
                resolve({ status: res.statusCode, ms });
            }
        );
        req.on('error', reject);
        req.end();
    });

const percentile = (sorted, p) => {
    if (!sorted.length) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
};

const runForEndpoint = async (ep) => {
    const latencies = [];
    let i = 0;
    const worker = async () => {
        while (i < ITERATIONS) {
            const cur = i;
            i += 1;
            try {
                const r = await requestOnce(ep.path, ep.method);
                if (r.status >= 200 && r.status < 400) latencies.push(r.ms);
            } catch (e) {
                console.error(ep.name, e.message);
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    latencies.sort((a, b) => a - b);
    return {
        name: ep.name,
        ok: latencies.length,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95)
    };
};

(async () => {
    if (!AUTH || !COMPANY_ID) {
        console.error('Set AUTH_TOKEN (or Bearer ...) and X_COMPANY_ID to run against a real API.');
        console.error('Example: AUTH_TOKEN=eyJ... X_COMPANY_ID=64abc... node scripts/performance-benchmark.js');
        process.exit(1);
    }

    console.log(`BASE_URL=${BASE_URL} iterations=${ITERATIONS} concurrency=${CONCURRENCY}`);
    const rows = [];
    for (const ep of endpoints) {
        const row = await runForEndpoint(ep);
        rows.push(row);
        console.log(
            `${row.name} | ok=${row.ok}/${ITERATIONS} p50=${row.p50.toFixed(1)}ms p95=${row.p95.toFixed(1)}ms`
        );
    }

    console.log('\nJSON (paste into docs/PERFORMANCE_BENCHMARK.md):');
    console.log(JSON.stringify({ at: new Date().toISOString(), BASE_URL, ITERATIONS, CONCURRENCY, rows }, null, 2));
})();
