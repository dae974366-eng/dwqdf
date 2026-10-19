'use strict';

/**
 * اختبار السلوك عندما تكون مكتبة canvas غير متاحة (شائع على استضافات Linux
 * بدون حزم cairo/pango): يجب أن تستمر اللعبة نصياً دون انهيار.
 */

const assert = require('assert');
const {
  installCanvasAlias,
  createFakeClient,
  createFakeDb,
  createUser,
  createFakeChannel,
  click,
  runCommand,
  waitFor
} = require('./helpers');

process.on('unhandledRejection', (error) => {
  console.error('✗ unhandledRejection:', error);
  process.exit(1);
});

const guildId = 'guild_nocanvas';
const channelId = 'channel_nocanvas';

async function main() {
  installCanvasAlias({ disableCanvas: true });

  const channel = createFakeChannel(channelId);
  const client = createFakeClient(channel, guildId);

  const db = createFakeDb({
    [`commandChannel_${guildId}`]: channelId,
    [`managergamesfr_${guildId}`]: 'role_manager',
    [`timerRPS_100`]: 300
  });

  const admin = createUser('admin', '100');
  const alice = createUser('Alice', '101');
  const bob = createUser('Bob', '102');
  admin.member = { roles: { cache: { has: (id) => String(id) === 'role_manager' } } };
  alice.member = { roles: { cache: { has: () => false } } };
  bob.member = { roles: { cache: { has: () => false } } };

  const config = {
    rps: {
      minJoinMs: 100,
      defaultJoinMs: 300,
      maxJoinMs: 1000,
      roundMs: 400,
      startDelayMs: 10,
      roundDelayMs: 10,
      maxGameMs: 20000,
      avatarTimeoutMs: 100
    }
  };

  // eslint-disable-next-line global-require
  const { execute } = require('../games/rockPaperScissors');
  const api = execute(client, db, () => {}, config, { prefix: '!', owners: [] });

  await runCommand(client, channel, admin, '!حجره', { guildId });

  const joinMessage = await waitFor(() => channel.last((m) => m.content.includes('ستبدأ اللعبة')), {
    label: 'رسالة الانضمام بدون canvas'
  });
  assert.deepStrictEqual(joinMessage.files, [], 'لا يجب إرفاق صورة بداية');

  await click(joinMessage, alice, 'join_rps');
  await click(joinMessage, bob, 'join_rps');

  const battle = await waitFor(
    () => channel.last((m) => m.content.includes('الجولة 1') && m.collectors.length > 0),
    { label: 'رسالة الجولة بدون canvas' }
  );
  assert.deepStrictEqual(battle.files, [], 'لا يجب إرفاق صورة معركة');

  await click(battle, alice, 'rps_rock');
  await click(battle, bob, 'rps_scissors');

  const result = await waitFor(() => channel.last((m) => m.content.includes('فاز')), {
    label: 'رسالة الفوز بدون canvas'
  });
  assert.deepStrictEqual(result.files, [], 'لا يجب إرفاق صورة نتيجة');

  await waitFor(
    () => channel.last((m) => m.embeds.length > 0 && m.embeds[0].data && m.embeds[0].data.title === '🏆 انتهت اللعبة!'),
    { label: 'الفائز النهائي بدون canvas' }
  );

  assert.strictEqual(api.getGame(guildId), null);
  assert.strictEqual(db.store.get(`points_${guildId}.101`), 1);
  console.log('✓ اللعبة تعمل كاملة بدون canvas ومنحت النقطة للفائز');
}

main().catch((error) => {
  console.error('✗ فشل اختبار بدون canvas:', error);
  process.exitCode = 1;
});
