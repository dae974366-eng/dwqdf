'use strict';

/**
 * نقطة تشغيل البوت — نسخة مصحّحة.
 *
 * أهم ما تغيّر عن الملف القديم:
 *  - حدث الجاهزية: clientReady بدل ready (بدون DeprecationWarning)، مع توافق مع
 *    النسخ الأقدم من discord.js عبر مستمع احتياطي محمي من التكرار.
 *  - المسارات: كلها مبنية على __dirname بدل الـ cwd، فيعمل البوت من أي مجلد.
 *  - الحزم المساعدة (colors, ms, canvas-constructor, dotenv, quick.db) لم تعد
 *    قادرة على إسقاط البوت عند غيابها؛ لكل واحدة بديل أو رسالة واضحة.
 *  - utils.times أصبحت عبر getter (النسخة القديمة كانت ترسل قيمة مجمّدة).
 *  - setMaxListeners يُحسب حسب عدد الأوامر الفعلي بدل رقم ثابت 120.
 *  - معالجة أخطاء الدخول/الاتصال/الإيقاف بشكل واضح، وأخطاء غير ملتقطة مع stack.
 */

/* ----------------------------- dotenv (اختياري) ----------------------------- */

try {
  require('dotenv').config();
} catch {
  // dotenv غير مثبت — لا مشكلة، يمكن وضع التوكن داخل config.json.
}

const fs = require('fs');
const path = require('path');

const discord = require('discord.js');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ActivityType
} = discord;

/* ------------------------------ colors (اختياري) ---------------------------- */

try {
  require('colors');
} catch {
  // بديل بسيط حتى لا تفشل سطور مثل "...".red في بقية الملفات.
  // colors يعرّفها كـ getters، لذلك نستخدم getter أيضاً (لا دالة تُستدعى).
  const names = ['green', 'red', 'yellow', 'cyan', 'magenta', 'blue', 'gray', 'grey', 'white', 'bold', 'underline'];
  for (const name of names) {
    if (!(name in String.prototype)) {
      Object.defineProperty(String.prototype, name, {
        get() {
          return String(this);
        },
        configurable: true
      });
    }
  }
}

/* -------------------------------- ms (اختياري) ------------------------------ */

let ms;
try {
  // eslint-disable-next-line global-require
  ms = require('ms');
} catch {
  ms = (value) => value;
}

/* ------------------------------ الإعدادات ---------------------------------- */

let config;
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  config = require(path.join(__dirname, 'config.json'));
} catch (error) {
  console.error('✗ لم يتم العثور على config.json أو أنه غير صالح للقراءة.'.red);
  console.error(`  المسار المتوقع: ${path.join(__dirname, 'config.json')}`);
  console.error('  أنشئ الملف بالشكل التالي:');
  console.error('  { "token": "TOKEN", "prefix": "!", "owners": ["123456789012345678"] }');
  process.exit(1);
}

const prefix = config.prefix || '!';
const owners = Array.isArray(config.owners) ? config.owners.map(String) : [];
const token = config.token || process.env.TOKEN || process.env.DISCORD_TOKEN || process.env.token;

if (!token || typeof token !== 'string' || !token.trim()) {
  console.error('✗ لا يوجد توكن.'.red);
  console.error('  ضعه في config.json تحت المفتاح "token" أو في ملف .env باسم TOKEN.');
  process.exit(1);
}

/* --------------------------- قاعدة البيانات -------------------------------- */

let dbq;
try {
  // eslint-disable-next-line global-require
  const { QuickDB } = require('quick.db');
  dbq = new QuickDB();
} catch (error) {
  console.warn('⚠️ quick.db غير متاح، سيتم استخدام مخزن JSON محلي مؤقت.'.yellow);
  console.warn('   ثبّته بالأمر: npm install quick.db');
  const reason = String((error && error.message) || error).split('\n')[0];
  console.warn(`   السبب: ${reason}`);
  dbq = createJsonStore(path.join(__dirname, 'database.fallback.json'));
}

/**
 * بديل بسيط لواجهة quick.db (get/set/delete/add/sub/push/pull/has/all)
 * يدعم المفاتيح النقطية مثل points_123.456.
 * لا يُستخدم إلا إذا فشل تحميل quick.db.
 */
