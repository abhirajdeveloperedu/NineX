// NineX - Secure Configuration (v11 - Final with New Credits)
const PROXY_URL = '/api/proxy';
const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0/appvf5cnySuHpWua4/tblCXb53fbuDTHt0E';

const CONFIG = {
    API: { PROXY_URL, BASE_URL: AIRTABLE_BASE_URL },
    SECURITY: { SESSION_TIMEOUT: 3600000 },
    HIERARCHY: {
        PERMISSIONS: {
            god: ['create_all', 'create_admin', 'create_seller', 'create_reseller', 'create_user'],
            admin: ['create_seller', 'create_reseller', 'create_user'],
            seller: ['create_reseller', 'create_user'],
            reseller: ['create_user']
        }
    },
    CREDITS: {
        // UPDATED PRICING TO MATCH NEW REQUIREMENTS
        PRICING: {
            '240': 1,        // 10 days (single)
            '480': 2,        // 20 days (single)
            '720': 3,        // 30 days (single)
            // Admin/God only options (short durations + Never)
            '0.08333': 0.5,  // 5 minutes
            '1': 1,          // 1 hour
            '24': 2,         // 1 day
            '9999': 100
        },
        DEVICE_MULTIPLIER: {
            'single': 1,
            'double': 2,
            'unlimited': 4 
        }
    }
};

function validateSession() {
    const session = localStorage.getItem('ninex_session');
    if (!session) return null;
    try {
        const data = JSON.parse(atob(session));
        if (Date.now() - data.timestamp > CONFIG.SECURITY.SESSION_TIMEOUT) {
            localStorage.removeItem('ninex_session'); return null;
        }
        return data;
    } catch (e) { localStorage.removeItem('ninex_session'); return null; }
}

function createSession(userData) {
    localStorage.setItem('ninex_session', btoa(JSON.stringify({ user: userData, timestamp: Date.now() })));
}
