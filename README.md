# لعبة حجر / ورق / مقص — نسخة مصححة (discord.js v14 + Node 22)

هذا المستودع يحتوي على نسخة مُعادة الكتابة والتصحيح من كود اللعبة الذي أرسلته، مع أخطاء
إصلاحات موثّقة، واختبارات تشغيل حقيقية تغطي مسار اللعبة كاملاً.

```
index.js                     ← نقطة تشغيل البوت (مصححة: clientReady، مسارات، معالجة أخطاء)
helpers/index.js             ← helpers احتياطي (يحلّ خطأ Cannot find module './helpers')
games/rockPaperScissors.js   ← الوحدة الرئيسية (تُستدعى بنفس واجهة execute القديمة)
test/game.test.js            ← اختبار التدفق الكامل (انضمام/تعادل/فوز/إقصاء/نقاط)
test/tournament.test.js      ← بطولة من 3 لاعبين عبر مسار الفوز الكامل
test/member-fallback.test.js ← فحص الرتب عندما يكون message.member فارغاً
test/bot-index.test.js       ← اختبار index.js: clientReady مرة واحدة، النشاط، الأوامر، SIGTERM
test/no-canvas.test.js       ← اختبار العمل بدون مكتبة canvas
test/helpers.js              ← بديل محلي لـ discord.js (رسائل، أزرار، collectors)
```

## 1) المتطلبات

- **Node.js 20.9+ أو 22** (اختُبر على 22.22.3).
- **discord.js v14.27**.
- **canvas 3.x** — اختيارية لكن مطلوبة للصور. على Debian/Ubuntu تحتاج حزم البناء:

```bash
sudo apt install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
npm install canvas
```

> الأهم: `canvas` أصبحت تُحمَّل **بشكل كسول**، فإذا فشل بناؤها على السيرفر لن ينهار
> البوت، بل تعمل اللعبة بالرسائل النصية فقط. (في نسختك القديمة كان `require('canvas')`
> في أعلى الملف كافياً لإسقاط البوت كله.)

## 2) نقطة التشغيل `index.js`

انسخ `index.js` إلى جذر البوت (بدل ملفك القديم) وأنشئ `config.json`:

```json
{
  "token": "TOKEN",
  "prefix": "!",
  "owners": ["123456789012345678"]
}
```

ثم: `npm start` (أو `node index.js`).

ما تم إصلاحه في نقطة التشغيل:

| المشكلة القديمة | الإصلاح |
|---|---|
| `client.on("ready")` → `DeprecationWarning` في discord.js 14.27+ | `clientReady` مع مستمع `ready` احتياطي وحماية من التنفيذ المزدوج (يعمل على النسخ الأقدم أيضاً) |
| `fs.readdirSync('./commands')` يعتمد على مجلد التشغيل | `path.join(__dirname, 'commands')` — يعمل من أي مجلد/systemd/PM2 |
| `require("canvas-constructor/napi-rs")` في الأعلى | محمي بـ try/catch؛ غيابه لم يعد يُسقط البوت |
| `require("colors")` / `require("ms")` إلزامية | بديل تلقائي عند غيابها |
| `require("quick.db")` إلزامي | رسالة واضحة + مخزن JSON محلي مؤقت بديل (get/set/delete/add/sub/push/pull) |
| `utils.times` تُمرَّر كقيمة مجمّدة | getter حي + `setTimes`، فأي تغيير يراه بقية الأوامر |
| `setMaxListeners(120)` رقم ثابت | يُحسب من عدد الأوامر المحمّلة فعلياً |
| لا معالجة لأخطاء `client.login` | رسائل واضحة لـ: توكن غير صالح / Privileged Intents / مشكلة شبكة + exit code 1 |
| لا معالجة لـ `error` / `warn` / `shardError` | مستمعات لكل منها |
| `process.on('uncaughtException')` يطبع الخطأ فقط | يطبع الـ stack كاملاً بدون إسقاط العملية |
| لا إيقاف لطيف | `SIGINT` / `SIGTERM` → `client.destroy()` ثم خروج نظيف |
| `config.json`/التوكن مفقود | رسالة إرشادية بدل انهيار غامض |
| `message.reply` بدون `catch` عند المنشن | مغلّف |
| `owners`/`prefix` قد تكون غير معرّفة | افتراضيات آمنة (`prefix = '!'`, قائمة فارغة) |
| لا تحقق من صحة `activity` القادم من قاعدة البيانات | `normalizeActivity` يصلح النوع/الرابط، وإلا fallback |

