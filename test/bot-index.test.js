'use strict';

/**
 * اختبار نقطة تشغيل البوت (index.js) بدون الاتصال بديسكورد:
 * نضع نسخة من index.js في مجلد مؤقت مع config.json وأمر تجريبي،
 * ونستبدل discord.js ببديل محلي يطلق ready و clientReady معاً.
 *
 * يتحقق من:
 *  - تحميل الأوامر من مجلد __dirname وليس من cwd.
 *  - utils.times getter يعمل (setTimes من أمر يظهر لأمر آخر).
 *  - حدث clientReady يعمل، ولا يتنفّذ معالج الجاهزية مرتين.
 *  - ضبط نشاط البوت بشكل صحيح.
 *  - الإيقاف اللطيف عند SIGTERM (exit code 0).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-bot-'));

function writeStubDiscord() {
  const dir = path.join(TMP, 'node_modules', 'discord.js');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'discord.js', version: '14.27.0', main: 'index.js' }, null, 2)
  );

  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `'use strict';
const { EventEmitter } = require('events');

class Builder {
  constructor() { this.data = {}; }
  setTitle(v) { this.data.title = v; return this; }
  setDescription(v) { this.data.description = v; return this; }
  setColor(v) { this.data.color = v; return this; }
  setThumbnail(v) { this.data.thumbnail = v; return this; }
  setFooter(v) { this.data.footer = v; return this; }
  setStyle() { return this; }
  setCustomId() { return this; }
  setLabel() { return this; }
  setDisabled() { return this; }
  setEmoji() { return this; }
  addComponents() { return this; }
  toJSON() { return this.data; }
}

class Client extends EventEmitter {
  constructor(options) { super(); this.options = options; this.user = null; this.destroyed = false; }
  async login() {
    this.user = {
      id: '999999999999999999',
      tag: 'TestBot#0001',
      setActivity: (activity, extra) => console.log('[stub] activity=' + JSON.stringify(activity) + ' extra=' + JSON.stringify(extra || null))
    };
    console.log('[stub] login ok');
    // يُبقي العملية حية مثل اتصال gateway الحقيقي حتى نختبر SIGTERM.
    this.keepAlive = setInterval(() => {}, 1000);
    setTimeout(() => {
      this.emit('ready', this);
      this.emit('clientReady', this);
      console.log('[stub] both ready events emitted');
      setTimeout(() => console.log('TEST_DONE'), 30);
    }, 10);
    return 'token';
  }
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    console.log('[stub] destroy');
  }
}

module.exports = {
  Client,
  GatewayIntentBits: { Guilds: 1, GuildMembers: 2, GuildMessages: 512, MessageContent: 32768 },
  Partials: { Channel: 0, GuildMember: 1, Message: 2, User: 3 },
  EmbedBuilder: Builder,
  ActionRowBuilder: Builder,
  ButtonBuilder: Builder,
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  PermissionsBitField: { Flags: {} },
  ActivityType: { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Custom: 4, Competing: 5 }
};
`
  );
}

function runBot() {
  const child = spawn(process.execPath, [path.join(TMP, 'index.js')], {
    cwd: os.tmpdir(), // مهم: cwd مختلف عن مجلد الملف لاختبار __dirname
    env: { ...process.env, PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

/**
 * يشغّل نسخة من index.js وينتظر ظهور علامة معينة في المخرجات،
 * ثم يوقفها بـ SIGTERM ويعيد المخرجات ورمز الخروج.
 */
