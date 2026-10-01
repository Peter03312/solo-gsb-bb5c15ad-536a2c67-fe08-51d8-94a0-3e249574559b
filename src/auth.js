'use strict';
const crypto = require('crypto');

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || `${1000 * 60 * 60 * 12}`, 10);

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function currentUser(db) {
  return (req, _res, next) => {
    const token = parseCookies(req).session;
    req.user = null;
    if (token) {
      const row = db
        .prepare(
          `SELECT s.expires_at, u.id, u.username, u.display_name, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
        )
        .get(token);
      if (row && row.expires_at > Date.now()) {
        req.user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
        req.sessionToken = token;
      }
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHENTICATED' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHENTICATED' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `无权操作：${req.user.displayName}（${req.user.role}）不能执行该操作，需要 ${roles.join(' 或 ')} 身份`,
        code: 'FORBIDDEN',
      });
    }
    next();
  };
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(
    token,
    userId,
    Date.now() + SESSION_TTL_MS
  );
  return token;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { currentUser, requireAuth, requireRole, createSession, destroySession, parseCookies };