> **مهم:** الملف `config.json` مضاف إلى `.gitignore` — لا ترفع التوكن إلى Git أبداً.

### حول الرتب و`message.member`

`message.member` يعتمد على كاش أعضاء السيرفر المملوء عبر **GuildMembers** (Privileged Intent).
لهذا أصبحت اللعبة تجلب العضو مباشرة عبر `guild.members.fetch()` عند الحاجة، فلا تحتاج
تفعيل الـ intent لمجرد فحص رتبة `managergamesfr_<guildId>`.

## 3) التركيب داخل البوت

```js
const rps = require('./games/rockPaperScissors');

// نفس التوقيع القديم تماماً
rps.execute(client, dbq, has_play, config, utils);
```

وإذا كنت على discord.js حديث، غيّر حدث الجاهزية في ملفك الرئيسي لتجنّب تحذير
`the ready event has been renamed to clientReady`:

```js
// قبل
client.once('ready', () => { ... });
// بعد
client.once('clientReady', () => { ... });
```

- `dbq` يجب أن يدعم `get(key)` و `set(key, value)` (نفس المفاتيح القديمة، بدون تغيير).
- `utils` يُقرأ منه `prefix` (افتراضي `'!'`) و `owners` (مصفوفة آي دي).
- `config.rps` اختياري لضبط الأرقام (انظر أدناه).
- الدالة تُرجع كائن إدارة مفيد:

```js
const api = rps.execute(...);

api.settings;              // الإعدادات المدمجة
api.getGame(guildId);      // اللعبة الفعالة أو null
await api.stopGame(guildId); // إيقاف قسري + تعطيل أزرار الانضمام
```

مسار الأصول: البحث يتم في `config.assetsPath` ثم `config.rps.assetsPath` ثم
`./photo` و `../photo` بالنسبة للملف، وكذلك `./imager`.

## 4) الإعدادات (`config.rps`)

| المفتاح | الافتراضي | الوصف |
|---|---|---|
| `maxPlayers` | `10` | الحد الأقصى للمشاركين |
| `minPlayers` | `2` | الحد الأدنى لبدء اللعبة |
| `defaultJoinMs` | `10000` | مدة الانضمام إذا لم يوجد `timerRPS_<userId>` |
| `minJoinMs` / `maxJoinMs` | `2000` / `600000` | حدود أمان لقيمة المؤقت من قاعدة البيانات |
| `roundMs` | `15000` | مدة اختيار كل لاعب في الجولة |
| `startDelayMs` / `roundDelayMs` | `2000` / `3000` | فواصل الانتقال |
| `maxRounds` | `80` | حد أقصى للجولات (حماية من الحلقات اللانهائية) |
| `maxDraws` | `25` | أقصى عدد تعادلات متتالية |
| `maxGameMs` | `2700000` | عمر اللعبة الأقصى (45 دقيقة) |
| `avatarTimeoutMs` | `8000` | مهلة تحميل صورة اللاعب |
| `requireCommandChannel` | `false` | `false`: يعمل الأمر في كل القنوات. `true`: يعمل فقط في قناة `commandChannel_<guildId>` (سلوك النسخة القديمة) |

مثال:

```js
const config = {
  rps: { roundMs: 20000, maxPlayers: 16, requireCommandChannel: true }
};
```

## 5) الأصول (اختيارية كلها)

`photo/vs.png`، `photo/rps_main.png`، `photo/rock.png`، `photo/paper.png`،
`photo/scissors.png`، `photo/crown.png`، `photo/bheart.png`، `photo/win.png`،
`photo/Cairo.ttf`، و`imager/rpsvsimage_<guildId>.png` للخلفية المخصصة.

أي ملف مفقود لا يوقف اللعبة:
- صورة VS المخصصة ← `vs.png` ← خلفية تدرّج بلون السيرفر.
- التاج/القلب ← أشكال متجهية مرسومة.
- إيموجي الخيارات على الصور ← أشكال متجهية (حجر/ورق/مقص).
- الأفاتار ← الحرف الأول من الاسم.

## 6) مفاتيح قاعدة البيانات

بدون أي تغيير عن النسخة القديمة:

