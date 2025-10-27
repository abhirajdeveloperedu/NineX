// NineX - Secure 2FA Login API (v1)
export default async function handler(request, response) {
    const AIRTABLE_TOKEN = process.env.AIRTABLE_API_TOKEN;
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const AIRTABLE_BASE_URL = process.env.AIRTABLE_BASE_URL || 'https://api.airtable.com/v0/appvf5cnySuHpWua4/tblCXb53fbuDTHt0E';

    if (!AIRTABLE_TOKEN || !TELEGRAM_BOT_TOKEN) {
        return response.status(500).json({ error: { message: "Server is not configured correctly." } });
    }

    const { username, password, otp } = request.body;

    // Helper functions
    async function sendTelegramMessage(chatId, text) {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }) });
    }

    async function updateAirtableRecord(recordId, fields) {
        const res = await fetch(`${AIRTABLE_BASE_URL}/${recordId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields }),
        });
        if (!res.ok) throw new Error('Failed to update user record in Airtable.');
    }

    try {
        // Find the user record first
        const findUserUrl = `${AIRTABLE_BASE_URL}?filterByFormula={Username}='${encodeURIComponent(username)}'`;
        const userRes = await fetch(findUserUrl, { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } });
        if (!userRes.ok) throw new Error('Could not connect to the user database.');
        
        const userData = await userRes.json();
        if (!userData.records || userData.records.length === 0) {
            return response.status(404).json({ error: { message: 'Invalid access key or username not found.' } });
        }
        
        const userRecord = userData.records[0];
        const user = userRecord.fields;
        const allowedToLogin = ['god', 'admin', 'seller', 'reseller'];
        if (!allowedToLogin.includes(user.AccountType)) {
            return response.status(403).json({ error: { message: 'Access Denied. Your account type cannot log in.' } });
        }

        // --- STEP 1: Handle Password Verification & Send OTP ---
        if (password) {
            if (user.Password !== password) {
                return response.status(401).json({ error: { message: 'Invalid password.' } });
            }
            if (!user.TelegramID) {
                return response.status(400).json({ error: { message: 'This account has no Telegram ID configured for 2FA login.' } });
            }

            const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
            const newOtpExpiry = Date.now() + 300000; // 5 minutes
            const loginTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });

            await updateAirtableRecord(userRecord.id, { Otp: newOtp, OtpExpiry: newOtpExpiry, OtpAttempts: 0 });
            
            const message = `Your login OTP is: *${newOtp}*\n\nLogin Time: ${loginTime}\nExpiration Time: +5 minutes\n\n_If you did not request this, please ignore this message._`;
            await sendTelegramMessage(user.TelegramID, message);
            
            return response.status(200).json({ success: true, message: 'An OTP has been sent to your Telegram.' });
        }

        // --- STEP 2: Handle OTP Verification & Login ---
        if (otp) {
            const { Otp: storedOtp, OtpExpiry, OtpAttempts } = user;
            if ((OtpAttempts || 0) >= 3) {
                await updateAirtableRecord(userRecord.id, { Otp: null, OtpExpiry: null, OtpAttempts: null });
                return response.status(400).json({ error: { message: 'Too many incorrect attempts. Please try logging in again.' } });
            }
            if (!storedOtp || !OtpExpiry || Date.now() > OtpExpiry) {
                return response.status(400).json({ error: { message: 'OTP is invalid or has expired.' } });
            }
            if (String(storedOtp) !== String(otp)) {
                await updateAirtableRecord(userRecord.id, { OtpAttempts: (OtpAttempts || 0) + 1 });
                return response.status(400).json({ error: { message: 'Incorrect OTP.' } });
            }

            // Success! Clear OTP and return user data to log in
            await updateAirtableRecord(userRecord.id, { Otp: null, OtpExpiry: null, OtpAttempts: null });
            return response.status(200).json({ success: true, user: { ...user, recordId: userRecord.id } });
        }

        return response.status(400).json({ error: { message: 'Invalid request.' } });

    } catch (error) {
        console.error("Login API Error:", error);
        return response.status(500).json({ error: { message: 'An internal server error occurred: ' + error.message } });
    }
}
