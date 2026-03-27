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

const OWNER_ID = process.env.OWNER_TELEGRAM_ID;
const BOT_PASSWORD = process.env.BOT_PASSWORD || 'YasenMF';
const conversations = new Map();
const authenticated = new Set(); // потребители влезли с парола

function isAllowed(id) {
  if (!OWNER_ID && !BOT_PASSWORD) return true;
  if (id === OWNER_ID) return true;
  if (authenticated.has(id)) return true;
  return false;
}

const SYSTEM = `Ти си Capy — личен AI асистент на Ясен Начев от Стара Загора, България.
Ясен управлява суши бизнес MOTAMO. Говори на български освен ако Ясен не пише на английски.
Имаш достъп до актуална информация от интернет — използвай я когато е нужно.
Бъди полезен, кратък и конкретен. Форматирай отговорите с Markdown.`;

// Проверка за достъп — парола
bot.use(async (ctx, next) => {
  const id = ctx.from?.id?.toString();
  if (isAllowed(id)) return next();

  // Проверка дали пишат паролата
  const text = ctx.message?.text?.trim();
  if (text === BOT_PASSWORD) {
    authenticated.add(id);
    return ctx.reply('✅ Добре дошъл! Вече имаш достъп.\n\nНапиши каквото искаш — аз съм Capy, твоят AI асистент.');
  }

  return ctx.reply('🔒 Този бот е защитен с парола.\nВъведи паролата за достъп:');
});

bot.start(ctx => {
  const id = ctx.from.id;
  ctx.reply(
    `👋 Здравей Ясен!\n\nАз съм Capy — твоят личен AI асистент.\n\nМога да:\n• Отговарям на въпроси\n• Проверявам актуална информация в интернет\n• Помагам с бизнеса ти\n\nТвоят Telegram ID: \`${id}\`\n_(запази го ако ти трябва)_`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('clear', ctx => {
  conversations.delete(ctx.from.id.toString());
  ctx.reply('✅ Историята е изчистена.');
});

bot.command('help', ctx => {
  ctx.reply(
    `*Команди:*\n/clear — изчисти историята на разговора\n/gmail — резюме на имейлите\n/help — тази помощ\n\nПросто пиши и аз отговарям!`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('gmail', async ctx => {
  await ctx.sendChatAction('typing');
  const summary = await getGmailSummary();
  if (summary) {
    try {
      await ctx.reply(summary, { parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(summary);
    }
  } else {
    await ctx.reply('⚠️ Gmail не е конфигуриран или няма имейли.');
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text;

  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }

  const history = conversations.get(userId);
  history.push({ role: 'user', content: text });

  // Пази последните 30 съобщения
  if (history.length > 30) {
    history.splice(0, history.length - 30);
  }

  try {
    await ctx.sendChatAction('typing');

    const response = await ai.chat.completions.create({
      model: 'perplexity/sonar',
      messages: [
        { role: 'system', content: SYSTEM },
        ...history
      ],
      max_tokens: 2000,
    });

    const reply = response.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });

    // Изпрати с Markdown (ако не се парсира, изпрати като обикновен текст)
    try {
      await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(reply);
    }

  } catch (e) {
    console.error('AI error:', e.message);
    await ctx.reply('⚠️ Грешка при свързване с AI. Опитай пак след малко.');
  }
});

// Снимки — опиши ги
bot.on('photo', async (ctx) => {
  await ctx.reply('📸 Получих снимката. Засега не мога да анализирам изображения — изпрати ми текстово описание.');
});

// ── Gmail ──
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
      model: 'google/gemini-flash-1.5',
      messages: [{
        role: 'user',
        content: `Резюмирай тези ${emails.length} имейла кратко на български. Групирай по важност. Маркирай тези изискващи действие с ⚡.\n\n${emails.join('\n---\n')}`
      }],
      max_tokens: 600,
    });
    return `📧 *Имейли — последните 24 часа (${emails.length}):*\n\n${aiRes.choices[0].message.content}`;
  } catch (e) {
    console.error('Gmail error:', e.message);
    return null;
  }
}

// ── Времето от OpenWeatherMap ──
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

// ── Сутрешен бюлетин ──
async function sendMorningBriefing() {
  if (!OWNER_ID) return;
  try {
    const weather = await getWeather();
    const newsResponse = await ai.chat.completions.create({
      model: 'perplexity/sonar',
      messages: [
        {
          role: 'user',
          content: `Дай топ 3 новини от България днес (${new Date().toLocaleDateString('bg-BG')}) и един мотивиращ цитат. Само новини и цитат — без времето. Кратко, с емоджи, на български.`
        }
      ],
      max_tokens: 500,
    });
    const news = newsResponse.choices[0].message.content;
    const gmail = await getGmailSummary();
    const weatherSection = weather
      ? `🌤 *Времето в Стара Загора:*\n${weather}\n\n`
      : '';
    const gmailSection = gmail ? `\n\n${gmail}` : '';
    const msg = `☀️ *Добро утро, Ясен!*\n\n${weatherSection}${news}${gmailSection}`;
    await bot.telegram.sendMessage(OWNER_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Morning briefing error:', e.message);
  }
}

// Всеки ден в 8:00 Sofia time
cron.schedule('0 8 * * *', sendMorningBriefing, { timezone: 'Europe/Sofia' });

// ── Вечерна MOTAMO статистика в 21:00 ──
async function sendEveningStats() {
  if (!OWNER_ID) return;
  const motamoUrl = process.env.MOTAMO_URL;
  const motamoKey = process.env.MOTAMO_KEY;
  if (!motamoUrl || !motamoKey) return;
  try {
    const res = await fetch(`${motamoUrl}/api/stats?key=${motamoKey}`);
    const stats = await res.json();
    const total = stats.total || 0;
    const lines = [`📊 *MOTAMO — Статистика днес*\n`, `Общо запитвания: *${total}*`];
    if (stats.categories && Object.keys(stats.categories).length) {
      lines.push('\n*По категории:*');
      for (const [cat, cnt] of Object.entries(stats.categories).sort((a,b) => b[1]-a[1])) {
        lines.push(`• ${cat}: ${cnt}`);
      }
    }
    if (stats.products && Object.keys(stats.products).length) {
      lines.push('\n*Топ продукти:*');
      Object.entries(stats.products).sort((a,b) => b[1]-a[1]).slice(0,5).forEach(([p,c]) => {
        lines.push(`• ${p}: ${c}`);
      });
    }
    await bot.telegram.sendMessage(OWNER_ID, lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Evening stats error:', e.message);
  }
}

// Всеки ден в 21:00 Sofia time
cron.schedule('0 21 * * *', sendEveningStats, { timezone: 'Europe/Sofia' });

bot.launch();
console.log('✅ Capy Telegram Bot стартиран!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