| المفتاح | الاستخدام |
|---|---|
| `commandChannel_<guildId>` | قناة تشغيل الأوامر |
| `managergamesfr_<guildId>` | رتبة مسموح لها بتشغيل اللعبة |
| `timerRPS_<userId>` | مدة الانضمام بالمللي ثانية |
| `custom_color_<guildId>` | لون السيرفر |
| `selected_game_emoji_<guildId>.<userId>` + `game_emojis_<guildId>.<userId>` | إيموجي النقاط |
| `points_<guildId>.<userId>` | تُزاد بمقدار 1 للفائز |

## 7) الأخطاء التي تم إصلاحها

### أخطاء تُسقط البوت (أهمها)

1. **`ephemeral: true` مهجورة في v14** — كل الأزرار كانت ستُرجع تحذيرات وتُعامَل كخيار غير معروف.
   استُبدلت بـ `flags: MessageFlags.Ephemeral`.
2. **وعود غير مُلتقطة (unhandledRejection)** — كل `collect`/`end` يستدعي `async` عمليات
   (`inter.reply`, `drawImage`, `channel.send`) دون `try/catch`. أي فشل واحد في Node 15+
   يُسقط العملية. الآن كل معالج مغلّف.
3. **`canvas` إلزامية عند تحميل الملف** — على استضافة بدون حزم cairo لا يعمل البوت كله.
   أصبح التحميل كسولاً مع بدائل نصية.
4. **`registerFont` داخل كل دالة رسم** — إعادة تسجيل الخط في كل جولة (بطء + تكرار).
   الآن مرة واحدة.
5. **`ctx.filter` غير مدعوم في كل نسخ canvas** — الآن داخل `try/catch` مع فحص `'filter' in ctx`.

### أخطاء منطقية / تسريبات حالة

6. **قفل السيرفر الدائم**: إذا فشل `channel.send` أو `createBattleImage` أو بدأ الـ collector
   ثم حُذفت الرسالة، كانت `activeRPSGames` تبقى مملوءة، فيرى السيرفر «هناك بالفعل لعبة فعالة»
   للأبد. الآن كل مسار فشل يفرّغ الخريطة ويعطّل الأزرار (واختبار رقم 5 يثبت أن لعبة جديدة تعمل بعد الإلغاء).
7. **بدء مزدوج / بدء بعد حذف الرسالة** — كان `end` يبدأ اللعبة حتى عند `messageDelete`.
   الآن يتم التحقق من سبب الإنهاء، والانتقال يتم مرة واحدة فقط عبر `startMatch` المحمية.
8. **لا شيء يوقف اللعبة إذا لم يختر أي لاعب** — كانت النسخة القديمة تقصي لاعباً **عشوائياً**
   عندما لا يختار الاثنان وتستمر. الآن تُلغى اللعبة برسالة واضحة.
9. **التعادل لا نهائي** (إعادة الجولة بلا حد) — أضيف `maxDraws`.
10. **`timerRPS` غير مُتحقَّق منه**: قيمة غير رقمية تعني مؤقتاً لا نهائياً. الآن تُقيَّد
    بين حدّي `minJoinMs` و `maxJoinMs`.
11. **`sort(() => Math.random() - 0.5)`** يعدّل مصفوفة اللاعبين الأصلية ويُعطي توزيعاً غير متوازن.
    استُبدل بـ Fisher–Yates على نسخة.
12. **اللاعبون غير المشاركين في الجولة** كان الـ `filter` يمنع نقراتهم تماماً فتظهر لهم
    رسالة «This interaction failed» من ديسكورد. الآن كل نقرة تحصل على رد ephemeral.
13. **`ctx.arc` + `clip`** كانت دائرة الأفاتار تُرسم بمقاس 170px داخل نصف قطر 85 مع حدود —
    الآن الحلقة والقص بمعاملات متسقة.
14. **أسماء اللاعبين الطويلة** كانت تتجاوز شريط الاسم على الصورة. الآن `measureText`
    يصغّر الخط تلقائياً + قصّ وتنقية من ماركداون ديسكورد في الرسائل.
15. **الألوان**: `lightenColor`/`darkenColor` كانت تعيد قيماً ثابتة عند أي لون غير صالح،
    وكانت ستُمرَّر ألوان غير نصية من قاعدة البيانات. الآن دالة `normalizeColor` واحدة
    تدعم `#RGB`/`#RRGGBB`/الأرقام، والتدرّج يستخدم القيم المطبَّعة.
