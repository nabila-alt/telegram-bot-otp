require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const Database = require('better-sqlite3');

const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || '0', 10);
const BOT_NAME = process.env.BOT_NAME || 'SMS KU';
const DEFAULT_LIMIT = parseInt(process.env.MAX_FREE_LIMIT || '3', 10);

const SERVER_CONFIG = {
  server1: {
    name: process.env.SERVER_1_NAME || 'SERVER SATU',
    baseUrl: process.env.SERVER_1_URL || 'https://smsku.zelapi.eu.cc'
  },
  server2: {
    name: process.env.SERVER_2_NAME || 'SERVER DUA',
    baseUrl: process.env.SERVER_2_URL || ''
  },
  server3: {
    name: process.env.SERVER_3_NAME || 'SERVER TIGA',
    baseUrl: process.env.SERVER_3_URL || ''
  }
};

if (!TOKEN) {
  console.error('ERROR: BOT_TOKEN tidak ditemukan di .env');
  process.exit(1);
}

const bot = new Telegraf(TOKEN);
const db = new Database(process.env.DATABASE_PATH || 'zelapi_bot.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    phone_number TEXT,
    is_suspended INTEGER DEFAULT 0,
    custom_limit INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    user_id INTEGER PRIMARY KEY,
    state TEXT,
    data TEXT
  );

  CREATE TABLE IF NOT EXISTS active_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    number TEXT UNIQUE,
    service TEXT,
    country TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS otp_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    number TEXT,
    service TEXT,
    otp_code TEXT,
    full_text TEXT,
    sms_timestamp TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const stmtGetUser = db.prepare('SELECT * FROM users WHERE user_id = ?');
const stmtGetAllUsers = db.prepare('SELECT * FROM users ORDER BY created_at DESC');
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (user_id, username, first_name, phone_number)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    phone_number = COALESCE(excluded.phone_number, users.phone_number)
`);

const stmtUpdateUserSuspend = db.prepare('UPDATE users SET is_suspended = ? WHERE user_id = ?');
const stmtUpdateUserLimit = db.prepare('UPDATE users SET custom_limit = ? WHERE user_id = ?');

const stmtGetSession = db.prepare('SELECT * FROM user_sessions WHERE user_id = ?');
const stmtSetSession = db.prepare(`
  INSERT INTO user_sessions (user_id, state, data)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data
`);
const stmtClearSession = db.prepare('DELETE FROM user_sessions WHERE user_id = ?');

const stmtAddActiveNumber = db.prepare(`
  INSERT INTO active_numbers (user_id, number, service, country, status)
  VALUES (?, ?, ?, ?, 'active')
  ON CONFLICT(number) DO UPDATE SET status = 'active', user_id = excluded.user_id, service = excluded.service, country = excluded.country
`);

const stmtReleaseActiveNumber = db.prepare(`
  UPDATE active_numbers SET status = 'released' WHERE number = ? AND user_id = ?
`);

const stmtGetUserActiveNumbers = db.prepare(`
  SELECT * FROM active_numbers WHERE user_id = ? AND status = 'active' ORDER BY id DESC
`);

const stmtGetAllActiveNumbers = db.prepare(`
  SELECT * FROM active_numbers WHERE status = 'active'
`);

const stmtCheckOtpExists = db.prepare(`
  SELECT id FROM otp_history WHERE number = ? AND full_text = ? AND sms_timestamp = ? LIMIT 1
`);

const stmtSaveOtpHistory = db.prepare(`
  INSERT INTO otp_history (user_id, number, service, otp_code, full_text, sms_timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtGetUserGlobalOtpHistory = db.prepare(`
  SELECT * FROM otp_history WHERE user_id = ? ORDER BY id DESC
`);

const stmtGetUserNumberOtpHistory = db.prepare(`
  SELECT * FROM otp_history WHERE user_id = ? AND number = ? ORDER BY id DESC
`);

const stmtGetUserOtpCount = db.prepare(`
  SELECT COUNT(*) as total FROM otp_history WHERE user_id = ?
`);

function getAvailableServers() {
  return Object.entries(SERVER_CONFIG)
    .filter(([, cfg]) => cfg.baseUrl && cfg.baseUrl.trim() !== '')
    .map(([key, cfg]) => ({ key, ...cfg }));
}

function getServerByKey(serverKey) {
  return SERVER_CONFIG[serverKey] || SERVER_CONFIG.server1;
}

function getSelectedServerKey(userId) {
  const session = stmtGetSession.get(userId);
  if (session && session.data) return session.data;
  return 'server1';
}

bot.use(async (ctx, next) => {
  if (ctx.from) {
    const u = stmtGetUser.get(ctx.from.id);
    if (u && u.is_suspended && ctx.from.id !== OWNER_ID) {
      return ctx.reply('🚫 <b>AKSES DITANGGUHKAN</b>\n━━━━━━━━━━━━━━━━━━━━\nAkun Anda telah dinonaktifkan sementara oleh Owner.', { parse_mode: 'HTML' });
    }
  }
  return next();
});

async function safeAnswerCb(ctx, text = '', options = {}) {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery(text, options);
  } catch {}
}

function getWibTimestamp(dateObj = new Date()) {
  const options = {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  };
  const formatter = new Intl.DateTimeFormat('id-ID', options);
  const parts = Object.fromEntries(formatter.formatToParts(dateObj).map(p => [p.type, p.value]));
  return `${parts.hour}:${parts.minute}:${parts.second} WIB • ${parts.day}/${parts.month}/${parts.year}`;
}

function formatApiTimestamp(rawTimestamp) {
  if (!rawTimestamp) return getWibTimestamp();
  const parsedDate = new Date(rawTimestamp.replace(' ', 'T') + '+00:00');
  if (isNaN(parsedDate.getTime())) return rawTimestamp;
  return getWibTimestamp(parsedDate);
}

function cleanNumStr(rawNumber) {
  return String(rawNumber).replace(/\D/g, '');
}

function formatPhoneNumber(rawNumber) {
  if (!rawNumber) return '-';
  let cleaned = cleanNumStr(rawNumber);
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;

  if (cleaned.startsWith('+62')) return cleaned.replace(/^(\+62)(\d{3})(\d{4})(\d{3,4})$/, '$1 $2-$3-$4');
  if (cleaned.startsWith('+1')) return cleaned.replace(/^(\+1)(\d{3})(\d{3})(\d{4})$/, '$1 ($2) $3-$4');
  if (cleaned.length > 10) return cleaned.replace(/^(\+\d{1,3})(\d{3,4})(\d{4,8})$/, '$1 $2-$3');
  return cleaned;
}

