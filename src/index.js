require('dotenv').config();
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

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
const ALLOWED_IDS = (process.env.ALLOWED_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const conversations = new Map();

function isAllowed(id) {
  if (!OWNER_ID) return true;
  if (id === OWNER_ID) return true;
  if (ALLOWED_IDS.includes(id)) return true;
  return false;
}

const SYSTEM = `Ти си Capy — личен AI асистент на Ясен Начев от Стара Загора, България.
Ясен управлява суши бизнес MOTAMO. Говори на български освен ако Ясен не пише на английски.
Имаш достъп до актуална информация от интернет — използвай я когато е нужно.
Бъди полезен, кратък и конкретен. Форматирай отговорите с Markdown.`;

// Проверка за достъп
bot.use(async (ctx, next) => {
  const id = ctx.from?.id?.toString();
  if (!isAllowed(id)) {
    return ctx.reply(`Нямаш достъп към този бот.\n\nТвоят Telegram ID: \`${id}\`\nПрати го на Ясен за да получиш достъп.`, { parse_mode: 'Markdown' });
  }
  return next();
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

bot.launch();
console.log('✅ Capy Telegram Bot стартиран!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