16. **صور الأفاتار webp** على نسخ canvas التي لا تدعم webp — الآن يُطلب
    `extension: 'png', forceStatic: true` + إعادة كتابة `.webp` إلى `.png` + مهلة 8 ثوان.
17. **الإيموجي داخل الصور** كان يظهر مربعات فارغة إذا لم يوجد خط إيموجي على السيرفر
    (خط Cairo لا يحتوي إيموجي). استُبدل بالكامل بأشكال متجهية (تاج/قلب/ميزان/حجر/ورق/مقص).
18. **إيموجي الأزرار المخصصة** قد ترفضها ديسكورد (إذا لم تكن متاحة للتطبيق) فتفشل رسالة اللعبة
    كلها. الآن يوجد fallback تلقائي إلى إيموجي يونيكود وإعادة إرسال.
19. **`prefix` غير معرّف** كان يعطي `undefinedحجره`؛ الآن افتراضي `'!'`.
20. **`owners`** تُقارن كنصوص حتى لو كانت أرقاماً في الإعدادات.
21. **الأمر**: أُضيف مرادف `!حجرة` بجانب `!حجره` (كان الكود يقبل `حجره` فقط بينما الصور تقول «حجرة»).
22. **`message.channel` بعد حذف القناة** — الآن حل القناة عبر الكاش ثم `fetch` مع تجاهل الأخطاء.
23. **مغادرة اللاعبين في المنتصف**: إذا خرج الجميع تبقى اللعبة معلّقة. الآن تُلغى تلقائياً.
24. **تكرار المستمع** عند إعادة تحميل الوحدة (hot reload) — يُزال المستمع القديم قبل تسجيل الجديد.

### تغييرات سلوكية مقصودة (راجعها)

- **عدم اختيار أي لاعب خلال الجولة = إلغاء اللعبة** بدل اختيار خاسر عشوائياً.
- **اللاعب الصامت وحده يُقصى** (نفس السلوك السابق) مع رسالة تذكر المتأهل.
- **`requireCommandChannel`** افتراضياً `false` الآن (يعمل في كل القنوات). اجعلها `true`
  إذا كنت تستخدم نظام قناة أوامر `commandChannel_<guildId>` وتريد تقييد اللعبة عليها.
- أزرار الانضمام **وأزرار الجولة** تُعطَّل عند الإلغاء/الانتهاء (بدل بقائها فعالة على رسائل ميتة).
- رسالة الانضمام تعرض أسماء المشاركين أيضاً (وليس العدد فقط).

## 8) الاختبارات

```bash
npm install --ignore-scripts   # في بيئة بدون حزم cairo
npm test
```

`npm test` يشغّل:

- `test/game.test.js`: صلاحيات، تجاهل القناة الخاطئة، الانضمام/الخروج/الشرح، انضمام مكرر،
  تعادل ثم إعادة الجولة، فوز وإقصاء، انتهاء المهلة بدون اختيار ← إلغاء وتحرير القفل،
  لعبة جديدة بعده، إقصاء اللاعب الصامت، رسالة الفائز، و`points_<guild>.<user> = 1`.
- `test/tournament.test.js`: بطولة من 3 لاعبين — تأهل الفائز، إقصاء الخاسر، ثم إعلان
  الفائز النهائي ونقطة واحدة فقط له.
- `test/channel-optional.test.js`: الأمر يعمل بدون `commandChannel_<guildId>` وبدون أي تحذير
  (الافتراضي الجديد).
- `test/member-fallback.test.js`: `message.member = null` (بدون GuildMembers intent) —
  العضو العادي يُرفض والمشرف يبدأ اللعبة عبر `members.fetch`.
- `test/bot-index.test.js`: يشغّل `index.js` فعلياً مع بديل لـ discord.js يطلق
  `ready` و`clientReady` معاً: يتحقق من تحميل الأوامر من `__dirname`، تنفيذ معالج
  الجاهزية مرة واحدة، ضبط النشاط، الإيقاف اللطيف على SIGTERM، رسائل الخطأ عند غياب
  `config.json` أو التوكن، تحميل `helpers` الاختياري، وذكر أسماء الوحدات الناقصة
  في أوامر المستخدم دون إسقاط البوت.
- `test/no-canvas.test.js`: نفس التدفق مع تعطيل `canvas` بالكامل والتأكد من عدم انهيار
  ومن عدم إرفاق ملفات.