function getUserMaxLimit(userId) {
  if (userId === OWNER_ID) return Infinity;
  const user = stmtGetUser.get(userId);
  if (user && user.custom_limit !== null && user.custom_limit !== undefined) {
    return user.custom_limit;
  }
  return DEFAULT_LIMIT;
}

class ZelApiClient {
  static getBaseUrl(serverKey = 'server1') {
    return getServerByKey(serverKey).baseUrl;
  }

  static async getServices(serverKey = 'server1') {
    try {
      const res = await axios.get(`${this.getBaseUrl(serverKey)}/api/services`, { timeout: 10000 });
      return (res.status === 200 && res.data && res.data.success) ? res.data.services : null;
    } catch {
      return null;
    }
  }

  static async getCountries(service, serverKey = 'server1') {
    try {
      const res = await axios.get(`${this.getBaseUrl(serverKey)}/api/countries`, {
        params: { service },
        timeout: 10000
      });
      return (res.status === 200 && res.data && res.data.success) ? res.data.countries : null;
    } catch {
      return null;
    }
  }

  static async requestNumber(service, country, serverKey = 'server1') {
    try {
      const res = await axios.post(`${this.getBaseUrl(serverKey)}/api/request_number`, { service, country }, { timeout: 10000 });
      return (res.status === 200 || res.status === 201) ? res.data : null;
    } catch {
      return null;
    }
  }

  static async releaseNumber(number, serverKey = 'server1') {
    try {
      const cleanNum = cleanNumStr(number);
      const res = await axios.post(`${this.getBaseUrl(serverKey)}/api/release_number`, { number: cleanNum }, { timeout: 10000 });
      return (res.status === 200 && res.data) ? res.data : null;
    } catch {
      return null;
    }
  }

  static async getPublicOtpFeed(count = 100, serverKey = 'server1') {
    try {
      const res = await axios.get(`${this.getBaseUrl(serverKey)}/api/otp`, { params: { count }, timeout: 10000 });
      return res.status === 200 ? res.data : null;
    } catch {
      return null;
    }
  }

  static async getStats(serverKey = 'server1') {
    try {
      const res = await axios.get(`${this.getBaseUrl(serverKey)}/api/stats/detailed`, {
        params: { period: 'daily' },
        timeout: 10000
      });
      return res.status === 200 ? res.data : null;
    } catch {
      return null;
    }
  }

  static async requestUniqueNumber(service, country, userId, excludeNumber = null, serverKey = 'server1') {
    let attempts = 0;
    const maxAttempts = 5;

    const userActiveNumbers = stmtGetUserActiveNumbers.all(userId).map(item => cleanNumStr(item.number));
    if (excludeNumber) {
      userActiveNumbers.push(cleanNumStr(excludeNumber));
    }

    while (attempts < maxAttempts) {
      attempts++;
      const res = await this.requestNumber(service, country, serverKey);
      if (!res || !res.success || !res.number) {
        return { success: false, error: res?.error || 'Stok nomor sedang kosong atau terjadi kendala API.' };
      }

      const cleanNum = cleanNumStr(res.number);

      if (userActiveNumbers.includes(cleanNum)) {
        await this.releaseNumber(cleanNum, serverKey);
        continue;
      }

      return res;
    }

    return { success: false, error: 'Server terus memberikan nomor yang sama. Silakan coba kembali dalam beberapa saat.' };
  }
}

function startGlobalOtpLoop() {
  setInterval(async () => {
    try {
      const availableServers = getAvailableServers();

      for (const server of availableServers) {
        const feed = await ZelApiClient.getPublicOtpFeed(100, server.key);
        if (!Array.isArray(feed)) continue;

        const activeNumbers = stmtGetAllActiveNumbers.all();
        if (!activeNumbers || activeNumbers.length === 0) continue;

        const activeMap = new Map();
        activeNumbers.forEach(item => activeMap.set(cleanNumStr(item.number), item));

        for (const item of feed) {
          if (!Array.isArray(item) || item.length < 4) continue;
          const [service, rawNum, message, timestamp, country] = item;
          const cleanNum = cleanNumStr(rawNum);

          if (activeMap.has(cleanNum)) {
            const userNumObj = activeMap.get(cleanNum);
            const formattedSmsTime = formatApiTimestamp(timestamp);

            const existingOtp = stmtCheckOtpExists.get(cleanNum, message, formattedSmsTime);
            if (!existingOtp) {
              const matchOtp = message.match(/\b\d{3}[-\s]?\d{3,4}\b|\b\d{4,8}\b/);
              const extractedCode = matchOtp ? matchOtp[0] : 'LIHAT SMS';

              stmtSaveOtpHistory.run(userNumObj.user_id, cleanNum, service, extractedCode, message, formattedSmsTime);

              const text = `📬 <b>NOTIFIKASI SMS/OTP MASUK</b>\n━━━━━━━━━━━━━━━━━━━━\n🔹 <b>Layanan:</b> <code>${service}</code>\n🌍 <b>Negara:</b> <code>${country || userNumObj.country}</code>\n📱 <b>Nomor:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n\n🔑 <b>KODE OTP:</b> <code>${extractedCode}</code>\n\n💬 <b>Isi Pesan:</b>\n<blockquote>${message}</blockquote>\n\n🕒 <b>Waktu:</b> <code>${formattedSmsTime}</code>\n━━━━━━━━━━━━━━━━━━━━\n<i>Sistem tetap memantau nomor ini untuk menerima SMS baru berikutnya.</i>`;

              const keyboard = Markup.inlineKeyboard([
                [
                  Markup.button.callback('🔄 Ganti Nomor', `change_${cleanNum}_${service}_${userNumObj.country || 'Default'}`),
                  Markup.button.callback('🗑️ Lepas Nomor', `rel_${cleanNum}_${service}`)
                ],
                [
                  Markup.button.callback('📜 Riwayat Nomor Ini', `history_num_${cleanNum}`),
                  Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
                ],
                [
                  Markup.button.callback('🌐 Layanan', 'menu_services'),
                  Markup.button.callback('🏠 Menu Utama', 'menu_main')
                ]
              ]);

              bot.telegram.sendMessage(userNumObj.user_id, text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
            }
          }
        }
      }
    } catch {}
  }, 4000);
}

startGlobalOtpLoop();

function getMainMenuKeyboard(userId) {
  const btns = [
    [
      Markup.button.callback('🌐 Pilih Server Endpoint', 'menu_server_select'),
      Markup.button.callback('📱 Nomor Aktif Saya', 'menu_my_numbers')
    ],
    [
      Markup.button.callback('🔍 Cek OTP Manual', 'menu_manual_check'),
      Markup.button.callback('📜 Riwayat OTP Global', 'menu_history_global')
    ],
    [
      Markup.button.callback('📊 Status & Statistik API', 'menu_stats'),
      Markup.button.callback('👤 Profil Akun', 'menu_profile')
    ]
  ];

  if (userId === OWNER_ID) {
    btns.push([Markup.button.callback('👑 Panel Pengaturan Owner', 'menu_owner')]);
  }
  return Markup.inlineKeyboard(btns);
}

function getServerSelectKeyboard() {
  const rows = [];
  const available = getAvailableServers();

  available.forEach(server => {
    rows.push([
      Markup.button.callback(`🌐 ${server.name}`, `server_select_${server.key}`)
    ]);
  });

  rows.push([Markup.button.callback('🏠 Menu Utama', 'menu_main')]);
  return Markup.inlineKeyboard(rows);
}

function getContactReplyKeyboard() {
  return Markup.keyboard([
    [Markup.button.contactRequest('📲 Verifikasi Kontak Telegram')]
  ]).resize().oneTime();
}

async function sendMainMenu(ctx) {
  const userId = ctx.from.id;
  const activeNums = stmtGetUserActiveNumbers.all(userId);
  const otpCountRes = stmtGetUserOtpCount.get(userId);
  const totalUserOtp = otpCountRes ? otpCountRes.total : 0;

  const limit = getUserMaxLimit(userId);
  const limitStr = limit === Infinity ? 'Unlimited' : `${limit} Slot`;
  const savedCountStr = `${activeNums.length} / ${limitStr}`;

  const text = `✨ <b>SELAMAT DATANG DI ${BOT_NAME.toUpperCase()}</b> ✨\n━━━━━━━━━━━━━━━━━━━━\nHalo <b>${ctx.from.first_name}</b> 👋\nSistem OTP Otomatis & Cek SMS Real-time siap digunakan.\n\n📊 <b>STATUS & METRIK AKUN:</b>\n├ 🟢 <b>Status Server:</b> <code>Normal & Aktif</code>\n├ 📱 <b>Nomor Tersimpan:</b> <code>${savedCountStr}</code>\n├ 📬 <b>Total OTP Diterima:</b> <code>${totalUserOtp} Pesan</code>\n└ 🕒 <b>Waktu Sistem:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n👇 <i>Pilih salah satu menu interaktif di bawah:</i>`;

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...getMainMenuKeyboard(userId) });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...getMainMenuKeyboard(userId) });
    }
  } catch {}
}

