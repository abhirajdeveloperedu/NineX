// NineX - Secure Application Logic (v16 - Auto-Delete Expired Users)
class NineXAdminPanel {
    constructor() {
        this.currentUser = null;
        this.allUsers = [];
        this.filteredUsers = [];
        this.config = CONFIG;
        this.loginUsername = null; 
        this.resetUsername = null; 
        this.allowedCreators = null; // hierarchy-based list of creator usernames current user can view; null => unrestricted (god)
        
        // --- NEW ---
        this.maintenanceState = null; // null = unknown, 'v3' = online, 'Maintenance' = offline
        // --- END NEW ---

        // Pagination, search, sort state
        this.currentPage = 1;
        this.rowsPerPage = 50;
        this.searchQuery = '';
        this.sortOption = 'expiry_desc'; // **** THIS IS THE UPDATED LINE ****
        // Server-side paging helpers
        this.pageOffsets = []; // page index -> offset token for that page
        this.totalCount = 0; // total count for current filter
        this.currentPageRecords = []; // records of current page
        this.currentFilterKey = '';
        
        // Payment management filters
        this.paymentFilter = 'all'; // 'all', 'paid', 'unpaid'
        this.init();
    }
    async extendAllUsers() {
        // Only admin or god may perform this action
        if (!(this.currentUser?.AccountType === 'god' || this.currentUser?.AccountType === 'admin')) {
            this.showNotification('You do not have permission to perform this action.', 'error');
            return;
        }
        const daysStr = prompt('Enter number of days to extend for all users:');
        if (!daysStr) return;
        const days = parseFloat(daysStr);
        if (!isFinite(days) || days <= 0) {
            this.showNotification('Please enter a valid positive number of days.', 'error');
            return;
        }
        const extendSeconds = Math.round(days * 86400);

        if (!confirm(`Extend all accessible users by ${days} day(s)?`)) return;

        try {
            const base = this.config.API.BASE_URL;
            const params = new URLSearchParams();
            params.set('pageSize', '100');
            // Build access filter and restrict to AccountType='user'
            const accessOnly = this.buildFilterFormula(false);
            let filter = `{AccountType}='user'`;
            if (accessOnly) filter = `AND(${accessOnly},${filter})`;
            params.set('filterByFormula', filter);
            // Minimal fields needed
            params.append('fields[]', 'Username');
            params.append('fields[]', 'Expiry');
            params.append('fields[]', 'AccountType');
            let url = `${base}?${params.toString()}`;

            const toUpdate = [];
            let guard = 0;
            const nowSec = Math.floor(Date.now() / 1000);
            while (true) {
                const data = await this.secureFetch(url);
                const recs = data.records || [];
                for (const r of recs) {
                    const f = r.fields || {};
                    if (String(f.AccountType) !== 'user') continue;
                    const cur = parseInt(f.Expiry, 10);
                    if (isNaN(cur)) continue; // skip invalid
                    const baseTime = Math.max(cur, nowSec);
                    const newExpiry = String(baseTime + extendSeconds);
                    toUpdate.push({ id: r.id, fields: { Expiry: newExpiry } });
                }
                if (data.offset && guard < 200) {
                    const u = new URL(url);
                    u.searchParams.set('offset', data.offset);
                    url = u.toString();
                    guard++;
                } else { break; }
            }

            if (toUpdate.length === 0) {
                this.showNotification('No user records found to extend.', 'success');
                return;
            }

            // Batch PATCH
            const chunkSize = 10;
            let processed = 0;
            for (let i = 0; i < toUpdate.length; i += chunkSize) {
                const batch = toUpdate.slice(i, i + chunkSize);
                await this.secureFetch(base, { method: 'PATCH', body: { records: batch } });
                processed += batch.length;
            }
            this.showNotification(`Extended ${processed} user(s) by ${days} day(s).`, 'success');
            await this.loadUsers();
        } catch (error) {
            this.showNotification('Failed to extend users: ' + error.message, 'error');
        }
    }

    async init() {
        // Load BASE_URL from server env via /api/config before any calls
        if (window.loadRuntimeConfig) {
            await window.loadRuntimeConfig();
        }
        this.setupEventListeners();
        this.checkExistingSession();
    }

    async secureFetch(url, options = {}) {
        const fetchOptions = {
            method: options.method || 'GET',
            headers: { 'Content-Type': 'application/json' },
        };
        if (!url.startsWith('/api/')) {
            fetchOptions.headers['x-airtable-url'] = url;
            url = this.config.API.BASE_URL ? this.config.API.PROXY_URL : url; // if BASE_URL not loaded yet, allow direct (will fail gracefully)
        }
        if (options.body) { fetchOptions.body = JSON.stringify(options.body); }

        let attempts = 0;
        while (true) {
            attempts++;
            try {
                const response = await fetch(url, fetchOptions);
                if (response.status === 429 && attempts < 4) {
                    // Backoff based on Retry-After or fixed 1000ms
                    const ra = parseFloat(response.headers.get('Retry-After'));
                    const delayMs = isFinite(ra) ? Math.max(1000, ra * 1000) : 1000 * attempts;
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                const data = await response.json().catch(() => ({ error: { message: `Server returned status ${response.status}. Could not parse response.` } }));
                if (!response.ok) {
                    throw new Error(data.error?.message || `An unknown server error occurred. (Status: ${response.status})`);
                }
                return data;
            } catch (error) {
                if (attempts >= 4) {
                    console.error('SecureFetch Error:', error);
                    throw error;
                }
                await new Promise(r => setTimeout(r, 500 * attempts));
            }
        }
    }

    setupEventListeners() {
        document.getElementById('loginForm')?.addEventListener('submit', (e) => this.handlePasswordSubmit(e));
        document.getElementById('otpForm')?.addEventListener('submit', (e) => this.handleOtpSubmit(e));
        document.getElementById('createUserForm')?.addEventListener('submit', (e) => this.handleCreateUser(e));
        document.getElementById('accountType')?.addEventListener('change', () => { this.updateFormVisibility(); this.updateCreateButtonText(); });
        ['expiryPeriod', 'deviceType', 'creditsToGive'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', () => this.updateCreateButtonText());
        });
        document.getElementById('forgotPasswordLink')?.addEventListener('click', (e) => { e.preventDefault(); this.openResetModal(); });
        document.getElementById('closeModalBtn')?.addEventListener('click', () => this.closeResetModal());
        document.getElementById('resetPasswordModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) this.closeResetModal(); });
        document.getElementById('requestOtpForm')?.addEventListener('submit', (e) => this.handleRequestOtp(e));
        document.getElementById('verifyOtpForm')?.addEventListener('submit', (e) => this.handleResetPassword(e));

        // New table controls
        document.getElementById('searchInput')?.addEventListener('input', (e) => {
            // Update local state only; do not fetch on every keystroke to save API calls
            this.searchQuery = (e.target.value || '').toLowerCase();
        });
        document.getElementById('searchInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.resetPagingAndReload();
            }
        });
        document.getElementById('searchBtn')?.addEventListener('click', () => {
            const input = document.getElementById('searchInput');
            this.searchQuery = (input?.value || '').toLowerCase();
            this.resetPagingAndReload();
        });
        document.getElementById('sortSelect')?.addEventListener('change', (e) => {
            this.sortOption = e.target.value || 'latest';
            this.resetPagingAndReload();
        });
        const rowsSelect = document.getElementById('rowsPerPageSelect');
        if (rowsSelect) {
            this.rowsPerPage = parseInt(rowsSelect.value, 10) || 50;
            rowsSelect.addEventListener('change', (e) => {
                this.rowsPerPage = parseInt(e.target.value, 10) || 50;
                this.resetPagingAndReload();
            });
        }
        document.getElementById('prevPageBtn')?.addEventListener('click', () => this.goToPrevPage());
        document.getElementById('nextPageBtn')?.addEventListener('click', () => this.goToNextPage());
        // Admin/God: Reset All Keys button
        document.getElementById('resetAllKeysBtn')?.addEventListener('click', () => this.resetAllKeys());
        // Admin/God: Extend All Users button
        document.getElementById('extendAllUsersBtn')?.addEventListener('click', () => this.extendAllUsers());
        
