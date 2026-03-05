// server.js - Full Stack Backend with Logic + Database + APIs
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname))); // Serve index.html from root

// ============ DATABASE SETUP ============
const db = new Database(process.env.DB_PATH || 'nickflix.db');

// Create tables with better schema
db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT DEFAULT 'default-avatar.png',
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        movie_id INTEGER NOT NULL,
        movie_title TEXT NOT NULL,
        poster_path TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, movie_id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content_type TEXT NOT NULL CHECK(content_type IN ('movie', 'song', 'artist')),
        content_id TEXT NOT NULL,
        content_title TEXT NOT NULL,
        content_data TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, content_type, content_id)
    );

    CREATE TABLE IF NOT EXISTS search_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        search_term TEXT NOT NULL,
        search_type TEXT DEFAULT 'all',
        results_count INTEGER DEFAULT 0,
        searched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS movie_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT UNIQUE NOT NULL,
        cache_data TEXT NOT NULL,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        content_id TEXT NOT NULL,
        rating INTEGER CHECK(rating >= 1 AND rating <= 5),
        review TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, content_type, content_id)
    );

    CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_search_user ON search_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_cache_key ON movie_cache(cache_key);
`);

console.log('✅ Database connected and tables created');

// ============ MIDDLEWARE: Authentication ============
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ 
            success: false, 
            error: 'Authentication required' 
        });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({ 
                success: false, 
                error: 'Invalid or expired token' 
            });
        }
        req.user = user;
        next();
    });
};

// ============ API KEYS ============
const TMDB_API_KEY = process.env.TMDB_API_KEY || '5e3b7c3d5a5e5b7c3d5a5e5b7c3d5a5e';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const DEEZER_API = 'https://api.deezer.com';

// ============ CACHE MIDDLEWARE ============
const cacheMiddleware = (duration = 3600) => {
    return (req, res, next) => {
        const cacheKey = `cache:${req.originalUrl}`;
        
        try {
            const stmt = db.prepare('SELECT cache_data FROM movie_cache WHERE cache_key = ? AND (expires_at > datetime(\'now\') OR expires_at IS NULL)');
            const cached = stmt.get(cacheKey);
            
            if (cached) {
                return res.json(JSON.parse(cached.cache_data));
            }
            
            // Store original send function
            const originalSend = res.json;
            res.json = function(data) {
                // Cache the response
                const insertStmt = db.prepare(
                    'INSERT OR REPLACE INTO movie_cache (cache_key, cache_data, expires_at) VALUES (?, ?, datetime(\'now\', ?))'
                );
                insertStmt.run(cacheKey, JSON.stringify(data), `+${duration} seconds`);
                
                // Call original send
                originalSend.call(this, data);
            };
            
            next();
        } catch (error) {
            console.error('Cache error:', error);
            next();
        }
    };
};

// ============ AUTHENTICATION ENDPOINTS ============
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Validation
        if (!username || !email || !password) {
            return res.status(400).json({ 
                success: false, 
                error: 'All fields are required' 
            });
        }

        if (password.length < 6) {
            return res.status(400).json({ 
                success: false, 
                error: 'Password must be at least 6 characters' 
            });
        }

        // Hash password
        const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Insert user
        const stmt = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)');
        const result = stmt.run(username, email, hashedPassword);

        // Create token
        const token = jwt.sign(
            { id: result.lastInsertRowid, username, email },
            process.env.JWT_SECRET || 'secret-key',
            { expiresIn: '7d' }
        );

        res.json({ 
            success: true, 
            token,
            user: { 
                id: result.lastInsertRowid, 
                username, 
                email 
            }
        });
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') {
            return res.status(400).json({ 
                success: false, 
                error: 'Username or email already exists' 
            });
        }
        console.error('Registration error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Registration failed' 
        });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Find user
        const stmt = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?');
        const user = stmt.get(username, username);

        if (!user) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid credentials' 
            });
        }

        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ 
                success: false, 
                error: 'Invalid credentials' 
            });
        }

        // Update last login
        db.prepare('UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

        // Create token
        const token = jwt.sign(
            { id: user.id, username: user.username, email: user.email },
            process.env.JWT_SECRET || 'secret-key',
            { expiresIn: '7d' }
        );

        res.json({ 
            success: true, 
            token,
            user: { 
                id: user.id, 
                username: user.username, 
                email: user.email 
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Login failed' 
        });
    }
});

app.get('/api/verify', authenticateToken, (req, res) => {
    res.json({ 
        success: true, 
        user: req.user 
    });
});

// ============ MOVIE API ENDPOINTS ============
app.get('/api/movies/popular', cacheMiddleware(3600), async (req, res) => {
    try {
        const response = await axios.get(
            `${TMDB_BASE_URL}/movie/popular?api_key=${TMDB_API_KEY}&language=en-US&page=1`
        );
        res.json(response.data);
    } catch (error) {
        console.error('TMDB API error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch movies' 
        });
    }
});

app.get('/api/movies/now-playing', cacheMiddleware(3600), async (req, res) => {
    try {
        const response = await axios.get(
            `${TMDB_BASE_URL}/movie/now_playing?api_key=${TMDB_API_KEY}&language=en-US&page=1`
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch movies' });
    }
});

app.get('/api/movies/top-rated', cacheMiddleware(3600), async (req, res) => {
    try {
        const response = await axios.get(
            `${TMDB_BASE_URL}/movie/top_rated?api_key=${TMDB_API_KEY}&language=en-US&page=1`
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch movies' });
    }
});

app.get('/api/movies/upcoming', cacheMiddleware(3600), async (req, res) => {
    try {
        const response = await axios.get(
            `${TMDB_BASE_URL}/movie/upcoming?api_key=${TMDB_API_KEY}&language=en-US&page=1`
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch movies' });
    }
});

app.get('/api/movies/search', async (req, res) => {
    const { query, page = 1 } = req.query;
    
    if (!query) {
        return res.status(400).json({ 
            success: false, 
            error: 'Search query is required' 
        });
    }

    try {
        const response = await axios.get(
            `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${page}`
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Search failed' 
        });
    }
});

app.get('/api/movies/:id', cacheMiddleware(3600), async (req, res) => {
    const { id } = req.params;
    
    try {
        const response = await axios.get(
            `${TMDB_BASE_URL}/movie/${id}?api_key=${TMDB_API_KEY}&append_to_response=videos,credits,similar`
        );
        res.json(response.data);
    } catch (error) {
        res.status(404).json({ 
            success: false, 
            error: 'Movie not found' 
        });
    }
});

// ============ MUSIC API ENDPOINTS ============
app.get('/api/music/trending', cacheMiddleware(1800), async (req, res) => {
    try {
        const response = await axios.get(`${DEEZER_API}/chart/0/tracks`);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch music' 
        });
    }
});

app.get('/api/music/search', async (req, res) => {
    const { query } = req.query;
    
    if (!query) {
        return res.status(400).json({ 
            success: false, 
            error: 'Search query is required' 
        });
    }

    try {
        const response = await axios.get(
            `${DEEZER_API}/search?q=${encodeURIComponent(query)}`
        );
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Music search failed' 
        });
    }
});

app.get('/api/music/artist/:id', cacheMiddleware(3600), async (req, res) => {
    const { id } = req.params;
    
    try {
        const response = await axios.get(`${DEEZER_API}/artist/${id}`);
        res.json(response.data);
    } catch (error) {
        res.status(404).json({ 
            success: false, 
            error: 'Artist not found' 
        });
    }
});

// ============ TRAILER ENDPOINT ============
app.get('/api/trailer/:movie', async (req, res) => {
    const { movie } = req.params;
    
    try {
        // Fallback to YouTube search URL
        res.json({ 
            success: true,
            url: `https://www.youtube.com/results?search_query=${encodeURIComponent(movie + ' official trailer')}`
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to get trailer' 
        });
    }
});

