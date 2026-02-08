/**
 * LEDGERLY.AI BACKEND
 * Handles data persistence, file uploads, and cross-origin requests.
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer'); // For handling file uploads
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'ledgerly_db.json');

// --- MIDDLEWARE ---
app.use(cors()); // Allow frontend to connect
app.use(bodyParser.json({ limit: '50mb' }));

// Configure Multer for file storage (keeps files in memory for this demo)
const upload = multer({ storage: multer.memoryStorage() });

// --- DATABASE HELPERS (Simple JSON Store) ---
const readData = () => {
    if (!fs.existsSync(DATA_FILE)) {
        // Return initial structure if file doesn't exist
        return {
            'u1': {
                'biz1': { transactions: [], lockedMonths: [] },
                'biz2': { transactions: [], lockedMonths: [] }
            }
        };
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
};

const writeData = (data) => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

// --- ROUTES ---

// 1. Sync Data (Get & Save)
// This endpoint handles both fetching the state and saving the full state.
app.get('/api/sync', (req, res) => {
    try {
        const data = readData();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to read data' });
    }
});

app.post('/api/sync', (req, res) => {
    try {
        const data = req.body;
        writeData(data);
        res.json({ success: true, message: 'Data synced successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save data' });
    }
});

// 2. Bank Import Endpoint
// Accepts a file, parses it (mocked for CSV/PDF), returns JSON data
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Simulate processing delay
    setTimeout(() => {
        // Mock parsing logic based on your frontend's expectation
        const mockData = [
            { date: '2023-10-25', desc: 'Amazon Web Services', amount: 2500 },
            { date: '2023-10-26', desc: 'Client Payment #402', amount: 15000 },
            { date: '2023-10-27', desc: 'Office Snacks', amount: 450 }
        ];
        res.json({ success: true, data: mockData });
    }, 1000);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`\n🚀 Ledgerly.ai Backend running at http://localhost:${PORT}`);
    console.log(`📁 Database file: ${DATA_FILE}`);
});