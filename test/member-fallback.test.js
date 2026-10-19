'use strict';

/**
 * اختبار فحص الرتب عندما يكون message.member فارغاً.
 * يحدث ذلك عندما لا يملك البوت GUILD_MEMBERS intent (كاش الأعضاء غير ممتلئ)،
 * أو عندما تكون الرسالة من نسخة قديمة. اللعبة تجلب العضو مباشرة قبل رفض الصلاحية.
 */

const assert = require('assert');
const {
  installCanvasAlias,
  ensureFixtures,
  PHOTO_DIR,
  createFakeClient,
  createFakeDb,
  createUser,
  createFakeChannel,
  runCommand,
  waitFor,
  wait
} = require('./helpers');

process.on('unhandledRejection', (error) => {
  console.error('✗ unhandledRejection:', error);
  process.exit(1);
});

const guildId = 'guild_fetch';
const channelId = 'channel_fetch';

async function main() {
  installCanvasAlias();
  await ensureFixtures();

  const channel = createFakeChannel(channelId);

  const admin = createUser('admin', '100');
  admin.member = { id: '100', roles: { cache: { has: (id) => String(id) === 'role_manager' } } };

  const member = createUser('member', '101');
  member.member = { id: '101', roles: { cache: { has: () => false } } };

  const members = { 100: admin.member, 101: member.member };

  const client = createFakeClient(channel, guildId, {
    resolveMember: (userId) => members[userId] || null
  });

  const db = createFakeDb({
    [`managergamesfr_${guildId}`]: 'role_manager',
    [`timerRPS_100`]: 150
  });

  const { execute } = require('../games/rockPaperScissors');
  const api = execute(client, db, () => {}, {
    assetsPath: PHOTO_DIR,
    rps: { minJoinMs: 100, defaultJoinMs: 300, roundMs: 200, startDelayMs: 10, roundDelayMs: 10 }
  }, { prefix: '!', owners: [] });

  /* 1) عضو عادي بدون message.member → يجب الرفض بعد جلب العضو */
  await runCommand(client, channel, member, '!حجره', { guildId, member: null });
  await waitFor(() => channel.last((m) => m.content.includes('ليس لديك صلاحية')), {
    label: 'رفض العضو العادي عبر members.fetch'
  });
  assert.strictEqual(api.getGame(guildId), null);
  console.log('✓ عضو عادي بدون message.member → رفض صحيح');

  /* 2) مشرف بدون message.member → يجب أن تبدأ اللعبة */
  await runCommand(client, channel, admin, '!حجره', { guildId, member: null });
  const joinMessage = await waitFor(
    () => channel.last((m) => m.content.includes('ستبدأ اللعبة')),
    { label: 'بدء اللعبة عبر members.fetch' }
  );

  assert.ok(joinMessage, 'يجب أن تبدأ اللعبة عندما يجلب members.fetch رتبة المشرف');
  assert.ok(api.getGame(guildId), 'يجب تسجيل اللعبة');

  await api.stopGame(guildId, 'انتهى الاختبار.');
  await wait(20);
  assert.strictEqual(api.getGame(guildId), null, 'يجب تحرير اللعبة بعد stopGame');
  console.log('✓ مشرف بدون message.member → بدء اللعبة، وstopGame يعمل');
}

main().catch((error) => {
  console.error('✗ فشل اختبار جلب العضو:', error);
  process.exitCode = 1;
});
