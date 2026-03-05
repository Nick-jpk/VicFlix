// server.js - Backend Logic + APIs + Database
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ DATABASE SETUP (SQLite) ============
const db = new Database('nickflix.db');

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        movie_id INTEGER,
        movie_title TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        content_type TEXT, -- 'movie' or 'song'
        content_id TEXT,
        content_title TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS search_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        search_term TEXT,
        searched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS movie_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        movie_id TEXT UNIQUE,
        movie_data TEXT,
        cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// ============ MIDDLEWARE: Authentication ============
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Authentication required' });

    jwt.verify(token, process.env.JWT_SECRET || 'secret-key', (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

// ============ API KEYS (from .env) ============
const TMDB_API_KEY = process.env.TMDB_API_KEY || '5e3b7c3d5a5e5b7c3d5a5e5b7c3d5a5e';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const DEEZER_API = 'https://api.deezer.com';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// ============ AUTHENTICATION ENDPOINTS ============
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user
        const stmt = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)');
        const result = stmt.run(username, email, hashedPassword);

        // Create token
        const token = jwt.sign(
            { id: result.lastInsertRowid, username },
            process.env.JWT_SECRET || 'secret-key'
        );

        res.json({ 
            success: true, 
            token,
            user: { id: result.lastInsertRowid, username, email }
        });
    } catch (error) {
        res.status(400).json({ error: 'User already exists' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Find user
        const stmt = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?');
        const user = stmt.get(username, username);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Create token
        const token = jwt.sign(
            { id: user.id, username: user.username },
            process.env.JWT_SECRET || 'secret-key'
        );

        res.json({ 
            success: true, 
            token,
            user: { id: user.id, username: user.username, email: user.email }
        });
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
});

// ============ MOVIE API ENDPOINTS (with caching) ============
app.get('/api/movies/popular', async (req, res) => {
    try {
        // Check cache first
        const cacheStmt = db.prepare('SELECT movie_data FROM movie_cache WHERE movie_id = ?');
        const cached = cacheStmt.get('popular');

        if (cached) {
            return res.json(JSON.parse(cached.movie_data));
        }

        // Fetch from TMDB
        const response = await axios.get(
            `${TMDB_BASE_URL}/movie/popular?api_key=${TMDB_API_KEY}&language=en-US&page=1`
        );

        // Cache the result
        const insertStmt = db.prepare('INSERT OR REPLACE INTO movie_cache (movie_id, movie_data) VALUES (?, ?)');
        insertStmt.run('popular', JSON.stringify(response.data));

        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch movies' });
    }
});

app.get('/api/movies/search', async (req, res) => {
    const { query } = req.query;
    
    try {
        const response = await axios.get(
            `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Search failed' });
    }
});

app.get('/api/movies/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const response = await axios.get(
            `${TMDB_BASE_URL}/movie/${id}?api_key=${TMDB_API_KEY}&append_to_response=videos,credits`
        );
        res.json(response.data);
    } catch (error) {
        res.status(404).json({ error: 'Movie not found' });
    }
});

// ============ MUSIC API ENDPOINTS ============
app.get('/api/music/trending', async (req, res) => {
    try {
        const response = await axios.get(`${DEEZER_API}/chart/0/tracks`);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch music' });
    }
});

app.get('/api/music/search', async (req, res) => {
    const { query } = req.query;
    
    try {
        const response = await axios.get(
            `${DEEZER_API}/search?q=${encodeURIComponent(query)}`
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Music search failed' });
    }
});

// ============ YOUTUBE TRAILER API ============
app.get('/api/trailer/:movie', async (req, res) => {
    const { movie } = req.params;
    
    try {
        const response = await axios.get(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(movie + ' trailer')}&key=${YOUTUBE_API_KEY}&maxResults=1&type=video`
        );
        res.json(response.data);
    } catch (error) {
        // Fallback to YouTube search URL
        res.json({ 
            fallback: true,
            url: `https://www.youtube.com/results?search_query=${encodeURIComponent(movie + ' trailer')}`
        });
    }
});

// ============ USER WATCHLIST (Protected) ============
app.get('/api/watchlist', authenticateToken, (req, res) => {
    const stmt = db.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC');
    const watchlist = stmt.all(req.user.id);
    res.json(watchlist);
});

app.post('/api/watchlist', authenticateToken, (req, res) => {
    const { movie_id, movie_title } = req.body;
    
    const stmt = db.prepare('INSERT INTO watchlist (user_id, movie_id, movie_title) VALUES (?, ?, ?)');
    const result = stmt.run(req.user.id, movie_id, movie_title);
    
    res.json({ 
        success: true, 
        id: result.lastInsertRowid,
        message: 'Added to watchlist' 
    });
});

app.delete('/api/watchlist/:id', authenticateToken, (req, res) => {
    const stmt = db.prepare('DELETE FROM watchlist WHERE id = ? AND user_id = ?');
    const result = stmt.run(req.params.id, req.user.id);
    
    res.json({ 
        success: true,
        message: 'Removed from watchlist' 
    });
});

// ============ USER FAVORITES ============
app.get('/api/favorites', authenticateToken, (req, res) => {
    const stmt = db.prepare('SELECT * FROM favorites WHERE user_id = ? ORDER BY added_at DESC');
    const favorites = stmt.all(req.user.id);
    res.json(favorites);
});

app.post('/api/favorites', authenticateToken, (req, res) => {
    const { content_type, content_id, content_title } = req.body;
    
    const stmt = db.prepare(
        'INSERT INTO favorites (user_id, content_type, content_id, content_title) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(req.user.id, content_type, content_id, content_title);
    
    res.json({ success: true, id: result.lastInsertRowid });
});

// ============ SEARCH HISTORY ============
app.post('/api/search/history', authenticateToken, (req, res) => {
    const { search_term } = req.body;
    
    const stmt = db.prepare('INSERT INTO search_history (user_id, search_term) VALUES (?, ?)');
    stmt.run(req.user.id, search_term);
    
    res.json({ success: true });
});

app.get('/api/search/history', authenticateToken, (req, res) => {
    const stmt = db.prepare('SELECT * FROM search_history WHERE user_id = ? ORDER BY searched_at DESC LIMIT 10');
    const history = stmt.all(req.user.id);
    res.json(history);
});

// ============ RECOMMENDATIONS ENGINE (Logic) ============
app.get('/api/recommendations', authenticateToken, (req, res) => {
    // Get user's watchlist and favorites
    const watchStmt = db.prepare('SELECT movie_title FROM watchlist WHERE user_id = ?');
    const watchlist = watchStmt.all(req.user.id);
    
    const favStmt = db.prepare('SELECT content_title FROM favorites WHERE user_id = ?');
    const favorites = favStmt.all(req.user.id);
    
    // Combine user preferences
    const preferences = [...watchlist.map(w => w.movie_title), ...favorites.map(f => f.content_title)];
    
    // Generate recommendations based on preferences
    // This is where your business logic goes
    const recommendations = [
        { type: 'movie', title: 'Based on your watchlist', reason: 'You watched similar movies' },
        { type: 'song', title: 'Recommended for you', reason: 'Based on your favorites' }
    ];
    
    res.json({ preferences, recommendations });
});

// ============ ANALYTICS ENDPOINT (Backend Logic) ============
app.get('/api/analytics', authenticateToken, (req, res) => {
    const stats = {
        totalUsers: db.prepare('SELECT COUNT(*) as count FROM users').get(),
        totalWatchlist: db.prepare('SELECT COUNT(*) as count FROM watchlist').get(),
        totalFavorites: db.prepare('SELECT COUNT(*) as count FROM favorites').get(),
        popularSearches: db.prepare(`
            SELECT search_term, COUNT(*) as count 
            FROM search_history 
            GROUP BY search_term 
            ORDER BY count DESC 
            LIMIT 5
        `).all()
    };
    
    res.json(stats);
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        database: 'connected',
        apis: {
            tmdb: !!TMDB_API_KEY,
            youtube: !!YOUTUBE_API_KEY,
            deezer: true
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 API endpoints:`);
    console.log(`   - GET  /api/movies/popular`);
    console.log(`   - GET  /api/movies/search?query=`);
    console.log(`   - GET  /api/music/trending`);
    console.log(`   - POST /api/login`);
    console.log(`   - POST /api/register`);
    console.log(`   - GET  /api/watchlist (protected)`);
    console.log(`   - POST /api/favorites (protected)`);
});
