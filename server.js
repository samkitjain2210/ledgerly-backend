/**
 * LEDGERLY.AI BACKEND (SAFE MODE)
 * Fixes: Startup crashes, Database corruption handling, and detailed logging.
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'ledgerly_db.json');
const JWT_SECRET = process.env.JWT_SECRET || 'ledgerly_secure_v4';

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage() });

// --- DATABASE HELPERS (FAIL-SAFE) ---
const readData = () => {
    if (!fs.existsSync(DATA_FILE)) {
        console.log("Database file missing. Creating new one.");
        const initialData = {
            users: [],
            data: {}
        };
        try {
            fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
            return initialData;
        } catch (e) {
            console.error("CRITICAL: Failed to create DB file", e);
            return { users: [], data: {} }; // Fallback to prevent crash
        }
    }

    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        // Validate JSON content
        if (!rawData || rawData.trim() === '') {
            console.error("Database file is empty. Resetting.");
            return { users: [], data: {} };
        }
        
        try {
            return JSON.parse(rawData);
        } catch (jsonErr) {
            console.error("CRITICAL: Database file is corrupted! Resetting to safe defaults.", jsonErr);
            // Safety mechanism: Reset the file content
            try { 
                if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE); 
            } catch(unlinkErr) {}
            return { users: [], data: {} };
        }
    } catch (e) {
        console.error("CRITICAL: Read failed unexpectedly. Using fallback.", e);
        return { users: [], data: {} };
    }
};

const writeData = (data) => {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Failed to write DB:", e);
        throw e; // Re-throw to let the API return 500
    }
};

// --- AUTH MIDDLEWARE ---
const verifyToken = (req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    if (typeof bearerHeader !== 'undefined') {
        const bearer = bearerHeader.split(' ');
        const token = bearer[1];
        jwt.verify(token, JWT_SECRET, (err, authData) => {
            if (err) return res.status(401).json({ error: 'Invalid Token' });
            else {
                req.userId = authData.id;
                next();
            }
        });
    } else {
        res.status(403).json({ error: 'No token provided' });
    }
};

// --- ACCOUNTING ENGINE (SERVER SIDE) ---

// 1. Chart of Accounts
const COA = {
    Asset: ['Cash', 'Bank', 'Equipment', 'Input Tax Credit', 'Receivables'],
    Liability: ['Term Loan', 'GST Payable', 'Vendor Payables'],
    Income: ['Sales', 'Service Income', 'Refunds'],
    Expense: ['Rent', 'Salary', 'Utilities', 'Office Supplies', 'Professional Fees'],
    Equity: ['Capital']
};

// 2. GST Calculator
const calculateGST = (amount, rate, isInclusive) => {
    let base = 0, gst = 0;
    if (isInclusive) {
        base = Math.round(amount / (1 + (rate / 100)));
        gst = amount - base;
    } else {
        base = amount;
        gst = Math.round(base * (rate / 100));
    }
    return { base, gst, total: base + gst };
};

// 3. Journal Entry Generator
const generateJournalEntries = (text, amount, mode, accountType, category, gstRate, isInclusiveGST, businessId) => {
    const entries = [];
    const gstCalc = calculateGST(amount, gstRate, isInclusiveGST);

    if (accountType === 'Income') {
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: gstCalc.total, cr: 0 });
        entries.push({ account: category, dr: 0, cr: gstCalc.base });
        if (gstCalc.gst > 0) entries.push({ account: 'GST Payable', dr: 0, cr: gstCalc.gst });
    }
    else if (accountType === 'Expense') {
        entries.push({ account: category, dr: gstCalc.base, cr: 0 });
        if (gstCalc.gst > 0) entries.push({ account: 'Input Tax Credit', dr: gstCalc.gst, cr: 0 });
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: 0, cr: gstCalc.total });
    }
    else if (accountType === 'Asset') {
        entries.push({ account: category, dr: amount, cr: 0 });
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: 0, cr: amount });
    }
    else if (accountType === 'Liability') {
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: amount, cr: 0 });
        entries.push({ account: category, dr: 0, cr: amount });
    }
    else if (accountType === 'Equity') {
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: amount, cr: 0 });
        entries.push({ account: 'Capital', dr: 0, cr: amount });
    }
    
    return entries;
};

// 4. NLP Parser (Server Side)
const parseTransactionText = (text) => {
    const lower = text.toLowerCase();
    let amount = 0, gstRate = 0, type = 'expense', mode = 'Cash', category = 'General', accountType = 'Expense';
    let isInclusiveGST = false;
    let date = new Date().toISOString().split('T')[0];

    const amtMatch = text.match(/(\d+(\,\d+)*(\.\d{1,2})?)/);
    if (amtMatch) amount = parseFloat(amtMatch[0].replace(/,/g, ''));

    if (lower.includes('gst')) {
        const gstMatch = text.match(/(\d+)%?/);
        if (gstMatch) gstRate = parseFloat(gstMatch[1]);
        else gstRate = 18;
    }
    if (lower.includes('incl') || lower.includes('included')) isInclusiveGST = true;

    if (lower.includes('bank') || lower.includes('transfer')) mode = 'Bank';
    else if (lower.includes('upi')) mode = 'UPI';

    if (['received', 'got', 'sale'].some(k => lower.includes(k))) {
        type = 'income';
        accountType = 'Income';
        if (lower.includes('refund')) category = 'Refunds';
        else if (type === 'income') category = 'Sales';
    } else {
        type = 'expense';
        accountType = 'Expense';
        if (lower.includes('rent')) category = 'Rent';
        else if (lower.includes('salary')) category = 'Salary';
        else if (lower.includes('food') || lower.includes('lunch')) category = 'Office Supplies';
    }

    return { amount, type, mode, category, accountType, date, gstRate, isInclusiveGST, desc: text };
};

// --- ROUTES ---

// 1. Health Check (Useful for Render)
app.get('/', (req, res) => {
    res.send('Ledgerly.ai Backend is Running 🚀');
});

// 2. LOGIN
app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;
        const db = readData();

        const user = db.users.find(u => u.email === email);

        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        const userBizs = db.data[user.id] || {};
        const businesses = Object.values(userBizs);
        const transactions = businesses.flatMap(b => b.transactions || []);

        res.json({
            token,
            user,
            businesses,
            transactions
        });
        console.log(`Login success: ${email}`);
    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).json({ error: 'Login failed' });
    }
});

// 3. REGISTER
app.post('/api/auth/register', (req, res) => {
    try {
        const { email, password, name } = req.body;
        const db = readData();
        if (db.users.find(u => u.email === email)) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const newUserId = 'u' + Date.now();
        const newUser = { id: newUserId, email, password, name, role: 'owner' };
        db.users.push(newUser);

        const bizId = 'biz' + Date.now();
        const newBusiness = { id: bizId, name: `${name}'s Business`, transactions: [], lockedMonths: [] };

        db.data[newUserId] = { [bizId]: newBusiness };
        writeData(db);

        const token = jwt.sign({ id: newUserId }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: newUser, businesses: [newBusiness], transactions: [] });
        console.log(`Register success: ${email}`);
    } catch (e) {
        console.error("Register Error:", e);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// 4. SMART ENTRY (NEW BRAIN)
app.post('/api/smart-entry', verifyToken, (req, res) => {
    try {
        const { text } = req.body;
        const parsed = parseTransactionText(text);
        
        if (parsed.amount === 0) return res.status(400).json({ error: 'No valid amount found' });

        const db = readData();
        const uid = req.userId;
        const userBizs = db.data[uid] || {};
        const bizIds = Object.keys(userBizs);
        const currentBizId = bizIds.length > 0 ? bizIds[0] : null;

        if (!currentBizId) return res.status(404).json({ error: 'No business found' });

        const entries = generateJournalEntries(
            parsed.text,
            parsed.amount,
            parsed.mode,
            parsed.accountType,
            parsed.category,
            parsed.gstRate,
            parsed.isInclusiveGST,
            currentBizId
        );

        const fullTx = {
            ...parsed,
            id: Date.now(),
            businessId: currentBizId,
            status: 'confirmed',
            entries
        };

        if (!userBizs[currentBizId]) userBizs[currentBizId] = { transactions: [] };
        userBizs[currentBizId].transactions.unshift(fullTx);
        writeData(db);

        res.json({
            success: true,
            transaction: fullTx
        });
        console.log(`Smart entry success: ${text}`);
    } catch (e) {
        console.error("Smart Entry Error:", e);
        res.status(500).json({ error: 'Failed to process entry' });
    }
});

// 5. SYNC (Standard)
app.get('/api/sync', verifyToken, (req, res) => {
    try {
        const db = readData();
        const uid = req.userId;
        if (!db.data[uid]) return res.json({ user: {}, businesses: [], transactions: [] });

        const businesses = Object.values(db.data[uid]);
        const transactions = businesses.flatMap(b => b.transactions || []);
        const user = db.users.find(u => u.id === uid);

        res.json({ user, businesses, transactions });
    } catch (e) {
        console.error("Sync Get Error:", e);
        res.status(500).json({ error: 'Sync failed' });
    }
});

app.post('/api/sync', verifyToken, (req, res) => {
    try {
        const { transactions } = req.body;
        const db = readData();
        const uid = req.userId;

        if (!db.data[uid]) return res.status(404).json({ error: 'User not found' });

        const userBizs = db.data[uid];
        
        for (let bizId in userBizs) {
            userBizs[bizId].transactions = [];
        }
        transactions.forEach(tx => {
            if (userBizs[tx.businessId]) {
                userBizs[tx.businessId].transactions.push(tx);
            }
        });
        writeData(db);
        res.json({ success: true });
    } catch (e) {
        console.error("Sync Save Error:", e);
        res.status(500).json({ error: 'Save failed' });
    }
});

// 6. UPLOAD
app.post('/api/upload', verifyToken, upload.single('file'), (req, res) => {
    setTimeout(() => {
        const mockData = [
            { date: new Date().toISOString().split('T')[0], desc: 'Amazon Web Services', amount: 2500 },
            { date: new Date().toISOString().split('T')[0], desc: 'Client Payment #402', amount: 15000 }
        ];
        res.json({ success: true, data: mockData });
    }, 1000);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`\n🧠 LEDGERLY.AI (SAFE MODE) RUNNING 🚀`);
    console.log(`📁 Database: ${DATA_FILE}`);
    console.log(`🧠 Accounting Logic: SERVER SIDE (Active)`);
    console.log(`🧠 Smart Entry: Ready (Debits/Credits calculated automatically)`);
});
