'use strict';

/**
 * لعبة: حجر / ورق / مقص — نسخة مصحّحة ومتوافقة مع Node.js 20/22 و discord.js v14.
 *
 * طريقة التركيب داخل البوت الحالي:
 *   const rps = require('./games/rockPaperScissors');
 *   rps.execute(client, dbq, has_play, config, utils);
 *
 * الملاحظات المهمة:
 *  - لم يتم تغيير واجهة الـ execute ولا أسماء الأوامر ولا مفاتيح قاعدة البيانات.
 *  - مكتبة canvas تُحمَّل بشكل "كسول" (lazy): إذا فشل تحميلها أو فشل تحميل أي صورة،
 *    تستمر اللعبة وتُرسل الرسائل نصياً بدل أن ينهار البوت.
 *  - كل الأخطاء داخل معالجات الأحداث مُلتقطة، لذلك لن يؤدي خطأ واحد إلى إيقاف
 *    العملية (unhandled rejection) كما كان يحدث سابقاً على Node 15+.
 */

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} = require('discord.js');

/* ------------------------------------------------------------------ */
/* إعدادات افتراضية (قابلة للتعديل من config.rps)                      */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  maxPlayers: 10,
  minPlayers: 2,
  defaultJoinMs: 10000,
  minJoinMs: 2000,
  maxJoinMs: 10 * 60 * 1000,
  roundMs: 15000,
  startDelayMs: 2000,
  roundDelayMs: 3000,
  maxRounds: 80,
  maxDraws: 25,
  maxGameMs: 45 * 60 * 1000,
  avatarTimeoutMs: 8000,
  avatarCacheSize: 200,
  // false: يعمل الأمر في كل القنوات (الافتراضي الآن).
  // true: يعمل فقط داخل commandChannel_<guildId> (سلوك النسخة القديمة).
  requireCommandChannel: false
};

const DEFAULT_COLORS = {
  base: '#082838',
  light: '#764ba2',
  dark: '#4a5c96'
};

const FONT_FAMILY = 'Cairo';
const FALLBACK_FONT = 'sans-serif';

const CUSTOM_IDS = {
  join: 'join_rps',
  leave: 'leave_rps',
  explain: 'explain_rps',
  rock: 'rps_rock',
  paper: 'rps_paper',
  scissors: 'rps_scissors'
};

/**
 * معرفات الإيموجي المخصصة + بديل يونيكود.
 * البديل يُستخدم تلقائياً إذا رفضت Discord الإيموجي المخصص (مثلاً إذا لم تكن
 * الإيموجي متاحة للتطبيق)، بدل أن تفشل رسالة اللعبة بالكامل.
 */
const EMOJIS = {
  [CUSTOM_IDS.join]: { custom: '1243848352026591274', unicode: '📥' },
  [CUSTOM_IDS.leave]: { custom: '1243848354535047230', unicode: '📤' },
  [CUSTOM_IDS.explain]: { custom: '1254234763699687476', unicode: '❓' },
  [CUSTOM_IDS.rock]: { custom: '1401256439909191890', unicode: '🪨' },
  [CUSTOM_IDS.paper]: { custom: '1401256441557418145', unicode: '📄' },
  [CUSTOM_IDS.scissors]: { custom: '1401256443277217912', unicode: '✂️' }
};

const CHOICES = {
  rock: { label: 'حجر', emoji: '🪨', id: CUSTOM_IDS.rock, file: 'rock.png' },
  paper: { label: 'ورق', emoji: '📄', id: CUSTOM_IDS.paper, file: 'paper.png' },
  scissors: { label: 'مقص', emoji: '✂️', id: CUSTOM_IDS.scissors, file: 'scissors.png' }
};

const CHOICE_BY_CUSTOM_ID = {
  [CUSTOM_IDS.rock]: 'rock',
  [CUSTOM_IDS.paper]: 'paper',
  [CUSTOM_IDS.scissors]: 'scissors'
};

/* ------------------------------------------------------------------ */
/* أدوات ألوان                                                         */
/* ------------------------------------------------------------------ */

function normalizeColor(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return `#${Math.max(0, Math.min(0xffffff, Math.floor(input))).toString(16).padStart(6, '0')}`;
  }

  if (typeof input !== 'string') return null;

  let value = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(value)) {
    value = value.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return `#${value.toLowerCase()}`;
}

function shiftColor(color, percent) {
  const clean = normalizeColor(color);
  if (!clean) return null;

  const amount = Math.round(2.55 * percent);
  const num = parseInt(clean.slice(1), 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));

  const r = clamp((num >> 16) + amount);
  const g = clamp(((num >> 8) & 0x00ff) + amount);
  const b = clamp((num & 0x0000ff) + amount);

  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function lightenColor(color, percent) {
  return shiftColor(color, percent) || DEFAULT_COLORS.base;
}

function darkenColor(color, percent) {
  return shiftColor(color, percent) || DEFAULT_COLORS.dark;
}

/* ------------------------------------------------------------------ */
/* تحميل canvas بشكل آمن                                               */
/* ------------------------------------------------------------------ */

let canvasModule;
let canvasLoadError = null;

function getCanvasLib() {
  if (canvasModule !== undefined) return canvasModule;

  try {
    // eslint-disable-next-line global-require
    canvasModule = require('canvas');
    if (typeof canvasModule.createCanvas !== 'function' || typeof canvasModule.loadImage !== 'function') {
      throw new Error('واجهة canvas غير متوقعة');
    }
  } catch (error) {
    canvasModule = null;
    canvasLoadError = error;
    console.warn(
      '[RPS] تعذّر تحميل مكتبة canvas، ستُرسل اللعبة بدون صور. السبب:',
      error && error.message ? error.message : error
    );
  }

  return canvasModule;
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function setRtl(ctx) {
  try {
    ctx.direction = 'rtl';
  } catch {
    /* بعض إصدارات canvas لا تدعم direction */
  }
}

function truncateText(text, maxChars) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** يصغّر الخط تدريجياً حتى يدخل النص في العرض المطلوب. */
function fitText(ctx, text, maxWidth, baseSize, family, weight = 'bold') {
  const value = truncateText(text, 24);
  let size = baseSize;

  for (; size > 10; size -= 1) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(value).width <= maxWidth) break;
  }

  ctx.font = `${weight} ${size}px ${family}`;
  return value;
}

/** يحوّل الأخطاء غير المتزامنة إلى رفض عادي بعد مهلة محددة. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('انتهت مهلة العملية')), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ */
/* الوحدة الرئيسية                                                     */
/* ------------------------------------------------------------------ */