// ============ WATCHLIST ENDPOINTS ============
app.get('/api/watchlist', authenticateToken, (req, res) => {
    try {
        const stmt = db.prepare(`
            SELECT * FROM watchlist 
            WHERE user_id = ? 
            ORDER BY added_at DESC
        `);
        const watchlist = stmt.all(req.user.id);
        res.json({ success: true, data: watchlist });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to load watchlist' 
        });
    }
});

app.post('/api/watchlist', authenticateToken, (req, res) => {
    const { movie_id, movie_title, poster_path } = req.body;
    
    if (!movie_id || !movie_title) {
        return res.status(400).json({ 
            success: false, 
            error: 'Movie ID and title are required' 
        });
    }

    try {
        const stmt = db.prepare(
            'INSERT OR IGNORE INTO watchlist (user_id, movie_id, movie_title, poster_path) VALUES (?, ?, ?, ?)'
        );
        const result = stmt.run(req.user.id, movie_id, movie_title, poster_path);
        
        res.json({ 
            success: true, 
            id: result.lastInsertRowid,
            message: 'Added to watchlist' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to add to watchlist' 
        });
    }
});

app.delete('/api/watchlist/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    
    try {
        const stmt = db.prepare('DELETE FROM watchlist WHERE id = ? AND user_id = ?');
        const result = stmt.run(id, req.user.id);
        
        if (result.changes === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Item not found' 
            });
        }
        
        res.json({ 
            success: true, 
            message: 'Removed from watchlist' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to remove from watchlist' 
        });
    }
});

