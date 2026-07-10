const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const db = new sqlite3.Database('./connected2me.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        pin TEXT,
        bio TEXT DEFAULT '',
        avatar TEXT DEFAULT ''
    )`);
    db.all("PRAGMA table_info(users)", (err, columns) => {
        if (columns) {
            if (!columns.some(col => col.name === 'bio')) db.run("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");
            if (!columns.some(col => col.name === 'avatar')) db.run("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''");
        }
    });
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        to_user TEXT,
        anon_id TEXT,
        sender TEXT,
        text TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        seen INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        media TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS story_views (
        story_id INTEGER,
        username TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(story_id, username)
    )`);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));

const anonMap = {};

function getAccountAnonId(username) {
    return 'anon_' + crypto.createHash('md5').update(username + "_secretSalt123").digest('hex').substring(0, 6);
}

function pushInboxToUser(username) {
    if(!username) return;
    const accountAnonId = getAccountAnonId(username);
    let unifiedChats = {};

    db.all("SELECT username, avatar FROM users", [], (err, users) => {
        const avatarMap = {};
        if (users) users.forEach(u => avatarMap[u.username] = u.avatar);

        db.all("SELECT * FROM messages WHERE to_user = ? ORDER BY timestamp ASC", [username], (err, receivedRows) => {
            if (receivedRows) {
                receivedRows.forEach(row => {
                    const chatId = `received_${row.anon_id}`;
                    if (!unifiedChats[chatId]) unifiedChats[chatId] = { type: 'received', partnerId: row.anon_id, messages: [] };
                    unifiedChats[chatId].messages.push({ sender: row.sender, text: row.text, seen: row.seen, timestamp: row.timestamp });
                });
            }

            db.all("SELECT * FROM messages WHERE anon_id = ? AND to_user != ? ORDER BY timestamp ASC", [accountAnonId, username], (err, sentRows) => {
                if (sentRows) {
                    sentRows.forEach(row => {
                        const chatId = `sent_${row.to_user}`;
                        if (!unifiedChats[chatId]) unifiedChats[chatId] = { type: 'sent', partnerId: row.to_user, messages: [], partnerAvatar: avatarMap[row.to_user] || '' };
                        unifiedChats[chatId].messages.push({ sender: row.sender, text: row.text, seen: row.seen, timestamp: row.timestamp });
                    });
                }

                db.get("SELECT bio, avatar FROM users WHERE username = ?", [username], (err, userProfile) => {
                    io.to(username).emit('unified-inbox-data', {
                        chats: unifiedChats,
                        accountAnonId: accountAnonId,
                        profile: userProfile || { bio: '', avatar: '' }
                    });
                });
            });
        });
    });
}

function pushAllStories(targetSocket) {
    db.all(`
        SELECT stories.*, users.avatar, 
               (SELECT COUNT(*) FROM story_views WHERE story_id = stories.id) as views 
        FROM stories 
        JOIN users ON stories.username = users.username 
        ORDER BY stories.timestamp DESC
    `, [], (err, rows) => {
        if (targetSocket) targetSocket.emit('all-stories-data', rows || []);
        else io.emit('all-stories-data', rows || []);
    });
}

