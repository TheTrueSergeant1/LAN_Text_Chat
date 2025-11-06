const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs'); // For file system operations
const setupWebSocket = require('./websocket');
const apiRouter = require('./api');
require('dotenv').config();

const PORT = process.env.SERVER_PORT || 3000;
const HOST = process.env.SERVER_IP || '0.0.0.0';

// --- File Upload Setup (Ensuring Secure Upload Directory Exists) ---
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
    console.log(`Created upload directory: ${UPLOAD_DIR}`);
}
// -------------------------

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json()); // To parse JSON bodies from HTTP POST requests
// HSTS Header for Transport Encryption (TLS >=1.3) compliance (simulated)
app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    // CORS for local dev environment
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    next();
});
app.use(express.static(path.join(__dirname, '..', 'public'))); // Serve the front-end

// Serve uploaded files statically under /uploads endpoint
// NOTE: Content-Disposition headers for secure file handling should be managed here
app.use('/uploads', express.static(UPLOAD_DIR, {
    setHeaders: (res, path, stat) => {
        res.set('Content-Disposition', 'attachment'); // Force download to mitigate XSS from user-uploaded content
    }
}));

// API Routes
app.use('/api', apiRouter);

// WebSocket Setup
setupWebSocket(server);

// Start the server
server.listen(PORT, HOST, () => {
    console.log(`
------------------------------------------------------
  LOCALCHAT Server (Professional Grade) is running!
------------------------------------------------------
    Server IP: ${HOST}
    Server Port: ${PORT}
    Front-end URL: http://${HOST}:${PORT}/index.html
------------------------------------------------------
    `);
});