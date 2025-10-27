// NineX - Secure Config Management API (God Account Only)
export default async function handler(request, response) {
    // Enable CORS for app requests
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        return response.status(200).end();
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_API_TOKEN;
    const AIRTABLE_BASE_URL = process.env.AIRTABLE_BASE_URL || '';

    if (!AIRTABLE_TOKEN) {
        return response.status(500).json({ error: 'Server configuration error' });
    }

    try {
        // GET: Return current config (for app to fetch)
        if (request.method === 'GET') {
            const configData = `${AIRTABLE_TOKEN}\n${AIRTABLE_BASE_URL}`;
            return response.status(200).send(configData);
        }

        // POST: Validate proposed credentials and return instructions to update env vars in Vercel
        if (request.method === 'POST') {
            const { newToken, newBaseUrl } = request.body || {};
            if (!newToken || !newBaseUrl) {
                return response.status(400).json({ error: 'Missing required fields: newToken, newBaseUrl' });
            }

            // Validate new credentials by testing them
            try {
                const testUrl = `${newBaseUrl}?maxRecords=1`;
                const testRes = await fetch(testUrl, {
                    headers: { 'Authorization': `Bearer ${newToken}` }
                });

                if (!testRes.ok) {
                    return response.status(400).json({ error: 'Invalid Airtable credentials. Please verify token and base URL.' });
                }
            } catch (err) {
                return response.status(400).json({ error: 'Failed to validate new credentials: ' + err.message });
            }

            // Return success with instructions to update environment variables
            return response.status(200).json({
                success: true,
                message: 'Credentials validated successfully',
                instructions: 'Please update the following environment variables in Vercel:\n' +
                             `AIRTABLE_API_TOKEN=${newToken}\n` +
                             `AIRTABLE_BASE_URL=${newBaseUrl}\n\n` +
                             'After updating, redeploy the application.',
                newToken,
                newBaseUrl
            });
        }

        return response.status(405).json({ error: 'Method not allowed' });

    } catch (error) {
        console.error('Config API Error:', error);
        return response.status(500).json({ error: 'Internal server error: ' + error.message });
    }
}