io.on('connection', (socket) => {
    socket.on('auth-request', ({ username, pin, isLogin }) => {
        username = username.trim().toLowerCase(); pin = pin.trim();
        if (!username || !pin) return;
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (isLogin) {
                if (!row) socket.emit('auth-error', "User does not exist!");
                else if (row.pin !== pin) socket.emit('auth-error', "Incorrect PIN!");
                else socket.emit('auth-success', { username, pin });
            } else {
                if (row) socket.emit('auth-error', "Username already taken!");
                else db.run("INSERT INTO users (username, pin) VALUES (?, ?)", [username, pin], () => socket.emit('auth-success', { username, pin }));
            }
        });
    });

    socket.on('register-user', ({ username, pin }) => {
        username = username.trim().toLowerCase(); pin = pin.trim();
        if (!username || !pin) return;
        db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
            if (row && row.pin === pin) {
                socket.join(username);
                const anonId = getAccountAnonId(username);
                anonMap[anonId] = username;
                pushInboxToUser(username);
            }
        });
    });

    socket.on('upload-story', ({ username, media }) => {
        if(!username || !media) return;
        db.run("INSERT INTO stories (username, media) VALUES (?, ?)", [username.toLowerCase(), media], () => {
            pushAllStories();
        });
    });

    socket.on('view-story', ({ storyId, username }) => {
        if(!storyId || !username) return;
        db.run("INSERT OR IGNORE INTO story_views (story_id, username) VALUES (?, ?)", [storyId, username.toLowerCase()], function(err) {
            if (this.changes > 0) pushAllStories();
        });
    });

    socket.on('get-stories', () => pushAllStories(socket));

    socket.on('search-users', (query) => {
        const searchTerm = `%${query.trim().toLowerCase()}%`;
        db.all("SELECT username, bio, avatar FROM users WHERE username LIKE ?", [searchTerm], (err, rows) => {
            socket.emit('search-results', rows || []);
        });
    });

    socket.on('get-public-profile', (targetUser) => {
        targetUser = targetUser.toLowerCase();
        db.get("SELECT username, bio, avatar FROM users WHERE username = ?", [targetUser], (err, userRow) => {
            if(userRow) {
                db.all(`
                    SELECT stories.*, 
                           (SELECT COUNT(*) FROM story_views WHERE story_id = stories.id) as views 
                    FROM stories 
                    WHERE username = ? 
                    ORDER BY timestamp DESC
                `, [targetUser], (err, storyRows) => {
                    socket.emit('public-profile-data', { user: userRow, stories: storyRows || [] });
                });
            }
        });
    });

    socket.on('update-profile', ({ username, bio, avatar }) => {
        db.run("UPDATE users SET bio = ?, avatar = ? WHERE username = ?", [bio, avatar, username.toLowerCase()], () => {
            pushInboxToUser(username);
            pushAllStories();
        });
    });

    socket.on('join-chat', ({ targetUser, anonId }) => socket.join(`${targetUser}_${anonId}`));

    socket.on('send-anon-message', ({ myUsername, toUser, text }) => {
        const anonId = getAccountAnonId(myUsername);
        db.run("INSERT INTO messages (to_user, anon_id, sender, text, seen) VALUES (?, ?, 'anon', ?, 0)", [toUser, anonId, text], () => {
            pushInboxToUser(toUser); pushInboxToUser(myUsername);
        });
    });

    socket.on('send-user-reply', ({ myUsername, toAnonId, text }) => {
        db.run("INSERT INTO messages (to_user, anon_id, sender, text, seen) VALUES (?, ?, ?, ?, 0)", [myUsername, toAnonId, myUsername, text], () => {
            pushInboxToUser(myUsername);
            const targetUsername = anonMap[toAnonId];
            if(targetUsername) pushInboxToUser(targetUsername);
        });
    });

    socket.on('mark-seen', ({ myUsername, partnerId, mode }) => {
        const myAnonId = getAccountAnonId(myUsername);
        if (mode === 'received') {
            db.run("UPDATE messages SET seen = 1 WHERE to_user = ? AND anon_id = ? AND sender = 'anon'", [myUsername, partnerId], () => {
                pushInboxToUser(myUsername);
                const targetUsername = anonMap[partnerId];
                if(targetUsername) pushInboxToUser(targetUsername);
            });
        } else if (mode === 'sent') {
            db.run("UPDATE messages SET seen = 1 WHERE to_user = ? AND anon_id = ? AND sender != 'anon'", [partnerId, myAnonId], () => {
                pushInboxToUser(myUsername); pushInboxToUser(partnerId);
            });
        }
    });
});

const PORT = 3000;
http.listen(PORT, '0.0.0.0', () => console.log(`Server v10 (English Edition) started!`));