function createJsonStore(file) {
  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      return {};
    }
  };

  let data = load();
  let timer = null;

  const persist = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('تعذّر حفظ قاعدة بيانات JSON:', error && error.message);
      }
    }, 100);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const parts = (key) => String(key).split('.').filter(Boolean);

  const readPath = (key) => {
    let node = data;
    for (const part of parts(key)) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  };

  const writePath = (key, value) => {
    const list = parts(key);
    if (!list.length) return;

    let node = data;
    for (let i = 0; i < list.length - 1; i += 1) {
      const part = list[i];
      if (node[part] == null || typeof node[part] !== 'object') node[part] = {};
      node = node[part];
    }

    const last = list[list.length - 1];
    if (value === undefined) delete node[last];
    else node[last] = value;
  };

  return {
    async get(key) {
      return readPath(key);
    },
    async set(key, value) {
      writePath(key, value);
      persist();
      return value;
    },
    async delete(key) {
      writePath(key, undefined);
      persist();
      return true;
    },
    async has(key) {
      return readPath(key) !== undefined;
    },
    async all() {
      return Object.entries(data).map(([id, value]) => ({ id, value }));
    },
    async add(key, value) {
      const next = Number(readPath(key) || 0) + Number(value || 0);
      writePath(key, next);
      persist();
      return next;
    },
    async sub(key, value) {
      const next = Number(readPath(key) || 0) - Number(value || 0);
      writePath(key, next);
      persist();
      return next;
    },
    async push(key, value) {
      const list = readPath(key);
      const next = Array.isArray(list) ? [...list, value] : [value];
      writePath(key, next);
      persist();
      return next;
    },
    async pull(key, value) {
      const list = readPath(key);
      const next = Array.isArray(list) ? list.filter((item) => item !== value) : [];
      writePath(key, next);
      persist();
      return next;
    }
  };
}

/* ------------------------------- العميل ------------------------------------ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const has_play = new Map();
let gameRunning = false;
let times = false;

function isGameRunning() {
  return gameRunning;
}

function setGameRunning(state) {
  gameRunning = Boolean(state);
}

function timeout(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

/**
 * utils المشتركة لكل الأوامر.
 * لاحظ getter الخاص بـ times: النسخة القديمة كانت تمرّر قيمة مجمّدة،
 * فأي setTimes من أمر لا يراه أمر آخر.
 */
const sharedUtils = {
  isGameRunning,
  setGameRunning,
  owners,
  prefix,
  timeout,
  Discord: discord,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ms,
  fs,
  path,
  dbq,
  get times() {
    return times;
  },
  setTimes: (value) => {
    times = value;
  }
};

/* ---------------------------- تحميل الأوامر -------------------------------- */

const commandsDir = path.join(__dirname, 'commands');
let loadedCommands = 0;
let failedCommands = 0;

if (fs.existsSync(commandsDir)) {
  const commandFiles = fs.readdirSync(commandsDir).filter((file) => file.endsWith('.js'));

  for (const file of commandFiles) {
    const fullPath = path.join(commandsDir, file);

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const command = require(fullPath);

      if (!command || typeof command.execute !== 'function') {
        console.warn(`⚠️ الملف ${file} لا يصدر دالة execute — تم تجاهله.`.yellow);
        failedCommands += 1;
        continue;
      }

      command.execute(client, dbq, has_play, config, sharedUtils);
      loadedCommands += 1;
    } catch (error) {
      failedCommands += 1;
      console.error(`✗ خطأ أثناء تحميل ملف الأمر ${file}:`.red, error);
    }
  }

  console.log(
    `تم تحميل ${loadedCommands} أمر${failedCommands ? ` (فشل ${failedCommands})` : ''}.`.cyan
  );
} else {
  console.warn(`⚠️ مجلد الأوامر غير موجود: ${commandsDir}`.yellow);
}

// كل ملف أمر يسجّل مستمع messageCreate خاص به، لذلك الحد يجب أن يكفي العدد الفعلي.
client.setMaxListeners(Math.max(60, loadedCommands * 2 + 40));

/* ------------------------ نظام المتجر الإضافي (اختياري) --------------------- */

try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  require(path.join(__dirname, 'helpers', 'gif-shop-system'));
} catch (error) {
  if (!error || error.code !== 'MODULE_NOT_FOUND') {
    console.error('✗ خطأ في تحميل helpers/gif-shop-system:'.red, error);
  }
}

/* ------------------------------- الجاهزية ---------------------------------- */

let readyHandled = false;

