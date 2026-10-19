'use strict';

/**
 * helpers/index.js
 *
 * هذا ملف "احتياطي" (shim) لحل خطأ:
 *   Error: Cannot find module './helpers'
 *
 * سبب الخطأ: ملف index.js عندك يستدعي `require('./helpers')`، وهذا يعني أنه يبحث عن
 * أحد الملفين:
 *   • helpers/index.js
 *   • helpers.js
 * ولم يجدهما، فتعطّل البوت قبل أن يصل إلى أي أمر.
 *
 * إذا كان لديك مجلد helpers الحقيقي: احتفظ به ولا تنسخ هذا الملف فوقه.
 * إذا لم يكن لديك (وهو المتوقع)، انسخ هذا الملف إلى المسار `helpers/index.js`
 * ليستطيع البوت الإقلاع، ثم استبدل الدوال بمنطقك الحقيقي حسب ما تستخدمه الأوامر.
 *
 * ملاحظة: أي دالة غير معرّفة هنا تُرجع `undefined` مع تحذير في الكونسول مرة واحدة،
 * فلا ينهار البوت بصمت، ويظهر لك اسم الدالة الناقصة لتضيفها.
 */

const crypto = require('crypto');

/* ------------------------------- أدوات عامة ------------------------------- */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
const sleep = wait;

function randomInt(min, max) {
  const low = Math.ceil(Math.min(Number(min) || 0, Number(max) || 0));
  const high = Math.floor(Math.max(Number(min) || 0, Number(max) || 0));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

function pick(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list[randomInt(0, list.length - 1)];
}

function shuffle(list) {
  const copy = Array.isArray(list) ? list.slice() : [];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function chunk(list, size) {
  const arr = Array.isArray(list) ? list : [];
  const step = Math.max(1, Math.floor(Number(size) || 1));
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step));
  return out;
}

function truncate(text, max = 100, suffix = '…') {
  const value = String(text == null ? '' : text);
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

function escapeMarkdown(text) {
  return String(text == null ? '' : text).replace(/[*_`~|>\\]/g, '');
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  const seconds = Math.floor(total / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}س ${minutes % 60}د`;
  if (minutes > 0) return `${minutes}د ${seconds % 60}ث`;
  return `${seconds}ث`;
}

function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

function randomId(length = 8) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function unique(list) {
  return Array.from(new Set(Array.isArray(list) ? list : []));
}

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function mention(id) {
  return `<@${String(id)}>`;
}

function sleepUntil(timestamp) {
  return wait(Math.max(0, Number(timestamp) - Date.now()));
}

/* --------------------------- مساعدات ديسكورد ------------------------------ */

async function safeSend(channel, payload) {
  if (!channel || typeof channel.send !== 'function') return null;
  try {
    return await channel.send(payload);
  } catch (error) {
    console.warn('[helpers] تعذّر إرسال رسالة:', error && error.message ? error.message : error);
    return null;
  }
}

async function safeReply(message, payload) {
  if (!message) return null;
  try {
    if (typeof message.reply === 'function') return await message.reply(payload);
    return await safeSend(message.channel, payload);
  } catch (error) {
    console.warn('[helpers] تعذّر الرد على الرسالة:', error && error.message ? error.message : error);
    return null;
  }
}

async function safeEdit(target, payload) {
  if (!target || typeof target.edit !== 'function') return null;
  try {
    return await target.edit(payload);
  } catch (error) {
    console.warn('[helpers] تعذّر تعديل الرسالة:', error && error.message ? error.message : error);
    return null;
  }
}

function createEmbed(EmbedBuilder, options = {}) {
  if (typeof EmbedBuilder !== 'function') return null;
  const embed = new EmbedBuilder();
  if (options.title) embed.setTitle(options.title);
  if (options.description) embed.setDescription(options.description);
  if (options.color !== undefined) embed.setColor(options.color);
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.image) embed.setImage(options.image);
  if (options.footer) embed.setFooter(typeof options.footer === 'string' ? { text: options.footer } : options.footer);
  if (options.fields) embed.addFields(options.fields);
  return embed;
}

function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  try {
    if (member.roles && member.roles.cache && typeof member.roles.cache.has === 'function') {
      return member.roles.cache.has(String(roleId));
    }
    if (Array.isArray(member.roles)) return member.roles.map(String).includes(String(roleId));
  } catch {
    /* تجاهل */
  }
  return false;
}

/* --------------------------------- التصدير -------------------------------- */

const helpers = {
  // عامة
  wait,
  sleep,
  timeout: wait,
  sleepUntil,
  randomInt,
  pick,
  shuffle,
  chunk,
  unique,
  truncate,
  escapeMarkdown,
  formatDuration,
  formatNumber,
  randomId,
  isSnowflake,
  mention,

  // ديسكورد
  safeSend,
  safeReply,
  safeEdit,
  createEmbed,
  memberHasRole
};

module.exports = new Proxy(helpers, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return target[prop];

    if (!missingWarned.has(prop)) {
      missingWarned.add(prop);
      console.warn(
        `[helpers] الدالة "${String(prop)}" غير موجودة في helpers/index.js. ` +
          'أضفها هنا أو صحّح الاسم في الأمر الذي يستخدمها.'
      );
    }

    return undefined;
  }
});

const missingWarned = new Set();