// ============ FAVORITES ENDPOINTS ============
app.get('/api/favorites', authenticateToken, (req, res) => {
    try {
        const stmt = db.prepare(`
            SELECT * FROM favorites 
            WHERE user_id = ? 
            ORDER BY added_at DESC
        `);
        const favorites = stmt.all(req.user.id);
        res.json({ success: true, data: favorites });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to load favorites' 
        });
    }
});

app.post('/api/favorites', authenticateToken, (req, res) => {
    const { content_type, content_id, content_title, content_data } = req.body;
    
    try {
        const stmt = db.prepare(
            'INSERT OR IGNORE INTO favorites (user_id, content_type, content_id, content_title, content_data) VALUES (?, ?, ?, ?, ?)'
        );
        const result = stmt.run(req.user.id, content_type, content_id, content_title, content_data);
        
        res.json({ 
            success: true, 
            id: result.lastInsertRowid 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to add to favorites' 
        });
    }
});

app.delete('/api/favorites/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    
    try {
        const stmt = db.prepare('DELETE FROM favorites WHERE id = ? AND user_id = ?');
        stmt.run(id, req.user.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to remove from favorites' 
        });
    }
});

// ============ SEARCH HISTORY ENDPOINTS ============
app.post('/api/search/history', authenticateToken, (req, res) => {
    const { search_term, search_type = 'all', results_count = 0 } = req.body;
    
    try {
        const stmt = db.prepare(
            'INSERT INTO search_history (user_id, search_term, search_type, results_count) VALUES (?, ?, ?, ?)'
        );
        stmt.run(req.user.id, search_term, search_type, results_count);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to save search history' 
        });
    }
});

app.get('/api/search/history', authenticateToken, (req, res) => {
    try {
        const stmt = db.prepare(`
            SELECT * FROM search_history 
            WHERE user_id = ? 
            ORDER BY searched_at DESC 
            LIMIT 20
        `);
        const history = stmt.all(req.user.id);
        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to load search history' 
        });
    }
});

// ============ RATINGS ENDPOINTS ============
app.post('/api/ratings', authenticateToken, (req, res) => {
    const { content_type, content_id, rating, review } = req.body;
    
    if (!content_type || !content_id || !rating) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing required fields' 
        });
    }

    if (rating < 1 || rating > 5) {
        return res.status(400).json({ 
            success: false, 
            error: 'Rating must be between 1 and 5' 
        });
    }

    try {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO ratings 
            (user_id, content_type, content_id, rating, review) 
            VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(req.user.id, content_type, content_id, rating, review);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to save rating' 
        });
    }
});