async function onClientReady(readyClient) {
  if (readyHandled) return; // يمنع التنفيذ مرتين (ready + clientReady)
  readyHandled = true;

  console.log(`تم تشغيل البوت بنجاح: ${readyClient.user.tag}`.green);
  console.log(
    `رابط دعوة البوت: https://discord.com/oauth2/authorize?client_id=${readyClient.user.id}&permissions=8&scope=bot`.cyan
  );

  const fallbackActivity = {
    name: 'BD7',
    type: ActivityType.Streaming,
    url: 'https://www.twitch.tv/BD7'
  };

  try {
    let stored = null;
    try {
      stored = await dbq.get(`activity_${readyClient.user.id}`);
    } catch {
      stored = null;
    }

    readyClient.user.setActivity(normalizeActivity(stored) || fallbackActivity);
  } catch (error) {
    console.log(`خطأ في ضبط الـ Activity: ${error && error.message ? error.message : error}`.yellow);
    try {
      readyClient.user.setActivity(fallbackActivity.name, { type: fallbackActivity.type });
    } catch {
      /* تجاهل */
    }
  }
}

/**
 * تنظيف نشاط البوت القادم من قاعدة البيانات:
 * يرفض أي نوع غير معروف، ويضمن وجود url صالح لحالة Streaming.
 */
function normalizeActivity(activity) {
  if (!activity || typeof activity !== 'object') return null;

  const name = typeof activity.name === 'string' ? activity.name.trim().slice(0, 128) : '';
  if (!name) return null;

  const numericType = typeof activity.type === 'string' ? ActivityType[activity.type] : activity.type;
  const type = Number.isInteger(numericType) && numericType >= 0 && numericType <= 5
    ? numericType
    : ActivityType.Playing;

  if (type === ActivityType.Custom) {
    return { name, type: ActivityType.Custom };
  }

  if (type === ActivityType.Streaming) {
    const url = typeof activity.url === 'string' && /^https?:\/\//i.test(activity.url)
      ? activity.url
      : 'https://www.twitch.tv/discord';
    return { name, type, url };
  }

  return { name, type };
}

// clientReady هي الاسم الجديد (discord.js 14.27+). النسخ الأقدم لا تعرفها،
// لذلك نضيف ready كاحتياط، والحماية أعلاه تمنع التشغيل المزدوج.
client.once('clientReady', (readyClient) => {
  onClientReady(readyClient).catch((error) => {
    console.error('✗ خطأ داخل معالج الجاهزية:'.red, error);
  });
});

client.once('ready', (readyClient) => {
  onClientReady(readyClient).catch((error) => {
    console.error('✗ خطأ داخل معالج الجاهزية:'.red, error);
  });
});

/* ------------------------------ منشن البوت --------------------------------- */

client.on('messageCreate', (message) => {
  if (!message || message.author.bot || !message.guild) return;
  if (!client.user) return;

  const mentioned = message.content === `<@${client.user.id}>` || message.content === `<@!${client.user.id}>`;
  if (!mentioned) return;

  message.reply({ content: `**Hello My prefix is \`${prefix}\`**` }).catch(() => {});
});

/* ------------------------------ الأخطاء ------------------------------------ */

client.on('error', (error) => {
  console.error('✗ خطأ في عميل ديسكورد:'.red, error);
});

client.on('warn', (message) => {
  console.warn(`⚠️ تحذير من ديسكورد: ${message}`.yellow);
});

client.on('shardError', (error) => {
  console.error('✗ خطأ في اتصال الشارد:'.red, error);
});

process.on('unhandledRejection', (error) => {
  console.error('✗ Unhandled Rejection:'.red, error && error.stack ? error.stack : error);
});

process.on('uncaughtException', (error) => {
  console.error('✗ Uncaught Exception:'.red, error && error.stack ? error.stack : error);
});

/* ------------------------------ الإيقاف ------------------------------------ */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${signal}: إيقاف البوت...`.yellow);
  try {
    await client.destroy();
  } catch (error) {
    console.error('خطأ أثناء الإيقاف:', error && error.message ? error.message : error);
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

/* ------------------------------- الدخول ------------------------------------ */

client.login(token).catch((error) => {
  const code = error && error.code;
  const message = String((error && error.message) || '');

  console.error('✗ فشل تسجيل الدخول إلى ديسكورد.'.red);

  if (code === 'TokenInvalid' || /invalid token/i.test(message)) {
    console.error('  التوكن غير صالح: انسخه من صفحة البوت في Developer Portal ثم ضعه في config.json.');
  } else if (/disallowed intents/i.test(message)) {
    console.error('  يجب تفعيل Privileged Intents من Developer Portal → Bot:');
    console.error('   • MESSAGE CONTENT INTENT');
    console.error('   • SERVER MEMBERS INTENT (إذا كنت تعتمد على message.member للرتب)');
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(message)) {
    console.error('  تعذّر الوصول إلى شبكة ديسكورد: تحقّق من اتصال السيرفر/الاستضافة أو من الحظر.');
  } else {
    console.error(`  ${message}`);
  }

  process.exitCode = 1;
  try {
    client.destroy();
  } catch {
    /* تجاهل */
  }
});