bot.start(async (ctx) => {
  const user = ctx.from;
  stmtUpsertUser.run(user.id, user.username || null, user.first_name, null);

  const dbUser = stmtGetUser.get(user.id);

  if (!dbUser || !dbUser.phone_number) {
    stmtSetSession.run(user.id, 'WAITING_CONTACT', '');
    const text = `👋 <b>Halo, ${user.first_name}!</b>\n━━━━━━━━━━━━━━━━━━━━\nSelamat datang di <b>${BOT_NAME} Bot</b>.\nUntuk memastikan keamanan dan kelancaran layanan sewa nomor virtual, silakan verifikasi nomor kontak Telegram Anda terlebih dahulu.\n\n🕒 <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n👇 <i>Klik tombol hijau di bawah untuk membagikan kontak resmi:</i>`;
    return ctx.reply(text, { parse_mode: 'HTML', ...getContactReplyKeyboard() });
  }

  stmtClearSession.run(user.id);
  return sendMainMenu(ctx);
});

bot.on('contact', async (ctx) => {
  const session = stmtGetSession.get(ctx.from.id);
  const contact = ctx.message.contact;

  if (session && session.state === 'WAITING_CONTACT') {
    if (contact.user_id !== ctx.from.id) {
      return ctx.reply('⚠️ <b>VERIFIKASI GAGAL!</b>\nKontak yang dibagikan tidak cocok dengan akun Telegram ini. Silakan tekan tombol resmi di bawah.', {
        parse_mode: 'HTML',
        ...getContactReplyKeyboard()
      });
    }

    stmtUpsertUser.run(ctx.from.id, ctx.from.username || null, ctx.from.first_name, contact.phone_number);
    stmtClearSession.run(ctx.from.id);

    await ctx.reply(`✅ <b>VERIFIKASI BERHASIL!</b>\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor:</b> <code>${formatPhoneNumber(contact.phone_number)}</code>\n🕒 <b>Waktu:</b> <code>${getWibTimestamp()}</code>\n\nAkun Anda kini aktif dan dapat menggunakan seluruh fitur.`, {
      parse_mode: 'HTML',
      ...Markup.removeKeyboard()
    });

    return sendMainMenu(ctx);
  }
});

bot.action('menu_main', async (ctx) => {
  stmtClearSession.run(ctx.from.id);
  await safeAnswerCb(ctx, 'Memuat Dashboard...');
  return sendMainMenu(ctx);
});

bot.action('menu_server_select', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat server endpoint...');
  const text = `🌐 <b>PILIH SERVER ENDPOINT</b>\n━━━━━━━━━━━━━━━━━━━━\nSilakan pilih server endpoint yang ingin Anda gunakan:`;

  return ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...getServerSelectKeyboard()
  }).catch(() => {});
});

