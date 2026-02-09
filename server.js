/**
 * LEDGERLY.AI BACKEND (Render Robust)
 * Fixes: Corrupt DB handling, and strict JSON checks.
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

const JWT_SECRET = process.env.JWT_SECRET || 'ledgerly_fallback_secret_key_v4';

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
            if (err) {
                return res.status(401).json({ error: 'Invalid Token' });
            } else {
                req.userId = authData.id;
                next();
            }
        });
    } else {
        res.status(403).json({ error: 'No token provided' });
    }
};

// --- DATABASE HELPERS (FAIL SAFE) ---
const readData = () => {
    try {
        // If file doesn't exist, return default
        if (!fs.existsSync(DATA_FILE)) {
            console.log("DB missing. Creating new one.");
            return { users: [], data: {} };
        }

        const rawData = fs.readFileSync(DATA_FILE, 'utf8');

        // Check for empty file
        if (!rawData || rawData.trim() === '') {
            console.log("DB empty. Resetting.");
            return { users: [], data: {} };
        }

        const parsed = JSON.parse(rawData);
        
        // Validate Structure
        if (!parsed.users || !parsed.data) {
            console.error("DB Structure Invalid. Resetting.");
            return { users: [], data: {} };
        }

        return parsed;

    } catch (e) {
        console.error("CRITICAL: Database Corrupted! Resetting...", e);
        
        // NUCLEAR OPTION: Delete bad file so next write succeeds
        try {
            if (fs.existsSync(DATA_FILE)) {
                fs.unlinkSync(DATA_FILE);
            }
        } catch(unlinkErr) {
            console.error("Could not delete DB:", unlinkErr);
        }
        
        // Return fresh structure
        return { users: [], data: {} };
    }
};

const writeData = (data) => {
    try {
        // Force write
        const jsonStr = JSON.stringify(data, null, 2);
        fs.writeFileSync(DATA_FILE, jsonStr);
    } catch (e) {
        console.error("CRITICAL: Write Failed!", e);
        throw e; // Re-throw so route returns 500
    }
};

// --- ROUTES ---

app.get('/', (req, res) => {
    res.send('Ledgerly.ai Backend is Running 🚀');
});

// 1. REGISTER
app.post('/api/auth/register', (req, res) => {
    try {
        const { email, password, name } = req.body;
        const db = readData();

        // Safety Check
        if (!db.users) db.users = [];
        if (!db.data) db.data = {};

        // Check existence
        const exists = db.users.find(u => u.email === email);
        if (exists) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Create User
        const newUserId = 'u' + Date.now() + Math.floor(Math.random() * 1000);
        const newUser = {
            id: newUserId,
            email,
            password,
            name,
            role: 'owner'
        };

        db.users.push(newUser);

        // Create Business
        const bizId = 'biz' + Date.now();
        const newBusiness = {
            id: bizId,
            name: `${name}'s Business`,
            transactions: [],
            lockedMonths: []
        };

        db.data[newUserId] = {
            [bizId]: newBusiness
        };

        writeData(db);

        const token = jwt.sign({ id: newUserId }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            token,
            user: newUser,
            businesses: [newBusiness],
            transactions: []
        });

        console.log(`✅ Registered: ${email}`);

    } catch (e) {
        console.error("Register Error:", e);
        res.status(500).json({ error: 'Server error during registration' });
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

        console.log(`🔑 Login: ${email}`);

    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).json({ error: 'Login failed' });
    }
});

// 3. SYNC
app.get('/api/sync', verifyToken, (req, res) => {
    try {
        const db = readData();
        const uid = req.userId;

        if (!db.data[uid]) {
            return res.json({ user: {}, businesses: [], transactions: [] });
        }

        const businesses = Object.values(db.data[uid]);
        const transactions = businesses.flatMap(b => b.transactions || []);
        const user = db.users.find(u => u.id === uid);

        res.json({
            user,
            businesses,
            transactions
        });
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

// 4. UPLOAD
app.post('/api/upload', verifyToken, upload.single('file'), (req, res) => {
    setTimeout(() => {
        const mockData = [
            { date: new Date().toISOString().split('T')[0], desc: 'Amazon Web Services', amount: 2500 },
            { date: new Date().toISOString().split('T')[0], desc: 'Client Payment #402', amount: 15000 }
        ];
        res.json({ success: true, data: mockData });
    }, 1000);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
