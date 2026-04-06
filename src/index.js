require('dotenv').config();
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
const cron = require('node-cron');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

const ai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://motamo.bg',
    'X-Title': 'Capy Assistant'
  }
});

const OWNER_ID = process.env.OWNER_TELEGRAM_ID?.trim();
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'YasenMF';
const conversations = new Map();
const authenticated = new Set();

const MODEL_CHAT   = 'anthropic/claude-sonnet-4-5';
const MODEL_SEARCH = 'perplexity/sonar';
const MODEL_FAST   = 'google/gemini-flash-1.5';

async function notifyOwnerError(where, err) {
  if (!OWNER_ID) return;
  try {
    await bot.telegram.sendMessage(
      OWNER_ID,
      `⚠️ *Грешка в Capy [${where}]:*\n\`${String(err).slice(0, 300)}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}
}

function isAllowed(id) {
  if (!OWNER_ID && !BOT_PASSWORD) return true;
  if (id === OWNER_ID) return true;
  if (authenticated.has(id)) return true;
  return false;
}

const SYSTEM = `Ти си Capy — личен AI асистент на Ясен Начев от Стара Загора, България.
Ясен управлява суши бизнес MOTAMO. Говори на български освен ако Ясен не пише на английски.
Бъди полезен, кратък и конкретен. Форматирай отговорите с Markdown.
Когато не знаеш нещо или ти трябва актуална информация — кажи го честно.
Имаш достъп до история на разговора — използвай я за контекст.`;

bot.use(async (ctx, next) => {
  const id = ctx.from?.id?.toString();
  if (isAllowed(id)) return next();
  const text = ctx.message?.text?.trim();
  if (text === BOT_PASSWORD) {
    authenticated.add(id);
    return ctx.reply('✅ Добре дошъл! Вече имаш достъп.\n\nНапиши каквото искаш — аз съм Capy, твоят AI асистент.');
  }
  return ctx.reply('🔒 Този бот е защитен с парола.\nВъведи паролата за достъп:');
});

bot.start(ctx => {
  ctx.reply(
    `👋 Здравей Ясен!\n\nАз съм *Capy* — твоят личен AI асистент, захранван от Claude.\n\nМога да:\n• Отговарям на въпроси и помагам с идеи\n• Помагам с бизнеса ти MOTAMO\n• Изпращам сутрешен бюлетин всеки ден в 8:00\n• Резюмирам имейлите ти с /gmail\n\nТвоят Telegram ID: \`${ctx.from.id}\``,
    { parse_mode: 'Markdown' }
  );
});

bot.command('clear', ctx => {
  conversations.delete(ctx.from.id.toString());
  ctx.reply('✅ Историята е изчистена. Започваме отначало!');
});

bot.command('help', ctx => {
  ctx.reply(
    `*Команди:*\n\n/clear — изчисти историята на разговора\n/gmail — резюме на имейлите от последните 24ч\n/weather — времето в Стара Загора\n/stats — статистика на MOTAMO\n/morning — изпрати сутрешния бюлетин СЕГА (за тест)\n/help — тази помощ\n\nПросто пиши и аз отговарям!`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('gmail', async ctx => {
  await ctx.sendChatAction('typing');
  const summary = await getGmailSummary();
  if (summary) {
    try { await ctx.reply(summary, { parse_mode: 'Markdown' }); }
    catch { await ctx.reply(summary); }
  } else {
    await ctx.reply('⚠️ Gmail не е конфигуриран или няма имейли.');
  }
});

bot.command('weather', async ctx => {
  await ctx.sendChatAction('typing');
  const weather = await getWeather();
  if (weather) {
    try { await ctx.reply(`🌤 *Времето в Стара Загора:*\n\n${weather}`, { parse_mode: 'Markdown' }); }
    catch { await ctx.reply(weather); }
  } else {
    await ctx.reply('⚠️ Не мога да получа информация за времето. Провери WEATHER_API_KEY.');
  }
});

bot.command('stats', async ctx => {
  await ctx.sendChatAction('typing');
  const motamoUrl = process.env.MOTAMO_URL;
  const motamoKey = process.env.MOTAMO_KEY;
  if (!motamoUrl || !motamoKey) {
    return ctx.reply('⚠️ MOTAMO не е конфигуриран (MOTAMO_URL / MOTAMO_KEY липсват).');
  }
  try {
    const res = await fetch(`${motamoUrl}/api/stats?key=${motamoKey}`);
    const stats = await res.json();
    const lines = [`📊 *MOTAMO — Статистика днес*\n`, `Общо запитвания: *${stats.total || 0}*`];
    if (stats.categories && Object.keys(stats.categories).length) {
      lines.push('\n*По категории:*');
      for (const [cat, cnt] of Object.entries(stats.categories).sort((a, b) => b[1] - a[1])) {
        lines.push(`• ${cat}: ${cnt}`);
      }
    }
    if (stats.products && Object.keys(stats.products).length) {
      lines.push('\n*Топ продукти:*');
      Object.entries(stats.products).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([p, c]) => {
        lines.push(`• ${p}: ${c}`);
      });
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Stats error:', e.message);
    await ctx.reply('⚠️ Грешка при зареждане на статистиката.');
  }
});

bot.command('morning', async ctx => {
  const id = ctx.from.id.toString();
  if (id !== OWNER_ID) return ctx.reply('🔒 Само за Ясен.');
  await ctx.reply('⏳ Генерирам сутрешния бюлетин...');
  await sendMorningBriefing();
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: text });
  if (history.length > 40) history.splice(0, history.length - 40);
  try {
    await ctx.sendChatAction('typing');
    const response = await ai.chat.completions.create({
      model: MODEL_CHAT,
      messages: [{ role: 'system', content: SYSTEM }, ...history],
      max_tokens: 2000,
    });
    const reply = response.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });
    try { await ctx.reply(reply, { parse_mode: 'Markdown' }); }
    catch { await ctx.reply(reply); }
  } catch (e) {
    console.error('AI error:', e.message);
    await ctx.reply('⚠️ Грешка при свързване с AI. Опитай пак след малко.');
  }
});

