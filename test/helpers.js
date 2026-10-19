'use strict';

/**
 * أدوات اختبار بسيطة: بديل محلي لـ discord.js (رسائل/أزرار/collectors)
 * + تهيئة صور الخط/الأصول عبر @napi-rs/canvas عندما لا تتوفر canvas الأصلية.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const http = require('http');
const Module = require('module');

const TMP_DIR = path.join(__dirname, '.tmp');
const PHOTO_DIR = path.join(TMP_DIR, 'photo');
const AVATAR_DIR = path.join(TMP_DIR, 'avatars');
const OUTPUT_DIR = path.join(TMP_DIR, 'output');

/* ----------------------------- canvas ----------------------------- */

const originalLoad = Module._load;
let aliasPatched = false;
let canvasDisabled = false;
let resolvedCanvas;
let canvasResolved = false;

function resolveCanvasImplementation() {
  if (canvasResolved) return resolvedCanvas;
  canvasResolved = true;

  try {
    resolvedCanvas = originalLoad.call(Module, 'canvas', module, false);
    return resolvedCanvas;
  } catch {
    // في هذه البيئة لا تُبنى canvas الأصلية، نستخدم @napi-rs/canvas للاختبار فقط.
  }

  try {
    const napi = originalLoad.call(Module, '@napi-rs/canvas', module, false);
    resolvedCanvas = {
      ...napi,
      registerFont(file, options) {
        return napi.GlobalFonts.registerFromPath(file, options && options.family);
      }
    };
  } catch {
    resolvedCanvas = null;
  }

  return resolvedCanvas;
}

function installCanvasAlias({ disableCanvas = false } = {}) {
  if (disableCanvas) canvasDisabled = true;

  if (!aliasPatched) {
    aliasPatched = true;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'canvas') {
        if (canvasDisabled) {
          const error = new Error("Cannot find module 'canvas'");
          error.code = 'MODULE_NOT_FOUND';
          throw error;
        }
        const implementation = resolveCanvasImplementation();
        if (!implementation) {
          const error = new Error("Cannot find module 'canvas'");
          error.code = 'MODULE_NOT_FOUND';
          throw error;
        }
        return implementation;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  }

  return canvasDisabled ? null : resolveCanvasImplementation();
}

/* ----------------------------- الأصول ----------------------------- */

