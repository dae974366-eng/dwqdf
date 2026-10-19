'use strict';

/**
 * اختبار تدفق اللعبة كاملاً عبر واجهة execute() العامة:
 *  - صلاحيات المشرف
 *  - الانضمام/الخروج/الشرح
 *  - التعادل وإعادة الجولة
 *  - الفوز والإقصاء
 *  - عدم تفاعل اللاعبين وإلغاء اللعبة
 *  - انتهاء اللعبة واحتساب النقطة
 *  - إنشاء الصور وإرفاقها
 */

const assert = require('assert');
const path = require('path');
const {
  installCanvasAlias,
  ensureFixtures,
  PHOTO_DIR,
  OUTPUT_DIR,
  createFakeClient,
  createFakeDb,
  createUser,
  startAvatarServer,
  avatarUrlFor,
  createFakeChannel,
  click,
  runCommand,
  wait,
  waitFor,
  dumpAttachments
} = require('./helpers');

process.on('unhandledRejection', (error) => {
  console.error('✗ unhandledRejection:', error);
  process.exit(1);
});

const guildId = 'guild_1';
const channelId = 'channel_1';
const prefix = '!';
const managerRole = 'role_manager';

async function main() {
  const canvasAvailable = Boolean(installCanvasAlias());
  const fixturesReady = await ensureFixtures();
  const avatarPort = fixturesReady ? await startAvatarServer() : null;
  console.log(
    `canvas للاختبار: ${canvasAvailable ? 'متاح' : 'غير متاح'} | أصول: ${fixturesReady ? PHOTO_DIR : 'بدون'} | أفاتار: ${avatarPort || 'بدون'}`
  );

  const channel = createFakeChannel(channelId);
  const client = createFakeClient(channel, guildId);

  const db = createFakeDb({
    [`commandChannel_${guildId}`]: channelId,
    [`managergamesfr_${guildId}`]: managerRole,
    [`custom_color_${guildId}`]: '#1E3A8A',
    [`timerRPS_100`]: 800
  });

  const users = {
    admin: createUser('admin', '100'),
    alice: createUser('Alice', '101'),
    bob: createUser('Bob', '102'),
    cara: createUser('Cara', '103'),
    // رابط غير موجود: يختبر مسار تعذّر تحميل الأفاتار (بديل مرسوم)
    eve: createUser('Eve', '104', { avatarUrl: `http://127.0.0.1:${avatarPort}/missing.png` })
  };

  for (const [key, user] of Object.entries(users)) {
    user.member = {
      id: user.id,
      roles: { cache: { has: (id) => key === 'admin' && String(id) === managerRole } }
    };
  }

  const config = {
    assetsPath: fixturesReady ? PHOTO_DIR : undefined,
    rps: {
      minJoinMs: 100,
      defaultJoinMs: 400,
      maxJoinMs: 1000,
      roundMs: 250,
      startDelayMs: 15,
      roundDelayMs: 15,
      maxGameMs: 30000,
      maxDraws: 5,
      avatarTimeoutMs: 250
    }
  };

  // eslint-disable-next-line global-require
  const { execute } = require('../games/rockPaperScissors');
  const api = execute(client, db, () => {}, config, { prefix, owners: [] });

  assert.ok(api && typeof api.getGame === 'function');

  /* ------------------------- 1) صلاحيات ------------------------- */
  await runCommand(client, channel, users.eve, `${prefix}حجره`, { guildId });
  await waitFor(() => channel.last((m) => m.content.includes('ليس لديك صلاحية')), {
    label: 'رسالة رفض الصلاحية'
  });
  assert.strictEqual(api.getGame(guildId), null, 'لا يجب أن تبدأ اللعبة بدون صلاحية');
  console.log('✓ رفض غير المشرف');

  // قناة غير القناة المضبوطة: يجب تجاهل الأمر تماماً
  const otherChannel = createFakeChannel('channel_other');
  const before = channel.messages.length;
  await runCommand(client, otherChannel, users.admin, `${prefix}حجره`, { guildId });
  await wait(30);
  assert.strictEqual(channel.messages.length, before, 'يجب تجاهل الأمر خارج القناة المضبوطة');
  assert.strictEqual(otherChannel.messages.length, 0, 'لا يجب أن يرد البوت في القناة الخاطئة');
  console.log('✓ تجاهل الأمر خارج القناة المضبوطة');

  /* ---------------------- 2) بدء اللعبة ------------------------ */
  // أول إرسال يفشل بسبب إيموجي مخصص غير متاح → يجب أن تعيد المحاولة بإيموجي يونيكود.
  channel.failWithEmojiErrorOnce = true;

  await runCommand(client, channel, users.admin, `${prefix}حجره`, { guildId });

  const joinMessage = await waitFor(
    () => channel.last((m) => m.content.includes('ستبدأ اللعبة')),
    { label: 'رسالة الانضمام' }
  );

  assert.ok(JSON.stringify(joinMessage.components).includes('📥'), 'يجب استخدام الإيموجي البديلة بعد فشل الإيموجي المخصص');
  assert.ok(api.getGame(guildId), 'يجب تسجيل اللعبة في الذاكرة');

  const joinCollector = joinMessage.collectors[0];
  assert.ok(joinCollector, 'يجب إنشاء collector للانضمام');

  /* --------------------- 3) الشرح والانضمام --------------------- */
  const explain = await click(joinMessage, users.alice, 'explain_rps');
  assert.ok(explain.lastReply && explain.lastReply.content.includes('طريقة اللعب'), 'يجب إرسال الشرح');

  await click(joinMessage, users.alice, 'join_rps');
  await click(joinMessage, users.bob, 'join_rps');
  await click(joinMessage, users.cara, 'join_rps');

  assert.ok(joinMessage.content.includes('(3 / 10)'), `عدد اللاعبين غير صحيح: ${joinMessage.content}`);

  const duplicate = await click(joinMessage, users.alice, 'join_rps');
  assert.ok(duplicate.lastReply.content.includes('بالفعل'), 'يجب رفض الانضمام المكرر');

  await click(joinMessage, users.cara, 'leave_rps');
  assert.ok(joinMessage.content.includes('(2 / 10)'), 'يجب تحديث العدد بعد الخروج');
  await click(joinMessage, users.cara, 'join_rps');
  assert.ok(joinMessage.content.includes('(3 / 10)'), 'يجب تحديث العدد بعد العودة');
  console.log('✓ الانضمام والخروج والشرح والانضمام المكرر');

  /* --------------------- 4) الجولة الأولى ---------------------- */
  const battle1 = await waitFor(
    () => channel.last((m) => m.content.includes('الجولة 1') && m.collectors.length > 0),
    { label: 'رسالة الجولة الأولى', timeout: 5000 }
  );

  const battleImages = dumpAttachments(battle1, 'battle');
  if (canvasAvailable) assert.ok(battleImages.length > 0, 'يجب إرفاق صورة المعركة');

  const ids = [...battle1.content.matchAll(/<@(\d+)>/g)].map((match) => match[1]);
  assert.strictEqual(ids.length, 2, 'يجب أن يتضمن نص الجولة لاعبين اثنين');

  const player1 = Object.values(users).find((user) => user.id === ids[0]);
  const player2 = Object.values(users).find((user) => user.id === ids[1]);

  // كلاهما حجر → تعادل
  await click(battle1, player1, 'rps_rock');
  await click(battle1, player2, 'rps_rock');

  const drawMessage = await waitFor(() => channel.last((m) => m.content.includes('تعادل')), {
    label: 'رسالة التعادل'
  });
  const drawImages = dumpAttachments(drawMessage, 'draw');
  if (canvasAvailable) assert.ok(drawImages.length > 0, 'يجب إرفاق صورة النتيجة عند التعادل');

  const battle1Replay = await waitFor(
    () => channel.last((m) => m.content.includes('الجولة 1') && m.collectors.length > 0 && m !== battle1),
    { label: 'إعادة الجولة بعد التعادل' }
  );

  // حجر ضد مقص → فوز اللاعب الأول
  await click(battle1Replay, player1, 'rps_rock');
  await click(battle1Replay, player2, 'rps_scissors');

  const winMessage = await waitFor(() => channel.last((m) => m.content.includes('فاز')), {
    label: 'رسالة الفوز'
  });
  assert.ok(winMessage.content.includes(`<@${player1.id}>`), 'يجب أن يفوز صاحب الحجر');
  const winImages = dumpAttachments(winMessage, 'win');
  if (canvasAvailable) assert.ok(winImages.length > 0, 'يجب إرفاق صورة النتيجة عند الفوز');

  const battle2 = await waitFor(
    () => channel.last((m) => m.content.includes('الجولة 2') && m.collectors.length > 0),
    { label: 'رسالة الجولة الثانية' }
  );
  console.log('✓ التعادل وإعادة الجولة ثم الفوز والإقصاء');

  /* ------------------ 5) عدم تفاعل → إلغاء -------------------- */
  await wait(400); // دع مهلة الجولة (250ms) تنتهي دون أي نقر
  await waitFor(() => channel.last((m) => m.content.includes('لم يختر أي لاعب')), {
    label: 'رسالة إلغاء اللعبة لعدم التفاعل'
  });
  await waitFor(() => api.getGame(guildId) === null, { label: 'تحرير اللعبة بعد الإلغاء' });

  const disabledJoin = joinMessage.edits[joinMessage.edits.length - 1];
  const disabledRows = disabledJoin.components[0].toJSON().components;
  assert.ok(disabledRows.every((component) => component.disabled), 'يجب تعطيل أزرار الانضمام بعد الإلغاء');
  assert.strictEqual(battle2.collectors[0].ended, true);
  console.log('✓ إلغاء اللعبة عند عدم تفاعل اللاعبين وتحرير القفل');

  /* ------------- 6) انتهاء اللعبة واحتساب النقطة --------------- */
  await runCommand(client, channel, users.admin, `${prefix}حجره`, { guildId });
  const joinMessage2 = await waitFor(
    () => channel.last((m) => m !== joinMessage && m.content.includes('ستبدأ اللعبة')),
    { label: 'رسالة الانضمام الثانية' }
  );

  await click(joinMessage2, users.alice, 'join_rps');
  await click(joinMessage2, users.bob, 'join_rps');

  const battle3 = await waitFor(
    () => channel.last((m) => m.content.includes('الجولة 1') && m.collectors.length > 0 && m !== battle1 && m !== battle1Replay),
    { label: 'جولة اللعبة الثانية' }
  );

  const ids3 = [...battle3.content.matchAll(/<@(\d+)>/g)].map((match) => match[1]);
  const responder = Object.values(users).find((user) => user.id === ids3[0]);
  const silent = Object.values(users).find((user) => user.id === ids3[1]);

  await click(battle3, responder, 'rps_paper');
  await wait(400); // انتظر انتهاء مهلة الجولة وإقصاء اللاعب الصامت

  await waitFor(() => channel.last((m) => m.content.includes('لم يختر')), {
    label: 'رسالة إقصاء اللاعب الصامت'
  });

  const finalEmbedMessage = await waitFor(
    () => channel.last((m) => m.embeds.length > 0 && m.embeds[0].data && m.embeds[0].data.title === '🏆 انتهت اللعبة!'),
    { label: 'رسالة الفائز النهائي' }
  );

  await waitFor(() => api.getGame(guildId) === null, { label: 'تحرير اللعبة بعد الفوز' });

  const pointsKey = `points_${guildId}.${responder.id}`;
  assert.strictEqual(db.store.get(pointsKey), 1, 'يجب منح نقطة واحدة للفائز');
  assert.ok(finalEmbedMessage.embeds[0].data.description.includes(responder.id));
  assert.ok(!db.store.get(`points_${guildId}.${silent.id}`), 'لا يجب منح نقاط للخاسر');

  console.log(`✓ إقصاء اللاعب الصامت واحتساب النقطة (${pointsKey} = 1)`);
  console.log(`الصور المحفوظة: ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error('✗ فشل الاختبار:', error);
  process.exitCode = 1;
});