bot.action(/^server_select_(server[123])$/, async (ctx) => {
  const serverKey = ctx.match[1];
  const server = getServerByKey(serverKey);

  stmtSetSession.run(ctx.from.id, 'SELECTED_SERVER', serverKey);
  await safeAnswerCb(ctx, `Server ${server.name} dipilih`);

  const services = await ZelApiClient.getServices(serverKey);

  if (!services || services.length === 0) {
    return ctx.editMessageText(`❌ <b>${server.name}</b>\n━━━━━━━━━━━━━━━━━━━━\nServer ini tidak bisa dihubungi atau tidak memiliki layanan aktif.\n\n🌐 <code>${server.baseUrl}</code>\n\n🕒 <code>${getWibTimestamp()}</code>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Pilih Server Lain', 'menu_server_select')],
        [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
      ])
    }).catch(() => {});
  }

  const buttons = services.slice(0, 10).map(item => [
    Markup.button.callback(`🔹 ${item.name} ── (${item.count} Stok)`, `svc_${serverKey}_${item.name}`)
  ]);

  buttons.push([
    Markup.button.callback('🔙 Pilih Server Lain', 'menu_server_select'),
    Markup.button.callback('🏠 Menu Utama', 'menu_main')
  ]);

  const text = `🌐 <b>${server.name}</b>\n━━━━━━━━━━━━━━━━━━━━\nBase URL: <code>${server.baseUrl}</code>\n\nPilih layanan yang tersedia di endpoint ini:`;

  return ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
});

bot.action('menu_manual_check', async (ctx) => {
  await safeAnswerCb(ctx, 'Mode Input Manual...');
  stmtSetSession.run(ctx.from.id, 'WAITING_MANUAL_NUMBER', '');

  const text = `🔍 <b>CEK OTP MANUAL VIA NOMOR</b>\n━━━━━━━━━━━━━━━━━━━━\nKirimkan nomor HP yang ingin Anda periksa ke chat ini (contoh: <code>6281234567890</code>).\n\n⚙️ <i>Sistem akan otomatis memvalidasi status release nomor dan memindai 100 antrean log SMS global secara instan.</i>\n\n🕒 <code>${getWibTimestamp()}</code>`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali ke Menu Utama', 'menu_main')]]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.on('text', async (ctx, next) => {
  const session = stmtGetSession.get(ctx.from.id);
  if (!session) return next();

  if (session.state === 'WAITING_MANUAL_NUMBER') {
    const inputNum = cleanNumStr(ctx.message.text);
    if (!inputNum || inputNum.length < 7) {
      return ctx.reply('⚠️ <b>Format Tidak Valid!</b>\nMasukkan nomor HP yang benar (hanya angka).');
    }

    const waitMsg = await ctx.reply('⚡ <i>Memvalidasi nomor & memindai SMS publik...</i>', { parse_mode: 'HTML' });

    const releaseRes = await ZelApiClient.releaseNumber(inputNum, getSelectedServerKey(ctx.from.id));
    const isReleasedSuccess = (releaseRes && releaseRes.success === true);

    const feed = await ZelApiClient.getPublicOtpFeed(100, getSelectedServerKey(ctx.from.id));

    let foundOtps = [];
    let detectedService = 'Manual Check';
    let detectedCountry = 'Global';

    if (Array.isArray(feed)) {
      foundOtps = feed.filter(item => Array.isArray(item) && cleanNumStr(item[1]) === inputNum);
      if (foundOtps.length > 0) {
        detectedService = foundOtps[0][0] || 'Manual Check';
        detectedCountry = foundOtps[0][4] || 'Global';
      }
    }

    stmtClearSession.run(ctx.from.id);

    let text = `🔍 <b>HASIL PEMERIKSAAN NOMOR</b>\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor:</b> <code>${formatPhoneNumber(inputNum)}</code>\n📡 <b>Status Release:</b> ${isReleasedSuccess ? '🟢 Siap Digunakan' : '🔴 Belum Siap'}\n\n`;

    if (foundOtps.length > 0) {
      text += `📬 <b>Ditemukan (${foundOtps.length}) Pesan SMS/OTP:</b>\n\n`;
      foundOtps.slice(0, 5).forEach((otp, idx) => {
        const formattedTime = formatApiTimestamp(otp[3]);
        text += `<b>${idx + 1}. ${otp[0]}</b> (<code>${formattedTime}</code>)\n└ 💬 <code>${otp[2]}</code>\n\n`;
      });
    } else {
      text += `📭 <i>Tidak ditemukan OTP aktif untuk nomor ini pada 100 log terbaru.</i>\n\n`;
    }

    const buttons = [];

    if (isReleasedSuccess) {
      text += `💡 <b>Opsi Tambah Nomor:</b>\nNomor ini valid! Anda dapat menyimpannya ke daftar nomor aktif agar sistem terus memantau SMS secara otomatis.`;
      buttons.push([Markup.button.callback('➕ Simpan ke Nomor Saya', `add_manual_${inputNum}_${detectedService}_${detectedCountry}`)]);
    }

    text += `\n━━━━━━━━━━━━━━━━━━━━\n🕒 <code>${getWibTimestamp()}</code>`;

    buttons.push([
      Markup.button.callback('🔍 Cek Nomor Lain', 'menu_manual_check'),
      Markup.button.callback('🏠 Menu Utama', 'menu_main')
    ]);

    await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
    return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }

  if (session.state === 'WAITING_USER_LIMIT') {
    const targetUserId = session.data;
    const newLimit = parseInt(ctx.message.text.trim(), 10);

    if (isNaN(newLimit) || newLimit < 1) {
      return ctx.reply('⚠️ Masukkan angka limit yang valid (minimal 1)!');
    }

    stmtUpdateUserLimit.run(newLimit, targetUserId);
    stmtClearSession.run(ctx.from.id);

    return ctx.reply(`✅ <b>Limit Berhasil Diperbarui!</b>\nUser ID: <code>${targetUserId}</code>\nLimit Baru: <b>${newLimit} Nomor</b>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('👑 Kembali ke Owner Panel', 'menu_owner')]])
    });
  }

  return next();
});

