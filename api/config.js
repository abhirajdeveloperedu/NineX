// NineX - Secure Config Management API (God Account Only - v2 Dynamic URL)
export default async function handler(request, response) {
    // Enable CORS for app requests
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
        return response.status(200).end();
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_API_TOKEN;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID;

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_ID) {
        return response.status(500).json({ error: 'Server configuration error - missing environment variables' });
    }

    // Construct the base URL dynamically
    const AIRTABLE_BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;

    try {
        // GET: Return current config (for app to fetch)
        if (request.method === 'GET') {
            const configData = `${AIRTABLE_TOKEN}\n${AIRTABLE_BASE_URL}`;
            return response.status(200).send(configData);
        }

        // POST: Validate proposed credentials and return instructions to update env vars in Vercel
        if (request.method === 'POST') {
            const { newToken, newBaseId, newTableId } = request.body || {};
            if (!newToken || !newBaseId || !newTableId) {
                return response.status(400).json({ error: 'Missing required fields: newToken, newBaseId, newTableId' });
            }

            // Construct the full URL for validation
            const newBaseUrl = `https://api.airtable.com/v0/${newBaseId}/${newTableId}`;

            // Validate new credentials by testing them
            try {
                const testUrl = `${newBaseUrl}?maxRecords=1`;
                const testRes = await fetch(testUrl, {
                    headers: { 'Authorization': `Bearer ${newToken}` }
                });

                if (!testRes.ok) {
                    return response.status(400).json({ error: 'Invalid Airtable credentials. Please verify token, base ID, and table ID.' });
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
                             `AIRTABLE_BASE_ID=${newBaseId}\n` +
                             `AIRTABLE_TABLE_ID=${newTableId}\n\n` +
                             'After updating, redeploy the application.',
                newToken,
                newBaseId,
                newTableId,
                newBaseUrl
            });
        }

        return response.status(405).json({ error: 'Method not allowed' });

    } catch (error) {
        console.error('Config API Error:', error);
        return response.status(500).json({ error: 'Internal server error: ' + error.message });
    }
}