bot.on('photo', async (ctx) => {
  await ctx.reply('📸 Получих снимката. Засега не мога да анализирам изображения — изпрати ми текстово описание.');
});

bot.on('voice', async (ctx) => {
  await ctx.reply('🎤 Засега не поддържам гласови съобщения — напиши ми текстово.');
});

async function getGmailAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  return data.access_token;
}

async function getGmailSummary() {
  if (!process.env.GMAIL_CLIENT_ID) return null;
  try {
    const token = await getGmailAccessToken();
    const since = Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox after:${since}&maxResults=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listData = await listRes.json();
    const messages = listData.messages || [];
    if (messages.length === 0) return '📭 Няма нови имейли за последните 24 часа.';
    const emails = [];
    for (const m of messages.slice(0, 10)) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const msg = await msgRes.json();
      const headers = msg.payload?.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || 'Неизвестен';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(без тема)';
      emails.push(`От: ${from}\nТема: ${subject}`);
    }
    const aiRes = await ai.chat.completions.create({
      model: MODEL_FAST,
      messages: [{ role: 'user', content: `Резюмирай тези ${emails.length} имейла кратко на български. Групирай по важност. Маркирай тези изискващи действие с ⚡.\n\n${emails.join('\n---\n')}` }],
      max_tokens: 600,
    });
    return `📧 *Имейли — последните 24 часа (${emails.length}):*\n\n${aiRes.choices[0].message.content}`;
  } catch (e) {
    console.error('Gmail error:', e.message);
    return null;
  }
}

async function getWeather() {
  const key = process.env.WEATHER_API_KEY;
  if (!key) return null;
  try {
    const [cur, fore] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?q=Stara+Zagora,BG&appid=${key}&units=metric&lang=bg`).then(r => r.json()),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?q=Stara+Zagora,BG&appid=${key}&units=metric&lang=bg&cnt=4`).then(r => r.json())
    ]);
    const desc = cur.weather[0]?.description || '';
    const temp = Math.round(cur.main?.temp);
    const feels = Math.round(cur.main?.feels_like);
    const humidity = cur.main?.humidity;
    const wind = Math.round(cur.wind?.speed);
    const maxTemp = Math.round(Math.max(...fore.list.map(f => f.main.temp_max)));
    const minTemp = Math.round(Math.min(...fore.list.map(f => f.main.temp_min)));
    return `🌡 Сега: *${temp}°C* (усеща се ${feels}°C)\n📊 Ден: ${minTemp}°C — ${maxTemp}°C\n☁️ ${desc}\n💧 Влажност: ${humidity}% | 💨 Вятър: ${wind} м/с`;
  } catch (e) {
    return null;
  }
}

