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
        // Pagination, search, sort state
        this.currentPage = 1;
        this.rowsPerPage = 50;
        this.searchQuery = '';
        this.sortOption = 'latest';
        // Server-side paging helpers
        this.pageOffsets = []; // page index -> offset token for that page
        this.totalCount = 0; // total count for current filter
        this.currentPageRecords = []; // records of current page
        this.currentFilterKey = '';
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

    init() {
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
            url = this.config.API.PROXY_URL;
        }
        if (options.body) { fetchOptions.body = JSON.stringify(options.body); }

        try {
            const response = await fetch(url, fetchOptions);
            const data = await response.json().catch(() => ({ error: { message: `Server returned status ${response.status}. Could not parse response.` } }));
            if (!response.ok) {
                throw new Error(data.error?.message || `An unknown server error occurred. (Status: ${response.status})`);
            }
            return data;
        } catch (error) {
            console.error('SecureFetch Error:', error);
            throw error;
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
    async handleOtpSubmit(e) { /* ... UNCHANGED ... */ 
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
        if (!otp || !newPassword) return this.showResetError('OTP and new password are required.');
        
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
    
    checkExistingSession() { /* ... UNCHANGED ... */ 
        const session = validateSession();
        if (session) {
            this.currentUser = session.user;
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('dashboardSection').style.display = 'block';
            this.setupPermissions();
            this.computeAllowedCreators().then(() => this.loadUsers());
        }
    }
    async setupPermissions() { /* ... UPDATED BUSINESS RULES ... */ 
        const { AccountType, Username, Credits } = this.currentUser;
        const perms = this.config.HIERARCHY.PERMISSIONS[AccountType] || [];
        document.getElementById('userTypeBadge').textContent = AccountType.toUpperCase();
        document.getElementById('welcomeUser').textContent = `Welcome, ${Username}`;
        const creditsBadge = document.getElementById('creditsBadge');
        // Hide credits for god and admin; only show for seller/reseller
        if (AccountType === 'god' || AccountType === 'admin') {
            creditsBadge.style.display = 'none';
        } else {
            creditsBadge.style.display = 'block';
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

    async createUser(userData) {
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
        // --- THIS IS THE CORRECTED LINE ---
        userData.Expiry = isPrivileged ? '9999' : String(Math.floor(Date.now() / 1000) + Math.floor(parseFloat(userData.Expiry) * 3600));
        userData.CreatedBy = this.currentUser.Username;
        userData.HWID = ''; userData.HWID2 = '';
        await this.secureFetch(this.config.API.BASE_URL, { method: 'POST', body: { records: [{ fields: userData }] } });
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

    // Build filterByFormula combining access control + optional search
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
            this.sortOption
        ].join('|');
    }

    async fetchPageRecords(pageNumber) {
        const base = this.config.API.BASE_URL;
        const params = new URLSearchParams();
        params.set('pageSize', String(Math.min(this.rowsPerPage, 100)));
        const filter = this.buildFilterFormula(true);
        if (filter) params.set('filterByFormula', filter);
        // Server-side sort for username options (az/za). For latest/oldest we'll sort within the page client-side.
        if (this.sortOption === 'az' || this.sortOption === 'za') {
            params.set('sort[0][field]', 'Username');
            params.set('sort[0][direction]', this.sortOption === 'az' ? 'asc' : 'desc');
        }
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

        // Page-level client sort for latest/oldest using record.createdTime
        if (this.sortOption === 'latest' || this.sortOption === 'oldest') {
            const dir = this.sortOption === 'latest' ? -1 : 1;
            this.currentPageRecords.sort((a, b) => (new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime()) * dir);
        }

        // Update page info with a temporary total if we don't have real total yet
        this.updatePageInfoServer();
    }

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
            tbody.innerHTML = `<tr><td colspan="10" style="text-align: center;">No users found.</td></tr>`;
            return;
        }
        toRender.forEach(({ id, fields: user }) => {
            const nowSec = Math.floor(Date.now() / 1000);
            const isExpired = user.Expiry !== '9999' && parseInt(user.Expiry) < nowSec;
            const row = tbody.insertRow();
            let creditButton = '';
            const canGive = (
                (this.currentUser.AccountType === 'god' && (user.AccountType === 'admin' || user.AccountType === 'seller' || user.AccountType === 'reseller')) ||
                ((this.currentUser.AccountType === 'admin' || this.currentUser.AccountType === 'seller') && (user.AccountType === 'seller' || user.AccountType === 'reseller'))
            );
            if (canGive) {
                creditButton = `<button onclick="app.giveCredits('${id}', '${user.Username}')" class="action-btn" style="background-color: var(--success);">Give Credits</button>`;
            }
            let expiryDisplay = '';
            if (user.Expiry === '9999') {
                expiryDisplay = '<span class="expiry-days">Never</span>';
            } else if (isExpired) {
                expiryDisplay = '<span class="expiry-expired">Expired</span>';
            } else {
                const secondsLeft = parseInt(user.Expiry) - nowSec;
                const daysLeft = Math.ceil(secondsLeft / 86400);
                expiryDisplay = `<span class=\"expiry-days\">${daysLeft} days</span>`;
            }
            // Only show credits for seller and reseller; not for admin
            const showCredits = (user.AccountType === 'seller' || user.AccountType === 'reseller');
            row.innerHTML = `<td>${user.Username || ''}</td><td>${user.Password || ''}</td><td>${user.AccountType || 'user'}</td><td>${showCredits ? (user.Credits || 0) : '-'}</td><td>${expiryDisplay}</td><td>${user.Device || 'Single'}</td><td>${user.HWID ? 'SET' : 'NONE'}</td><td>${user.CreatedBy || ''}</td><td><span class=\"status-badge ${isExpired ? 'status-expired' : 'status-active'}\">${isExpired ? 'Expired' : 'Active'}</span></td><td class=\"action-buttons\">${creditButton}<button onclick=\"app.resetHWID('${id}', '${user.Username}')\" class=\"action-btn btn-warning\">Reset HWID</button><button onclick=\"app.deleteUser('${id}', '${user.Username}')\" class=\"action-btn btn-danger\">Delete</button></td>`;
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
        let url = `${base}?${params.toString()}`;
        let total = 0, active = 0, reseller = 0;
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
}
const app = new NineXAdminPanel();
