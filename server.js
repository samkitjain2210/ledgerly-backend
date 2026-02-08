/**
 * LEDGERLY.AI BACKEND (Render Ready)
 * Enables multiple users to register and login instantly.
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const jwt = require('jsonwebtoken'); // This is already in your package.json
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'ledgerly_db.json');

// SECURITY: Use Render Environment Variable, or fallback
const JWT_SECRET = process.env.JWT_SECRET || 'ledgerly_fallback_secret_key_v4';

// --- MIDDLEWARE ---
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// Multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// --- AUTH MIDDLEWARE (Protects /api/sync) ---
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

// --- DATABASE HELPERS (JSON File) ---
const readData = () => {
    if (!fs.existsSync(DATA_FILE)) {
        // Initialize DB if missing
        const initialData = {
            users: [],
            data: {} 
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        if (!rawData) return { users: [], data: {} };
        return JSON.parse(rawData);
    } catch (e) {
        console.error("Database file error, resetting...", e);
        return { users: [], data: {} };
    }
};

const writeData = (data) => {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Failed to write DB:", e);
    }
};

// --- ROUTES ---

// Health Check
app.get('/', (req, res) => {
    res.send('Ledgerly.ai Backend is Running 🚀');
});

// 1. REGISTER ROUTE (Instant Login)
app.post('/api/auth/register', (req, res) => {
    try {
        const { email, password, name } = req.body;
        const db = readData();

        // 1. Check if user already exists
        const exists = db.users.find(u => u.email === email);
        if (exists) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // 2. Create Unique User ID
        const newUserId = 'u' + Date.now() + Math.floor(Math.random() * 1000);
        
        const newUser = {
            id: newUserId,
            email,
            password, // Note: In production, use bcryptjs to hash this!
            name,
            role: 'owner'
        };

        // 3. Add to Users Array
        db.users.push(newUser);

        // 4. Create a Default Business for this user
        const bizId = 'biz' + Date.now();
        const newBusiness = {
            id: bizId,
            name: `${name}'s Business`,
            transactions: [],
            lockedMonths: []
        };

        // 5. Link Business to User in Data
        db.data[newUserId] = {
            [bizId]: newBusiness
        };

        // 6. WRITE TO FILE
        writeData(db);

        // 7. Generate Token (Instant Login)
        const token = jwt.sign({ id: newUserId }, JWT_SECRET, { expiresIn: '7d' });

        // 8. Return Data (Format matches Frontend)
        res.json({
            token,
            user: newUser,
            businesses: [newBusiness],
            transactions: []
        });

        console.log(`✅ New User Registered: ${email}`);

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// 2. LOGIN ROUTE
app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;
        const db = readData();

        const user = db.users.find(u => u.email === email);

        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });

        // Fetch User's Businesses and Transactions
        const userBizs = db.data[user.id] || {};
        const businesses = Object.values(userBizs);
        const transactions = businesses.flatMap(b => b.transactions || []);

        res.json({
            token,
            user,
            businesses,
            transactions
        });

        console.log(`🔑 User Logged In: ${email}`);

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error during login' });
    }
});

// 3. SYNC ROUTES (Protected)
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
        console.error(e);
        res.status(500).json({ error: 'Sync failed' });
    }
});

app.post('/api/sync', verifyToken, (req, res) => {
    try {
        const { transactions } = req.body;
        const db = readData();
        const uid = req.userId;

        if (!db.data[uid]) return res.status(404).json({ error: 'User not found' });

        // Update Logic: Clear existing, re-add incoming
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
        console.error(e);
        res.status(500).json({ error: 'Save failed' });
    }
});

// 4. UPLOAD ENDPOINT (Protected)
app.post('/api/upload', verifyToken, upload.single('file'), (req, res) => {
    setTimeout(() => {
        const mockData = [
            { date: new Date().toISOString().split('T')[0], desc: 'Amazon Web Services', amount: 2500 },
            { date: new Date().toISOString().split('T')[0], desc: 'Client Payment #402', amount: 15000 },
            { date: new Date().toISOString().split('T')[0], desc: 'Office Snacks', amount: 450 }
        ];
        res.json({ success: true, data: mockData });
    }, 1000);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📁 Data File: ${DATA_FILE}`);
    console.log(`🔐 Ready for Login/Register`);
});