        // --- NEW ---
        // Admin/God: Maintenance Mode button
        document.getElementById('maintenanceToggleBtn')?.addEventListener('click', () => this.toggleMaintenanceMode());
        // --- END NEW ---
        
        // Payment management buttons
        document.getElementById('approveAllPaymentsBtn')?.addEventListener('click', () => this.approveAllUnpaidAdmins());
        document.getElementById('filterAllBtn')?.addEventListener('click', () => this.setPaymentFilter('all'));
        document.getElementById('filterPaidBtn')?.addEventListener('click', () => this.setPaymentFilter('paid'));
        document.getElementById('filterUnpaidBtn')?.addEventListener('click', () => this.setPaymentFilter('unpaid'));
    }

    async handlePasswordSubmit(e) { /* ... UNCHANGED ... */ 
        e.preventDefault();
        this.showError('');
        const form = e.target;
        const btn = form.querySelector('button');
        const username = form.loginUsername.value.trim();
        const password = form.loginPassword.value;
        if (!username || !password) return this.showError('Please enter both username and password.');

        this.loginUsername = username;
        btn.disabled = true; btn.querySelector('span').textContent = 'Sending OTP...';

        try {
            await this.secureFetch('/api/login', {
                method: 'POST',
                body: { username, password }
            });
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('otpForm').style.display = 'block';
            this.showNotification('An OTP has been sent to your Telegram', 'success');
        } catch (error) {
            this.showError(error.message);
        } finally {
            btn.disabled = false; btn.querySelector('span').textContent = 'Continue';
        }
    }
    async handleOtpSubmit(e) { /* ... UPDATED ... */ 
        e.preventDefault();
        this.showError('');
        const form = e.target;
        const btn = form.querySelector('button');
        const otp = form.loginOtp.value.trim();
        if (!otp) return this.showError('Please enter the OTP from Telegram.');

        btn.disabled = true; btn.querySelector('span').textContent = 'Verifying...';

        try {
            const { success, user } = await this.secureFetch('/api/login', {
                method: 'POST',
                body: { username: this.loginUsername, otp }
            });

            if (success && user) {
                this.currentUser = user;
                createSession(this.currentUser);
                document.getElementById('loginSection').style.display = 'none';
                document.getElementById('dashboardSection').style.display = 'block';
                await this.setupPermissions();
                await this.computeAllowedCreators();
                await this.loadUsers();
                await this.checkMaintenanceState(); // --- NEW ---
                this.showNotification('Login successful!', 'success');
            } else {
                 this.showError('Login failed. Please try again.');
            }
        } catch (error) {
            this.showError(error.message);
        } finally {
            btn.disabled = false; btn.querySelector('span').textContent = 'Enter NineX Panel';
        }
    }

    openResetModal() { /* ... UNCHANGED ... */ 
        document.getElementById('resetPasswordModal').style.display = 'flex';
        document.getElementById('resetStep1').style.display = 'block';
        document.getElementById('resetStep2').style.display = 'none';
        document.getElementById('requestOtpForm').reset();
        document.getElementById('verifyOtpForm').reset();
        this.showResetError('');
    }
    closeResetModal() { /* ... UNCHANGED ... */ 
        document.getElementById('resetPasswordModal').style.display = 'none';
    }
    showResetError(message) { /* ... UNCHANGED ... */ 
        const el = document.getElementById('resetError');
        el.textContent = message;
        el.style.display = message ? 'block' : 'none';
    }
    async handleRequestOtp(e) { /* ... UNCHANGED ... */ 
        e.preventDefault();
        this.showResetError('');
        const form = e.target;
        const btn = form.querySelector('button');
        const username = form.resetUsername.value.trim();
        const telegramId = form.telegramId.value.trim();
        if (!username || !telegramId) return this.showResetError('Username and Telegram ID are required.');
        
        this.resetUsername = username;
        btn.disabled = true; btn.querySelector('span').textContent = 'Sending...';

        try {
            const data = await this.secureFetch('/api/password-reset', { method: 'POST', body: { username, telegramId } });
            this.showNotification(data.message, 'success');
            document.getElementById('resetStep1').style.display = 'none';
            document.getElementById('resetStep2').style.display = 'block';
        } catch (error) {
            this.showResetError(error.message);
        } finally {
            btn.disabled = false; btn.querySelector('span').textContent = 'Send OTP';
        }
    }
    async handleResetPassword(e) { /* ... UNCHANGED ... */ 
        e.preventDefault();
        this.showResetError('');
        const form = e.target;
        const btn = form.querySelector('button');
        const otp = form.otp.value.trim();
        const newPassword = form.newPasswordReset.value;
        if (!otp || !newPassword) return this.showError('OTP and new password are required.');
        
        btn.disabled = true; btn.querySelector('span').textContent = 'Resetting...';

        try {
            const data = await this.secureFetch('/api/password-reset', { method: 'POST', body: { username: this.resetUsername, otp, newPassword } });
            this.showNotification(data.message, 'success');
            this.closeResetModal();
        } catch (error) {
            this.showResetError(error.message);
        } finally {
            btn.disabled = false; btn.querySelector('span').textContent = 'Reset Password';
        }
    }
    
    checkExistingSession() { /* ... UPDATED ... */ 
        const session = validateSession();
        if (session) {
            this.currentUser = session.user;
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('dashboardSection').style.display = 'block';
            this.setupPermissions();
            // Chain the async functions properly
            this.computeAllowedCreators()
                .then(() => this.loadUsers())
                .then(() => this.checkMaintenanceState()); // --- UPDATED ---
        }
    }
    async setupPermissions() { /* ... UPDATED BUSINESS RULES ... */ 
        const { AccountType, Username, Credits } = this.currentUser;
        const perms = this.config.HIERARCHY.PERMISSIONS[AccountType] || [];
        document.getElementById('userTypeBadge').textContent = AccountType.toUpperCase();
        document.getElementById('welcomeUser').textContent = `Welcome, ${Username}`;
        const creditsBadge = document.getElementById('creditsBadge');
        const amountOwedBadge = document.getElementById('amountOwedBadge');
        
        // Show appropriate badge based on account type
        if (AccountType === 'god') {
            creditsBadge.style.display = 'none';
            amountOwedBadge.style.display = 'none';
        } else if (AccountType === 'admin') {
            creditsBadge.style.display = 'none';
            amountOwedBadge.style.display = 'block';
            const amountOwed = this.currentUser.AmountOwed || 0;
            document.getElementById('userAmountOwed').textContent = `₹${amountOwed}`;
        } else {
            // Seller/Reseller
            creditsBadge.style.display = 'block';
            amountOwedBadge.style.display = 'none';
            document.getElementById('userCredits').textContent = Credits;
        }
        // Toggle Reset All Keys button visibility based on role
        const resetBtn = document.getElementById('resetAllKeysBtn');
        if (resetBtn) {
            resetBtn.style.display = (AccountType === 'god' || AccountType === 'admin') ? 'inline-flex' : 'none';
        }
        // Toggle Extend All Users button visibility based on role
        const extendBtn = document.getElementById('extendAllUsersBtn');
        if (extendBtn) {
            extendBtn.style.display = (AccountType === 'god' || AccountType === 'admin') ? 'inline-flex' : 'none';
        }

        // --- NEW ---
        // Toggle Maintenance Mode button visibility based on role
        const maintenanceBtn = document.getElementById('maintenanceToggleBtn');
        if (maintenanceBtn) {
            maintenanceBtn.style.display = (AccountType === 'god' || AccountType === 'admin') ? 'inline-flex' : 'none';
        }
        
        // Toggle Payment Management buttons visibility (god only)
        const approvePaymentsBtn = document.getElementById('approveAllPaymentsBtn');
        if (approvePaymentsBtn) {
            approvePaymentsBtn.style.display = (AccountType === 'god') ? 'inline-flex' : 'none';
        }
        
        const paymentFilterGroup = document.getElementById('paymentFilterGroup');
        if (paymentFilterGroup) {
            paymentFilterGroup.style.display = (AccountType === 'god') ? 'flex' : 'none';
        }
        
        // Show payment statistics for God only
        const paymentStatsGrid = document.getElementById('paymentStatsGrid');
        if (paymentStatsGrid) {
            paymentStatsGrid.style.display = (AccountType === 'god') ? 'grid' : 'none';
        }
        // --- END NEW ---

        const expiryEl = document.getElementById('expiryPeriod');
        if (AccountType === 'god') {
            // God: full set including short durations and Never
            expiryEl.innerHTML = `
                <option value="0.08333">5 Minutes</option>
                <option value="1">1 Hour</option>
                <option value="24">1 Day</option>
                <option value="240" selected>10 Days</option>
                <option value="480">20 Days</option>
                <option value="720">30 Days</option>
                <option value="9999">Never</option>`;
        } else if (AccountType === 'admin') {
            // Admin: standard choices only (no short durations or Never)
            expiryEl.innerHTML = `
                <option value="240" selected>10 Days</option>
                <option value="480">20 Days</option>
                <option value="720">30 Days</option>`;
        } else {
            // Seller/Reseller creating users: standard choices
            expiryEl.innerHTML = `
                <option value="240" selected>10 Days</option>
                <option value="480">20 Days</option>
                <option value="720">30 Days</option>`;
        }
        // Device options: Admin should also have 'unlimited'
        if (AccountType === 'god' || AccountType === 'admin') {
            document.getElementById('deviceType').innerHTML = `<option value="single">Single</option><option value="double">Double</option><option value="unlimited">Unlimited</option>`;
        } else {
            document.getElementById('deviceType').innerHTML = `<option value="single">Single</option><option value="double">Double</option>`;
        }
        let options = '<option value="user">User</option>';
        if (perms.includes('create_reseller')) options += '<option value="reseller">Reseller</option>';
        if (perms.includes('create_seller')) options += '<option value="seller">Seller</option>';
        if (perms.includes('create_all')) options += '<option value="admin">Admin</option>';
        document.getElementById('accountType').innerHTML = options;
        this.updateFormVisibility();
        this.updateCreateButtonText();
    }

    async computeAllowedCreators() {
        // Determine which CreatedBy values are visible based on hierarchy
        const { AccountType, Username } = this.currentUser;
        if (AccountType === 'god') { this.allowedCreators = null; return; }
        const creators = new Set([Username]);
        const base = this.config.API.BASE_URL;
        const params = new URLSearchParams();
        params.set('pageSize', '100');
        params.append('fields[]', 'Username');
        params.append('fields[]', 'AccountType');
        params.append('fields[]', 'CreatedBy');
        // Determine which subordinate types to include
        let subordinateFilter = '';
        if (AccountType === 'admin') {
            subordinateFilter = "OR({AccountType}='seller',{AccountType}='reseller')";
        } else if (AccountType === 'seller') {
            subordinateFilter = "{AccountType}='reseller'";
        } else {
            this.allowedCreators = Array.from(creators);
            return;
        }
        // Fetch subordinate accounts created by current user
        const filter = `AND(${subordinateFilter},{CreatedBy}='${this.escapeFormulaString(Username)}')`;
        params.set('filterByFormula', filter);
        let url = `${base}?${params.toString()}`;
        let guard = 0;
        while (true) {
            const data = await this.secureFetch(url);
            const recs = data.records || [];
            for (const r of recs) { if (r.fields?.Username) creators.add(String(r.fields.Username)); }
            if (data.offset && guard < 50) {
                const u = new URL(url);
                u.searchParams.set('offset', data.offset);
                url = u.toString();
                guard++;
            } else { break; }
        }
        this.allowedCreators = Array.from(creators);
    }

    updateFormVisibility() { /* ... UNCHANGED ... */
        const accountType = document.getElementById('accountType').value;
        const isPrivileged = ['admin', 'seller', 'reseller'].includes(accountType);
        const needsTelegramId = ['seller', 'reseller'].includes(accountType);

        document.getElementById('creditsGroup').style.display = isPrivileged ? 'block' : 'none';
        document.getElementById('telegramIdGroup').style.display = needsTelegramId ? 'block' : 'none';
        
        document.getElementById('expiryPeriod').parentElement.style.display = isPrivileged ? 'none' : 'block';
        document.getElementById('deviceType').parentElement.style.display = isPrivileged ? 'none' : 'block';
    }

    updateCreateButtonText() { /* ... UPDATED FOR ADMIN COSTS + UNLIMITED FREE ... */ 
        const btnText = document.getElementById('createUserBtn').querySelector('span');
        const { AccountType } = this.currentUser;
        const selectedType = document.getElementById('accountType').value;
        // Admins are treated like god: no credit costs shown/deducted
        if (AccountType === 'god' || AccountType === 'admin') {
            btnText.textContent = `Create ${selectedType}`;
            return;
        }
        const isPrivileged = ['admin', 'seller', 'reseller'].includes(selectedType);
        let cost;
        if (isPrivileged) {
            cost = (parseInt(document.getElementById('creditsToGive').value, 10) || 0);
        } else {
            const period = document.getElementById('expiryPeriod').value;
            const device = document.getElementById('deviceType').value;
            const isAdminFree = (AccountType === 'admin') && (period === '0.08333' || period === '1');
            const isAdminUnlimitedFree = (AccountType === 'admin') && device === 'unlimited';
            cost = (isAdminFree || isAdminUnlimitedFree) ? 0 : this.calculateCreditCost();
        }
        btnText.textContent = `Create ${selectedType} (-${cost} Credits)`;
    }
    calculateCreditCost() { /* ... UNCHANGED ... */ 
        const { PRICING, DEVICE_MULTIPLIER } = this.config.CREDITS;
        const period = document.getElementById('expiryPeriod').value;
        const device = document.getElementById('deviceType').value;
        return (PRICING[period] || 0) * (DEVICE_MULTIPLIER[device] || 1);
    }
    
    async handleCreateUser(e) { /* ... UNCHANGED ... */
        e.preventDefault();
        const form = e.target;
        const btn = form.querySelector('button');
        
        const userData = {
            Username: form.newUsername.value.trim(),
            Password: form.newPassword.value,
            Expiry: form.expiryPeriod.value,
            Device: form.deviceType.value,
            AccountType: form.accountType.value,
            Credits: parseInt(form.creditsToGive.value) || 0,
            TelegramID: form.newTelegramId.value.trim(),
            // Set Airtable 'Version' to 'v3' for every new account
            Version: 'v3'
        };

        // Ensure normal users start with 0 credits regardless of the input's default
        if (userData.AccountType === 'user') {
            userData.Credits = 0;
        }

        if (!userData.Username || !userData.Password) {
            return this.showNotification('Username and password are required', 'error');
        }
        if (['seller', 'reseller'].includes(userData.AccountType) && !userData.TelegramID) {
            return this.showNotification('Telegram ID is required for Sellers and Resellers', 'error');
        }
        
        btn.disabled = true;
        try {
            await this.createUser(userData);
            form.reset(); this.updateFormVisibility(); this.updateCreateButtonText();
            await this.loadUsers();
            this.showNotification('User created successfully', 'success');
        } catch (error) { this.showNotification(`Failed to create user: ${error.message}`, 'error'); }
        finally { btn.disabled = false; }
    }

    async checkUsernameExists(username) {
        // Check if username already exists in the database
        const base = this.config.API.BASE_URL;
        const params = new URLSearchParams();
        params.set('pageSize', '1');
        // Search for exact username match (case-sensitive)
        const filter = `{Username}='${this.escapeFormulaString(username)}'`;
        params.set('filterByFormula', filter);
        params.append('fields[]', 'Username');
        
        const url = `${base}?${params.toString()}`;
        const data = await this.secureFetch(url);
        
        return (data.records && data.records.length > 0);
    }

    async createUser(userData) {
        // Check if username already exists
        const usernameExists = await this.checkUsernameExists(userData.Username);
        if (usernameExists) {
            throw new Error(`Username "${userData.Username}" already exists. Please choose a different username.`);
        }

        let cost = 0;
        const isPrivileged = ['admin', 'seller', 'reseller'].includes(userData.AccountType);
        // Treat admin like god: no credit deductions
        if (this.currentUser.AccountType !== 'god' && this.currentUser.AccountType !== 'admin') {
            if (isPrivileged) {
                cost = userData.Credits;
            } else {
                cost = this.calculateCreditCost();
            }
            if (this.currentUser.Credits < cost) throw new Error('Insufficient credits.');
        }
        
        // Calculate payment amount for admin tracking (if creator is admin)
        let paymentAmount = 0;
        if (this.currentUser.AccountType === 'admin' && !isPrivileged) {
            const period = userData.Expiry; // This is the period in hours before conversion
            const device = userData.Device;
            const { PAYMENT } = this.config;
            
            // Get base price from package
            const packagePrice = PAYMENT.PACKAGES[period]?.price || 0;
            const deviceMultiplier = this.config.CREDITS.DEVICE_MULTIPLIER[device] || 1;
            paymentAmount = packagePrice * deviceMultiplier;
        }
        
        // --- THIS IS THE CORRECTED LINE ---
        userData.Expiry = isPrivileged ? '9999' : String(Math.floor(Date.now() / 1000) + Math.floor(parseFloat(userData.Expiry) * 3600));
        userData.CreatedBy = this.currentUser.Username;
        userData.HWID = ''; userData.HWID2 = '';
        
        // --- NEW ---
        // Ensure new user's version matches the current server state
        userData.Version = this.maintenanceState || 'v3'; 
        // --- END NEW ---

        await this.secureFetch(this.config.API.BASE_URL, { method: 'POST', body: { records: [{ fields: userData }] } });
        
        // Update admin's AmountOwed if they created a user
        if (paymentAmount > 0 && this.currentUser.AccountType === 'admin') {
            const currentOwed = this.currentUser.AmountOwed || 0;
            const newOwed = currentOwed + paymentAmount;
            await this.secureFetch(this.config.API.BASE_URL, {
                method: 'PATCH',
                body: { records: [{ id: this.currentUser.recordId, fields: { AmountOwed: newOwed, PaymentStatus: 'Unpaid' } }] }
            });
            this.currentUser.AmountOwed = newOwed;
            // Update badge display
            const amountOwedEl = document.getElementById('userAmountOwed');
            if (amountOwedEl) {
                amountOwedEl.textContent = `₹${newOwed}`;
            }
        }
        
        if (cost > 0) {
            this.currentUser.Credits -= cost;
            await this.updateUserCredits(this.currentUser.recordId, this.currentUser.Credits);
            document.getElementById('userCredits').textContent = this.currentUser.Credits;
        }
    }

    // --- Fetch current page from Airtable using server-side pagination and filters ---
    async loadUsers() {
        document.getElementById('loadingUsers').style.display = 'block';
        document.getElementById('usersTableBody').innerHTML = '';
        try {
            // Ensure filter key is tracked; if changed externally, reset paging
            const newKey = this.makeFilterKey();
            if (newKey !== this.currentFilterKey) {
                this.pageOffsets = [];
                this.currentPage = 1;
                this.totalCount = 0;
                this.currentFilterKey = newKey;
            }

            await this.fetchPageRecords(this.currentPage);
            // Render page
            this.renderUsersTable(this.currentPageRecords);
            // Start async total count and stats update (not blocking)
            this.countTotalRecords().catch(() => {});
            this.updateStats().catch(() => {});
        } catch (error) {
            this.showNotification('Failed to load users: ' + error.message, 'error');
        } finally {
            document.getElementById('loadingUsers').style.display = 'none';
        }
    }

    // Build filterByFormula combining access control + optional search + payment filter
    buildFilterFormula(includeSearch = true) {
        const clauses = [];
        // Access filter based on allowed creators
        if (this.currentUser.AccountType !== 'god') {
            const creators = this.allowedCreators || [this.currentUser.Username];
            const orCreators = creators.map(c => `{CreatedBy}='${this.escapeFormulaString(c)}'`).join(',');
            clauses.push(`OR(${orCreators})`);
        }
        if (includeSearch && this.searchQuery) {
            const q = this.escapeFormulaString(this.searchQuery);
            clauses.push(`SEARCH('${q}', {Username})`);
        }
        // Payment filter (only for admins)
        if (this.paymentFilter === 'paid') {
            clauses.push(`AND({AccountType}='admin',{PaymentStatus}='Paid')`);
        } else if (this.paymentFilter === 'unpaid') {
            clauses.push(`AND({AccountType}='admin',OR({PaymentStatus}='Unpaid',{PaymentStatus}=''))`);
        }
        if (clauses.length === 0) return '';
        if (clauses.length === 1) return clauses[0];
        return `AND(${clauses.join(',')})`;
    }

    escapeFormulaString(str) {
        return String(str).replace(/'/g, "\\'");
    }

    makeFilterKey() {
        return [
            this.currentUser?.AccountType,
            this.currentUser?.Username,
            this.rowsPerPage,
            this.searchQuery,
            this.sortOption,
            this.paymentFilter
        ].join('|');
    }

    // **** THIS IS THE FUNCTION FROM THE PREVIOUS STEP ****
    async fetchPageRecords(pageNumber) {
        const base = this.config.API.BASE_URL;
        const params = new URLSearchParams();
        params.set('pageSize', String(Math.min(this.rowsPerPage, 100)));
        const filter = this.buildFilterFormula(true);
        if (filter) params.set('filterByFormula', filter);

        // --- UPDATED Server-Side Sort Logic ---
        // Set sort field and direction based on sortOption
        switch (this.sortOption) {
            case 'latest':
                params.set('sort[0][field]', 'createdTime');
                params.set('sort[0][direction]', 'desc');
                break;
            case 'oldest':
                params.set('sort[0][field]', 'createdTime');
                params.set('sort[0][direction]', 'asc');
                break;
            case 'az':
                params.set('sort[0][field]', 'Username');
                params.set('sort[0][direction]', 'asc');
                break;
            case 'za':
                params.set('sort[0][field]', 'Username');
                params.set('sort[0][direction]', 'desc');
                break;
            case 'expiry_desc': // New option
                params.set('sort[0][field]', 'Expiry');
                params.set('sort[0][direction]', 'desc');
                break;
            default:
                // Default to latest if option is unknown
                params.set('sort[0][field]', 'createdTime');
                params.set('sort[0][direction]', 'desc');
        }
        // --- END UPDATED Logic ---

        const offsetToken = this.pageOffsets[pageNumber] || undefined; // undefined for page 1
        if (offsetToken) params.set('offset', offsetToken);

        const url = `${base}?${params.toString()}`;
        const data = await this.secureFetch(url);
        this.currentPageRecords = Array.isArray(data.records) ? data.records.slice() : [];
        // Cache next page's offset token
        if (data.offset) {
            this.pageOffsets[pageNumber + 1] = data.offset;
        } else {
            this.pageOffsets[pageNumber + 1] = null;
        }

        // --- REMOVED OLD CLIENT-SIDE SORT ---
        // The client-side sort logic that was here has been removed,
        // as the server is now handling all sorting.
        
        // Update page info with a temporary total if we don't have real total yet
        this.updatePageInfoServer();
    }
    // **** END OF UPDATED FUNCTION ****

    resetPagingAndReload() {
        this.pageOffsets = [];
        this.currentPage = 1;
        this.totalCount = 0;
        this.currentFilterKey = this.makeFilterKey();
        this.loadUsers();
    }

    async goToPrevPage() {
        if (this.currentPage <= 1) return;
        this.currentPage -= 1;
        await this.fetchPageRecords(this.currentPage);
        this.renderUsersTable(this.currentPageRecords);
    }

    async goToNextPage() {
        // If next page offset is known null, we are at the last page
        const nextOffsetKnown = this.pageOffsets[this.currentPage + 1];
        if (typeof nextOffsetKnown === 'undefined' && this.currentPage > 1) {
            // Unknown state but should be rare; allow fetch to determine
        }
        if (nextOffsetKnown === null) return; // already at end
        this.currentPage += 1;
        await this.fetchPageRecords(this.currentPage);
        this.renderUsersTable(this.currentPageRecords);
    }

    // Count total records for current filter (including search). Light-weight fields.
    async countTotalRecords() {
        const base = this.config.API.BASE_URL;
        const params = new URLSearchParams();
        params.set('pageSize', '100');
        const filter = this.buildFilterFormula(true);
        if (filter) params.set('filterByFormula', filter);
        // Ask only for Username field to reduce payload
        params.append('fields[]', 'Username');
        let url = `${base}?${params.toString()}`;
        let count = 0;
        let guard = 0;
        while (true) {
            const data = await this.secureFetch(url);
            count += (data.records || []).length;
            if (data.offset && guard < 100) {
                const u = new URL(url);
                u.searchParams.set('offset', data.offset);
                url = u.toString();
                guard++;
            } else {
                break;
            }
        }
        this.totalCount = count;
        this.updatePageInfoServer();
    }

    renderUsersTable(records) { /* now renders a provided page slice */ 
        const tbody = document.getElementById('usersTableBody');
        tbody.innerHTML = '';
        const toRender = records || [];
        if (toRender.length === 0) {
            tbody.innerHTML = `<tr><td colspan="11" style="text-align: center;">No users found.</td></tr>`;
            return;
        }
        toRender.forEach(({ id, fields: user }) => {
            const nowSec = Math.floor(Date.now() / 1000);
            const isExpired = user.Expiry !== '9999' && parseInt(user.Expiry) < nowSec;
            const row = tbody.insertRow();
            
            // Payment status badge (only for admins)
            let paymentBadge = '';
            if (user.AccountType === 'admin') {
                const paymentStatus = user.PaymentStatus || 'Unpaid';
                const badgeClass = paymentStatus === 'Paid' ? 'payment-paid' : 'payment-unpaid';
                paymentBadge = `<span class="payment-badge ${badgeClass}">${paymentStatus}</span>`;
            }
            
            // Username with payment badge
            const usernameCell = paymentBadge ? `${paymentBadge} ${user.Username || ''}` : (user.Username || '');
            
            let creditButton = '';
            const canGive = (
                (this.currentUser.AccountType === 'god' && (user.AccountType === 'admin' || user.AccountType === 'seller' || user.AccountType === 'reseller')) ||
                ((this.currentUser.AccountType === 'admin' || this.currentUser.AccountType === 'seller') && (user.AccountType === 'seller' || user.AccountType === 'reseller'))
            );
            if (canGive) {
                creditButton = `<button onclick="app.giveCredits('${id}', '${user.Username}')" class="action-btn" style="background-color: var(--success);">Give Credits</button>`;
            }
            
            // Payment action button (only for god viewing admins)
            let paymentButton = '';
            if (this.currentUser.AccountType === 'god' && user.AccountType === 'admin') {
                const currentStatus = user.PaymentStatus || 'Unpaid';
                const newStatus = currentStatus === 'Paid' ? 'Unpaid' : 'Paid';
                const btnColor = currentStatus === 'Paid' ? 'var(--warning)' : 'var(--success)';
                paymentButton = `<button onclick="app.togglePaymentStatus('${id}', '${user.Username}', '${currentStatus}')" class="action-btn" style="background-color: ${btnColor};">Mark ${newStatus}</button>`;
            }
            
            // Expiry display with X/Y format for admins
            let expiryDisplay = '';
            if (user.Expiry === '9999') {
                expiryDisplay = '<span class="expiry-days">Never</span>';
            } else if (isExpired) {
                expiryDisplay = '<span class="expiry-expired">Expired</span>';
            } else {
                const secondsLeft = parseInt(user.Expiry) - nowSec;
                const daysLeft = Math.ceil(secondsLeft / 86400);
                
                // For admins, show X/Y format (remaining/total purchased)
                if (user.AccountType === 'admin' && user.PurchasedDays) {
                    expiryDisplay = `<span class="expiry-days">${daysLeft}/${user.PurchasedDays} days</span>`;
                } else {
                    expiryDisplay = `<span class="expiry-days">${daysLeft} days</span>`;
                }
            }
            
            // Show credits for seller/reseller, amount owed for admin
            let creditsDisplay = '-';
            if (user.AccountType === 'seller' || user.AccountType === 'reseller') {
                creditsDisplay = user.Credits || 0;
            } else if (user.AccountType === 'admin' && this.currentUser.AccountType === 'god') {
                const owed = parseFloat(user.AmountOwed) || 0;
                creditsDisplay = owed > 0 ? `₹${owed}` : '₹0';
            }
            
            row.innerHTML = `<td>${usernameCell}</td><td>${user.Password || ''}</td><td>${user.AccountType || 'user'}</td><td>${creditsDisplay}</td><td>${expiryDisplay}</td><td>${user.Device || 'Single'}</td><td>${user.HWID ? 'SET' : 'NONE'}</td><td>${user.CreatedBy || ''}</td><td><span class="status-badge ${isExpired ? 'status-expired' : 'status-active'}">${isExpired ? 'Expired' : 'Active'}</span></td><td class="action-buttons">${paymentButton}${creditButton}<button onclick="app.resetHWID('${id}', '${user.Username}')" class="action-btn btn-warning">Reset HWID</button><button onclick="app.deleteUser('${id}', '${user.Username}')" class="action-btn btn-danger">Delete</button></td>`;
        });
    }

    // Server-mode: just update page info based on current page and totalCount
    updatePageInfoServer() {
        const startIndex = this.totalCount === 0 ? (this.currentPage - 1) * this.rowsPerPage : (this.currentPage - 1) * this.rowsPerPage;
        const endIndexExclusive = startIndex + (this.currentPageRecords?.length || 0);
        const total = this.totalCount || Math.max(endIndexExclusive, 0);
        this.updatePageInfo(startIndex, endIndexExclusive, total);
    }

    getFilteredUsers(users) { // retained for potential future client-side mode
        const q = this.searchQuery.trim();
        if (!q) return users;
        const lower = q.toLowerCase();
        return users.filter(({ fields }) => String(fields.Username || '').toLowerCase().includes(lower));
    }

    getSortedUsers(users) { // retained for potential future client-side mode
        const opt = this.sortOption;
        const copied = users.slice();
        if (opt === 'latest') {
            // Sort by record createdTime DESC (latest first)
            return copied.sort((a, b) => new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime());
        }
        if (opt === 'oldest') {
            return copied.sort((a, b) => new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime());
        }
        if (opt === 'az') {
            return copied.sort((a, b) => String(a.fields.Username || '').localeCompare(String(b.fields.Username || ''), undefined, { sensitivity: 'base' }));
        }
        if (opt === 'za') {
            return copied.sort((a, b) => String(b.fields.Username || '').localeCompare(String(a.fields.Username || ''), undefined, { sensitivity: 'base' }));
        }
        return copied;
    }

    updatePageInfo(startIndex, endIndexExclusive, total) {
        const pageInfo = document.getElementById('pageInfo');
        const humanStart = total === 0 ? 0 : startIndex + 1;
        const humanEnd = endIndexExclusive;
        if (pageInfo) pageInfo.textContent = `${humanStart} – ${humanEnd} of ${total}`;
        const prevBtn = document.getElementById('prevPageBtn');
        const nextBtn = document.getElementById('nextPageBtn');
        if (prevBtn) prevBtn.disabled = this.currentPage === 1 || total === 0;
        if (nextBtn) {
            // Disable next if we've reached last page based on totalCount, otherwise enable
            nextBtn.disabled = endIndexExclusive >= total || this.pageOffsets[this.currentPage + 1] === null;
        }
    }
    async giveCredits(recordId, username) { /* ... UNCHANGED ... */ 
        const amountStr = prompt(`How many credits to give to ${username}?`);
        if (!amountStr) return;
        const amount = parseInt(amountStr);
        if (isNaN(amount) || amount <= 0) return this.showNotification('Invalid credit amount.', 'error');
        if (this.currentUser.AccountType !== 'god' && this.currentUser.AccountType !== 'admin' && this.currentUser.Credits < amount) {
            return this.showNotification('Insufficient credits.', 'error');
        }
        try {
            const targetUser = (this.currentPageRecords.find(u => u.id === recordId) || this.allUsers.find(u => u.id === recordId)).fields;
            const newCreditTotal = (targetUser.Credits || 0) + amount;
            await this.updateUserCredits(recordId, newCreditTotal);
            if (this.currentUser.AccountType !== 'god' && this.currentUser.AccountType !== 'admin') {
                this.currentUser.Credits -= amount;
                await this.updateUserCredits(this.currentUser.recordId, this.currentUser.Credits);
                document.getElementById('userCredits').textContent = this.currentUser.Credits;
            }
            this.showNotification(`Successfully gave ${amount} credits to ${username}`, 'success');
            await this.loadUsers();
        } catch (error) { this.showNotification(`Failed to give credits: ${error.message}`, 'error'); }
    }
    async resetHWID(recordId, username) { /* ... UNCHANGED ... */ 
        if (!confirm(`Reset HWID for ${username}?`)) return;
        try {
            await this.secureFetch(this.config.API.BASE_URL, { method: 'PATCH', body: { records: [{ id: recordId, fields: { HWID: '', HWID2: '' } }] } });
            this.showNotification(`HWID reset for ${username}`, 'success');
            await this.loadUsers();
        } catch (error) { this.showNotification(`Failed to reset HWID: ${error.message}`, 'error'); }
    }
    async resetAllKeys() {
        // Only admin or god may perform this action
        if (!(this.currentUser?.AccountType === 'god' || this.currentUser?.AccountType === 'admin')) {
            this.showNotification('You do not have permission to perform this action.', 'error');
            return;
        }
        const scopeLabel = this.currentUser.AccountType === 'god' ? 'ALL users' : 'all users you can access';
        if (!confirm(`This will reset HWID keys for ${scopeLabel}. Continue?`)) return;

        try {
            // Gather all accessible records using existing access filter
            const base = this.config.API.BASE_URL;
            const params = new URLSearchParams();
            params.set('pageSize', '100');
            const accessOnly = this.buildFilterFormula(false);
            if (accessOnly) params.set('filterByFormula', accessOnly);
            // Request minimal fields
            params.append('fields[]', 'Username');
            params.append('fields[]', 'HWID');
            params.append('fields[]', 'HWID2');
            let url = `${base}?${params.toString()}`;

            const recordsToReset = [];
            let guard = 0;
            while (true) {
                const data = await this.secureFetch(url);
                const recs = data.records || [];
                for (const r of recs) {
                    // Reset all regardless; optionally skip if already empty
                    recordsToReset.push({ id: r.id });
                }
                if (data.offset && guard < 200) {
                    const u = new URL(url);
                    u.searchParams.set('offset', data.offset);
                    url = u.toString();
                    guard++;
                } else { break; }
            }

            if (recordsToReset.length === 0) {
                this.showNotification('No records found to reset.', 'success');
                return;
            }

            // Batch PATCH in chunks of 10 per Airtable API limits
            const chunkSize = 10;
            let processed = 0;
            for (let i = 0; i < recordsToReset.length; i += chunkSize) {
                const batch = recordsToReset.slice(i, i + chunkSize).map(r => ({ id: r.id, fields: { HWID: '', HWID2: '' } }));
                await this.secureFetch(base, { method: 'PATCH', body: { records: batch } });
                processed += batch.length;
            }
            this.showNotification(`Reset HWID keys for ${processed} users.`, 'success');
            await this.loadUsers();
        } catch (error) {
            this.showNotification('Failed to reset all keys: ' + error.message, 'error');
        }
    }
    async deleteUser(recordId, username) {
        // No confirmation needed for auto-delete, but keep for manual delete
        if (username && !confirm(`Delete user ${username}?`)) return;
        try {
            await this.secureFetch(`${this.config.API.BASE_URL}/${recordId}`, { method: 'DELETE' });
            if (username) { // Only show notification for manual deletion
                this.showNotification(`User ${username} deleted`, 'success');
            }
            // Manually remove the user from the table to avoid a full reload
            const index = this.allUsers.findIndex(u => u.id === recordId);
            if (index > -1) {
                this.allUsers.splice(index, 1);
                // Reload current page and refresh stats after deletion
                await this.loadUsers();
            }
        } catch (error) { this.showNotification(`Failed to delete user: ${error.message}`, 'error'); }
    }
    async updateUserCredits(recordId, newCredits) { /* ... UNCHANGED ... */ 
        await this.secureFetch(this.config.API.BASE_URL, { method: 'PATCH', body: { records: [{ id: recordId, fields: { Credits: newCredits } }] } });
    }
    async updateStats() { /* now fetch lightweight pages to compute accurate counts */ 
        const base = this.config.API.BASE_URL;
        const params = new URLSearchParams();
        params.set('pageSize', '100');
        const accessOnly = this.buildFilterFormula(false); // exclude search for global stats
        if (accessOnly) params.set('filterByFormula', accessOnly);
        params.append('fields[]', 'Expiry');
        params.append('fields[]', 'AccountType');
        params.append('fields[]', 'AmountOwed');
        params.append('fields[]', 'AmountPaid');
        params.append('fields[]', 'PaymentStatus');
        let url = `${base}?${params.toString()}`;
        let total = 0, active = 0, reseller = 0;
        let totalOwed = 0, totalPaid = 0;
        let guard = 0;
        const nowSec = Math.floor(Date.now() / 1000);
        while (true) {
            const data = await this.secureFetch(url);
            const recs = data.records || [];
            total += recs.length;
            for (const r of recs) {
                const f = r.fields || {};
                const isActive = f.Expiry === '9999' || parseInt(f.Expiry) > nowSec;
                if (isActive) active++;
                if (f.AccountType === 'reseller') reseller++;
                
                // Calculate payment stats for admins (God view only)
                if (this.currentUser.AccountType === 'god' && f.AccountType === 'admin') {
                    const owed = parseFloat(f.AmountOwed) || 0;
                    const paid = parseFloat(f.AmountPaid) || 0;
                    const status = f.PaymentStatus || 'Unpaid';
                    
                    if (status === 'Unpaid') {
                        totalOwed += owed;
                    } else {
                        totalPaid += paid;
                    }
                }
            }
            if (data.offset && guard < 100) {
                const u = new URL(url);
                u.searchParams.set('offset', data.offset);
                url = u.toString();
                guard++;
            } else {
                break;
            }
        }
        document.getElementById('totalUsers').textContent = total;
        document.getElementById('activeUsers').textContent = active;
        document.getElementById('expiredUsers').textContent = total - active;
        document.getElementById('resellerCount').textContent = reseller;
        
        // Update payment stats (God only)
        if (this.currentUser.AccountType === 'god') {
            const owedEl = document.getElementById('totalOwed');
            const paidEl = document.getElementById('totalPaid');
            if (owedEl) owedEl.textContent = `₹${totalOwed.toFixed(0)}`;
            if (paidEl) paidEl.textContent = `₹${totalPaid.toFixed(0)}`;
        }
    }
    logout() { /* ... UNCHANGED ... */ 
        localStorage.removeItem('ninex_session'); window.location.reload(); 
    }
    showError(message) { /* ... UNCHANGED ... */ 
        const el = document.getElementById('loginError');
        el.textContent = message;
        el.style.display = message ? 'block' : 'none';
    }
    showNotification(message, type) { /* ... UNCHANGED ... */ 
        const el = document.getElementById('notification');
        el.textContent = message; el.className = `notification ${type} show`;
        setTimeout(() => el.classList.remove('show'), 3000);
    }

    // ---
    // --- NEW MAINTENANCE MODE FUNCTIONS (checkMaintenanceState is modified) ---
    // ---

    /**
     * Checks the maintenance state by fetching one user record.
     * --- MODIFIED: This function no longer uses an access filter ---
     * It checks the *global* state by fetching the first record in the table.
     */
    async checkMaintenanceState() {
        this.updateMaintenanceUI('Checking...');
        try {
            const base = this.config.API.BASE_URL;
            const params = new URLSearchParams();
            params.set('pageSize', '1');
            params.append('fields[]', 'Version'); // We only need the Version field
            
            // --- REMOVED FILTER ---
            // This now checks the absolute first record in the table,
            // giving a true global maintenance state.
            let url = `${base}?${params.toString()}`;

            const data = await this.secureFetch(url);
            let state = 'v3'; // Default to 'v3' (Online)
            if (data.records && data.records.length > 0) {
                const firstUser = data.records[0].fields;
                if (firstUser.Version === 'Maintenance') {
                    state = 'Maintenance';
                }
            }
            this.maintenanceState = state;
            this.updateMaintenanceUI(state);
        } catch (error) {
            this.showNotification('Could not check server state: ' + error.message, 'error');
            this.updateMaintenanceUI('Error');
        }
    }

    /**
     * Updates the UI elements (badge, button) to reflect the current maintenance state.
     * @param {string} state - The current state ('v3', 'Maintenance', 'Checking...', 'Error')
     */
    updateMaintenanceUI(state) {
        const statusText = document.getElementById('serverStatusText');
        const statusBadge = document.getElementById('serverStatusBadge');
        const btn = document.getElementById('maintenanceToggleBtn');
        const btnSpan = btn?.querySelector('span');

        if (!statusText || !statusBadge) return;

        switch (state) {
            case 'Maintenance':
                statusText.textContent = 'Maintenance';
                statusBadge.style.backgroundColor = 'var(--error)'; // Red
                statusBadge.style.color = 'white';
                if (btn) {
                    btn.style.backgroundColor = 'var(--success)';
                    btn.style.color = 'white';
                    if (btnSpan) btnSpan.textContent = 'Disable Maintenance (Go Online)';
                }
                break;
            case 'v3':
                statusText.textContent = 'Online';
                statusBadge.style.backgroundColor = 'var(--success)'; // Green
                statusBadge.style.color = 'white';
                 if (btn) {
                    btn.style.backgroundColor = 'var(--warning)';
                    btn.style.color = 'var(--dark-bg)';
                    if (btnSpan) btnSpan.textContent = 'Enable Maintenance (Go Offline)';
                }
                break;
            case 'Checking...':
                statusText.textContent = 'Checking...';
                statusBadge.style.backgroundColor = 'var(--warning)'; // Yellow
                statusBadge.style.color = 'var(--dark-bg)';
                if (btn) {
                    btn.style.backgroundColor = 'var(--warning)';
                    btn.style.color = 'var(--dark-bg)';
                    if (btnSpan) btnSpan.textContent = 'Checking State...';
                }
                break;
            default: // Error or unknown
                statusText.textContent = 'Unknown';
                statusBadge.style.backgroundColor = '#888'; // Grey
                statusBadge.style.color = 'white';
                if (btn) {
                    btn.style.backgroundColor = '#888';
                    btn.style.color = 'white';
                    if (btnSpan) btnSpan.textContent = 'Check State Failed';
                }
        }
    }

    /**
     * Handles the click event for the maintenance toggle button.
     */
    async toggleMaintenanceMode() {
        if (this.maintenanceState === null || this.maintenanceState === 'Checking...') {
            this.showNotification('Still checking current state. Please wait.', 'error');
            return;
        }

        const currentState = this.maintenanceState;
        const newState = (currentState === 'v3') ? 'Maintenance' : 'v3';
        const action = (newState === 'Maintenance') ? 'ENABLE maintenance mode' : 'DISABLE maintenance mode (go online)';
        const scopeLabel = this.currentUser.AccountType === 'god' ? 'ALL users' : 'all users you can access';

        if (!confirm(`Are you sure you want to ${action} for ${scopeLabel}?`)) return;

        const btn = document.getElementById('maintenanceToggleBtn');
        if (btn) btn.disabled = true;
        this.updateMaintenanceUI('Checking...'); // Show "Checking..." as a loading state

        try {
            await this.setAllUsersVersion(newState);
            this.maintenanceState = newState;
            this.updateMaintenanceUI(newState);
            this.showNotification(`Successfully set ${scopeLabel} to '${newState}'.`, 'success');
        } catch (error) {
            this.showNotification('Failed to update user versions: ' + error.message, 'error');
            // Revert UI to the state it was before the failed attempt
            this.updateMaintenanceUI(currentState);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /**
     * Fetches all accessible user records and batch-updates their 'Version' field.
     * @param {string} newVersion - The new version string ('v3' or 'Maintenance')
     */
    async setAllUsersVersion(newVersion) {
        // Only admin or god may perform this action
        if (!(this.currentUser?.AccountType === 'god' || this.currentUser?.AccountType === 'admin')) {
            throw new Error('You do not have permission to perform this action.');
        }

        const base = this.config.API.BASE_URL;
        const params = new URLSearchParams();
        params.set('pageSize', '100');

        // Apply access filter. 'god' has no filter and updates all.
        // 'admin' updates all users they and their subordinates created.
        const accessOnly = this.buildFilterFormula(false);
        if (accessOnly) params.set('filterByFormula', accessOnly);

        // Request minimal fields (just need ID)
        params.append('fields[]', 'Username');
        let url = `${base}?${params.toString()}`;

        const recordsToUpdate = [];
        let guard = 0;
        while (true) {
            const data = await this.secureFetch(url);
            const recs = data.records || [];
            for (const r of recs) {
                recordsToUpdate.push({ id: r.id });
            }
            if (data.offset && guard < 200) { // 200 page guard
                const u = new URL(url);
                u.searchParams.set('offset', data.offset);
                url = u.toString();
                guard++;
            } else { break; }
        }

        if (recordsToUpdate.length === 0) {
            // This is not an error, just no users to update.
            return;
        }

        // Batch PATCH in chunks of 10
        const chunkSize = 10;
        let processed = 0;
        for (let i = 0; i < recordsToUpdate.length; i += chunkSize) {
            const batch = recordsToUpdate.slice(i, i + chunkSize).map(r => ({
                id: r.id,
                fields: { Version: newVersion }
            }));
            await this.secureFetch(base, { method: 'PATCH', body: { records: batch } });
            processed += batch.length;
        }
        
        console.log(`Updated ${processed} users to ${newVersion}.`);
    }

    // ============ PAYMENT MANAGEMENT FUNCTIONS ============
    
    /**
     * Toggle payment status for an admin between Paid and Unpaid
     */
    async togglePaymentStatus(recordId, username, currentStatus) {
        if (this.currentUser.AccountType !== 'god') {
            this.showNotification('Only God can manage payment status.', 'error');
            return;
        }
        
        const newStatus = currentStatus === 'Paid' ? 'Unpaid' : 'Paid';
        const confirmMsg = `Mark ${username} as ${newStatus}?`;
        
        if (!confirm(confirmMsg)) return;
        
        try {
            // Get current admin record to transfer amounts
            const adminRecord = this.currentPageRecords.find(r => r.id === recordId);
            if (!adminRecord) {
                throw new Error('Admin record not found');
            }
            
            const fields = { 
                PaymentStatus: newStatus,
                PaymentDate: newStatus === 'Paid' ? new Date().toISOString() : ''
            };
            
            // When marking as PAID: transfer AmountOwed to AmountPaid and clear AmountOwed
            if (newStatus === 'Paid') {
                const amountOwed = parseFloat(adminRecord.fields.AmountOwed) || 0;
                const currentPaid = parseFloat(adminRecord.fields.AmountPaid) || 0;
                
                fields.AmountPaid = currentPaid + amountOwed;
                fields.AmountOwed = 0;
            }
            // When marking as UNPAID: transfer AmountPaid back to AmountOwed
            else {
                const amountPaid = parseFloat(adminRecord.fields.AmountPaid) || 0;
                const currentOwed = parseFloat(adminRecord.fields.AmountOwed) || 0;
                
                fields.AmountOwed = currentOwed + amountPaid;
                fields.AmountPaid = 0;
            }
            
            await this.secureFetch(this.config.API.BASE_URL, {
                method: 'PATCH',
                body: { records: [{ id: recordId, fields }] }
            });
            
            this.showNotification(`${username} marked as ${newStatus}`, 'success');
            await this.loadUsers();
        } catch (error) {
            this.showNotification(`Failed to update payment status: ${error.message}`, 'error');
        }
    }
    
    /**
     * Approve all unpaid admins - mark them as paid
     */
    async approveAllUnpaidAdmins() {
        if (this.currentUser.AccountType !== 'god') {
            this.showNotification('Only God can approve payments.', 'error');
            return;
        }
        
        if (!confirm('Mark ALL unpaid admins as PAID? This action will update all unpaid admin accounts.')) {
            return;
        }
        
        try {
            const base = this.config.API.BASE_URL;
            const params = new URLSearchParams();
            params.set('pageSize', '100');
            
            // Filter for unpaid admins
            const filter = `AND({AccountType}='admin',OR({PaymentStatus}='Unpaid',{PaymentStatus}=''))`;
            params.set('filterByFormula', filter);
            params.append('fields[]', 'Username');
            params.append('fields[]', 'PaymentStatus');
            params.append('fields[]', 'AmountOwed');
            params.append('fields[]', 'AmountPaid');
            
            let url = `${base}?${params.toString()}`;
            const toUpdate = [];
            let guard = 0;
            
            while (true) {
                const data = await this.secureFetch(url);
                const recs = data.records || [];
                
                for (const r of recs) {
                    const amountOwed = parseFloat(r.fields.AmountOwed) || 0;
                    const currentPaid = parseFloat(r.fields.AmountPaid) || 0;
                    
                    toUpdate.push({ 
                        id: r.id, 
                        fields: { 
                            PaymentStatus: 'Paid',
                            PaymentDate: new Date().toISOString(),
                            AmountPaid: currentPaid + amountOwed,
                            AmountOwed: 0
                        } 
                    });
                }
                
                if (data.offset && guard < 100) {
                    const u = new URL(url);
                    u.searchParams.set('offset', data.offset);
                    url = u.toString();
                    guard++;
                } else {
                    break;
                }
            }
            
            if (toUpdate.length === 0) {
                this.showNotification('No unpaid admins found.', 'success');
                return;
            }
            
            // Batch update in chunks of 10
            const chunkSize = 10;
            let processed = 0;
            for (let i = 0; i < toUpdate.length; i += chunkSize) {
                const batch = toUpdate.slice(i, i + chunkSize);
                await this.secureFetch(base, { method: 'PATCH', body: { records: batch } });
                processed += batch.length;
            }
            
            this.showNotification(`Approved ${processed} admin(s) as PAID.`, 'success');
            await this.loadUsers();
        } catch (error) {
            this.showNotification(`Failed to approve payments: ${error.message}`, 'error');
        }
    }
    
    /**
     * Update admin's purchased days (for tracking X/Y format)
     */
    async updateAdminPurchasedDays(recordId, username) {
        if (this.currentUser.AccountType !== 'god') {
            this.showNotification('Only God can update purchased days.', 'error');
            return;
        }
        
        const daysStr = prompt(`Enter total purchased days for ${username}:`);
        if (!daysStr) return;
        
        const days = parseInt(daysStr);
        if (isNaN(days) || days <= 0) {
            this.showNotification('Please enter a valid positive number.', 'error');
            return;
        }
        
        try {
            await this.secureFetch(this.config.API.BASE_URL, {
                method: 'PATCH',
                body: { records: [{ id: recordId, fields: { PurchasedDays: days } }] }
            });
            
            this.showNotification(`Updated purchased days for ${username} to ${days}`, 'success');
            await this.loadUsers();
        } catch (error) {
            this.showNotification(`Failed to update purchased days: ${error.message}`, 'error');
        }
    }
    
    /**
     * Set payment filter and reload
     */
    setPaymentFilter(filter) {
        this.paymentFilter = filter;
        this.resetPagingAndReload();
    }

}
const app = new NineXAdminPanel();
