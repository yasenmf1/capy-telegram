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
    `*Команди:*\n/clear — изчисти историята на разговора\n/help — тази помощ\n\nПросто пиши и аз отговарям!`,
    { parse_mode: 'Markdown' }
  );
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
    const weatherSection = weather
      ? `🌤 *Времето в Стара Загора:*\n${weather}\n\n`
      : '';
    const msg = `☀️ *Добро утро, Ясен!*\n\n${weatherSection}${news}`;
    await bot.telegram.sendMessage(OWNER_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Morning briefing error:', e.message);
  }
}

// Всеки ден в 8:00 Sofia time
cron.schedule('0 8 * * *', sendMorningBriefing, { timezone: 'Europe/Sofia' });

bot.launch();
console.log('✅ Capy Telegram Bot стартиран!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