app.get('/api/ratings/:contentType/:contentId', (req, res) => {
    const { contentType, contentId } = req.params;
    
    try {
        const stmt = db.prepare(`
            SELECT AVG(rating) as average, COUNT(*) as count 
            FROM ratings 
            WHERE content_type = ? AND content_id = ?
        `);
        const stats = stmt.get(contentType, contentId);
        
        res.json({ 
            success: true, 
            data: stats 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to load ratings' 
        });
    }
});

// ============ RECOMMENDATIONS ENGINE ============
app.get('/api/recommendations', authenticateToken, (req, res) => {
    try {
        // Get user's watchlist and favorites
        const watchStmt = db.prepare('SELECT movie_title FROM watchlist WHERE user_id = ?');
        const watchlist = watchStmt.all(req.user.id);
        
        const favStmt = db.prepare('SELECT content_title FROM favorites WHERE user_id = ?');
        const favorites = favStmt.all(req.user.id);
        
        // Get user's search history
        const searchStmt = db.prepare(`
            SELECT search_term FROM search_history 
            WHERE user_id = ? 
            GROUP BY search_term 
            ORDER BY COUNT(*) DESC 
            LIMIT 5
        `);
        const searches = searchStmt.all(req.user.id);
        
        // Generate recommendations based on user activity
        const recommendations = {
            based_on_watchlist: watchlist.map(w => w.movie_title),
            based_on_favorites: favorites.map(f => f.content_title),
            based_on_searches: searches.map(s => s.search_term),
            suggested: [
                { type: 'movie', title: 'Popular in your region', reason: 'Trending now' },
                { type: 'movie', title: 'Because you watched...', reason: 'Based on your history' },
                { type: 'song', title: 'Recommended for you', reason: 'Music you might like' }
            ]
        };
        
        res.json({ 
            success: true, 
            data: recommendations 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to generate recommendations' 
        });
    }
});

// ============ ANALYTICS ENDPOINT ============
app.get('/api/analytics', authenticateToken, (req, res) => {
    try {
        const stats = {
            user: {
                watchlist_count: db.prepare('SELECT COUNT(*) as count FROM watchlist WHERE user_id = ?').get(req.user.id).count,
                favorites_count: db.prepare('SELECT COUNT(*) as count FROM favorites WHERE user_id = ?').get(req.user.id).count,
                searches_count: db.prepare('SELECT COUNT(*) as count FROM search_history WHERE user_id = ?').get(req.user.id).count,
                ratings_count: db.prepare('SELECT COUNT(*) as count FROM ratings WHERE user_id = ?').get(req.user.id).count
            },
            global: {
                total_users: db.prepare('SELECT COUNT(*) as count FROM users').get().count,
                total_watchlist: db.prepare('SELECT COUNT(*) as count FROM watchlist').get().count,
                total_favorites: db.prepare('SELECT COUNT(*) as count FROM favorites').get().count,
                total_searches: db.prepare('SELECT COUNT(*) as count FROM search_history').get().count
            },
            popular_searches: db.prepare(`
                SELECT search_term, COUNT(*) as count 
                FROM search_history 
                GROUP BY search_term 
                ORDER BY count DESC 
                LIMIT 10
            `).all()
        };
        
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to load analytics' 
        });
    }
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({ 
        success: true,
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        node_version: process.version,
        database: 'connected',
        apis: {
            tmdb: !!TMDB_API_KEY,
            deezer: true
        }
    });
});

// ============ SERVE FRONTEND ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============ ERROR HANDLING MIDDLEWARE ============
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
    });
});

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 NICKFLIX SERVER RUNNING`);
    console.log('='.repeat(50));
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`🟢 Node.js: ${process.version}`);
    console.log(`💾 Database: ${process.env.DB_PATH || 'nickflix.db'}`);
    console.log('='.repeat(50));
    console.log(`📊 API Endpoints:`);
    console.log(`   GET  /api/health`);
    console.log(`   POST /api/register`);
    console.log(`   POST /api/login`);
    console.log(`   GET  /api/movies/popular`);
    console.log(`   GET  /api/movies/search?query=`);
    console.log(`   GET  /api/music/trending`);
    console.log(`   GET  /api/watchlist (protected)`);
    console.log(`   POST /api/watchlist (protected)`);
    console.log('='.repeat(50));
});