function runBot(dir, { marker = 'TEST_DONE', timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'index.js')], {
      cwd: os.tmpdir(),
      env: { ...process.env, NODE_PATH: path.join(TMP, 'node_modules') },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ code, signal, stdout, stderr });
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const poll = setInterval(() => {
      if (stdout.includes(marker) && !done) {
        clearInterval(poll);
        child.kill('SIGTERM');
      }
    }, 20);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!done) {
        done = true;
        clearInterval(poll);
        reject(new Error(`انتهت المهلة بانتظار "${marker}". stdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    }, timeout);

    child.once('exit', (code, signal) => finish(code, signal));
  });
}

/** يشغّل نسخة من index.js وينتظر خروجها، ويعيد stdout/stderr ورمز الخروج. */
function runAndExit(dir, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, 'index.js')], {
      cwd: os.tmpdir(),
      env: { ...process.env, NODE_PATH: path.join(TMP, 'node_modules') },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`انتهت المهلة. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeout);

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * يتأكد من أن غياب مجلد helpers لا يمنع الإقلاع، وأن الأوامر التي تستدعي
 * وحدات ناقصة تُبلّغ باسم الوحدة بدل إسقاط البوت.
 */
async function checkOptionalHelpers() {
  // (أ) وجود helpers: يُحمّل ويُمرَّر إلى الأوامر
  const withHelpers = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-withhelpers-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'index.js'), path.join(withHelpers, 'index.js'));
  fs.copyFileSync(path.join(TMP, 'config.json'), path.join(withHelpers, 'config.json'));
  fs.cpSync(path.join(REPO_ROOT, 'helpers'), path.join(withHelpers, 'helpers'), { recursive: true });
  fs.mkdirSync(path.join(withHelpers, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(withHelpers, 'commands', 'helper-user.js'),
    `'use strict';
module.exports = { execute(client, dbq, has_play, config, utils) {
  const h = utils.helpers || {};
  console.log('[helper-user] hasWait=' + (typeof h.wait === 'function'));
  console.log('[helper-user] escaped=' + h.escapeMarkdown('a*b_c'));
  console.log('HELPERS_DONE');
} };
`
  );

  const withResult = await runBot(withHelpers, { marker: 'HELPERS_DONE' });
  assert.ok(withResult.stdout.includes('تم تحميل helpers'), `لم يُحمّل helpers:\n${withResult.stdout}`);
  assert.ok(withResult.stdout.includes('[helper-user] hasWait=true'), 'utils.helpers.wait غير متاح');
  assert.ok(withResult.stdout.includes('[helper-user] escaped=abc'), 'escapeMarkdown لا يعمل');

  // (ب) غياب helpers + أمر يستدعي وحدة ناقصة: البوت يقلع ويطبع اسم الوحدة
  const withoutHelpers = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-nohelpers-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'index.js'), path.join(withoutHelpers, 'index.js'));
  fs.copyFileSync(path.join(TMP, 'config.json'), path.join(withoutHelpers, 'config.json'));

  const badCommands = path.join(withoutHelpers, 'commands');
  fs.mkdirSync(badCommands, { recursive: true });
  fs.writeFileSync(
    path.join(badCommands, 'needs-helpers.js'),
    `'use strict';
require('../helpers');
module.exports = { execute() {} };
`
  );
  fs.writeFileSync(
    path.join(badCommands, 'needs-package.js'),
    `'use strict';
require('package-that-does-not-exist-xyz');
module.exports = { execute() {} };
`
  );
  fs.writeFileSync(
    path.join(badCommands, 'fine.js'),
    `'use strict';
module.exports = { execute() { console.log('FINE_COMMAND_LOADED'); } };
`
  );

  const withoutResult = await runBot(withoutHelpers, { marker: '[stub] both ready events emitted' });
  // التحذيرات تُكتب على stderr، والمخرجات العادية على stdout.
  const combined = `${withoutResult.stdout}\n${withoutResult.stderr}`;

  assert.ok(combined.includes('لم يتم العثور على helpers'), `يجب التحذير عند غياب helpers:\n${combined}`);
  assert.ok(combined.includes('../helpers'), `يجب ذكر الوحدة الناقصة ../helpers:\n${combined}`);
  assert.ok(
    combined.includes('package-that-does-not-exist-xyz'),
    `يجب ذكر الحزمة الناقصة:\n${combined}`
  );
  assert.ok(withoutResult.stdout.includes('FINE_COMMAND_LOADED'), 'الأمر السليم يجب أن يُحمّل رغم فشل الآخرين');
  assert.ok(withoutResult.stdout.includes('فشل 2'), `عدّاد الفشل غير صحيح:\n${withoutResult.stdout}`);

  console.log('✓ index.js: helpers اختياري، ورسائل واضحة للوحدات الناقصة');
}

