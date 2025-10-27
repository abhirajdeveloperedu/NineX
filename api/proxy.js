// NineX - Secure Server-Side Proxy (v3 - Final)
export default async function handler(request, response) {
    // Basic in-memory rate limiter per IP (token bucket: 5 req/sec, burst 10)
    const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket?.remoteAddress || 'unknown';
    if (!global.__ninexRate__) {
        global.__ninexRate__ = new Map();
    }
    const now = Date.now();
    const state = global.__ninexRate__.get(ip) || { tokens: 10, last: now };
    const refill = Math.floor((now - state.last) / 200); // 5 tokens/sec
    state.tokens = Math.min(10, state.tokens + refill);
    state.last = now;
    if (state.tokens <= 0) {
        response.setHeader('Retry-After', '1');
        return response.status(429).json({ error: { message: 'Too Many Requests. Please slow down.' } });
    }
    state.tokens -= 1;
    global.__ninexRate__.set(ip, state);

    const airtableUrl = request.headers['x-airtable-url'];
    if (!airtableUrl) {
        return response.status(400).json({ error: { message: "Configuration error: Airtable URL is missing." } });
    }
    const AIRTABLE_TOKEN = process.env.AIRTABLE_API_TOKEN;
    if (!AIRTABLE_TOKEN) {
        return response.status(500).json({ error: { message: "Security Alert: Server API Token is not configured." } });
    }
    try {
        const fetchOptions = {
            method: request.method,
            headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
        };
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
            fetchOptions.body = JSON.stringify(request.body);
        }
        const airtableResponse = await fetch(airtableUrl, fetchOptions);
        // Pass through relevant rate limit headers if Airtable sets them
        const passHeaders = ['date','etag','content-type','content-length','airtable-rate-limit-reset','airtable-rate-limit-remaining'];
        passHeaders.forEach(h => { const v = airtableResponse.headers.get(h); if (v) response.setHeader(h, v); });
        const status = airtableResponse.status;
        // Try JSON parse, fallback to text
        const text = await airtableResponse.text();
        let payload;
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
        return response.status(status).json(payload);
    } catch (error) {
        return response.status(500).json({ error: { message: 'An unexpected internal server error occurred.' } });
    }
}

