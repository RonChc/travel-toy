// 資料層：node:sqlite（Node 內建）。所有查詢都帶 group_id，避免跨群組存取。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { newToken, hashToken, newId } from './crypto.js';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  invite_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('family','friend')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT NOT NULL UNIQUE,
  push_sub TEXT,
  lat REAL, lng REAL, accuracy REAL, floor TEXT, note TEXT, loc_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS members_group ON members(group_id);
CREATE TABLE IF NOT EXISTS finds (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  asker_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'asked',
  replied_at INTEGER,
  lat REAL, lng REAL, accuracy REAL, floor TEXT, note TEXT,
  photo TEXT,
  asker_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS finds_group ON finds(group_id);
CREATE INDEX IF NOT EXISTS finds_target ON finds(target_id, status);
CREATE INDEX IF NOT EXISTS finds_asker ON finds(asker_id);
CREATE TABLE IF NOT EXISTS usage (
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, day, kind)
);
`;

// 以台灣時間（UTC+8）切日，用來算每日用量
export const dayString = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);

export function openStore({ dbFile, dataDir, now = () => Date.now() }) {
  const photoDir = join(dataDir, 'photos');
  mkdirSync(photoDir, { recursive: true });
  const file = dbFile || join(dataDir, 'group.db');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const st = {
    insGroup: q('INSERT INTO groups (id,name,created_at,expires_at,invite_hash) VALUES (?,?,?,?,?)'),
    insMember: q('INSERT INTO members (id,group_id,name,emoji,tier,is_admin,token_hash,created_at) VALUES (?,?,?,?,?,?,?,?)'),
    memberByToken: q('SELECT m.*, g.expires_at AS g_expires, g.name AS g_name FROM members m JOIN groups g ON g.id = m.group_id WHERE m.token_hash = ?'),
    groupByInvite: q('SELECT * FROM groups WHERE invite_hash = ?'),
    groupById: q('SELECT * FROM groups WHERE id = ?'),
    members: q('SELECT * FROM members WHERE group_id = ? ORDER BY created_at, id'),
    member: q('SELECT * FROM members WHERE id = ? AND group_id = ?'),
    memberCount: q('SELECT COUNT(*) AS n FROM members WHERE group_id = ?'),
    setTier: q('UPDATE members SET tier = ? WHERE id = ? AND group_id = ? AND is_admin = 0'),
    setPush: q('UPDATE members SET push_sub = ? WHERE id = ?'),
    setLoc: q('UPDATE members SET lat=?, lng=?, accuracy=?, floor=?, note=?, loc_at=? WHERE id=?'),
    setInvite: q('UPDATE groups SET invite_hash = ? WHERE id = ?'),
    delGroup: q('DELETE FROM groups WHERE id = ?'),
    delMember: q('DELETE FROM members WHERE id = ? AND group_id = ?'),
    expired: q('SELECT id FROM groups WHERE expires_at <= ?'),
    insFind: q('INSERT INTO finds (id,group_id,asker_id,target_id,created_at) VALUES (?,?,?,?,?)'),
    find: q('SELECT * FROM finds WHERE id = ? AND group_id = ? AND (asker_id = ? OR target_id = ?)'),
    findAsk: q("SELECT * FROM finds WHERE asker_id = ? AND target_id = ? AND group_id = ? AND status = 'asked' AND created_at > ?"),
    pendingAsks: q("SELECT * FROM finds WHERE target_id = ? AND group_id = ? AND status = 'asked' AND created_at > ? ORDER BY created_at"),
    unseenReplies: q("SELECT * FROM finds WHERE asker_id = ? AND group_id = ? AND status = 'replied' AND asker_seen = 0 ORDER BY replied_at"),
    reply: q("UPDATE finds SET status='replied', replied_at=?, lat=?, lng=?, accuracy=?, floor=?, note=? WHERE id=? AND status='asked'"),
    setPhoto: q('UPDATE finds SET photo = ? WHERE id = ?'),
    markSeen: q('UPDATE finds SET asker_seen = 1 WHERE id = ? AND asker_id = ?'),
    photosOfGroup: q('SELECT photo FROM finds WHERE group_id = ? AND photo IS NOT NULL'),
    photosOfMember: q('SELECT photo FROM finds WHERE (asker_id = ? OR target_id = ?) AND photo IS NOT NULL'),
    allPhotos: q('SELECT photo FROM finds WHERE photo IS NOT NULL'),
    usageGet: q('SELECT n FROM usage WHERE member_id=? AND day=? AND kind=?'),
    usageAdd: q('INSERT INTO usage (member_id,day,kind,n) VALUES (?,?,?,1) ON CONFLICT(member_id,day,kind) DO UPDATE SET n = n + 1'),
    usageClean: q('DELETE FROM usage WHERE day < ?'),
  };

  const removePhotos = (rows) => {
    for (const r of rows) rmSync(join(photoDir, r.photo), { force: true });
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const self = {
    db,
    photoDir,
    close: () => db.close(),

    createGroup({ name, adminName, emoji, ttlMs }) {
      const t = now();
      const groupId = newId();
      const inviteCode = newToken();
      const adminToken = newToken();
      const memberId = newId();
      tx(() => {
        st.insGroup.run(groupId, name, t, t + ttlMs, hashToken(inviteCode));
        // 管理員固定是「家人」（老闆本人），不能被降級
        st.insMember.run(memberId, groupId, adminName, emoji, 'family', 1, hashToken(adminToken), t);
      });
      return { groupId, memberId, adminToken, inviteCode, expiresAt: t + ttlMs };
    },

    addMember(groupId, { name, emoji }) {
      const token = newToken();
      const id = newId();
      st.insMember.run(id, groupId, name, emoji, 'friend', 0, hashToken(token), now());
      return { id, token };
    },

    groupByInvite: (code) => st.groupByInvite.get(hashToken(code)),
    group: (id) => st.groupById.get(id),
    memberByToken: (token) => st.memberByToken.get(hashToken(token)),
    members: (groupId) => st.members.all(groupId),
    member: (id, groupId) => st.member.get(id, groupId),
    memberCount: (groupId) => st.memberCount.get(groupId).n,

    setTier: (id, groupId, tier) => Number(st.setTier.run(tier, id, groupId).changes) > 0,
    setPush: (id, sub) => st.setPush.run(sub, id),
    setLocation: (id, l) => st.setLoc.run(l.lat, l.lng, l.accuracy ?? null, l.floor ?? null, l.note ?? null, now(), id),

    resetInvite(groupId) {
      const code = newToken();
      st.setInvite.run(hashToken(code), groupId);
      return code;
    },

    // 刪掉整個群組：照片檔案、成員、位置、找人紀錄、用量
    deleteGroup(groupId) {
      removePhotos(st.photosOfGroup.all(groupId));
      st.delGroup.run(groupId);
    },
    deleteMember(id, groupId) {
      removePhotos(st.photosOfMember.all(id, id));
      return Number(st.delMember.run(id, groupId).changes) > 0;
    },
    // 到期群組一律清掉；回傳清掉幾個
    sweepExpired() {
      const ids = st.expired.all(now()).map((r) => r.id);
      for (const id of ids) self.deleteGroup(id);
      st.usageClean.run(dayString(now() - 3 * 864e5));
      return ids.length;
    },
    // 資料夾裡不屬於任何找人紀錄的照片（例如上傳到一半當機）一併清掉
    sweepOrphanPhotos() {
      const used = new Set(st.allPhotos.all().map((r) => r.photo));
      let n = 0;
      for (const f of existsSync(photoDir) ? readdirSync(photoDir) : []) {
        if (!used.has(f)) {
          rmSync(join(photoDir, f), { force: true });
          n++;
        }
      }
      return n;
    },

    createFind(groupId, askerId, targetId) {
      const id = newId();
      st.insFind.run(id, groupId, askerId, targetId, now());
      return id;
    },
    find: (id, groupId, memberId) => st.find.get(id, groupId, memberId, memberId),
    openAsk: (groupId, askerId, targetId, since) => st.findAsk.get(askerId, targetId, groupId, since),
    pendingAsks: (memberId, groupId, since) => st.pendingAsks.all(memberId, groupId, since),
    unseenReplies: (memberId, groupId) => st.unseenReplies.all(memberId, groupId),
    replyFind: (id, r) => Number(st.reply.run(now(), r.lat, r.lng, r.accuracy ?? null, r.floor ?? null, r.note ?? null, id).changes) > 0,
    setPhoto: (findId, name) => st.setPhoto.run(name, findId),
    markSeen: (id, askerId) => st.markSeen.run(id, askerId),

    usage: (memberId, kind) => st.usageGet.get(memberId, dayString(now()), kind)?.n || 0,
    addUsage: (memberId, kind) => st.usageAdd.run(memberId, dayString(now()), kind),
  };
  return self;
}
