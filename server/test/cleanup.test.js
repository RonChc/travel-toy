// 驗收 3：解散或到期後，成員、位置、照片都查不到，照片檔案已刪除
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startBackend, JPEG, PNG, WEBP } from './helpers.js';

let s;
before(async () => { s = await startBackend({ groupTtlMs: 60 * 60e3 }); });
after(async () => { await s.close(); });
// 每個測試從乾淨狀態開始（上一個測試留下的群組與照片清掉）
beforeEach(() => { s.app.store.db.exec('DELETE FROM groups'); s.app.store.sweepOrphanPhotos(); });

// 建一個有成員、位置、找人、照片的群組
async function populate() {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'Bob');
  await s.call('POST', '/api/location', { token: b.token, body: { lat: 25, lng: 121, floor: '2F' } });
  const f = await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } });
  const findId = f.json.finds[0].id;
  assert.equal((await s.call('PUT', `/api/finds/${findId}/photo`, { token: b.token, raw: JPEG, headers: { 'Content-Type': 'image/jpeg' } })).status, 200);
  await s.call('POST', `/api/finds/${findId}/reply`, { token: b.token, body: { lat: 25, lng: 121, floor: '2F' } });
  return { g, b, findId };
}

const counts = () => ({
  groups: s.app.store.db.prepare('SELECT COUNT(*) n FROM groups').get().n,
  members: s.app.store.db.prepare('SELECT COUNT(*) n FROM members').get().n,
  finds: s.app.store.db.prepare('SELECT COUNT(*) n FROM finds').get().n,
});

test('管理員解散：成員、位置、找人紀錄、照片檔案全部刪除', async () => {
  const { g, b, findId } = await populate();
  assert.equal(s.photoFiles().length, 1);
  assert.equal((await s.call('DELETE', '/api/group', { token: g.token })).status, 200);
  assert.deepEqual(counts(), { groups: 0, members: 0, finds: 0 });
  assert.deepEqual(s.photoFiles(), [], '照片檔案要刪掉');
  for (const t of [g.token, b.token]) assert.equal((await s.call('GET', '/api/state', { token: t })).status, 401);
  assert.equal((await s.call('GET', `/api/finds/${findId}/photo`, { token: b.token })).status, 401);
  assert.equal((await s.call('POST', '/api/invite/info', { body: { inviteCode: g.inviteCode } })).status, 404);
});

test('到期：任何請求都查不到，背景清理也會刪掉資料與照片', async () => {
  const { g, b, findId } = await populate();
  assert.equal(s.photoFiles().length, 1);
  s.clock.t += 61 * 60e3; // 超過 1 小時
  // 還沒有任何人呼叫之前先被清理程序掃掉
  assert.ok(s.app.store.sweepExpired() >= 1);
  assert.deepEqual(counts(), { groups: 0, members: 0, finds: 0 });
  assert.deepEqual(s.photoFiles(), []);
  assert.equal((await s.call('GET', '/api/state', { token: b.token })).status, 401);
  assert.equal((await s.call('GET', `/api/finds/${findId}/photo`, { token: g.token })).status, 401);
});

test('到期但清理還沒跑：請求當下就會被擋並順手刪掉', async () => {
  const { g, b } = await populate();
  s.clock.t += 61 * 60e3;
  const r = await s.call('GET', '/api/state', { token: b.token });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'group_expired');
  assert.deepEqual(counts(), { groups: 0, members: 0, finds: 0 });
  assert.deepEqual(s.photoFiles(), []);
  assert.equal((await s.call('GET', '/api/state', { token: g.token })).status, 401);
  // 邀請碼也不能再加入
  assert.equal((await s.call('POST', '/api/join', { body: { inviteCode: g.inviteCode, name: 'X', emoji: '🐶' } })).status, 404);
});

test('只刪到期或解散的那個群組，別的群組不受影響', async () => {
  const one = await populate();
  s.clock.t += 30 * 60e3;
  const two = await populate(); // 晚 30 分鐘建立
  s.clock.t += 31 * 60e3; // 第一個到期，第二個還沒
  s.app.store.sweepExpired();
  assert.equal((await s.call('GET', '/api/state', { token: one.b.token })).status, 401);
  assert.equal((await s.call('GET', '/api/state', { token: two.b.token })).status, 200);
  assert.equal(s.photoFiles().length, 1, '第二個群組的照片還在');
});

test('踢人會刪掉那個人相關的照片；殘留的孤兒照片會被清掉', async () => {
  const { g, b } = await populate();
  assert.equal(s.photoFiles().length, 1);
  await s.call('DELETE', `/api/members/${b.memberId}`, { token: g.token });
  assert.deepEqual(s.photoFiles(), []);
  // 手動放一個不屬於任何紀錄的檔案
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(s.dataDir, 'photos', 'orphan.jpg'), JPEG);
  assert.equal(s.app.store.sweepOrphanPhotos(), 1);
  assert.deepEqual(s.photoFiles(), []);
});

test('離開群組（朋友自己退出）也會刪掉自己的資料', async () => {
  const { g, b } = await populate();
  assert.equal((await s.call('DELETE', '/api/me', { token: b.token })).status, 200);
  assert.equal((await s.call('GET', '/api/state', { token: b.token })).status, 401);
  assert.equal((await s.call('DELETE', '/api/me', { token: g.token })).status, 400, '管理員要結束請解散');
  assert.deepEqual(s.photoFiles(), []);
});

test('照片：只收 jpeg/png/webp、看檔頭、有大小上限、檔名隨機', async () => {
  const g = await s.newGroup();
  const b = await s.join(g.inviteCode, 'Bob');
  const mk = async () => (await s.call('POST', '/api/find', { token: g.token, body: { targetId: b.memberId } })).json.finds[0].id;
  const put = (id, raw, type) => s.call('PUT', `/api/finds/${id}/photo`, { token: b.token, raw, headers: { 'Content-Type': type } });

  const id = await mk();
  assert.equal((await put(id, Buffer.from('<script>alert(1)</script>'), 'text/html')).status, 415);
  assert.equal((await put(id, Buffer.from('<script>alert(1)</script>'), 'image/jpeg')).status, 415, '宣稱 jpeg 但內容不是');
  assert.equal((await put(id, Buffer.from('GIF89a......'), 'image/gif')).status, 415);
  assert.equal((await put(id, Buffer.concat([JPEG, Buffer.alloc(s.config.maxPhotoBytes)]), 'image/jpeg')).status, 413, '超過大小上限');
  assert.equal(s.photoFiles().length, 0);

  assert.equal((await put(id, PNG, 'image/png')).status, 200);
  assert.equal((await put(id, WEBP, 'image/webp')).status, 200, '重傳會取代舊的');
  const files = s.photoFiles();
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{32}\.webp$/, '檔名是隨機的，不含使用者資料');
  const got = await s.call('GET', `/api/finds/${id}/photo`, { token: b.token });
  assert.equal(got.headers.get('content-type'), 'image/webp');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  // 沒有權杖看不到
  assert.equal((await s.call('GET', `/api/finds/${id}/photo`)).status, 401);
});