الصور الناتجة تُحفظ في `test/.tmp/output/` لمعاينتها بصرياً.

بيئة الاختبار تستخدم `@napi-rs/canvas` (بديل متوافق) فقط لأن بناء `canvas` الأصلية يحتاج
حزم نظام غير متوفرة هنا؛ الكود نفسه لا يعرف شيئاً عنها ويستورد `canvas` كما في الإنتاج.

## 9) خطأ `Cannot find module './helpers'`

```
Error: Cannot find module './helpers'
    at Object.<anonymous> (C:\...\games-v2\index.js:15:5)
```

**السبب:** `index.js` القديم عندك يستدعي `require('./helpers')`، أي أنه يبحث عن
`helpers/index.js` أو `helpers.js` ولم يجدهما، فيتوقف البوت **قبل** تحميل أي أمر.

**الحل (اختر واحداً):**

1. **استخدم `index.js` المرفق هنا** — لا يستدعي `./helpers` إلزامياً؛ يحمّله إن وُجد
   فقط، ويُمرّره للأوامر عبر `utils.helpers`:

```js
npm start
```

2. **أنشئ مجلد helpers** إن أردت الاحتفاظ بملفك القديم:

```
games-v2/
  index.js
  helpers/
    index.js      ← انسخ الملف المرفق، أو دوالك الحقيقية
```

   الملف المرفق `helpers/index.js` يحتوي أدوات جاهزة (`wait`, `randomInt`, `pick`,
   `shuffle`, `truncate`, `escapeMarkdown`, `formatDuration`, `safeSend`, `safeEdit`,
   `createEmbed`, `memberHasRole` …)، وأي دالة غير موجودة تُظهر تحذيراً باسمها مرة واحدة
   بدل أن ينهار البوت بصمت.

3. **أو احذف السطر** `const helpers = require('./helpers');` من ملفك إن لم تكن تستخدمه.

> لا تنسخ `helpers/index.js` المرفق فوق مجلد helpers **حقيقي** عندك — سيستبدل دوالك.

**تحسينات إضافية في `index.js` المرفق:**

- `discord.js` المفقودة تعطي رسالة «npm install» بدل Stack ترويسة غير مفهوم.
- أي أمر يستدعي وحدة ناقصة يُطبع اسم الوحدة صريحاً، ويكمل البوت تحميل بقية الأوامر:

```
✗ الملف needs-helpers.js يستدعي وحدة غير مثبتة أو غير موجودة: ../helpers
   ثبّتها بالأمر: npm install <package> — أو تحقّق من المسار إن كان ملفاً محلياً.
تم تحميل 1 أمر (فشل 2).
```

## 10) استكشاف الأخطاء

| الرسالة | السبب |
|---|---|
| `[RPS] requireCommandChannel = true لكن commandChannel_...` | فعّلت التقييد لكن القناة غير مضبوطة; اضبطها أو أعِدها `false` |
| `[RPS] تعذّر تحميل مكتبة canvas` | بناء canvas فشل؛ اللعبة تعمل بدون صور |
| `[RPS] رفضت Discord إيموجي الأزرار` | الإيموجي المخصصة غير متاحة للتطبيق؛ تم التحويل لبدائل |
| `[RPS] تعذّر تحميل صورة لاعب` | رابط الأفاتار غير متاح/بطيء؛ استُخدم الحرف الأول |
| `Unknown interaction (10062)` | نقر متأخر على زر قديم — يُتجاهل بصمت |
| `DeprecationWarning: The ready event has been renamed to clientReady` | يظهر إذا كان ملفك الرئيسي القديم يستخدم `ready`. نسخة `index.js` هنا تستخدم `clientReady` ولم تعد تصدر هذا التحذير |
| `Used disallowed intents` عند الدخول | فعّل MESSAGE CONTENT INTENT من Developer Portal → Bot |
| `TokenInvalid` | التوكن خاطئ أو تم تجديده من Developer Portal |
| `Cannot find module './helpers'` | ملفك القديم يستدعي helpers غير موجود → انظر القسم 9 |
| `Cannot find module 'X'` داخل أمر | الحزمة X غير مثبتة: `npm install X` (يُطبع اسم الوحدة في السجل) |
| `Cannot find module 'discord.js'` | نفّذ `npm install` داخل مجلد المشروع |
