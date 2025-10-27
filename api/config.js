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
    const AIRTABLE_BASE_URL = process.env.AIRTABLE_BASE_URL || 'https://api.airtable.com/v0/appgOPuIvNQ1eMYQw/tbls64uNeAgvXrZge';

    if (!AIRTABLE_TOKEN) {
        return response.status(500).json({ error: 'Server configuration error' });
    }

    try {
        // GET: Return current config (for app to fetch)
        if (request.method === 'GET') {
            const configData = `${AIRTABLE_TOKEN}\n${AIRTABLE_BASE_URL}`;
            return response.status(200).send(configData);
        }

        // POST: Update config (god account only)
        if (request.method === 'POST') {
            const { username, password, newToken, newBaseUrl } = request.body;

            if (!username || !password || !newToken || !newBaseUrl) {
                return response.status(400).json({ error: 'Missing required fields' });
            }

            // Verify user is god account
            const findUserUrl = `${AIRTABLE_BASE_URL}?filterByFormula={Username}='${encodeURIComponent(username)}'`;
            const userRes = await fetch(findUserUrl, {
                headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` }
            });

            if (!userRes.ok) {
                return response.status(500).json({ error: 'Failed to verify credentials' });
            }

            const userData = await userRes.json();
            if (!userData.records || userData.records.length === 0) {
                return response.status(401).json({ error: 'Invalid credentials' });
            }

            const user = userData.records[0].fields;
            
            // Check password
            if (user.Password !== password) {
                return response.status(401).json({ error: 'Invalid credentials' });
            }

            // Check if user is god
            if (user.AccountType !== 'god') {
                return response.status(403).json({ error: 'Access denied. Only god accounts can update config.' });
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