async function ensureFixtures() {
  const canvas = installCanvasAlias();
  if (!canvas) return false;

  for (const dir of [PHOTO_DIR, AVATAR_DIR, OUTPUT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { createCanvas } = canvas;

  const save = (name, width, height, draw) => {
    const file = path.join(PHOTO_DIR, name);
    if (fs.existsSync(file)) return;
    const c = createCanvas(width, height);
    const ctx = c.getContext('2d');
    draw(ctx, width, height);
    fs.writeFileSync(file, c.toBuffer('image/png'));
  };

  save('vs.png', 800, 450, (ctx, w, h) => {
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#12263f');
    gradient.addColorStop(1, '#061019');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 110px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('VS', w / 2, h / 2 + 30);
  });

  save('rps_main.png', 500, 350, (ctx, w, h) => {
    ctx.fillStyle = '#123';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RPS', w / 2, h / 2);
  });

  const icon = (name, text) => save(name, 100, 100, (ctx, w, h) => {
    ctx.fillStyle = '#223';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = '60px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  });

  icon('rock.png', 'R');
  icon('paper.png', 'P');
  icon('scissors.png', 'S');
  icon('crown.png', 'C');
  icon('bheart.png', 'H');
  icon('win.png', 'W');

  const fontSource = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const fontTarget = path.join(PHOTO_DIR, 'Cairo.ttf');
  if (fs.existsSync(fontSource) && !fs.existsSync(fontTarget)) {
    fs.copyFileSync(fontSource, fontTarget);
  }

  return true;
}

function ensureAvatar(username) {
  const canvas = installCanvasAlias();
  if (!canvas) return null;

  const file = path.join(AVATAR_DIR, `${username}.png`);
  if (fs.existsSync(file)) return file;

  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const c = canvas.createCanvas(128, 128);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5865f2';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(username.slice(0, 1).toUpperCase(), 64, 68);

  fs.writeFileSync(file, c.toBuffer('image/png'));
  return file;
}

/* -------------------------- بديل ديسكورد -------------------------- */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 4000, interval = 10, label = 'الشرط' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`انتهت المهلة في انتظار: ${label}`);
    await wait(interval);
  }
}

class FakeCollector extends EventEmitter {
  constructor({ time, filter } = {}) {
    super();
    this.filter = filter;
    this.ended = false;
    this.reason = null;
    this._timer = setTimeout(() => this.stop('time'), Math.max(1, Number(time) || 1));
  }

  handle(interaction) {
    if (this.ended) return false;
    if (this.filter) {
      try {
        if (!this.filter(interaction)) return false;
      } catch {
        return false;
      }
    }
    this.emit('collect', interaction);
    return true;
  }

  stop(reason = 'user') {
    if (this.ended) return;
    this.ended = true;
    this.reason = reason;
    clearTimeout(this._timer);
    this.emit('end', new Map(), reason);
  }
}

class FakeMessage {
  constructor(channel, payload = {}) {
    this.channel = channel;
    this.id = `msg_${channel.messages.length + 1}`;
    this.content = payload.content || '';
    this.embeds = payload.embeds || [];
    this.files = payload.files || [];
    this.components = payload.components || [];
    this.edits = [];
    this.deleted = false;
    this.collectors = [];
  }

  async edit(payload = {}) {
    if (this.deleted) throw new Error('Unknown Message');
    if (payload.content !== undefined) this.content = payload.content;
    if (payload.components !== undefined) this.components = payload.components;
    if (payload.files !== undefined) this.files = payload.files;
    if (payload.embeds !== undefined) this.embeds = payload.embeds;
    this.edits.push(payload);
    return this;
  }

  createMessageComponentCollector(options = {}) {
    const collector = new FakeCollector(options);
    this.collectors.push(collector);
    return collector;
  }

  async delete() {
    if (this.deleted) return;
    this.deleted = true;
    for (const collector of this.collectors) collector.stop('messageDelete');
  }
}

class FakeChannel {
  constructor(id) {
    this.id = id;
    this.messages = [];
    this.failWithEmojiErrorOnce = false;
  }

  async send(payload = {}) {
    if (this.failWithEmojiErrorOnce) {
      this.failWithEmojiErrorOnce = false;
      const error = new Error('Invalid Form Body: components.0.components.0.emoji.id');
      error.code = 50035;
      error.rawError = { components: [{ components: [{ emoji: { id: 'bad' } }] }] };
      throw error;
    }

    const message = new FakeMessage(this, payload);
    this.messages.push(message);
    return message;
  }

  last(predicate) {
    return this.messages.filter(predicate).slice(-1)[0] || null;
  }
}

function createFakeChannel(id) {
  return new FakeChannel(id);
}

function createFakeClient(channel, guildId, { resolveMember } = {}) {
  const client = new EventEmitter();

  client.channels = {
    cache: new Map([[channel.id, channel]]),
    fetch: async (id) => (id === channel.id ? channel : null)
  };

  const guild = {
    id: guildId,
    members: {
      cache: new Map(),
      // يحاكي guild.members.fetch({ user }) الذي تستخدمه اللعبة عندما
      // يكون message.member فارغاً (بدون GuildMembers intent).
      async fetch(options) {
        const userId = typeof options === 'object' && options !== null ? options.user : options;
        const member = typeof resolveMember === 'function' ? await resolveMember(String(userId)) : null;
        if (!member) {
          const error = new Error('Unknown Member');
          error.code = 10007;
          throw error;
        }
        this.cache.set(String(userId), member);
        return member;
      }
    }
  };

  client.guilds = { cache: new Map([[guildId, guild]]) };
  return client;
}

function createFakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  const gets = [];
  const sets = [];

  return {
    store,
    gets,
    sets,
    async get(key) {
      gets.push(key);
      return store.get(key);
    },
    async set(key, value) {
      sets.push([key, value]);
      store.set(key, value);
      return value;
    }
  };
}