function execute(client, dbq, _hasPlay, config, utils) {
  if (!client || typeof client.on !== 'function') {
    throw new TypeError('[RPS] execute() يحتاج إلى client صالح (discord.js Client).');
  }
  if (!dbq || typeof dbq.get !== 'function' || typeof dbq.set !== 'function') {
    throw new TypeError('[RPS] execute() يحتاج إلى dbq يدعم get/set.');
  }

  const { prefix = '!', owners = [] } = utils || {};
  const overrides = (config && (config.rps || config.rockPaperScissors)) || {};
  const settings = { ...DEFAULT_SETTINGS, ...(typeof overrides === 'object' ? overrides : {}) };

  const ownerIds = new Set((Array.isArray(owners) ? owners : []).map(String));

  const activeRPSGames = new Map(); // guildId -> game
  let gameCounter = 0;
  let warnedNoCommandChannel = false;

  /* ----------------------------- الأصول ----------------------------- */

  const assetRoots = [];
  const addRoot = (value) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (!assetRoots.includes(resolved)) assetRoots.push(resolved);
  };

  addRoot(config && config.assetsPath);
  addRoot(config && config.rps && config.rps.assetsPath);
  addRoot(path.join(process.cwd(), 'photo'));
  addRoot(path.join(__dirname, '..', 'photo'));
  addRoot(path.join(process.cwd(), 'imager'));
  addRoot(path.join(__dirname, '..', 'imager'));

  const assets = {
    find(fileName) {
      if (!fileName) return null;
      if (path.isAbsolute(fileName) && fs.existsSync(fileName)) return fileName;
      for (const root of assetRoots) {
        const candidate = path.join(root, fileName);
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          /* تجاهل */
        }
      }
      return null;
    },
    customVs(guildId) {
      return assets.find(`rpsvsimage_${guildId}.png`);
    }
  };

  /* ----------------------------- الخطوط ----------------------------- */

  let fontState = 'unknown'; // unknown | ready | missing
  let fontFamily = FALLBACK_FONT;

  function ensureFont() {
    if (fontState !== 'unknown') return;
    const lib = getCanvasLib();
    if (!lib) {
      fontState = 'missing';
      return;
    }

    const fontPath = assets.find('Cairo.ttf');
    if (!fontPath) {
      fontState = 'missing';
      console.warn('[RPS] لم يتم العثور على الخط Cairo.ttf، سيُستخدم خط النظام.');
      return;
    }

    try {
      lib.registerFont(fontPath, { family: FONT_FAMILY });
      fontFamily = FONT_FAMILY;
      fontState = 'ready';
    } catch (error) {
      fontState = 'missing';
      console.warn('[RPS] تعذّر تسجيل الخط العربي:', error && error.message);
    }
  }

  /* ------------------------- تحميل الأفاتارات ------------------------ */

  const avatarCache = new Map();
  let warnedAvatarFailure = false;

  function placeholderAvatar(username) {
    const lib = getCanvasLib();
    if (!lib) return null;

    try {
      ensureFont();
      const canvas = lib.createCanvas(128, 128);
      const ctx = canvas.getContext('2d');

      const gradient = ctx.createLinearGradient(0, 0, 128, 128);
      gradient.addColorStop(0, '#5865f2');
      gradient.addColorStop(1, '#23272a');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold 64px ${fontFamily}`;
      const letter = truncateText(username, 1).toUpperCase() || '?';
      ctx.fillText(letter, 64, 68);

      return lib.loadImage(canvas.toBuffer());
    } catch {
      return null;
    }
  }

  async function fetchAvatar(url, username) {
    const lib = getCanvasLib();
    if (!lib || !url) return null;

    const key = String(url);
    if (avatarCache.has(key)) {
      const cached = avatarCache.get(key);
      avatarCache.delete(key);
      avatarCache.set(key, cached);
      return cached;
    }

    // طلب png حتى لو كان الرابط webp (بعض إصدارات canvas لا تدعم webp).
    const candidates = [];
    const pngUrl = String(url).replace(/\.webp(\?.*)?$/i, '.png$1');
    if (pngUrl !== url) candidates.push(pngUrl);
    candidates.push(String(url));

    for (const candidate of candidates) {
      try {
        const image = await withTimeout(Promise.resolve(lib.loadImage(candidate)), settings.avatarTimeoutMs);
        avatarCache.set(key, image);
        if (avatarCache.size > settings.avatarCacheSize) {
          const oldest = avatarCache.keys().next().value;
          avatarCache.delete(oldest);
        }
        return image;
      } catch {
        /* جرّب الرابط التالي */
      }
    }

    if (!warnedAvatarFailure) {
      warnedAvatarFailure = true;
      console.warn('[RPS] تعذّر تحميل صورة لاعب، سيُستخدم بديل مرسوم.');
    }

    try {
      const image = await withTimeout(Promise.resolve(placeholderAvatar(username)), 3000);
      if (image) {
        avatarCache.set(key, image);
        if (avatarCache.size > settings.avatarCacheSize) {
          avatarCache.delete(avatarCache.keys().next().value);
        }
      }
      return image;
    } catch {
      return null;
    }
  }

  /* --------------------------- قاعدة البيانات ------------------------ */

  async function dbGet(key) {
    try {
      return await dbq.get(key);
    } catch (error) {
      console.warn('[RPS] خطأ في القراءة من قاعدة البيانات:', key);
      return undefined;
    }
  }

  async function dbSet(key, value) {
    try {
      await dbq.set(key, value);
      return true;
    } catch (error) {
      console.warn('[RPS] خطأ في الكتابة إلى قاعدة البيانات:', key);
      return false;
    }
  }

  async function getCustomColors(guildId) {
    const custom = normalizeColor(await dbGet(`custom_color_${guildId}`));
    if (!custom) {
      return { baseColor: DEFAULT_COLORS.base, lightColor: DEFAULT_COLORS.light, darkColor: DEFAULT_COLORS.dark };
    }

    return {
      baseColor: custom,
      lightColor: lightenColor(custom, 20),
      darkColor: darkenColor(custom, 20)
    };
  }

  async function getUserGameEmoji(userId, guildId) {
    try {
      const selected = await dbGet(`selected_game_emoji_${guildId}.${userId}`);
      if (!selected) return '🧩';

      const emojis = (await dbGet(`game_emojis_${guildId}.${userId}`)) || {};
      const data = emojis[selected];
      return (data && data.emoji) || '🧩';
    } catch {
      return '🧩';
    }
  }

  /* ------------------------- مساعدات ديسكورد ------------------------- */

  function escapeName(value) {
    return truncateText(
      String(value == null ? '' : value).replace(/[*_`~|>\\]/g, ''),
      32
    );
  }

  function button(style, customId, label, disabled = false) {
    const builder = new ButtonBuilder()
      .setStyle(style)
      .setCustomId(customId)
      .setLabel(label)
      .setDisabled(Boolean(disabled));

    const emoji = EMOJIS[customId];
    if (emoji && emoji.custom) {
      try {
        builder.setEmoji(emoji.custom);
      } catch {
        builder.setEmoji(emoji.unicode);
      }
    }

    return builder;
  }

  function joinRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
      button(ButtonStyle.Secondary, CUSTOM_IDS.join, 'دخول', disabled),
      button(ButtonStyle.Secondary, CUSTOM_IDS.leave, 'خروج', disabled),
      button(ButtonStyle.Secondary, CUSTOM_IDS.explain, 'الشرح', disabled)
    );
  }

  function choiceRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
      button(ButtonStyle.Secondary, CUSTOM_IDS.rock, CHOICES.rock.label, disabled),
      button(ButtonStyle.Secondary, CUSTOM_IDS.paper, CHOICES.paper.label, disabled),
      button(ButtonStyle.Secondary, CUSTOM_IDS.scissors, CHOICES.scissors.label, disabled)
    );
  }

  function toUnicodeComponents(components) {
    return components.map((row) => {
      const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
      return {
        type: 1,
        components: (json.components || []).map((component) => {
          const fallback = EMOJIS[component.custom_id];
          return fallback ? { ...component, emoji: { name: fallback.unicode } } : component;
        })
      };
    });
  }

  function isEmojiError(error) {
    if (!error) return false;
    const raw = JSON.stringify(error.rawError || {}) + ' ' + String(error.message || '');
    return /emoji/i.test(raw) && (error.code === 50035 || error.code === 400);
  }

  async function sendWithEmojiFallback(channel, payload) {
    try {
      return await channel.send(payload);
    } catch (error) {
      if (!payload || !payload.components || !isEmojiError(error)) throw error;

      console.warn('[RPS] رفضت Discord إيموجي الأزرار، سيتم استخدام إيموجي بديلة.');
      return channel.send({ ...payload, components: toUnicodeComponents(payload.components) });
    }
  }

  async function safeSend(channel, payload) {
    if (!channel || typeof channel.send !== 'function') return null;
    try {
      return await sendWithEmojiFallback(channel, payload);
    } catch (error) {
      console.warn('[RPS] تعذّر إرسال رسالة:', error && error.message ? error.message : error);
      return null;
    }
  }

  async function safeEdit(message, payload) {
    if (!message || typeof message.edit !== 'function') return false;
    try {
      await message.edit(payload);
      return true;
    } catch (error) {
      console.warn('[RPS] تعذّر تعديل رسالة اللعبة:', error && error.message ? error.message : error);
      return false;
    }
  }

  async function replyEphemeral(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (error) {
      // 10062: التفاعل منتهي، 40060: تم الرد مسبقاً — حالات طبيعية ولا تستحق إزعاج السجل.
      const code = error && error.code;
      if (code !== 10062 && code !== 40060) {
        console.warn('[RPS] تعذّر الرد على التفاعل:', error && error.message ? error.message : error);
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  async function resolveChannel(game) {
    const cache = client.channels && client.channels.cache;
    const cached = cache && typeof cache.get === 'function' ? cache.get(game.channelId) : null;
    if (cached && typeof cached.send === 'function') return cached;

    if (client.channels && typeof client.channels.fetch === 'function') {
      try {
        const fetched = await client.channels.fetch(game.channelId);
        if (fetched && typeof fetched.send === 'function') return fetched;
      } catch {
        /* تجاهل */
      }
    }

    return null;
  }

  /* ---------------------- صور المعارك والنتائج ---------------------- */

  function drawFallbackBackground(ctx, colors, width, height) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, colors.lightColor);
    gradient.addColorStop(0.35, colors.baseColor);
    gradient.addColorStop(0.7, colors.baseColor);
    gradient.addColorStop(1, colors.darkColor);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  async function loadAssetImage(fileName) {
    const lib = getCanvasLib();
    if (!lib) return null;

    const file = assets.find(fileName);
    if (!file) return null;

    try {
      return await lib.loadImage(file);
    } catch (error) {
      console.warn(`[RPS] تعذّر تحميل الصورة ${fileName}:`, error && error.message);
      return null;
    }
  }

  function drawAvatar(ctx, image, cx, cy, radius, options = {}) {
    const {
      ring = '#ffffff',
      ringWidth = 6,
      innerRing = null,
      glow = false,
      ringColor = ring,
      dim = false
    } = options;

    // الحلقة الخارجية (مع توهج اختياري)
    ctx.save();
    if (glow) {
      ctx.shadowColor = ringColor;
      ctx.shadowBlur = 25;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, radius + ringWidth, 0, Math.PI * 2);
    ctx.lineWidth = ringWidth;
    ctx.strokeStyle = ringColor;
    ctx.stroke();
    ctx.restore();

    if (innerRing) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = innerRing;
      ctx.stroke();
      ctx.restore();
    }

    if (image) {
      ctx.save();
      if (dim && 'filter' in ctx) {
        try {
          ctx.filter = 'grayscale(100%) brightness(0.6)';
        } catch {
          /* بعض إصدارات canvas لا تدعم filter */
        }
      }
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(image, cx - radius, cy - radius, radius * 2, radius * 2);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#34495e';
    ctx.fill();
    drawPersonSilhouette(ctx, cx, cy, radius * 1.35);
    ctx.restore();
  }

  function drawNameplate(ctx, cx, y, width, height, text, color = '#ffffff') {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    drawRoundedRect(ctx, cx - width / 2, y, width, height, height / 2);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = fitText(ctx, text, width - 28, 28, fontFamily, 'bold');
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(label, cx, y + height / 2 + 1);
    ctx.fillStyle = color;
    ctx.fillText(label, cx, y + height / 2 + 1);
    ctx.restore();
  }

  async function createBattleImage(guildId, player1, player2) {
    const lib = getCanvasLib();
    if (!lib) return null;

    ensureFont();

    try {
      const [colors, avatar1, avatar2] = await Promise.all([
        getCustomColors(guildId),
        fetchAvatar(player1.avatar, player1.username),
        fetchAvatar(player2.avatar, player2.username)
      ]);

      const canvas = lib.createCanvas(800, 450);
      const ctx = canvas.getContext('2d');
      setRtl(ctx);

      let background = null;
      const customVs = assets.customVs(guildId);
      if (customVs) {
        try {
          background = await lib.loadImage(customVs);
        } catch (error) {
          console.warn('[RPS] تعذّر تحميل صورة VS المخصصة:', error && error.message);
        }
      }
      if (!background) background = await loadAssetImage('vs.png');

      if (background) {
        ctx.drawImage(background, 0, 0, 800, 450);
      } else {
        drawFallbackBackground(ctx, colors, 800, 450);
      }

      drawAvatar(ctx, avatar1, 200, 225, 85, {
        ringColor: '#00ff88',
        ringWidth: 8,
        innerRing: '#ffffff',
        glow: true
      });
      drawAvatar(ctx, avatar2, 600, 225, 85, {
        ringColor: '#ffffff',
        ringWidth: 8,
        innerRing: '#ffffff'
      });

      ctx.textBaseline = 'alphabetic';
      drawNameplate(ctx, 200, 350, 300, 50, player1.username);
      drawNameplate(ctx, 600, 350, 300, 50, player2.username);

      return canvas.toBuffer('image/png');
    } catch (error) {
      console.warn('[RPS] تعذّر إنشاء صورة المعركة:', error && error.message ? error.message : error);
      return null;
    }
  }

  /* ---- أشكال متجهية بدل الإيموجي (كثير من السيرفرات لا تملك خط إيموجي) ---- */

  function drawPersonSilhouette(ctx, cx, cy, size, color = '#ecf0f1') {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.18, size * 0.22, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy + size * 0.42, size * 0.38, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawCrownIcon(ctx, cx, cy, size, color = '#f1c40f') {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - size / 2, cy + size * 0.28);
    ctx.lineTo(cx - size / 2, cy - size * 0.28);
    ctx.lineTo(cx - size * 0.22, cy);
    ctx.lineTo(cx, cy - size * 0.42);
    ctx.lineTo(cx + size * 0.22, cy);
    ctx.lineTo(cx + size / 2, cy - size * 0.28);
    ctx.lineTo(cx + size / 2, cy + size * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawHeartIcon(ctx, cx, cy, size, color = '#ff4757') {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    const top = cy - size * 0.12;
    ctx.moveTo(cx, cy + size * 0.38);
    ctx.bezierCurveTo(cx - size * 0.6, cy - size * 0.02, cx - size * 0.42, top - size * 0.36, cx, top);
    ctx.bezierCurveTo(cx + size * 0.42, top - size * 0.36, cx + size * 0.6, cy - size * 0.02, cx, cy + size * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawTieIcon(ctx, cx, cy, size, color = '#ffffff') {
    // ميزان متساوٍ الكفتين = رمز التعادل
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(2, size * 0.07);
    ctx.lineCap = 'round';

    const beamY = cy - size * 0.2;
    const halfBeam = size * 0.42;

    ctx.beginPath();
    ctx.moveTo(cx, cy + size * 0.4);
    ctx.lineTo(cx, beamY);
    ctx.moveTo(cx - halfBeam, beamY);
    ctx.lineTo(cx + halfBeam, beamY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, beamY, size * 0.07, 0, Math.PI * 2);
    ctx.fill();

    for (const side of [-1, 1]) {
      const px = cx + side * halfBeam;
      ctx.beginPath();
      ctx.moveTo(px, beamY);
      ctx.lineTo(px, beamY + size * 0.12);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(px, beamY + size * 0.12, size * 0.16, 0, Math.PI, false);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(cx - size * 0.2, cy + size * 0.4);
    ctx.lineTo(cx + size * 0.2, cy + size * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  function drawChoiceVector(ctx, choice, cx, cy, size, color = '#ffffff') {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, size * 0.06);
    ctx.lineCap = 'round';

    if (choice === 'rock') {
      ctx.beginPath();
      const points = 7;
      for (let i = 0; i < points; i += 1) {
        const angle = (Math.PI * 2 * i) / points - Math.PI / 2;
        const radius = size * (i % 2 === 0 ? 0.42 : 0.34);
        const px = cx + Math.cos(angle) * radius;
        const py = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    } else if (choice === 'paper') {
      const w = size * 0.56;
      const h = size * 0.72;
      drawRoundedRect(ctx, cx - w / 2, cy - h / 2, w, h, size * 0.06);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.lineWidth = Math.max(1.5, size * 0.035);
      for (let i = 1; i <= 3; i += 1) {
        const y = cy - h / 2 + (h * i) / 4;
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.32, y);
        ctx.lineTo(cx + w * 0.32, y);
        ctx.stroke();
      }
    } else if (choice === 'scissors') {
      ctx.beginPath();
      ctx.arc(cx - size * 0.18, cy + size * 0.24, size * 0.12, 0, Math.PI * 2);
      ctx.arc(cx + size * 0.18, cy + size * 0.24, size * 0.12, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - size * 0.12, cy + size * 0.12);
      ctx.lineTo(cx + size * 0.3, cy - size * 0.38);
      ctx.moveTo(cx + size * 0.12, cy + size * 0.12);
      ctx.lineTo(cx - size * 0.3, cy - size * 0.38);
      ctx.stroke();
    } else {
      ctx.font = `${Math.floor(size * 0.5)}px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', cx, cy + 2);
    }

    ctx.restore();
  }

  function drawChoiceBadge(ctx, image, x, y, size, choice) {
    ctx.save();
    ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = 'rgba(25, 42, 86, 0.4)';

    drawRoundedRect(ctx, x, y, size, size, 20);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (image) {
      ctx.save();
      drawRoundedRect(ctx, x, y, size, size, 20);
      ctx.clip();
      ctx.drawImage(image, x + 10, y + 10, size - 20, size - 20);
      ctx.restore();
    } else {
      drawChoiceVector(ctx, choice, x + size / 2, y + size / 2, size * 0.8);
    }

    ctx.restore();
  }

  async function createResultImage(guildId, player1, choice1, player2, choice2, result) {
    const lib = getCanvasLib();
    if (!lib) return null;

    ensureFont();

    try {
      const [colors, avatar1, avatar2, crown, heart, winImage, choiceImage1, choiceImage2] = await Promise.all([
        getCustomColors(guildId),
        fetchAvatar(player1.avatar, player1.username),
        fetchAvatar(player2.avatar, player2.username),
        loadAssetImage('crown.png'),
        loadAssetImage('bheart.png'),
        loadAssetImage('win.png'),
        loadAssetImage(CHOICES[choice1] && CHOICES[choice1].file),
        loadAssetImage(CHOICES[choice2] && CHOICES[choice2].file)
      ]);

      const canvas = lib.createCanvas(800, 500);
      const ctx = canvas.getContext('2d');
      setRtl(ctx);

      const gradient = ctx.createLinearGradient(0, 0, 800, 500);
      gradient.addColorStop(0, lightenColor(colors.baseColor, 30));
      gradient.addColorStop(0.5, colors.baseColor);
      gradient.addColorStop(1, colors.darkColor);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 800, 500);

      const p1Won = result === 'player1';
      const p2Won = result === 'player2';

      drawAvatar(ctx, avatar1, 150, 195, 78, {
        ringColor: p1Won ? '#f1c40f' : p2Won ? '#e74c3c' : '#ffffff',
        ringWidth: 8,
        glow: p1Won,
        dim: p2Won
      });
      drawAvatar(ctx, avatar2, 650, 195, 78, {
        ringColor: p2Won ? '#f1c40f' : p1Won ? '#e74c3c' : '#ffffff',
        ringWidth: 8,
        glow: p2Won,
        dim: p1Won
      });

      // التاج / القلب / التعادل فوق الأفاتار
      const drawBadgeIcon = (image, kind, cx) => {
        if (image) {
          ctx.drawImage(image, cx - 27, 55, 54, 54);
        } else if (kind === 'crown') {
          drawCrownIcon(ctx, cx, 82, 54);
        } else {
          drawHeartIcon(ctx, cx, 82, 50);
        }
      };

      if (result === 'player1') {
        drawBadgeIcon(crown, 'crown', 150);
        drawBadgeIcon(heart, 'heart', 650);
      } else if (result === 'player2') {
        drawBadgeIcon(heart, 'heart', 150);
        drawBadgeIcon(crown, 'crown', 650);
      } else {
        drawTieIcon(ctx, 150, 74, 52);
        drawTieIcon(ctx, 650, 74, 52);
      }

      drawChoiceBadge(ctx, choiceImage1, 270, 140, 100, choice1);
      drawChoiceBadge(ctx, choiceImage2, 430, 140, 100, choice2);

      // شريط العنوان
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.lineWidth = 3;

      if (result === 'draw') {
        const title = fitText(ctx, 'تعادل!', 700, 45, fontFamily, 'bold');
        ctx.strokeText(title, 400, 48);
        ctx.fillText(title, 400, 48);
      } else {
        const winnerName = p1Won ? player1.username : player2.username;
        const title = fitText(ctx, `فاز ${winnerName}`, 420, 45, fontFamily, 'bold');
        const titleWidth = ctx.measureText(title).width;
        const iconSize = 45;
        const groupWidth = iconSize + 12 + titleWidth;
        const startX = 400 - groupWidth / 2;
        const textRight = startX + groupWidth - iconSize - 12;

        // مع اتجاه RTL يبدأ النص من اليمين، لذلك تُرسم الأيقونة على يمين النص.
        ctx.textAlign = 'right';
        ctx.strokeText(title, textRight, 48);
        ctx.fillText(title, textRight, 48);

        if (winImage) {
          ctx.drawImage(winImage, startX + groupWidth - iconSize, 25, iconSize, iconSize);
        } else {
          drawCrownIcon(ctx, startX + groupWidth - iconSize / 2, 42, iconSize * 0.9);
        }
      }

      // أفاتار صغير + اسم الاختيار أسفل الصورة
      ctx.textBaseline = 'middle';

      const drawVote = (avatar, cx, choiceKey) => {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.beginPath();
        ctx.arc(cx, 320, 35, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (avatar) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, 320, 30, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(avatar, cx - 30, 290, 60, 60);
          ctx.restore();
        } else {
          ctx.save();
          ctx.fillStyle = '#2c3e50';
          ctx.beginPath();
          ctx.arc(cx, 320, 30, 0, Math.PI * 2);
          ctx.fill();
          drawPersonSilhouette(ctx, cx, 320, 40, '#ecf0f1');
          ctx.restore();
        }

        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        drawRoundedRect(ctx, cx - 50, 380, 100, 35, 15);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = fitText(ctx, CHOICES[choiceKey] ? CHOICES[choiceKey].label : '—', 90, 20, fontFamily, 'bold');
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 1;
        ctx.strokeText(label, cx, 398);
        ctx.fillText(label, cx, 398);
        ctx.restore();
      };

      drawVote(avatar1, 320, choice1);
      drawVote(avatar2, 480, choice2);

      drawNameplate(ctx, 150, 420, 200, 50, player1.username, p1Won ? '#00ff88' : p2Won ? '#ff4757' : '#ffffff');
      drawNameplate(ctx, 650, 420, 200, 50, player2.username, p2Won ? '#00ff88' : p1Won ? '#ff4757' : '#ffffff');

      return canvas.toBuffer('image/png');
    } catch (error) {
      console.warn('[RPS] تعذّر إنشاء صورة النتيجة:', error && error.message ? error.message : error);
      return null;
    }
  }

  async function createStartImage(guildId) {
    const existing = assets.find('rps_main.png');
    if (existing) {
      try {
        return fs.readFileSync(existing);
      } catch {
        /* تجاهل وارسم البديل */
      }
    }

    const lib = getCanvasLib();
    if (!lib) return null;

    ensureFont();

    try {
      const colors = await getCustomColors(guildId);
      const canvas = lib.createCanvas(500, 350);
      const ctx = canvas.getContext('2d');
      setRtl(ctx);

      const gradient = ctx.createLinearGradient(0, 0, 500, 350);
      gradient.addColorStop(0, colors.lightColor);
      gradient.addColorStop(1, colors.baseColor);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 500, 350);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ['rock', 'paper', 'scissors'].forEach((choice, index) => {
        const cx = 160 + index * 90;
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        drawRoundedRect(ctx, cx - 38, 92, 76, 76, 18);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 2;
        ctx.stroke();
        drawChoiceVector(ctx, choice, cx, 130, 56, '#ffffff');
        ctx.restore();
      });

      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3;
      const title = fitText(ctx, 'حجر ورق مقص', 430, 40, fontFamily, 'bold');
      ctx.strokeText(title, 250, 215);
      ctx.fillText(title, 250, 215);

      const hint = fitText(ctx, 'اضغط دخول للمشاركة!', 430, 20, fontFamily, 'bold');
      ctx.strokeText(hint, 250, 280);
      ctx.fillText(hint, 250, 280);

      return canvas.toBuffer('image/png');
    } catch (error) {
      console.warn('[RPS] تعذّر إنشاء صورة البداية:', error && error.message ? error.message : error);
      return null;
    }
  }

  /* ----------------------------- حالة اللعبة ------------------------ */

  function touch(game) {
    game.expiresAt = Date.now() + settings.maxGameMs;
    if (game.expiryTimer) clearTimeout(game.expiryTimer);
    game.expiryTimer = setTimeout(() => {
      if (isLive(game)) {
        cancelGame(game, 'انتهت المدة القصوى للعبة وتم إلغاؤها تلقائياً.').catch(() => {});
      }
    }, settings.maxGameMs);
    if (typeof game.expiryTimer.unref === 'function') game.expiryTimer.unref();
  }

  function isLive(game) {
    return Boolean(game) && !game.disposed && activeRPSGames.get(game.guildId) === game;
  }

  function disposeGame(game, reason) {
    if (!game || game.disposed) return false;

    game.disposed = true;
    game.phase = 'ended';
    game.endReason = reason || 'ended';

    if (activeRPSGames.get(game.guildId) === game) activeRPSGames.delete(game.guildId);
    if (game.expiryTimer) {
      clearTimeout(game.expiryTimer);
      game.expiryTimer = null;
    }

    for (const collector of [game.joinCollector, game.roundCollector]) {
      if (!collector) continue;
      try {
        collector.stop(reason || 'ended');
      } catch {
        /* تجاهل */
      }
    }
    game.joinCollector = null;
    game.roundCollector = null;

    return true;
  }

  async function cancelGame(game, reason) {
    if (!isLive(game)) return;
    const channel = await resolveChannel(game);

    // عطّل أزرار الانضمام وأزرار الجولة إن كانت الرسائل ما تزال موجودة.
    if (game.joinMessage) {
      await safeEdit(game.joinMessage, { components: [joinRow(true)] });
    }
    if (game.roundMessage) {
      await safeEdit(game.roundMessage, { components: [choiceRow(true)] });
    }

    disposeGame(game, 'cancelled');
    if (channel) await safeSend(channel, { content: `⛔ - ${reason}` });
  }

  function pickTwo(players) {
    const pool = players.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return [pool[0], pool[1]];
  }

  function playerMention(player) {
    return `<@${player.id}>`;
  }

  function determineWinner(choice1, choice2) {
    if (!choice1 || !choice2 || choice1 === choice2) return 'draw';

    const winConditions = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    return winConditions[choice1] === choice2 ? 'player1' : 'player2';
  }

  /* ------------------------------ الانضمام -------------------------- */

  function joinContent(game) {
    const timestamp = Math.floor(game.joinEndsAt / 1000);
    const names = game.players.map((player) => `\`${escapeName(player.username)}\``).join(', ');
    const list = names ? `\n${names}` : '';
    return `**__ستبدأ اللعبة خلال__: <t:${timestamp}:R>\n(${game.players.length} / ${game.maxPlayers})**${list}`;
  }

  async function refreshJoinMessage(game) {
    if (!isLive(game) || game.phase !== 'joining') return;
    await safeEdit(game.joinMessage, {
      content: joinContent(game),
      components: [joinRow(false)]
    });
  }

  function buildJoinCollector(game) {
    const collector = game.joinMessage.createMessageComponentCollector({ time: game.joinMs });

    collector.on('collect', (interaction) => {
      handleJoinInteraction(game, interaction, collector).catch((error) => {
        console.warn('[RPS] خطأ في معالجة زر الانضمام:', error && error.message ? error.message : error);
      });
    });

    collector.on('end', (_collected, reason) => {
      if (game.joinCollector === collector) game.joinCollector = null;
      if (!isLive(game) || game.phase !== 'joining') return;

      if (reason === 'messageDelete' || reason === 'channelDelete' || reason === 'guildDelete') {
        disposeGame(game, reason);
        return;
      }

      startMatch(game).catch((error) => {
        console.warn('[RPS] خطأ أثناء بدء اللعبة:', error && error.message ? error.message : error);
        cancelGame(game, 'حدث خطأ غير متوقع أثناء بدء اللعبة.').catch(() => {});
      });
    });

    return collector;
  }

  async function handleJoinInteraction(game, interaction, collector) {
    if (!isLive(game) || game.phase !== 'joining' || game.joinCollector !== collector) {
      return replyEphemeral(interaction, '⛔ انتهى وقت الانضمام لهذه اللعبة.');
    }

    const userId = interaction.user.id;

    if (interaction.customId === CUSTOM_IDS.explain) {
      return replyEphemeral(
        interaction,
        [
          '**طريقة اللعب:**',
          '1- شارك في اللعبة بالضغط على زر الدخول',
          '2- يتم اختيار لاعبَين عشوائياً في كل جولة',
          '3- كل لاعب يختار: حجر 🪨 أو ورق 📄 أو مقص ✂️',
          '4- قوانين الفوز:',
          '   • الحجر يكسر المقص',
          '   • المقص يقطع الورق',
          '   • الورق يغطي الحجر',
          '5- الفائز يتقدم للجولة التالية، والخاسر يُقصى',
          `6- آخر لاعب يبقى هو الفائز ويحصل على نقطة عامة${await getUserGameEmoji(userId, game.guildId)}`
        ].join('\n')
      );
    }

    if (interaction.customId === CUSTOM_IDS.join) {
      if (game.players.some((player) => player.id === userId)) {
        return replyEphemeral(interaction, '⚠️ - أنت مسجل في اللعبة بالفعل.');
      }

      if (game.players.length >= game.maxPlayers) {
        return replyEphemeral(interaction, '⚠️ - عدد المشاركين مكتمل.');
      }

      game.players.push({
        id: userId,
        username: escapeName(interaction.user.username || interaction.user.tag || userId),
        avatar: interaction.user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true }),
        isActive: true
      });

      await refreshJoinMessage(game);
      return replyEphemeral(interaction, '✅ - تمت إضافتك للعبة بنجاح.');
    }

    if (interaction.customId === CUSTOM_IDS.leave) {
      const index = game.players.findIndex((player) => player.id === userId);
      if (index === -1) {
        return replyEphemeral(interaction, '⚠️ - أنت غير مشارك في اللعبة.');
      }

      game.players.splice(index, 1);
      await refreshJoinMessage(game);
      return replyEphemeral(interaction, '✅ - تمت إزالتك من اللعبة.');
    }

    return replyEphemeral(interaction, '⚠️ - زر غير معروف.');
  }

  /* -------------------------- بدء المباراة -------------------------- */

  async function startMatch(game) {
    if (!isLive(game) || game.phase !== 'joining') return;

    game.phase = 'starting';

    // أوقف عدّاد الانضمام نهائياً قبل أي عملية غير متزامنة.
    if (game.joinCollector) {
      const collector = game.joinCollector;
      game.joinCollector = null;
      try {
        collector.stop('starting');
      } catch {
        /* تجاهل */
      }
    }

    await safeEdit(game.joinMessage, {
      content: `**(${game.players.length} / ${game.maxPlayers})**`,
      components: [joinRow(true)]
    });

    const channel = await resolveChannel(game);
    if (!channel) {
      disposeGame(game, 'channel-missing');
      return;
    }

    if (game.players.length < settings.minPlayers) {
      disposeGame(game, 'not-enough-players');
      await safeSend(channel, {
        content: `⛔ - يجب أن تحتوي اللعبة على \`${settings.minPlayers}\` لاعبين على الأقل لبدء اللعبة.`
      });
      return;
    }

    game.phase = 'playing';
    touch(game);

    await safeSend(channel, {
      content: `🎮 بدأت اللعبة بـ \`${game.players.length}\` لاعبين!\nآخر لاعب يبقى هو الفائز 🏆`
    });

    await sleep(settings.startDelayMs);
    if (!isLive(game)) return;

    await runTournament(game);
  }

  async function finishGame(game, winner) {
    if (!isLive(game)) return;

    const channel = await resolveChannel(game);
    disposeGame(game, 'finished');

    let points = 0;
    const pointsKey = `points_${game.guildId}.${winner.id}`;
    const stored = Number(await dbGet(pointsKey));
    points = (Number.isFinite(stored) ? stored : 0) + 1;
    await dbSet(pointsKey, points);

    const emoji = await getUserGameEmoji(winner.id, game.guildId);
    const colors = await getCustomColors(game.guildId);

    const embed = new EmbedBuilder()
      .setTitle('🏆 انتهت اللعبة!')
      .setDescription(`**الفائز النهائي:** <@${winner.id}>\n${emoji} **حصل على نقطة عامة واحدة!**\nمجموع نقاطه: **${points}**`)
      .setColor(colors.baseColor)
      .setFooter({ text: `عدد الجولات: ${game.roundsPlayed}` });

    if (winner.avatar && /^https?:\/\//i.test(winner.avatar)) {
      embed.setThumbnail(winner.avatar);
    }

    if (channel) await safeSend(channel, { embeds: [embed] });
  }

  /* ---------------------------- الجولات ----------------------------- */

  async function runTournament(game) {
    while (isLive(game)) {
      const activePlayers = game.players.filter((player) => player.isActive);

      if (activePlayers.length === 0) {
        await cancelGame(game, 'لم يتبقَّ أي لاعب نشط.');
        return;
      }

      if (activePlayers.length === 1) {
        await finishGame(game, activePlayers[0]);
        return;
      }

      if (game.roundsPlayed >= settings.maxRounds) {
        await cancelGame(game, 'تم الوصول إلى الحد الأقصى لعدد الجولات، أُلغيت اللعبة.');
        return;
      }

      const [player1, player2] = pickTwo(activePlayers);
      game.currentRound += 1;

      let replay = true;
      while (replay && isLive(game)) {
        replay = false;
        game.roundsPlayed += 1;
        touch(game);

        const outcome = await playRound(game, player1, player2);

        if (!outcome || outcome.type === 'cancelled') return;

        if (outcome.type === 'draw') {
          game.draws += 1;
          if (game.draws >= settings.maxDraws) {
            await cancelGame(game, 'تكرر التعادل كثيراً، أُلغيت اللعبة.');
            return;
          }
          replay = true;
          continue;
        }

        if (outcome.type === 'no-response') {
          await cancelGame(game, 'لم يختر أي لاعب في الوقت المحدد، أُلغيت اللعبة.');
          return;
        }

        if (outcome.type === 'timeout') {
          const loser = outcome.loser;
          loser.isActive = false;
          if (outcome.winner) {
            const channel = await resolveChannel(game);
            if (channel) {
              await safeSend(channel, {
                content: `⏰ - <@${loser.id}> لم يختر في الوقت المحدد وتم إقصاؤه!\n✅ - تأهل <@${outcome.winner.id}> للجولة التالية.`
              });
            }
          }
        } else if (outcome.type === 'win') {
          outcome.loser.isActive = false;
        }

        if (!isLive(game)) return;
        await sleep(settings.roundDelayMs);
      }
    }
  }

  async function playRound(game, player1, player2) {
    const channel = await resolveChannel(game);
    if (!channel) {
      disposeGame(game, 'channel-missing');
      return { type: 'cancelled' };
    }

    const image = await createBattleImage(game.guildId, player1, player2);
    const payload = {
      content: [
        `🥊 **الجولة ${game.currentRound}:**`,
        `${playerMention(player1)} **VS** ${playerMention(player2)}`,
        `⏰ لديكما ${Math.round(settings.roundMs / 1000)} ثانية للاختيار!`
      ].join('\n'),
      components: [choiceRow(false)]
    };
    if (image) payload.files = [new AttachmentBuilder(image, { name: 'battle.png' })];

    const battleMessage = await safeSend(channel, payload);
    if (!battleMessage) {
      disposeGame(game, 'round-message-failed');
      return { type: 'cancelled' };
    }

    game.roundMessage = battleMessage;
    const choices = new Map();
    const collector = battleMessage.createMessageComponentCollector({ time: settings.roundMs });
    game.roundCollector = collector;

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (game.roundCollector === collector) game.roundCollector = null;
        resolve(value);
      };

      collector.on('collect', (interaction) => {
        handleChoice(interaction).catch((error) => {
          console.warn('[RPS] خطأ في معالجة اختيار اللاعب:', error && error.message ? error.message : error);
        });
      });

      async function handleChoice(interaction) {
        if (settled || !isLive(game) || game.roundCollector !== collector) {
          return replyEphemeral(interaction, '⛔ انتهت هذه الجولة.');
        }

        const userId = interaction.user.id;
        if (userId !== player1.id && userId !== player2.id) {
          return replyEphemeral(interaction, '⚠️ هذه الجولة بين لاعبَين آخرَين.');
        }

        if (choices.has(userId)) {
          return replyEphemeral(interaction, '✅ لقد سجّلت اختيارك بالفعل.');
        }

        const choice = CHOICE_BY_CUSTOM_ID[interaction.customId];
        if (!choice) {
          return replyEphemeral(interaction, '⚠️ خيار غير معروف.');
        }

        choices.set(userId, choice);
        const label = CHOICES[choice] ? CHOICES[choice].label : choice;
        await replyEphemeral(interaction, `✅ تم تسجيل اختيارك: **${label}**`);

        if (choices.size === 2) {
          try {
            collector.stop('complete');
          } catch {
            /* تجاهل */
          }
        }
      }

      collector.on('end', async (_collected, reason) => {
        try {
          if (game.roundCollector === collector) game.roundCollector = null;
          if (game.roundMessage === battleMessage) game.roundMessage = null;

          // تعطيل الأزرار دائماً
          try {
            await battleMessage.edit({ components: [choiceRow(true)] });
          } catch {
            /* الرسالة قد تكون محذوفة */
          }

          if (reason === 'messageDelete' || reason === 'channelDelete' || reason === 'guildDelete') {
            disposeGame(game, reason);
            return finish({ type: 'cancelled' });
          }

          if (!isLive(game)) return finish({ type: 'cancelled' });

          if (choices.size === 0) {
            return finish({ type: 'no-response' });
          }

          if (choices.size === 1) {
            const winnerId = choices.keys().next().value;
            const winner = winnerId === player1.id ? player1 : player2;
            const loser = winnerId === player1.id ? player2 : player1;
            return finish({ type: 'timeout', winner, loser });
          }

          const choice1 = choices.get(player1.id);
          const choice2 = choices.get(player2.id);
          const result = determineWinner(choice1, choice2);

          const resultImage = await createResultImage(game.guildId, player1, choice1, player2, choice2, result);
          const resultPayload = {
            content:
              result === 'draw'
                ? '🤝 **تعادل!**\nسيتم إعادة الجولة بنفس اللاعبَين...'
                : `🎉 **فاز:** ${playerMention(result === 'player1' ? player1 : player2)}\n💔 **خسر:** ${playerMention(result === 'player1' ? player2 : player1)}`
          };
          if (resultImage) resultPayload.files = [new AttachmentBuilder(resultImage, { name: 'result.png' })];

          await safeSend(channel, resultPayload);

          if (!isLive(game)) return finish({ type: 'cancelled' });

          if (result === 'draw') return finish({ type: 'draw' });

          return finish({
            type: 'win',
            winner: result === 'player1' ? player1 : player2,
            loser: result === 'player1' ? player2 : player1
          });
        } catch (error) {
          console.warn('[RPS] خطأ غير متوقع في نهاية الجولة:', error && error.stack ? error.stack : error);
          return finish({ type: 'cancelled' });
        }
      });
    });

    return outcome;
  }

  /* ----------------------------- الأمر ------------------------------ */

  /**
   * message.member يعتمد على كاش الأعضاء (GuildMembers intent).
   * إذا لم يكن الكاش ممتلئاً نجلبه مباشرة قبل فحص الرتبة.
   */
  async function resolveMember(message) {
    if (message.member) return message.member;

    const guild = message.guild;
    const authorId = message.author && message.author.id;
    if (!guild || !authorId || !guild.members || typeof guild.members.fetch !== 'function') return null;

    try {
      return await guild.members.fetch({ user: authorId, force: false });
    } catch {
      return null;
    }
  }

  async function handleGameCommand(message) {
    const guild = message.guild;
    if (!guild) return;

    const guildId = guild.id;
    const channel = message.channel;

    const existing = activeRPSGames.get(guildId);
    if (existing) {
      if (!isLive(existing)) {
        disposeGame(existing, 'stale');
      } else if (Date.now() > existing.expiresAt) {
        await cancelGame(existing, 'انتهت صلاحية اللعبة السابقة وتم إغلاقها.');
      } else {
        await safeSend(channel, { content: '🛑 - هناك بالفعل لعبة فعالة في هذا السيرفر!' });
        return;
      }
    }

    const member = await resolveMember(message);
    const managerRole = await dbGet(`managergamesfr_${guildId}`);
    const isOwner = ownerIds.has(String(message.author.id));
    const hasManagerRole = Boolean(
      member &&
      managerRole &&
      member.roles &&
      member.roles.cache &&
      typeof member.roles.cache.has === 'function' &&
      member.roles.cache.has(String(managerRole))
    );

    if (!isOwner && !hasManagerRole) {
      await safeSend(channel, { content: '❌ - ليس لديك صلاحية لتشغيل هذه اللعبة!' });
      return;
    }

    const storedTimer = Number(await dbGet(`timerRPS_${message.author.id}`));
    const requested = Number.isFinite(storedTimer) && storedTimer > 0 ? storedTimer : settings.defaultJoinMs;
    const joinMs = Math.min(settings.maxJoinMs, Math.max(settings.minJoinMs, Math.floor(requested)));

    const now = Date.now();
    const game = {
      id: ++gameCounter,
      guildId,
      channelId: channel.id,
      hostId: message.author.id,
      players: [],
      maxPlayers: Math.max(settings.minPlayers, Math.floor(settings.maxPlayers) || 10),
      phase: 'joining',
      joinMs,
      joinEndsAt: now + joinMs,
      startedAt: now,
      expiresAt: now + settings.maxGameMs,
      currentRound: 0,
      roundsPlayed: 0,
      draws: 0,
      joinMessage: null,
      joinCollector: null,
      roundMessage: null,
      roundCollector: null,
      disposed: false
    };

    const image = await createStartImage(guildId);
    const payload = { content: joinContent(game), components: [joinRow(false)] };
    if (image) payload.files = [new AttachmentBuilder(image, { name: 'rps_main.png' })];

    let joinMessage = null;
    try {
      joinMessage = await sendWithEmojiFallback(channel, payload);
    } catch (error) {
      console.warn('[RPS] تعذّر إرسال رسالة بدء اللعبة:', error && error.message ? error.message : error);
    }

    if (!joinMessage) return;

    game.joinMessage = joinMessage;
    activeRPSGames.set(guildId, game);
    touch(game);

    game.joinCollector = buildJoinCollector(game);

    // ملاحظة: لم نعد نستخدم setTimeout خارجي لبدء اللعبة؛ نهاية الـ collector
    // هي المصدر الوحيد للانتقال إلى مرحلة اللعب، ما يمنع البدء المزدوج.
  }

  async function handleMessage(message) {
    if (!message || !message.author || message.author.bot) return;
    if (!message.guild) return;

    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) return;

    const command = content.split(/\s+/)[0];
    const accepted = new Set([`${prefix}حجره`, `${prefix}حجرة`]);
    if (!accepted.has(command)) return;

    const configuredChannel = await dbGet(`commandChannel_${message.guild.id}`);

    if (configuredChannel) {
      if (String(message.channel.id) !== String(configuredChannel)) return;
    } else if (settings.requireCommandChannel) {
      if (!warnedNoCommandChannel) {
        warnedNoCommandChannel = true;
        console.warn(
          `[RPS] requireCommandChannel = true لكن commandChannel_${message.guild.id} غير مضبوط، ` +
            'لذلك لن يستجيب الأمر. اضبط القناة أو اجعل config.rps.requireCommandChannel = false.'
        );
      }
      return;
    }

    await handleGameCommand(message);
  }

  const handler = (message) => {
    handleMessage(message).catch((error) => {
      console.warn('[RPS] خطأ في حدث الرسالة:', error && error.stack ? error.stack : error);
    });
  };

  // يمنع تكرار المستمع إذا أُعيد تحميل الوحدة (hot reload).
  const handlerKey = Symbol.for('rps.messageCreate.handler');
  if (client[handlerKey] && typeof client.off === 'function') {
    client.off('messageCreate', client[handlerKey]);
  }
  client[handlerKey] = handler;
  client.on('messageCreate', handler);

  return {
    settings,
    getGame: (guildId) => activeRPSGames.get(String(guildId)) || null,
    stopGame: async (guildId, reason = 'تم إيقاف اللعبة بواسطة المشرف.') => {
      const game = activeRPSGames.get(String(guildId));
      if (!game) return false;
      await cancelGame(game, reason);
      return true;
    }
  };
}

module.exports = { execute };
