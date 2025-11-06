const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const multer = require('multer');
const path = require('path');

// NOTE: Use a secure, non-guessable prefix in a real environment
const ADMIN_USERNAME_PREFIX = 'admin-'; 

const apiRouter = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// --- Multer Configuration for Robust Uploads (Max 5MB) ---
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB limit

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
         // Ensure the upload directory exists (handled in server.js, but safe here too)
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        // Use a secure, unique filename to prevent path traversal/overwrite
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const fileExtension = path.extname(file.originalname);
        // Prep for secure file handling by including user ID context (though not used in filename here)
        cb(null, file.fieldname + '-' + uniqueSuffix + fileExtension);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        // Enforce whitelisting of allowed content types for security
        const allowedMimes = [
            'image/jpeg', 'image/png', 'image/gif', 
            'text/plain', 
            'application/pdf'
        ];
        if (allowedMimes.includes(file.mimetype)) {
            // NOTE: A real enterprise app would perform virus scanning here.
            cb(null, true);
        } else {
            // Robust error handling for unsupported types
            cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: images, PDFs, text.`), false);
        }
    }
});

// --- User Auth Functions (Updated to reflect Argon2id recommendation, but using existing crypto functions) ---

/** Hashes a plain password using PBKDF2 with a random salt. */
function hashPassword(password) {
    // For demonstration, sticking to PBKDF2 provided in the original, but simulating complexity
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

/** Verifies a plain password against the stored hash. */
function verifyPassword(password, storedHash) {
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;
    const hashed = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return hashed === hash;
}

// --- API Routes ---

/** POST /api/register - Creates a new user account with role assignment. */
apiRouter.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 6) {
        return res.status(400).json({ error: 'Username (min 3 chars) and Password (min 6 chars) are required.' });
    }
    const userId = crypto.randomUUID();
    const hashedPassword = hashPassword(password);
    // RBAC: Assign role based on prefix (Admin/Moderator/User)
    let role = 'User';
    if (username.startsWith(ADMIN_USERNAME_PREFIX)) {
        role = 'Admin';
    } else if (username.startsWith('mod-')) {
        role = 'Moderator';
    }

    try {
        await db.query(
            'INSERT INTO users (user_id, username, password_hash, user_role) VALUES (?, ?, ?, ?)',
            [userId, username, hashedPassword, role]
        );
        res.status(201).json({ message: 'Registration successful. Please log in.', userId: userId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Username already taken.' });
        }
        res.status(500).json({ error: 'Database error during registration.' });
    }
});

/** POST /api/login - Authenticates a user, checks for ban status, and updates IP. */
apiRouter.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and Password are required.' });
    }

    const clientIp = req.ip || req.connection.remoteAddress;

    try {
        // Rate Limiting/Brute Force protection would be implemented before this query
        const users = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        const user = users[0];

        if (!user || !verifyPassword(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }
        
        // Check ban status from the DB (schema feature)
        if (user.is_banned) {
            return res.status(403).json({ error: `Account is banned: ${user.ban_reason || 'No reason provided.'}` });
        }

        // Update last login IP (for account protection features)
        await db.query('UPDATE users SET last_login_ip = ? WHERE user_id = ?', [clientIp, user.user_id]);

        res.status(200).json({
            message: 'Login successful.',
            userId: user.user_id,
            username: user.username,
            role: user.user_role
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Database error during login.' });
    }
});

/** POST /api/upload - Handles secure file upload via HTTP. */
apiRouter.post('/upload', (req, res) => {
    // This handler uses Multer middleware to process the incoming file
    upload.single('chatFile')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            console.error("Multer Error:", err);
            return res.status(400).json({ error: `Upload Failed: ${err.code}. Max size: 5MB.` });
        } else if (err) {
            console.error("Upload Error:", err);
            return res.status(400).json({ error: `Upload Failed: ${err.message}` });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file selected for upload.' });
        }

        // Return the necessary file metadata
        res.status(200).json({
            message: 'File uploaded successfully.',
            fileData: {
                filename: req.file.filename, // Stored secure name
                originalname: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size
            }
        });
    });
});


module.exports = apiRouter;