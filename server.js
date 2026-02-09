/**
 * LEDGERLY.AI BACKEND (EVENT-BASED ACCOUNTING ENGINE)
 * Philosophy: Users speak in plain language ("Paid rent 5000").
 * System translates this into strict Accounting Events (Debit/Credit).
 * No accounting knowledge required by the user.
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

// --- ACCOUNTING ENGINE (THE BRAIN) ---

// 1. Chart of Accounts (Fixed Types for consistency)
const COA = {
    Asset: ['Cash', 'Bank', 'Equipment', 'Input Tax Credit', 'Receivables'],
    Liability: ['Term Loan', 'GST Payable', 'Vendor Payables'],
    Income: ['Sales', 'Service Income', 'Refunds'],
    Expense: ['Rent', 'Salary', 'Utilities', 'Office Supplies', 'Professional Fees'],
    Equity: ['Capital']
};

// 2. GST Calculator (Server Side)
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

// 3. Journal Entry Generator (Strict Double-Entry)
const generateJournalEntries = (text, amount, mode, accountType, category, gstRate, isInclusiveGST, businessId) => {
    const entries = [];
    const gstCalc = calculateGST(amount, gstRate, isInclusiveGST);

    if (accountType === 'Income') {
        // Rule: Bank Dr (Total), Sales Cr (Base), GST Payable Cr (Tax)
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: gstCalc.total, cr: 0 });
        entries.push({ account: category, dr: 0, cr: gstCalc.base });
        if (gstCalc.gst > 0) entries.push({ account: 'GST Payable', dr: 0, cr: gstCalc.gst });
    }
    else if (accountType === 'Expense') {
        // Rule: Expense Dr (Base), ITC Dr (Tax), Bank Cr (Total)
        entries.push({ account: category, dr: gstCalc.base, cr: 0 });
        if (gstCalc.gst > 0) entries.push({ account: 'Input Tax Credit', dr: gstCalc.gst, cr: 0 });
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: 0, cr: gstCalc.total });
    }
    else if (accountType === 'Asset') {
        // Rule: Asset Dr (Total), Bank Cr (Total)
        entries.push({ account: category, dr: amount, cr: 0 });
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: 0, cr: amount });
    }
    else if (accountType === 'Liability') {
        // Rule: Bank Dr (Total), Liability Cr (Total)
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: amount, cr: 0 });
        entries.push({ account: category, dr: 0, cr: amount });
    }
    else if (accountType === 'Equity') {
        // Rule: Bank Dr (Total), Capital Cr (Total)
        entries.push({ account: mode === 'Cash' ? 'Cash' : 'Bank', dr: amount, cr: 0 });
        entries.push({ account: 'Capital', dr: 0, cr: amount });
    }
    
    return entries;
};

// 4. NLP Parser (Server Side - "The Brain")
const parseTransactionText = (text) => {
    const lower = text.toLowerCase();
    let amount = 0, gstRate = 0, type = 'expense', mode = 'Cash', category = 'General', accountType = 'Expense';
    let isInclusiveGST = false;
    let date = new Date().toISOString().split('T')[0];

    // Extract Amount
    const amtMatch = text.match(/(\d+(\,\d+)*(\.\d{1,2})?)/);
    if (amtMatch) amount = parseFloat(amtMatch[0].replace(/,/g, ''));

    // Detect GST
    if (lower.includes('gst')) {
        const gstMatch = text.match(/(\d+)%?/);
        if (gstMatch) gstRate = parseFloat(gstMatch[1]);
        else gstRate = 18; // Default
    }
    if (lower.includes('incl') || lower.includes('included')) isInclusiveGST = true;

    // Detect Mode
    if (lower.includes('bank') || lower.includes('transfer')) mode = 'Bank';
    else if (lower.includes('upi')) mode = 'UPI';

    // Detect Type (Income vs Expense)
    if (['received', 'got', 'sale'].some(k => lower.includes(k))) {
        type = 'income';
        accountType = 'Income';
        if (lower.includes('refund')) category = 'Refunds';
        else if (type === 'income') category = 'Sales';
    } else {
        type = 'expense';
        accountType = 'Expense';
        // Simple keyword matching for better UX
        if (lower.includes('rent')) category = 'Rent';
        else if (lower.includes('salary')) category = 'Salary';
        else if (lower.includes('food') || lower.includes('lunch')) category = 'Office Supplies';
    }

    return { amount, type, mode, category, accountType, date, gstRate, isInclusiveGST, desc: text };
};

// --- DATABASE HELPERS ---
const readData = () => {
    if (!fs.existsSync(DATA_FILE)) {
        const initialData = { users: [], data: {} };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        if (!rawData || rawData.trim() === '') return { users: [], data: {} };
        return JSON.parse(rawData);
    } catch (e) {
        console.error("CRITICAL: Database Corrupted! Resetting...", e);
        try { if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE); } catch(unlinkErr) {}
        return { users: [], data: {} };
    }
};

const writeData = (data) => {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Failed to write DB:", e);
        throw e; 
    }
};

// --- ROUTES ---

// 1. SMART ENTRY API (The Brain)
app.post('/api/smart-entry', verifyToken, (req, res) => {
    try {
        const { text } = req.body; // Frontend sends raw text
        const uid = req.userId;

        // 1. Parse Text
        const parsed = parseTransactionText(text);
        if (parsed.amount === 0) return res.status(400).json({ error: 'No valid amount found' });

        // 2. Add Business ID
        const db = readData();
        const userBizs = db.data[uid] || {};
        const bizIds = Object.keys(userBizs);
        const currentBizId = bizIds.length > 0 ? bizIds[0] : null;

        if (!currentBizId) return res.status(404).json({ error: 'No business found' });

        // 3. Generate Double Entries using Accounting Engine
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

        // 4. Create Full Transaction Object (The "Event")
        const fullTx = {
            ...parsed,
            id: Date.now(),
            businessId: currentBizId,
            status: 'draft', // Starts as draft
            entries // IMPORTANT: Calculated by SERVER
        };

        // 5. Return Calculated Transaction to Frontend
        // This ensures "Accounting Knowledge" is correct
        res.json({ 
            success: true, 
            transaction: fullTx 
        });

    } catch (e) {
        console.error("Smart Entry Error:", e);
        res.status(500).json({ error: 'Failed to process entry' });
    }
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
    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).json({ error: 'Login failed' });
    }
