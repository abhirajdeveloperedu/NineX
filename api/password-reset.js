// NineX - Secure Password Reset API (v9 - Hardened Airtable Logic)
export default async function handler(request, response) {
    const AIRTABLE_TOKEN = process.env.AIRTABLE_API_TOKEN;
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

    if (!AIRTABLE_TOKEN) {
        return response.status(500).json({ error: { message: "Configuration Error: Airtable API Token is not set on the server." } });
    }
    if (!TELEGRAM_BOT_TOKEN) {
        return response.status(500).json({ error: { message: "Configuration Error: Telegram Bot Token is not set on the server." } });
    }

    const { username, telegramId, otp, newPassword } = request.body;
    const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0/appgOPuIvNQ1eMYQw/tbls64uNeAgvXrZge';

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
        if (!res.ok) {
            const errorData = await res.json();
            throw new Error(`Failed to update Airtable. Reason: ${errorData.error?.message || res.statusText}. Please ensure Otp, OtpExpiry, OtpLastRequest, and OtpAttempts fields exist in your table.`);
        }
    }

    try {
        const findUserUrl = `${AIRTABLE_BASE_URL}?filterByFormula={Username}='${encodeURIComponent(username)}'`;
        const userRes = await fetch(findUserUrl, { headers: { 'Authorization': `Bearer ${AIRTABLE_TOKEN}` } });

        if (!userRes.ok) {
            const errorData = await userRes.json();
            throw new Error(`Could not connect to database. Airtable says: ${errorData.error?.message || 'Unknown Error'}`);
        }
        
        const userData = await userRes.json();
        if (!userData.records || userData.records.length === 0) return response.status(404).json({ error: 'User not found.' });
        
        const userRecord = userData.records[0];
        const { TelegramID, AccountType, Otp: storedOtp, OtpExpiry, OtpAttempts } = userRecord.fields;

        if (AccountType === 'user') return response.status(403).json({ error: 'Password reset is not available for this account type.' });
        if (!TelegramID) return response.status(400).json({ error: 'This user has no Telegram ID configured for password reset.' });
        
        if (otp && newPassword) { // Step 2: Verify OTP and reset password
            if ((OtpAttempts || 0) >= 3) {
                await updateAirtableRecord(userRecord.id, { Otp: null, OtpExpiry: null, OtpAttempts: null });
                return response.status(400).json({ error: 'Too many incorrect attempts. OTP has been invalidated.' });
            }
            if (!storedOtp || !OtpExpiry || Date.now() > OtpExpiry) return response.status(400).json({ error: 'OTP is invalid or has expired.' });
            
            if (String(storedOtp) !== String(otp)) {
                await updateAirtableRecord(userRecord.id, { OtpAttempts: (OtpAttempts || 0) + 1 });
                return response.status(400).json({ error: 'Incorrect OTP.' });
            }

            await updateAirtableRecord(userRecord.id, { Password: newPassword, Otp: null, OtpExpiry: null, OtpLastRequest: null, OtpAttempts: null });
            await sendTelegramMessage(TelegramID, `✅ Your password for user *'${username}'* has been reset successfully.`);
            return response.status(200).json({ message: 'Password has been reset successfully.' });
        } else if (telegramId) { // Step 1: Send OTP
            if (String(TelegramID) !== String(telegramId)) return response.status(401).json({ error: 'Incorrect Telegram ID for this user.' });
            
            const { OtpLastRequest } = userRecord.fields;
            if (OtpLastRequest && (Date.now() - new Date(OtpLastRequest).getTime()) < 60000) {
                return response.status(429).json({ error: 'Please wait 60 seconds before requesting another OTP.' });
            }
            
            const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
            const newOtpExpiry = Date.now() + 300000;
            const loginTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });

            await updateAirtableRecord(userRecord.id, { Otp: newOtp, OtpExpiry: newOtpExpiry, OtpLastRequest: new Date().toISOString(), OtpAttempts: 0 });
            
            const message = `Your login OTP is: *${newOtp}*\n\nLogin Time: ${loginTime}\nExpiration Time: +5 minutes\n\n_If you did not request this, please ignore this message._`;
            await sendTelegramMessage(TelegramID, message);
            return response.status(200).json({ message: 'An OTP has been sent to your registered Telegram account.' });
        } else {
             return response.status(400).json({ error: 'Invalid request.' });
        }
    } catch (error) {
        console.error("Password Reset Error:", error);
        return response.status(500).json({ error: { message: 'An internal server error occurred: ' + error.message } });
    }
}
