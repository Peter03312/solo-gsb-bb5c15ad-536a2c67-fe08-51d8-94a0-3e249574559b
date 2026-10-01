'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'hearing.sqlite');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  seed(db);
  return db;
}

function initSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('recordist','reviewer','participant')),
    password_hash TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 全局只有一份文档（一场听证会）；导入后创建第 1 个已发布版本
  CREATE TABLE IF NOT EXISTS doc_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    title TEXT NOT NULL,
    initialized INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  INTEGER NOT NULL
  );

  -- 不可变版本：segments_json 为该版本全文快照 [{seg,text}]
  CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY,
    note        TEXT NOT NULL DEFAULT '',
    segments_json TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    -- 该版本决议水位线：本版本可见 id <= decision_watermark 的决议
    decision_watermark INTEGER NOT NULL DEFAULT 0
  );

  -- 修订提议：绑定提交时的已发布版本 base_version_id
  CREATE TABLE IF NOT EXISTS proposals (
    id          INTEGER PRIMARY KEY,
    seg         INTEGER NOT NULL,
    start_cp    INTEGER NOT NULL,   -- 码点偏移，半开区间 [start,end)
    end_cp      INTEGER NOT NULL,
    replacement TEXT NOT NULL,      -- 允许空串（删除）
    basis       TEXT NOT NULL,
    original_excerpt TEXT NOT NULL, -- 基版原文快照
    base_version_id INTEGER NOT NULL REFERENCES versions(id),
    status      TEXT NOT NULL CHECK (status IN ('pending','adopted','rejected','conflicted','published')),
    conflict_reason TEXT NOT NULL DEFAULT '',
    conflict_kind TEXT NOT NULL DEFAULT '',  -- 冲突类别：base_expired（基版已过期）| overlap（范围交叠）
    rebased_from_id INTEGER REFERENCES proposals(id), -- 续提来源：本提议由哪个冲突提议换算重提而来
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by  INTEGER REFERENCES users(id),
    decided_at  TEXT,
    published_version_id INTEGER REFERENCES versions(id)
  );

  -- 决议（不可变审计流；驳回/采纳/冲突/发布均留痕）
  CREATE TABLE IF NOT EXISTS decisions (
    id          INTEGER PRIMARY KEY,
    type        TEXT NOT NULL,           -- adopt | reject | conflict | publish
    proposal_id INTEGER REFERENCES proposals(id),
    version_id  INTEGER REFERENCES versions(id),
    actor_id    INTEGER REFERENCES users(id),
    reason      TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 异议引用：锚定到某段字符范围，保存原文快照
  CREATE TABLE IF NOT EXISTS objections (
    id          INTEGER PRIMARY KEY,
    seg         INTEGER NOT NULL,
    start_cp    INTEGER NOT NULL,
    end_cp      INTEGER NOT NULL,
    quoted_text TEXT NOT NULL,           -- 提交时被引原文快照
    note        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_relocation')),
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_in_version INTEGER NOT NULL REFERENCES versions(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 每个异议在每个已发布版本下的锚点（发布时从旧版本映射生成）
  CREATE TABLE IF NOT EXISTS objection_anchors (
    objection_id INTEGER NOT NULL REFERENCES objections(id),
    version_id   INTEGER NOT NULL REFERENCES versions(id),
    seg          INTEGER NOT NULL,
    start_cp     INTEGER NOT NULL,
    end_cp       INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('active','needs_relocation')),
    PRIMARY KEY (objection_id, version_id)
  );

  CREATE TABLE IF NOT EXISTS objection_logs (
    id INTEGER PRIMARY KEY,
    objection_id INTEGER NOT NULL REFERENCES objections(id),
    actor_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,                -- create | relocate
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 发布前对异议的逐条回应：关联异议、触及它的已采纳提议，以及回应时的版本与暂存区指纹；
  -- published_version_id 为空表示回应尚未随版本发布（可被重述取代：status='superseded'）。
  CREATE TABLE IF NOT EXISTS objection_responses (
    id          INTEGER PRIMARY KEY,
    objection_id INTEGER NOT NULL REFERENCES objections(id),
    note        TEXT NOT NULL,           -- 非空回应说明
    proposal_ids_json TEXT NOT NULL DEFAULT '[]', -- 触及该异议的暂存提议 id 快照
    version_id  INTEGER NOT NULL REFERENCES versions(id),   -- 回应时的当前版本
    stage_fingerprint TEXT NOT NULL,     -- 回应时暂存区指纹（发布时重新核对）
    seg         INTEGER NOT NULL,        -- 回应时异议当前锚点快照
    start_cp    INTEGER NOT NULL,
    end_cp      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
    published_version_id INTEGER REFERENCES versions(id),   -- 随哪个版本发布
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_proposals_base ON proposals(base_version_id, status);
  CREATE INDEX IF NOT EXISTS idx_decisions_version ON decisions(version_id);
  CREATE INDEX IF NOT EXISTS idx_anchors_version ON objection_anchors(version_id);
  CREATE INDEX IF NOT EXISTS idx_responses_objection ON objection_responses(objection_id, status);

  -- 段级保密：存在行即表示该段号当前对参与者保密（以段号为准，立即作用于当前及全部历史版本）
  CREATE TABLE IF NOT EXISTS segment_secrets (
    seg INTEGER PRIMARY KEY
  );

  -- 保密/解除保密操作留痕：操作人、时间与前后状态
  CREATE TABLE IF NOT EXISTS secret_logs (
    id          INTEGER PRIMARY KEY,
    seg         INTEGER NOT NULL,
    action      TEXT NOT NULL CHECK (action IN ('classify','declassify')),
    actor_id    INTEGER NOT NULL REFERENCES users(id),
    previous_state TEXT NOT NULL,   -- public | secret
    new_state      TEXT NOT NULL,   -- public | secret
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_secret_logs_seg ON secret_logs(seg, id);
  `);

  // 既有数据库的轻量迁移：补充续提所需列，并按冲突原因文本回填类别
  const pcols = db.prepare('PRAGMA table_info(proposals)').all().map((c) => c.name);
  if (!pcols.includes('conflict_kind')) {
    db.exec(`ALTER TABLE proposals ADD COLUMN conflict_kind TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE proposals SET conflict_kind='base_expired' WHERE status='conflicted' AND conflict_reason LIKE '基版已过期%'`);
    db.exec(`UPDATE proposals SET conflict_kind='overlap' WHERE status='conflicted' AND conflict_kind='' AND conflict_reason<>''`);
  }
  if (!pcols.includes('rebased_from_id')) {
    db.exec(`ALTER TABLE proposals ADD COLUMN rebased_from_id INTEGER REFERENCES proposals(id)`);
  }
}

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const accounts = [
    { username: process.env.SEED_RECORDIST_USER || 'recorder', password: process.env.SEED_RECORDIST_PASS || 'recorder123', role: 'recordist', display: '记录员' },
    { username: process.env.SEED_REVIEWER_USER || 'reviewer', password: process.env.SEED_REVIEWER_PASS || 'reviewer123', role: 'reviewer', display: '复核员' },
    { username: process.env.SEED_PARTICIPANT_USER || 'participant', password: process.env.SEED_PARTICIPANT_PASS || 'participant123', role: 'participant', display: '参与者' },
  ];
  const stmt = db.prepare('INSERT INTO users (username, display_name, role, password_hash) VALUES (?,?,?,?)');
  for (const a of accounts) stmt.run(a.username, a.display, a.role, hashPassword(a.password));
  console.log('[db] 已创建种子账户：', accounts.map((a) => `${a.username}/${a.password}(${a.role})`).join('  '));
}

if (require.main === module) {
  const db = openDb();
  console.log('[db] 初始化完成：', DB_PATH);
  db.close();
}

module.exports = { openDb, hashPassword, verifyPassword, DB_PATH };