async function checkStartupErrors() {
  const noConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-noconfig-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'index.js'), path.join(noConfigDir, 'index.js'));

  const noConfig = await runAndExit(noConfigDir);
  assert.notStrictEqual(noConfig.code, 0, 'يجب أن يخرج البوت بخطأ عند غياب config.json');
  assert.ok(/config\.json/.test(noConfig.stderr), `رسالة config.json غير واضحة:\n${noConfig.stderr}`);

  const noTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-notoken-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'index.js'), path.join(noTokenDir, 'index.js'));
  fs.writeFileSync(path.join(noTokenDir, 'config.json'), JSON.stringify({ prefix: '!' }));

  const noToken = await runAndExit(noTokenDir);
  assert.notStrictEqual(noToken.code, 0, 'يجب أن يخرج البوت بخطأ عند غياب التوكن');
  assert.ok(/لا يوجد توكن|token/i.test(noToken.stderr), `رسالة التوكن غير واضحة:\n${noToken.stderr}`);

  console.log('✓ index.js: رسائل خطأ واضحة عند غياب config.json أو التوكن');
}

async function main() {
  // نسخة من نقطة التشغيل + إعدادات + أمر تجريبي
  fs.copyFileSync(path.join(REPO_ROOT, 'index.js'), path.join(TMP, 'index.js'));
  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify({ token: 'FAKE_TOKEN_FOR_TEST', prefix: '!', owners: ['100'] }, null, 2)
  );

  const commandsDir = path.join(TMP, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'sample.js'),
    `'use strict';
const state = { seen: null };
module.exports = {
  execute(client, dbq, has_play, config, utils) {
    console.log('[sample] loaded prefix=' + utils.prefix + ' times=' + utils.times + ' owners=' + utils.owners.join(','));
    utils.setTimes(777);
    console.log('[sample] getter times=' + utils.times);
    if (typeof utils.setGameRunning === 'function') {
      utils.setGameRunning(true);
      console.log('[sample] isGameRunning=' + utils.isGameRunning());
    }
    if (client.listenerCount('messageCreate') < 1) console.log('[sample] no listener registered (ok for sample)');
  }
};
`
  );

  fs.writeFileSync(
    path.join(commandsDir, 'broken.js'),
    `'use strict';\nthrow new Error('ملف تالف للاختبار');\n`
  );

  writeStubDiscord();

  const result = await runBot(TMP);
  const out = result.stdout;
  const err = result.stderr;

  assert.ok(out.includes('[sample] loaded prefix=! times=false owners=100'), `لم يُحمّل الأمر من __dirname:\n${out}`);
  assert.ok(out.includes('[sample] getter times=777'), 'utils.times يجب أن يقرأ القيمة المحدثة');
  assert.ok(out.includes('[sample] isGameRunning=true'), 'isGameRunning يجب أن يعيد الحالة المحدّثة');
  assert.ok(out.includes('تم تحميل 1 أمر'), `عدّاد الأوامر غير صحيح:\n${out}`);
  assert.ok(err.includes('broken.js'), 'يجب الإبلاغ عن ملف الأمر التالف دون إسقاط البوت');

  const readyMatches = out.match(/تم تشغيل البوت بنجاح/g) || [];
  assert.strictEqual(readyMatches.length, 1, `معالج الجاهزية تنفّذ ${readyMatches.length} مرة:\n${out}`);
  assert.ok(out.includes('[stub] both ready events emitted'), 'يجب أن يُطلق البديل الحدثين');

  assert.ok(out.includes('"name":"BD7"'), `لم يُضبط النشاط:\n${out}`);
  assert.ok(out.includes('"type":1'), 'يجب أن يكون النشاط Streaming');
  assert.ok(out.includes('https://www.twitch.tv/BD7'), 'يجب أن يحتوي النشاط على الرابط');

  assert.ok(out.includes('[stub] destroy'), `يجب استدعاء client.destroy عند الإيقاف:\n${out}\n${err}`);
  assert.strictEqual(result.code, 0, `رمز الخروج يجب أن يكون 0، كان ${result.code} (signal ${result.signal})\n${err}`);

  console.log('✓ index.js: تحميل الأوامر، clientReady مرة واحدة، النشاط، والإيقاف اللطيف');
  console.log(`  (تم الاختبار في ${TMP})`);

  await checkOptionalHelpers();
  await checkStartupErrors();
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('✗ فشل اختبار index.js:', error);
    process.exit(1);
  }
);
