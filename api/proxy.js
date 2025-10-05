// NineX - Secure Server-Side Proxy (v3 - Final)
export default async function handler(request, response) {
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
        const data = await airtableResponse.json();
        return response.status(airtableResponse.status).json(data);
    } catch (error) {
        return response.status(500).json({ error: { message: 'An unexpected internal server error occurred.' } });
    }
}