/* ---------------------------- مستخدمون ---------------------------- */

let avatarServer = null;

/** سيرفر HTTP محلي صغير يقدّم صور الأفاتار كما يفعل CDN ديسكورد في الإنتاج. */
async function startAvatarServer() {
  if (avatarServer) return avatarServer.address().port;

  avatarServer = http.createServer((req, res) => {
    const name = decodeURIComponent(String(req.url || '').replace(/^\//, ''));
    const file = path.join(AVATAR_DIR, name);
    if (!name || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((resolve) => avatarServer.listen(0, '127.0.0.1', resolve));
  if (typeof avatarServer.unref === 'function') avatarServer.unref();
  return avatarServer.address().port;
}

function avatarUrlFor(username) {
  if (!avatarServer) return `https://cdn.test/avatars/${username}.png`;
  return `http://127.0.0.1:${avatarServer.address().port}/${encodeURIComponent(username)}.png`;
}

function createUser(username, id, { avatarUrl } = {}) {
  ensureAvatar(username);
  const url = avatarUrl || avatarUrlFor(username);

  return {
    id,
    username,
    tag: `${username}#0001`,
    bot: false,
    avatar: url,
    displayAvatarURL() {
      return url;
    }
  };
}

function makeInteraction(user, customId) {
  return {
    user,
    customId,
    replied: false,
    deferred: false,
    lastReply: null,
    async reply(payload) {
      if (this.replied) {
        const error = new Error('Interaction has already been acknowledged.');
        error.code = 40060;
        throw error;
      }
      this.replied = true;
      this.lastReply = payload;
      return payload;
    },
    async followUp(payload) {
      this.lastReply = payload;
      return payload;
    }
  };
}

async function click(message, user, customId, { settle = 25 } = {}) {
  const collector = message.collectors[message.collectors.length - 1];
  if (!collector) throw new Error('لا يوجد collector على هذه الرسالة');
  const interaction = makeInteraction(user, customId);
  collector.handle(interaction);
  await wait(settle);
  return interaction;
}

async function runCommand(client, channel, user, content, { member, guildId = 'guild_1' } = {}) {
  const effectiveMember = member === undefined ? user.member : member;
  // نستخدم كائن السيرفر الحقيقي من الكاش حتى تتوفر members.fetch وrest.
  const guild =
    (client.guilds && client.guilds.cache && typeof client.guilds.cache.get === 'function'
      ? client.guilds.cache.get(guildId)
      : null) || { id: guildId };

  const message = {
    content,
    guild,
    channel,
    author: user,
    member: effectiveMember,
    async reply(payload) {
      return channel.send(payload);
    }
  };
  client.emit('messageCreate', message);
  await wait(10);
  return message;
}

/* ---------------------------- إخراج ------------------------------ */

function dumpAttachments(message, prefix) {
  if (!message || !Array.isArray(message.files)) return [];
  const saved = [];
  for (const file of message.files) {
    const buffer = file.attachment;
    const name = file.name || 'image.png';
    if (!Buffer.isBuffer(buffer)) continue;
    const target = path.join(OUTPUT_DIR, `${prefix}_${name}`);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(target, buffer);
    saved.push(target);
  }
  return saved;
}

module.exports = {
  TMP_DIR,
  PHOTO_DIR,
  AVATAR_DIR,
  OUTPUT_DIR,
  installCanvasAlias,
  ensureFixtures,
  ensureAvatar,
  startAvatarServer,
  avatarUrlFor,
  createFakeClient,
  createFakeDb,
  createUser,
  createFakeChannel,
  makeInteraction,
  click,
  runCommand,
  wait,
  waitFor,
  dumpAttachments
};