async function sendMorningBriefing() {
  console.log(`[${new Date().toISOString()}] ⏰ sendMorningBriefing стартира, OWNER_ID="${OWNER_ID}"`);
  if (!OWNER_ID) {
    console.error('❌ OWNER_TELEGRAM_ID не е зададен в .env!');
    return;
  }
  try {
    const [weatherResult, gmailResult] = await Promise.allSettled([
      getWeather(),
      getGmailSummary()
    ]);

    let newsText = '';
    try {
      const newsResponse = await ai.chat.completions.create({
        model: MODEL_SEARCH,
        messages: [{ role: 'user', content: `Дай топ 3 новини от България днес (${new Date().toLocaleDateString('bg-BG')}) и един мотивиращ цитат. Само новини и цитат — без времето. Кратко, с емоджи, на български.` }],
        max_tokens: 500,
      });
      newsText = newsResponse.choices[0].message.content;
    } catch (e) {
      console.error('News fetch error:', e.message);
      newsText = '📰 Новините не успяха да се заредят днес.';
    }

    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const gmail   = gmailResult.status   === 'fulfilled' ? gmailResult.value   : null;

    const weatherSection = weather ? `🌤 *Времето в Стара Загора:*\n${weather}\n\n` : '';
    // ПОПРАВКА: Винаги показва секцията за имейли — дори когато няма нови
    const gmailSection = gmail
      ? `\n\n${gmail}`
      : '\n\n📭 *Имейли:* Няма нови съобщения за последните 24 часа.';

    const msg = `☀️ *Добро утро, Ясен!*\n\n${weatherSection}${newsText}${gmailSection}`;
    await bot.telegram.sendMessage(OWNER_ID, msg, { parse_mode: 'Markdown' });
    console.log('✅ Сутрешният бюлетин е изпратен успешно.');
  } catch (e) {
    console.error('Morning briefing FATAL error:', e.message);
    await notifyOwnerError('Сутрешен бюлетин', e.message);
  }
}

async function sendEveningStats() {
  console.log(`[${new Date().toISOString()}] ⏰ sendEveningStats стартира, OWNER_ID="${OWNER_ID}"`);
  if (!OWNER_ID) {
    console.error('❌ OWNER_TELEGRAM_ID не е зададен в .env!');
    return;
  }
  const motamoUrl = process.env.MOTAMO_URL;
  const motamoKey = process.env.MOTAMO_KEY;
  if (!motamoUrl || !motamoKey) {
    await notifyOwnerError('Вечерна статистика', 'MOTAMO_URL или MOTAMO_KEY не са зададени в .env');
    return;
  }
  try {
    const res = await fetch(`${motamoUrl}/api/stats?key=${motamoKey}`);
    const stats = await res.json();
    const total = stats.total || 0;
    const lines = [`📊 *MOTAMO — Статистика днес*\n`, `Общо запитвания: *${total}*`];
    if (stats.categories && Object.keys(stats.categories).length) {
      lines.push('\n*По категории:*');
      for (const [cat, cnt] of Object.entries(stats.categories).sort((a, b) => b[1] - a[1])) {
        lines.push(`• ${cat}: ${cnt}`);
      }
    }
    if (stats.products && Object.keys(stats.products).length) {
      lines.push('\n*Топ продукти:*');
      Object.entries(stats.products).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([p, c]) => {
        lines.push(`• ${p}: ${c}`);
      });
    }
    await bot.telegram.sendMessage(OWNER_ID, lines.join('\n'), { parse_mode: 'Markdown' });
    console.log('✅ Вечерната статистика е изпратена успешно.');
  } catch (e) {
    console.error('Evening stats error:', e.message);
    await notifyOwnerError('Вечерна статистика', e.message);
  }
}

cron.schedule('0 8 * * *', sendMorningBriefing, { timezone: 'Europe/Sofia' });
cron.schedule('0 21 * * *', sendEveningStats,   { timezone: 'Europe/Sofia' });

bot.launch();
console.log('✅ Capy Telegram Bot стартиран!');
console.log(`   OWNER_ID: ${OWNER_ID || '❌ НЕ Е ЗАДАДЕН — репортите НЯМА да се изпращат!'}`);
console.log(`   Gmail:    ${process.env.GMAIL_CLIENT_ID ? '✅' : '❌ не е конфигуриран'}`);
console.log(`   Weather:  ${process.env.WEATHER_API_KEY ? '✅' : '❌ не е конфигуриран'}`);
console.log(`   MOTAMO:   ${process.env.MOTAMO_URL ? '✅' : '❌ не е конфигуриран'}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