bot.action(/^add_manual_([0-9]+)_(.+)_(.+)$/, async (ctx) => {
  const cleanNum = cleanNumStr(ctx.match[1]);
  const serviceName = ctx.match[2];
  const countryName = ctx.match[3];
  const userId = ctx.from.id;

  const activeNums = stmtGetUserActiveNumbers.all(userId);
  const maxLimit = getUserMaxLimit(userId);

  if (activeNums.length >= maxLimit) {
    await safeAnswerCb(ctx, 'Batas slot nomor penuh!', { show_alert: true });
    return ctx.editMessageText(`⚠️ <b>BATAS MAKSIMAL SIMPAN NOMOR TERCAPAI!</b>\n━━━━━━━━━━━━━━━━━━━━\nSlot simpan nomor Anda: <b>${maxLimit} nomor</b>.\nLepas salah satu nomor aktif Anda terlebih dahulu.`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📱 Kelola Nomor Saya', 'menu_my_numbers')],
        [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
      ])
    }).catch(() => {});
  }

  stmtAddActiveNumber.run(userId, cleanNum, serviceName, countryName);
  await safeAnswerCb(ctx, 'Nomor berhasil disimpan!');

  const text = `✅ <b>NOMOR BERHASIL DITAMBAHKAN!</b>\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor Virtual:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n🔹 <b>Layanan:</b> <code>${serviceName}</code>\n🌍 <b>Negara:</b> <code>${countryName}</code>\n\n🕒 <b>Waktu:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n💡 <i>Sistem otomatis memantau dan mengirim SMS ke chat ini setiap kali OTP masuk.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📱 Buka Nomor Saya', 'menu_my_numbers')],
    [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
  ]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('menu_profile', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat Profil...');
  const dbUser = stmtGetUser.get(ctx.from.id);
  const phone = (dbUser && dbUser.phone_number) ? formatPhoneNumber(dbUser.phone_number) : 'Belum Verifikasi';
  const limit = getUserMaxLimit(ctx.from.id);
  const isOwner = (ctx.from.id === OWNER_ID);

  const text = `👤 <b>PROFIL PENGGUNA TERDAFTAR</b>\n━━━━━━━━━━━━━━━━━━━━\n🆔 <b>User ID:</b> <code>${ctx.from.id}</code>\n👤 <b>Nama:</b> <code>${ctx.from.first_name}</code>\n🏷️ <b>Username:</b> @${ctx.from.username || '-'}\n📱 <b>Kontak Resmi:</b> <code>${phone}</code>\n💎 <b>Status Akun:</b> <code>${isOwner ? 'Owner / Developer' : 'Member Pengguna'}</code>\n🔒 <b>Kapasitas Slot:</b> <code>${limit === Infinity ? 'Unlimited' : limit + ' Nomor'}</code>\n\n🕒 <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n<i>Data akun Anda tersinkronisasi aman dengan basis data server.</i>`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali ke Menu Utama', 'menu_main')]]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('menu_services', async (ctx) => {
  const selectedServerKey = getSelectedServerKey(ctx.from.id);
  const server = getServerByKey(selectedServerKey);

  await safeAnswerCb(ctx, 'Memuat daftar layanan...');
  const services = await ZelApiClient.getServices(selectedServerKey);

  if (!services || services.length === 0) {
    return ctx.editMessageText(`❌ <b>Layanan Server Tidak Bisa Diakses</b>\n━━━━━━━━━━━━━━━━━━━━\nEndpoint sedang tidak aktif atau kosong.\n\n🌐 <code>${server.baseUrl}</code>\n\n🕒 <code>${getWibTimestamp()}</code>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Pilih Server Lain', 'menu_server_select')],
        [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
      ])
    }).catch(() => {});
  }

  const buttons = services.slice(0, 10).map(item => [
    Markup.button.callback(`🔹 ${item.name} ── (${item.count} Stok)`, `svc_${selectedServerKey}_${item.name}`)
  ]);
  buttons.push([
    Markup.button.callback('🔙 Pilih Server Lain', 'menu_server_select'),
    Markup.button.callback('🏠 Menu Utama', 'menu_main')
  ]);

  const text = `🌐 <b>${server.name}</b>\n━━━━━━━━━━━━━━━━━━━━\nPilih layanan dari endpoint ini:`;

  return ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
});

