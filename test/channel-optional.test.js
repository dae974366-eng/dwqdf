'use strict';

/**
 * اختبار أن الأمر يعمل بدون ضبط commandChannel_<guildId>
 * (السلوك الافتراضي الجديد: requireCommandChannel = false).
 */

const assert = require('assert');
const {
  installCanvasAlias,
  ensureFixtures,
  PHOTO_DIR,
  startAvatarServer,
  createFakeClient,
  createFakeDb,
  createUser,
  createFakeChannel,
  runCommand,
  waitFor
} = require('./helpers');

process.on('unhandledRejection', (error) => {
  console.error('✗ unhandledRejection:', error);
  process.exit(1);
});

const guildId = 'guild_no_channel';
const channelId = 'channel_free';

async function main() {
  const canvasAvailable = Boolean(installCanvasAlias());
  await ensureFixtures();
  if (canvasAvailable) await startAvatarServer();

  const channel = createFakeChannel(channelId);
  const otherChannel = createFakeChannel('channel_other');
  const client = createFakeClient(channel, guildId);

  // لا يوجد أي مفتاح commandChannel_<guildId> هنا بقصد.
  const db = createFakeDb({
    [`managergamesfr_${guildId}`]: 'role_manager',
    [`timerRPS_100`]: 150
  });

  const admin = createUser('admin', '100');
  admin.member = { roles: { cache: { has: (id) => String(id) === 'role_manager' } } };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(' '));
    originalWarn(...args);
  };

  // eslint-disable-next-line global-require
  const { execute } = require('../games/rockPaperScissors');
  const api = execute(client, db, () => {}, {
    assetsPath: PHOTO_DIR,
    rps: { minJoinMs: 100, defaultJoinMs: 300, roundMs: 200, startDelayMs: 10, roundDelayMs: 10 }
  }, { prefix: '!', owners: [] });

  console.warn = originalWarn;

  assert.strictEqual(api.settings.requireCommandChannel, false, 'الافتراضي يجب أن يكون false');

  await runCommand(client, otherChannel, admin, '!حجره', { guildId });

  const joinMessage = await waitFor(
    () => otherChannel.last((m) => m.content.includes('ستبدأ اللعبة')),
    { label: 'رسالة الانضمام بدون قناة أوامر' }
  );

  assert.ok(joinMessage, 'يجب أن تبدأ اللعبة في أي قناة');
  assert.ok(
    !warnings.some((line) => line.includes('commandChannel_')),
    'لا يجب إصدار تحذير commandChannel مع الإعداد الافتراضي'
  );

  assert.strictEqual(api.getGame(guildId) !== null, true);
  console.log('✓ الأمر يعمل بدون commandChannel، وبدون تحذير');
}

main().catch((error) => {
  console.error('✗ فشل اختبار القناة الافتراضية:', error);
  process.exitCode = 1;
});
