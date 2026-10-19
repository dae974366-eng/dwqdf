'use strict';

/**
 * اختبار بطولة كاملة من 3 لاعبين عبر مسار الفوز (بدون انتهاء مهلة):
 * جولة 1 → إقصاء لاعب → جولة 2 بين الفائز واللاعب الثالث → إعلان الفائز النهائي.
 */

const assert = require('assert');
const {
  installCanvasAlias,
  ensureFixtures,
  PHOTO_DIR,
  createFakeClient,
  createFakeDb,
  createUser,
  startAvatarServer,
  createFakeChannel,
  click,
  runCommand,
  waitFor
} = require('./helpers');

process.on('unhandledRejection', (error) => {
  console.error('✗ unhandledRejection:', error);
  process.exit(1);
});

const guildId = 'guild_tournament';
const channelId = 'channel_tournament';

async function main() {
  installCanvasAlias();
  await ensureFixtures();
  await startAvatarServer();

  const channel = createFakeChannel(channelId);
  const client = createFakeClient(channel, guildId);

  const db = createFakeDb({
    [`commandChannel_${guildId}`]: channelId,
    [`managergamesfr_${guildId}`]: 'role_manager',
    [`timerRPS_100`]: 250
  });

  const admin = createUser('admin', '100');
  const users = [createUser('Alice', '201'), createUser('Bob', '202'), createUser('Cara', '203')];

  admin.member = { roles: { cache: { has: (id) => String(id) === 'role_manager' } } };
  for (const user of users) user.member = { roles: { cache: { has: () => false } } };

  const { execute } = require('../games/rockPaperScissors');
  const api = execute(client, db, () => {}, {
    assetsPath: PHOTO_DIR,
    rps: {
      defaultJoinMs: 250,
      minJoinMs: 100,
      maxJoinMs: 1000,
      roundMs: 300,
      startDelayMs: 10,
      roundDelayMs: 10,
      maxGameMs: 30000
    }
  }, { prefix: '!', owners: [] });

  await runCommand(client, channel, admin, '!حجره', { guildId });
  const joinMessage = await waitFor(() => channel.last((m) => m.content.includes('ستبدأ اللعبة')), {
    label: 'رسالة الانضمام'
  });

  for (const user of users) await click(joinMessage, user, 'join_rps');

  const battle1 = await waitFor(
    () => channel.last((m) => m.content.includes('الجولة 1') && m.collectors.length > 0),
    { label: 'الجولة الأولى' }
  );

  const pair1 = [...battle1.content.matchAll(/<@(\d+)>/g)].map((match) => match[1]);
  const first1 = users.find((user) => user.id === pair1[0]);
  const second1 = users.find((user) => user.id === pair1[1]);

  // اللاعب الأول في النص يفوز (ورق يغطي الحجر)
  await click(battle1, first1, 'rps_paper');
  await click(battle1, second1, 'rps_rock');

  await waitFor(() => channel.last((m) => m.content.includes('فاز')), { label: 'نتيجة الجولة الأولى' });

  const battle2 = await waitFor(
    () => channel.last((m) => m.content.includes('الجولة 2') && m.collectors.length > 0),
    { label: 'الجولة الثانية' }
  );

  const pair2 = [...battle2.content.matchAll(/<@(\d+)>/g)].map((match) => match[1]);
  const first2 = users.find((user) => user.id === pair2[0]);
  const second2 = users.find((user) => user.id === pair2[1]);

  assert.ok(pair2.includes(first1.id), 'يجب أن يتأهل الفائز من الجولة الأولى');
  assert.ok(!pair2.includes(second1.id), 'يجب ألا يعود الخاسر للجولة الثانية');

  await click(battle2, first2, 'rps_scissors');
  await click(battle2, second2, 'rps_paper');

  const finalMessage = await waitFor(
    () => channel.last((m) => m.embeds.length > 0 && m.embeds[0].data && m.embeds[0].data.title === '🏆 انتهت اللعبة!'),
    { label: 'إعلان الفائز النهائي' }
  );

  assert.ok(finalMessage.embeds[0].data.description.includes(pair2[0]), 'الفائز النهائي يجب أن يكون فائز الجولة الثانية');
  await waitFor(() => api.getGame(guildId) === null, { label: 'تحرير اللعبة' });

  assert.strictEqual(db.store.get(`points_${guildId}.${pair2[0]}`), 1);
  assert.strictEqual(db.store.get(`points_${guildId}.${pair1[1]}`), undefined);
  assert.strictEqual(db.store.get(`points_${guildId}.${pair2[1]}`), undefined);

  console.log('✓ بطولة من 3 لاعبين: تأهل الفائز، إقصاء الخاسر، ونقطة واحدة للفائز النهائي');
}

main().catch((error) => {
  console.error('✗ فشل اختبار البطولة:', error);
  process.exitCode = 1;
});