bot.action(/^svc_(server[123])_(.+)$/, async (ctx) => {
  const serverKey = ctx.match[1];
  const serviceName = ctx.match[2];
  await safeAnswerCb(ctx, `Memuat negara ${serviceName}...`);

  const countries = await ZelApiClient.getCountries(serviceName, serverKey);

  if (!countries || countries.length === 0) {
    return ctx.editMessageText(`❌ <b>Stok Negara Kosong</b>\n━━━━━━━━━━━━━━━━━━━━\nSaat ini stok negara untuk layanan <b>${serviceName}</b> pada server <b>${getServerByKey(serverKey).name}</b> sedang habis.\n\n🕒 <code>${getWibTimestamp()}</code>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Pilih Layanan Lain', 'menu_services')],
        [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
      ])
    }).catch(() => {});
  }

  const buttons = countries.slice(0, 10).map(item => [
    Markup.button.callback(`🏳️ ${item.name} ── (${item.count} Stok)`, `req_${serverKey}_${serviceName}_${item.name}`)
  ]);

  buttons.push([
    Markup.button.callback('🔙 Pilih Layanan Lain', 'menu_services'),
    Markup.button.callback('🏠 Menu Utama', 'menu_main')
  ]);

  const text = `📦 <b>PILIH NEGARA ASAL NOMOR</b>\n━━━━━━━━━━━━━━━━━━━━\n📌 <b>Server:</b> <code>${getServerByKey(serverKey).name}</code>\n📌 <b>Layanan:</b> <code>${serviceName.toUpperCase()}</code>\nSilakan pilih negara asal nomor virtual:`;

  return ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
});

bot.action(/^req_(server[123])_(.+)_(.+)$/, async (ctx) => {
  const serverKey = ctx.match[1];
  const serviceName = ctx.match[2];
  const countryName = ctx.match[3];
  const userId = ctx.from.id;

  const activeNums = stmtGetUserActiveNumbers.all(userId);
  const maxLimit = getUserMaxLimit(userId);

  if (activeNums.length >= maxLimit) {
    await safeAnswerCb(ctx, 'Slot nomor Anda sudah penuh!', { show_alert: true });
    return ctx.editMessageText(`⚠️ <b>BATAS SIMPAN NOMOR TERCAPAI!</b>\n━━━━━━━━━━━━━━━━━━━━\nKapasitas akun Anda maksimal <b>${maxLimit} nomor</b>.\nSilakan lepas nomor lama Anda untuk memesan nomor baru.`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📱 Kelola Nomor Saya', 'menu_my_numbers')],
        [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
      ])
    }).catch(() => {});
  }

  await safeAnswerCb(ctx, 'Memesan nomor baru...');
  const res = await ZelApiClient.requestUniqueNumber(serviceName, countryName, userId, null, serverKey);

  if (res && res.success) {
    const rawNumber = res.number;
    const cleanNum = cleanNumStr(rawNumber);
    const formattedNum = formatPhoneNumber(cleanNum);
    const reqId = res.id || '-';

    stmtAddActiveNumber.run(ctx.from.id, cleanNum, serviceName, countryName);

    const text = `🎉 <b>NOMOR VIRTUAL BERHASIL DIPESAN!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔹 <b>Server:</b> <code>${getServerByKey(serverKey).name}</code>\n🔹 <b>Layanan:</b> <code>${serviceName}</code>\n🌍 <b>Negara:</b> <code>${countryName}</code>\n📱 <b>Nomor Virtual:</b> <code>${formattedNum}</code>\n🆔 <b>Order ID:</b> <code>${reqId}</code>\n\n🕒 <b>Waktu:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n💡 <b>Petunjuk:</b> Masukkan nomor ke aplikasi tujuan. Sistem akan otomatis mendeteksi dan mengirim SMS berulang selagi nomor belum dilepas.`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⚡ Cek OTP Manual', `otp_${cleanNum}_${serviceName}_${countryName}`)],
      [
        Markup.button.callback('🔄 Ganti Nomor', `change_${cleanNum}_${serviceName}_${countryName}`),
        Markup.button.callback('🗑️ Lepas Nomor', `rel_${cleanNum}_${serviceName}`)
      ],
      [
        Markup.button.callback('📜 Riwayat Nomor Ini', `history_num_${cleanNum}`),
        Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
      ],
      [
        Markup.button.callback('🌐 Layanan Lain', 'menu_services'),
        Markup.button.callback('🏠 Menu Utama', 'menu_main')
      ]
    ]);

    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  } else {
    const errorMsg = (res && res.error) ? res.error : 'Stok habis atau server mengalami gangguan.';
    const text = `❌ <b>GAGAL MEMESAN NOMOR!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔹 <b>Server:</b> <code>${getServerByKey(serverKey).name}</code>\n🔹 <b>Layanan:</b> <code>${serviceName}</code>\n🌍 <b>Negara:</b> <code>${countryName}</code>\n⚠️ <b>Alasan:</b> ${errorMsg}\n\n🕒 <code>${getWibTimestamp()}</code>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Pilih Negara Lain', `svc_${serverKey}_${serviceName}`)],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);

    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }
});

bot.action(/^change_(.+)_(.+)_(.+)$/, async (ctx) => {
  await safeAnswerCb(ctx, 'Melepas & mengambil nomor baru...');
  const oldRawNum = ctx.match[1];
  const oldCleanNum = cleanNumStr(oldRawNum);
  const serviceName = ctx.match[2];
  const countryName = ctx.match[3];
  const serverKey = getSelectedServerKey(ctx.from.id);

  await ZelApiClient.releaseNumber(oldCleanNum, serverKey);
  stmtReleaseActiveNumber.run(oldCleanNum, ctx.from.id);

  const res = await ZelApiClient.requestUniqueNumber(serviceName, countryName, ctx.from.id, oldCleanNum, serverKey);

  if (res && res.success) {
    const newRawNum = res.number;
    const newCleanNum = cleanNumStr(newRawNum);
    const formattedNum = formatPhoneNumber(newCleanNum);
    const reqId = res.id || '-';

    stmtAddActiveNumber.run(ctx.from.id, newCleanNum, serviceName, countryName);

    const text = `🔄 <b>NOMOR BERHASIL DIGANTI!</b>\n━━━━━━━━━━━━━━━━━━━━\n🔹 <b>Server:</b> <code>${getServerByKey(serverKey).name}</code>\n🔹 <b>Layanan:</b> <code>${serviceName}</code>\n🌍 <b>Negara:</b> <code>${countryName}</code>\n📱 <b>Nomor Baru:</b> <code>${formattedNum}</code>\n🗑️ <b>Nomor Lama Dilepas:</b> <code>${formatPhoneNumber(oldCleanNum)}</code>\n🆔 <b>Order ID:</b> <code>${reqId}</code>\n\n🕒 <b>Waktu:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n💡 <i>Sistem otomatis memantau nomor baru ini dan memastikan nomor berbeda dari nomor sebelumnya.</i>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('⚡ Cek OTP Manual', `otp_${newCleanNum}_${serviceName}_${countryName}`)],
      [
        Markup.button.callback('🔄 Ganti Lagi', `change_${newCleanNum}_${serviceName}_${countryName}`),
        Markup.button.callback('🗑️ Lepas Nomor', `rel_${newCleanNum}_${serviceName}`)
      ],
      [
        Markup.button.callback('📜 Riwayat Nomor Ini', `history_num_${newCleanNum}`),
        Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
      ],
      [
        Markup.button.callback('🌐 Layanan Lain', 'menu_services'),
        Markup.button.callback('🏠 Menu Utama', 'menu_main')
      ]
    ]);

    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  } else {
    const errorMsg = (res && res.error) ? res.error : 'Stok habis atau server gangguan.';
    const text = `⚠️ <b>PERHATIAN!</b>\n━━━━━━━━━━━━━━━━━━━━\nNomor lama <code>${formatPhoneNumber(oldCleanNum)}</code> berhasil dilepaskan, namun server gagal memberikan nomor pengganti baru.\n\n⚠️ <b>Keterangan:</b> ${errorMsg}\n🕒 <code>${getWibTimestamp()}</code>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🌐 Beli Layanan Lain', 'menu_services')],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);

    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }
});

bot.action(/^otp_([^_]+)(?:_(.+)_(.+))?$/, async (ctx) => {
  const rawNum = ctx.match[1];
  const cleanNum = cleanNumStr(rawNum);
  const serviceName = ctx.match[2] || 'Unknown';
  const countryName = ctx.match[3] || 'Unknown';
  const serverKey = getSelectedServerKey(ctx.from.id);

  await safeAnswerCb(ctx, 'Memeriksa SMS...');

  await ZelApiClient.releaseNumber(cleanNum, serverKey);
  const feed = await ZelApiClient.getPublicOtpFeed(100, serverKey);

  let otpFound = null;
  if (Array.isArray(feed)) {
    otpFound = feed.find(item => Array.isArray(item) && cleanNumStr(item[1]) === cleanNum);
  }

  let text = '';
  if (otpFound) {
    const msg = otpFound[2];
    const timestamp = otpFound[3];
    const formattedSmsTime = formatApiTimestamp(timestamp);
    const matchOtp = msg.match(/\b\d{3}[-\s]?\d{3,4}\b|\b\d{4,8}\b/);
    const extractedCode = matchOtp ? matchOtp[0] : 'LIHAT SMS';

    const existingOtp = stmtCheckOtpExists.get(cleanNum, msg, formattedSmsTime);
    if (!existingOtp) {
      stmtSaveOtpHistory.run(ctx.from.id, cleanNum, serviceName, extractedCode, msg, formattedSmsTime);
    }

    text = `📬 <b>SMS OTP DITEMUKAN!</b>\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor Virtual:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n🔑 <b>Kode OTP:</b> <code>${extractedCode}</code>\n\n💬 <b>Isi Pesan:</b>\n<blockquote>${msg}</blockquote>\n\n🕒 <b>Waktu SMS:</b> <code>${formattedSmsTime}</code>\n🕒 <b>Waktu Cek:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n<i>Kode SMS telah tersimpan di riwayat database Anda.</i>`;
  } else {
    text = `⏳ <b>MENUNGGU SMS MASUK...</b>\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor Virtual:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n📌 <b>Status:</b> Belum ada SMS baru di log publik.\n\n🕒 <b>Terakhir Cek:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n💡 <i>Sistem terus memantau otomatis. Klik 'Refresh' jika baru saja mengirim ulang kode.</i>`;
  }

  const changeBtnData = (serviceName !== 'Unknown' && countryName !== 'Unknown')
    ? `change_${cleanNum}_${serviceName}_${countryName}`
    : null;

  const row2 = [];
  if (changeBtnData) row2.push(Markup.button.callback('🔄 Ganti Nomor', changeBtnData));
  row2.push(Markup.button.callback('🗑️ Lepas Nomor', `rel_${cleanNum}_${serviceName}`));

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh Status OTP', ctx.match[0])],
    row2,
    [
      Markup.button.callback('📜 Riwayat Nomor Ini', `history_num_${cleanNum}`),
      Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
    ],
    [
      Markup.button.callback('🌐 Layanan Lain', 'menu_services'),
      Markup.button.callback('🏠 Menu Utama', 'menu_main')
    ]
  ]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action(/^rel_([^_]+)(?:_(.+))?$/, async (ctx) => {
  await safeAnswerCb(ctx, 'Melepaskan nomor...');
  const rawNum = ctx.match[1];
  const cleanNum = cleanNumStr(rawNum);
  const serviceName = ctx.match[2] || 'Layanan';
  const serverKey = getSelectedServerKey(ctx.from.id);

  await ZelApiClient.releaseNumber(cleanNum, serverKey);
  stmtReleaseActiveNumber.run(cleanNum, ctx.from.id);

  const text = `🗑️ <b>NOMOR BERHASIL DILEPASKAN!</b>\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor Virtual:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n🔹 <b>Layanan:</b> <code>${serviceName}</code>\n\n🕒 <b>Waktu:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n<i>Nomor ini telah resmi dikembalikan dan tidak lagi aktif dalam antrean pemantauan Anda.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📱 Kelola Nomor Aktif', 'menu_my_numbers')],
    [Markup.button.callback('🌐 Beli Nomor Baru', 'menu_services')],
    [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
  ]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('menu_my_numbers', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat nomor aktif...');
  const activeDbNumbers = stmtGetUserActiveNumbers.all(ctx.from.id);

  if (!activeDbNumbers || activeDbNumbers.length === 0) {
    const text = `📭 <b>TIDAK ADA NOMOR AKTIF</b>\n━━━━━━━━━━━━━━━━━━━━\nSaat ini Anda belum memiliki nomor virtual yang sedang disewa.\n\n🕒 <code>${getWibTimestamp()}</code>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🌐 Beli / Sewa Nomor Baru', 'menu_server_select')],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }

  const limit = getUserMaxLimit(ctx.from.id);
  const limitStr = limit === Infinity ? 'Unlimited' : `${limit} Slot`;

  const text = `📱 <b>DAFTAR NOMOR VIRTUAL ANDA (${activeDbNumbers.length} / ${limitStr})</b>\n━━━━━━━━━━━━━━━━━━━━\nKlik pada tombol nomor di bawah untuk cek SMS, ganti nomor, atau melepaskan sewa:\n\n🕒 <code>${getWibTimestamp()}</code>`;

  const buttons = activeDbNumbers.map(item => [
    Markup.button.callback(`📱 ${formatPhoneNumber(item.number)} ── [${item.service}]`, `otp_${item.number}_${item.service}_${item.country}`)
  ]);

  buttons.push([
    Markup.button.callback('📜 Riwayat OTP Global', 'menu_history_global'),
    Markup.button.callback('🌐 Beli Nomor Lagi', 'menu_server_select')
  ]);
  buttons.push([Markup.button.callback('🏠 Menu Utama', 'menu_main')]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
});

bot.action(/^menu_history_global(?:_(\d+))?$/, async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat riwayat global...');
  const page = parseInt(ctx.match[1] || '1', 10);
  const history = stmtGetUserGlobalOtpHistory.all(ctx.from.id);

  if (!history || history.length === 0) {
    const text = `📜 <b>RIWAYAT OTP MASIH KOSONG</b>\n━━━━━━━━━━━━━━━━━━━━\nBelum ada catatan kode OTP yang diterima oleh akun Anda dari nomor manapun.\n\n🕒 <code>${getWibTimestamp()}</code>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📱 Buka Nomor Saya', 'menu_my_numbers')],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }

  const perPage = 20;
  const totalPages = Math.ceil(history.length / perPage) || 1;
  const sliceHistory = history.slice((page - 1) * perPage, page * perPage);

  let text = `📜 <b>RIWAYAT SMS & OTP GLOBAL (Halaman ${page}/${totalPages})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  sliceHistory.forEach((item, index) => {
    const actualIndex = ((page - 1) * perPage) + index + 1;
    text += `<b>${actualIndex}. ${item.service}</b> ── <code>${formatPhoneNumber(item.number)}</code>\n├ 🔑 <b>OTP:</b> <code>${item.otp_code}</code>\n├ 💬 <code>${item.full_text}</code>\n└ 🕒 <code>${item.sms_timestamp || item.created_at}</code>\n\n`;
  });
  text += `━━━━━━━━━━━━━━━━━━━━\n🕒 <code>${getWibTimestamp()}</code>`;

  const buttons = [];
  const navRow = [];
  if (page > 1) navRow.push(Markup.button.callback('◀️ Sebelumnya', `menu_history_global_${page - 1}`));
  if (page < totalPages) navRow.push(Markup.button.callback('Selanjutnya ▶️', `menu_history_global_${page + 1}`));
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers'), Markup.button.callback('🌐 Layanan', 'menu_server_select')]);
  buttons.push([Markup.button.callback('🏠 Menu Utama', 'menu_main')]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
});

bot.action(/^history_num_([0-9]+)(?:_(\d+))?$/, async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat riwayat nomor...');
  const cleanNum = cleanNumStr(ctx.match[1]);
  const page = parseInt(ctx.match[2] || '1', 10);
  const history = stmtGetUserNumberOtpHistory.all(ctx.from.id, cleanNum);

  if (!history || history.length === 0) {
    const text = `📜 <b>RIWAYAT OTP NOMOR: <code>${formatPhoneNumber(cleanNum)}</code></b>\n━━━━━━━━━━━━━━━━━━━━\nBelum ada catatan kode OTP yang diterima oleh nomor ini.\n\n🕒 <code>${getWibTimestamp()}</code>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Kembali ke Nomor Saya', 'menu_my_numbers')],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }

  const perPage = 20;
  const totalPages = Math.ceil(history.length / perPage) || 1;
  const sliceHistory = history.slice((page - 1) * perPage, page * perPage);

  let text = `📜 <b>RIWAYAT OTP: <code>${formatPhoneNumber(cleanNum)}</code> (${page}/${totalPages})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  sliceHistory.forEach((item, index) => {
    const actualIndex = ((page - 1) * perPage) + index + 1;
    text += `<b>${actualIndex}. ${item.service}</b>\n├ 🔑 <b>OTP:</b> <code>${item.otp_code}</code>\n├ 💬 <code>${item.full_text}</code>\n└ 🕒 <code>${item.sms_timestamp || item.created_at}</code>\n\n`;
  });
  text += `━━━━━━━━━━━━━━━━━━━━\n🕒 <code>${getWibTimestamp()}</code>`;

  const buttons = [];
  const navRow = [];
  if (page > 1) navRow.push(Markup.button.callback('◀️ Sebelumnya', `history_num_${cleanNum}_${page - 1}`));
  if (page < totalPages) navRow.push(Markup.button.callback('Selanjutnya ▶️', `history_num_${cleanNum}_${page + 1}`));
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([Markup.button.callback('🔙 Kembali ke Nomor Saya', 'menu_my_numbers')]);
  buttons.push([Markup.button.callback('🏠 Menu Utama', 'menu_main')]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
});

bot.action('menu_stats', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat Statistik...');
  const serverKey = getSelectedServerKey(ctx.from.id);
  const stats = await ZelApiClient.getStats(serverKey);

  let text = '';
  if (stats) {
    text = `📊 <b>STATISTIK & KONDISI SERVER HARIAN</b>\n━━━━━━━━━━━━━━━━━━━━\n📌 <b>Server:</b> <code>${getServerByKey(serverKey).name}</code>\n📩 <b>Total Sukses OTP:</b> <code>${stats.otp_count || 0}</code>\n🌍 <b>Negara Tersedia:</b> <code>${stats.countries_count || 0}</code>\n🌐 <b>Layanan Aktif:</b> <code>${stats.services_count || 0}</code>\n📱 <b>Total Stok Tersedia:</b> <code>${stats.available_numbers || 0}</code>\n\n🕒 <b>Update:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━━\n<i>Data metrik disinkronkan langsung dari server pusat ZELAPI.</i>`;
  } else {
    text = `❌ <b>GAGAL MEMUAT STATISTIK</b>\n━━━━━━━━━━━━━━━━━━━━\nServer sedang lambat merespons permintaan metrik.\n\n🕒 <code>${getWibTimestamp()}</code>`;
  }

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali ke Menu Utama', 'menu_main')]]);
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('menu_owner', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;
  await safeAnswerCb(ctx);

  const text = `👑 <b>PANEL KONTROL OWNER</b>\n━━━━━━━━━━━━━━━━━━━━\nSilakan pilih menu manajemen pengguna di bawah:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('👥 Daftar & Manajemen User', 'owner_users_1')],
    [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
  ]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action(/^owner_users_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;
  await safeAnswerCb(ctx);

  const page = parseInt(ctx.match[1], 10);
  const users = stmtGetAllUsers.all();
  const perPage = 5;
  const totalPages = Math.ceil(users.length / perPage) || 1;
  const sliceUsers = users.slice((page - 1) * perPage, page * perPage);

  let text = `👥 <b>DAFTAR PENGGUNA TERDAFTAR (${page}/${totalPages})</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  const buttons = [];

  sliceUsers.forEach(u => {
    const status = u.is_suspended ? '🔴 Ditangguhkan' : '🟢 Aktif';
    const limit = u.user_id === OWNER_ID ? '∞' : (u.custom_limit ?? DEFAULT_LIMIT);
    text += `👤 <b>${u.first_name}</b> (<code>${u.user_id}</code>)\n├ Status: ${status}\n└ Limit: ${limit} Nomor\n\n`;

    buttons.push([Markup.button.callback(`⚙️ Atur User: ${u.first_name}`, `owner_manage_${u.user_id}`)]);
  });

  const navRow = [];
  if (page > 1) navRow.push(Markup.button.callback('◀️ Prev', `owner_users_${page - 1}`));
  if (page < totalPages) navRow.push(Markup.button.callback('Next ▶️', `owner_users_${page + 1}`));
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([Markup.button.callback('🔙 Kembali ke Panel Owner', 'menu_owner')]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
});

bot.action(/^owner_manage_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;
  await safeAnswerCb(ctx);

  const targetUserId = parseInt(ctx.match[1], 10);
  const targetUser = stmtGetUser.get(targetUserId);

  if (!targetUser) return ctx.reply('User tidak ditemukan.');

  const text = `⚙️ <b>PENGATURAN USER: ${targetUser.first_name}</b>\n━━━━━━━━━━━━━━━━━━━━\n🆔 <b>User ID:</b> <code>${targetUser.user_id}</code>\n📌 <b>Status:</b> ${targetUser.is_suspended ? '🔴 Ditangguhkan' : '🟢 Aktif'}\n🔒 <b>Limit Khusus:</b> <code>${targetUser.custom_limit ?? 'Default (' + DEFAULT_LIMIT + ')'}</code>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(targetUser.is_suspended ? '🟢 Aktifkan Akun' : '🔴 Tangguhkan (Suspend)', `owner_toggle_suspend_${targetUserId}`),
      Markup.button.callback('✏️ Set Limit Slot', `owner_set_limit_${targetUserId}`)
    ],
    [Markup.button.callback('🔙 Kembali ke Daftar User', 'owner_users_1')]
  ]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action(/^owner_toggle_suspend_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;
  const targetUserId = parseInt(ctx.match[1], 10);
  const targetUser = stmtGetUser.get(targetUserId);

  if (targetUser) {
    const newStatus = targetUser.is_suspended ? 0 : 1;
    stmtUpdateUserSuspend.run(newStatus, targetUserId);
    await safeAnswerCb(ctx, `Status berhasil diperbarui!`);
  }

  return ctx.telegram.editMessageText(
    ctx.chat.id,
    ctx.callbackQuery.message.message_id,
    null,
    `✅ Status suspend ID <code>${targetUserId}</code> berhasil diperbarui.`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Kembali', `owner_manage_${targetUserId}`)]]) }
  );
});

bot.action(/^owner_set_limit_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return;
  await safeAnswerCb(ctx);

  const targetUserId = parseInt(ctx.match[1], 10);
  stmtSetSession.run(ctx.from.id, 'WAITING_USER_LIMIT', String(targetUserId));

  const text = `✏️ <b>ATUR LIMIT SLOT NOMOR</b>\n━━━━━━━━━━━━━━━━━━━━\nKirimkan angka jumlah maksimal nomor yang boleh disimpan oleh User ID <code>${targetUserId}</code>:`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Batal', `owner_manage_${targetUserId}`)]]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.catch((err, ctx) => {
  console.error(`Telegram Handler Error for ${ctx.updateType}:`, err.message);
});

bot.launch().then(() => {
  console.log(`Bot ${BOT_NAME} Telegraf sedang berjalan...`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
