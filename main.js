require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const Database = require('better-sqlite3');

const TOKEN = process.env.BOT_TOKEN;
const ZELAPI_BASE_URL = 'https://smsku.zelapi.eu.cc';

if (!TOKEN) {
  console.error('ERROR: BOT_TOKEN tidak ditemukan di file .env');
  process.exit(1);
}

const bot = new Telegraf(TOKEN);
const db = new Database('zelapi_bot.db');
const activePolling = new Map();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    phone_number TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS user_sessions (
    user_id INTEGER PRIMARY KEY,
    state TEXT
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const stmtGetUser = db.prepare('SELECT * FROM users WHERE user_id = ?');
const stmtUpsertUser = db.prepare(`
  INSERT INTO users (user_id, username, first_name, phone_number)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    phone_number = COALESCE(excluded.phone_number, users.phone_number)
`);

const stmtGetSession = db.prepare('SELECT state FROM user_sessions WHERE user_id = ?');
const stmtSetSession = db.prepare(`
  INSERT INTO user_sessions (user_id, state)
  VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET state = excluded.state
`);
const stmtClearSession = db.prepare('DELETE FROM user_sessions WHERE user_id = ?');

const stmtAddActiveNumber = db.prepare(`
  INSERT INTO active_numbers (user_id, number, service, country, status)
  VALUES (?, ?, ?, ?, 'active')
  ON CONFLICT(number) DO UPDATE SET status = 'active', user_id = excluded.user_id
`);

const stmtReleaseActiveNumber = db.prepare(`
  UPDATE active_numbers SET status = 'released' WHERE number = ? AND user_id = ?
`);

const stmtGetUserActiveNumbers = db.prepare(`
  SELECT * FROM active_numbers WHERE user_id = ? AND status = 'active' ORDER BY id DESC
`);

const stmtSaveOtpHistory = db.prepare(`
  INSERT INTO otp_history (user_id, number, service, otp_code)
  VALUES (?, ?, ?, ?)
`);

const stmtGetUserOtpHistory = db.prepare(`
  SELECT * FROM otp_history WHERE user_id = ? ORDER BY id DESC LIMIT 15
`);

async function safeAnswerCb(ctx, text = '', options = {}) {
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(text, options);
    }
  } catch (err) {
  }
}

function getWibTimestamp() {
  const options = {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  const formatter = new Intl.DateTimeFormat('id-ID', options);
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.hour}:${parts.minute}:${parts.second} WIB - ${parts.day}/${parts.month}/${parts.year}`;
}

function formatPhoneNumber(rawNumber) {
  if (!rawNumber) return '-';
  let cleaned = String(rawNumber).replace(/\D/g, '');
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  
  if (cleaned.startsWith('+62')) {
    return cleaned.replace(/^(\+62)(\d{3})(\d{4})(\d{3,4})$/, '$1 $2-$3-$4');
  } else if (cleaned.startsWith('+1')) {
    return cleaned.replace(/^(\+1)(\d{3})(\d{3})(\d{4})$/, '$1 ($2) $3-$4');
  } else if (cleaned.length > 10) {
    return cleaned.replace(/^(\+\d{1,3})(\d{3,4})(\d{4,8})$/, '$1 $2-$3');
  }
  return cleaned;
}

class ZelApiClient {
  static async getServices() {
    try {
      const res = await axios.get(`${ZELAPI_BASE_URL}/api/services`, { timeout: 10000 });
      return (res.status === 200 && res.data && res.data.success) ? res.data.services : null;
    } catch {
      return null;
    }
  }

  static async getCountries(service) {
    try {
      const res = await axios.get(`${ZELAPI_BASE_URL}/api/countries`, {
        params: { service },
        timeout: 10000
      });
      return (res.status === 200 && res.data && res.data.success) ? res.data.countries : null;
    } catch {
      return null;
    }
  }

  static async requestNumber(service, country) {
    try {
      const payload = { service, country };
      const res = await axios.post(`${ZELAPI_BASE_URL}/api/request_number`, payload, { timeout: 10000 });
      return (res.status === 200 || res.status === 201) ? res.data : null;
    } catch {
      return null;
    }
  }

  static async releaseNumber(number) {
    try {
      const cleanNum = String(number).replace(/\D/g, '');
      const res = await axios.post(`${ZELAPI_BASE_URL}/api/release_number`, { number: cleanNum }, { timeout: 10000 });
      if (activePolling.has(cleanNum)) {
        clearInterval(activePolling.get(cleanNum));
        activePolling.delete(cleanNum);
      }
      return (res.status === 200 && res.data && res.data.success) ? res.data : null;
    } catch {
      return null;
    }
  }

  static async getLatestOtp(number) {
    try {
      const cleanNum = String(number).replace(/\D/g, '');
      const res = await axios.get(`${ZELAPI_BASE_URL}/api/latest_otp`, {
        params: { number: cleanNum },
        timeout: 10000
      });
      return res.status === 200 ? res.data : null;
    } catch {
      return null;
    }
  }

  static async getStats() {
    try {
      const res = await axios.get(`${ZELAPI_BASE_URL}/api/stats/detailed`, {
        params: { period: 'daily' },
        timeout: 10000
      });
      return res.status === 200 ? res.data : null;
    } catch {
      return null;
    }
  }
}

function startOtpPolling(chatId, userId, number, serviceName, countryName) {
  const cleanNum = String(number).replace(/\D/g, '');
  if (activePolling.has(cleanNum)) return;

  let attempts = 0;
  const maxAttempts = 60;

  const interval = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(interval);
      activePolling.delete(cleanNum);
      return;
    }

    try {
      const res = await ZelApiClient.getLatestOtp(cleanNum);
      if (res && res.success && res.has_otp) {
        clearInterval(interval);
        activePolling.delete(cleanNum);

        stmtSaveOtpHistory.run(userId, cleanNum, serviceName, res.otp_code);

        const text = `📩 <b>OTP OTOMATIS DITERIMA!</b>\n━━━━━━━━━━━━━━━━━━━\n<b>Layanan:</b> ${serviceName}\n<b>Negara:</b> ${countryName}\n<b>Nomor Virtual:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n<b>Kode OTP:</b> <code>${res.otp_code}</code>\n\n🕒 <b>Waktu Masuk:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\n<i>OTP berhasil tersimpan di riwayat. Nomor ini siap digunakan atau dilepaskan.</i>`;
        
        const keyboard = Markup.inlineKeyboard([
          [
            Markup.button.callback('🔄 Ganti Lagi', `change_${cleanNum}_${serviceName}_${countryName}`),
            Markup.button.callback('❌ Lepas Nomor', `rel_${cleanNum}_${serviceName}`)
          ],
          [
            Markup.button.callback('📜 Riwayat OTP', 'menu_history'),
            Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
          ],
          [
            Markup.button.callback('🌐 Kembali ke Service', 'menu_services'),
            Markup.button.callback('🏠 Menu Utama', 'menu_main')
          ]
        ]);

        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });
      }
    } catch (err) {
    }
  }, 5000);

  activePolling.set(cleanNum, interval);
}

function getMainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🌐 Layanan Tersedia', 'menu_services'),
      Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
    ],
    [
      Markup.button.callback('📜 Riwayat OTP', 'menu_history'),
      Markup.button.callback('📊 Statistik API', 'menu_stats')
    ],
    [
      Markup.button.callback('👤 Profil Kontak', 'menu_profile')
    ]
  ]);
}

function getContactReplyKeyboard() {
  return Markup.keyboard([
    [Markup.button.contactRequest('📱 Bagikan Kontak Saya')]
  ]).resize().oneTime();
}

async function sendMainMenu(ctx) {
  const text = `📱 <b>ZELAPI VIRTUAL NUMBER DASHBOARD</b>\n━━━━━━━━━━━━━━━━━━━\nHalo <b>${ctx.from.first_name}</b>, selamat datang di layanan OTP otomatis ZELAPI.\n\n🌐 <b>Status Server:</b> Active & Normal\n🕒 <b>Waktu Sistem:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\nSilakan pilih menu interaktif di bawah ini untuk mengelola nomor virtual, melihat layanan, atau memeriksa status nomor aktif Anda.`;
  
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...getMainMenuKeyboard() });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...getMainMenuKeyboard() });
    }
  } catch (err) {
  }
}

bot.start(async (ctx) => {
  const user = ctx.from;
  stmtUpsertUser.run(user.id, user.username || null, user.first_name, null);

  const dbUser = stmtGetUser.get(user.id);

  if (!dbUser || !dbUser.phone_number) {
    stmtSetSession.run(user.id, 'WAITING_CONTACT');
    const text = `👋 <b>Selamat datang, ${user.first_name}!</b>\n━━━━━━━━━━━━━━━━━━━\nUntuk dapat mengakses seluruh fungsi dari <b>ZELAPI OTP Bot</b>, Anda diwajibkan melakukan pendaftaran kontak Telegram terlebih dahulu.\n\n🕒 <b>Waktu Akses:</b> <code>${getWibTimestamp()}</code>\n\n👇 <i>Silakan tekan tombol di bawah untuk membagikan nomor kontak Anda.</i>`;
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
      return ctx.reply('⚠️ <b>Verifikasi Gagal!</b> Kontak yang dikirim tidak sesuai dengan ID Telegram Anda. Silakan tekan tombol resmi di bawah.', {
        parse_mode: 'HTML',
        ...getContactReplyKeyboard()
      });
    }

    stmtUpsertUser.run(ctx.from.id, ctx.from.username || null, ctx.from.first_name, contact.phone_number);
    stmtClearSession.run(ctx.from.id);

    await ctx.reply(`✅ <b>Verifikasi Kontak Berhasil!</b>\n━━━━━━━━━━━━━━━━━━━\n<b>Nomor Terdaftar:</b> <code>${formatPhoneNumber(contact.phone_number)}</code>\n🕒 <b>Waktu Verifikasi:</b> <code>${getWibTimestamp()}</code>\n\nData Anda telah tersimpan di database internal secara aman.`, {
      parse_mode: 'HTML',
      ...Markup.removeKeyboard()
    });

    return sendMainMenu(ctx);
  }
});

bot.action('menu_main', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat Menu Utama...');
  return sendMainMenu(ctx);
});

bot.action('menu_profile', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat Profil...');
  const dbUser = stmtGetUser.get(ctx.from.id);
  const phone = (dbUser && dbUser.phone_number) ? formatPhoneNumber(dbUser.phone_number) : 'Belum Terverifikasi';

  const text = `👤 <b>PROFIL PENGGUNA TERDAFTAR</b>\n━━━━━━━━━━━━━━━━━━━\n🆔 <b>User ID:</b> <code>${ctx.from.id}</code>\n👤 <b>Nama:</b> ${ctx.from.first_name}\n🏷️ <b>Username:</b> @${ctx.from.username || '-'}\n📱 <b>Nomor Kontak:</b> <code>${phone}</code>\n\n🕒 <b>Waktu Cek:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\n<i>Informasi di atas diambil dari basis data terverifikasi bot ZELAPI.</i>`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Utama', 'menu_main')]]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('menu_services', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat daftar layanan...');
  const services = await ZelApiClient.getServices();

  if (!services || services.length === 0) {
    return ctx.editMessageText(`❌ <b>Layanan Tidak Tersedia</b>\n━━━━━━━━━━━━━━━━━━━\nSaat ini penyedia API tidak memiliki daftar layanan yang aktif atau koneksi sedang terganggu.\n\n🕒 <b>Waktu:</b> <code>${getWibTimestamp()}</code>`, Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]), { parse_mode: 'HTML' }).catch(() => {});
  }

  const buttons = services.slice(0, 10).map(item => [
    Markup.button.callback(`${item.name} (${item.count} Stok)`, `svc_${item.name}`)
  ]);
  buttons.push([Markup.button.callback('🏠 Menu Utama', 'menu_main')]);

  const text = `🌐 <b>DAFTAR LAYANAN VIRTUAL NUMBER</b>\n━━━━━━━━━━━━━━━━━━━\nSilakan pilih salah satu platform/layanan di bawah untuk melihat ketersediaan stok negara.\n\n🕒 <b>Waktu Pembaruan:</b> <code>${getWibTimestamp()}</code>`;

  return ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons)
  }).catch(() => {});
});

bot.action(/^svc_(.+)$/, async (ctx) => {
  const serviceName = ctx.match[1];
  await safeAnswerCb(ctx, `Memuat negara untuk ${serviceName}...`);
  const countries = await ZelApiClient.getCountries(serviceName);

  if (!countries || countries.length === 0) {
    return ctx.editMessageText(`❌ <b>Negara Tidak Tersedia</b>\n━━━━━━━━━━━━━━━━━━━\nStok negara untuk platform <b>${serviceName}</b> sedang kosong.\n\n🕒 <b>Waktu Cek:</b> <code>${getWibTimestamp()}</code>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🌐 Kembali ke Service', 'menu_services')]])
    }).catch(() => {});
  }

  const buttons = countries.slice(0, 10).map(item => [
    Markup.button.callback(`🏳️ ${item.name} (${item.count} Stok)`, `req_${serviceName}_${item.name}`)
  ]);
  buttons.push([Markup.button.callback('🌐 Kembali ke Service', 'menu_services')]);

  const text = `📦 <b>PILIH NEGARA TUK LAYANAN: ${serviceName.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━\nPilih negara asal nomor virtual yang ingin Anda sewa dari daftar ketersediaan di bawah ini.\n\n🕒 <b>Waktu Pembaruan:</b> <code>${getWibTimestamp()}</code>`;
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
});

bot.action(/^req_(.+)_(.+)$/, async (ctx) => {
  const serviceName = ctx.match[1];
  const countryName = ctx.match[2];
  await safeAnswerCb(ctx, 'Memesan nomor virtual...');
  
  const res = await ZelApiClient.requestNumber(serviceName, countryName);

  if (res && res.success) {
    const rawNumber = res.number;
    const cleanNum = String(rawNumber).replace(/\D/g, '');
    const formattedNum = formatPhoneNumber(cleanNum);
    const reqId = res.id || '-';
    
    stmtAddActiveNumber.run(ctx.from.id, cleanNum, serviceName, countryName);
    startOtpPolling(ctx.chat.id, ctx.from.id, cleanNum, serviceName, countryName);

    const text = `✅ <b>NOMOR VIRTUAL BERHASIL DIPESAN!</b>\n━━━━━━━━━━━━━━━━━━━\n📌 <b>Layanan:</b> ${serviceName}\n🏳️ <b>Negara:</b> ${countryName}\n📱 <b>Nomor Virtual:</b> <code>${formattedNum}</code>\n🆔 <b>ID Transaksi:</b> <code>${reqId}</code>\n\n🕒 <b>Waktu Order:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\n💡 <b>Petunjuk:</b> Masukkan nomor di atas ke aplikasi target. Sistem polling otomatis telah diaktifkan dan akan memberi notifikasi saat SMS/OTP tiba.`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📩 Cek OTP Manual', `otp_${cleanNum}_${serviceName}_${countryName}`)],
      [
        Markup.button.callback('🔄 Ganti Lagi', `change_${cleanNum}_${serviceName}_${countryName}`),
        Markup.button.callback('❌ Lepas Nomor', `rel_${cleanNum}_${serviceName}`)
      ],
      [
        Markup.button.callback('📜 Riwayat OTP', 'menu_history'),
        Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
      ],
      [
        Markup.button.callback('🌐 Kembali ke Service', 'menu_services'),
        Markup.button.callback('🏠 Menu Utama', 'menu_main')
      ]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  } else {
    const errorMsg = (res && res.error) ? res.error : 'Stok habis atau server mengalami gangguan.';
    const text = `❌ <b>GAGAL MEMESAN NOMOR!</b>\n━━━━━━━━━━━━━━━━━━━\n📌 <b>Layanan:</b> ${serviceName}\n🏳️ <b>Negara:</b> ${countryName}\n⚠️ <b>Penyebab:</b> ${errorMsg}\n\n🕒 <b>Waktu Error:</b> <code>${getWibTimestamp()}</code>`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🌐 Kembali ke Service', 'menu_services')],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }
});

bot.action(/^change_(.+)_(.+)_(.+)$/, async (ctx) => {
  await safeAnswerCb(ctx, 'Sedang melepaskan nomor & meminta pengganti...');
  const oldRawNum = ctx.match[1];
  const oldCleanNum = String(oldRawNum).replace(/\D/g, '');
  const serviceName = ctx.match[2];
  const countryName = ctx.match[3];

  await ZelApiClient.releaseNumber(oldCleanNum);
  stmtReleaseActiveNumber.run(oldCleanNum, ctx.from.id);

  const res = await ZelApiClient.requestNumber(serviceName, countryName);

  if (res && res.success) {
    const newRawNum = res.number;
    const newCleanNum = String(newRawNum).replace(/\D/g, '');
    const formattedNum = formatPhoneNumber(newCleanNum);
    const reqId = res.id || '-';

    stmtAddActiveNumber.run(ctx.from.id, newCleanNum, serviceName, countryName);
    startOtpPolling(ctx.chat.id, ctx.from.id, newCleanNum, serviceName, countryName);

    const text = `🔄 <b>BERHASIL GANTI NOMOR!</b>\n━━━━━━━━━━━━━━━━━━━\n📌 <b>Layanan:</b> ${serviceName}\n🏳️ <b>Negara:</b> ${countryName}\n📱 <b>Nomor Baru:</b> <code>${formattedNum}</code>\n🗑️ <b>Nomor Dilepas:</b> <code>${formatPhoneNumber(oldCleanNum)}</code>\n🆔 <b>ID Transaksi:</b> <code>${reqId}</code>\n\n🕒 <b>Waktu Penggantian:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\n💡 <i>Sistem otomatis memperbarui pemantauan OTP untuk nomor baru ini.</i>`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📩 Cek OTP Manual', `otp_${newCleanNum}_${serviceName}_${countryName}`)],
      [
        Markup.button.callback('🔄 Ganti Lagi', `change_${newCleanNum}_${serviceName}_${countryName}`),
        Markup.button.callback('❌ Lepas Nomor', `rel_${newCleanNum}_${serviceName}`)
      ],
      [
        Markup.button.callback('📜 Riwayat OTP', 'menu_history'),
        Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
      ],
      [
        Markup.button.callback('🌐 Kembali ke Service', 'menu_services'),
        Markup.button.callback('🏠 Menu Utama', 'menu_main')
      ]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  } else {
    const errorMsg = (res && res.error) ? res.error : 'Stok habis atau server gangguan.';
    const text = `⚠️ <b>PERHATIAN!</b>\n━━━━━━━━━━━━━━━━━━━\nNomor lama <code>${formatPhoneNumber(oldCleanNum)}</code> telah dilepaskan dari akun Anda, tetapi sistem <b>gagal mendapatkan nomor pengganti</b>.\n\n⚠️ <b>Detail Alasan:</b> ${errorMsg}\n🕒 <b>Waktu Kejadian:</b> <code>${getWibTimestamp()}</code>`;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🌐 Kembali ke Service', 'menu_services')],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }
});

bot.action(/^otp_([^_]+)(?:_(.+)_(.+))?$/, async (ctx) => {
  const rawNum = ctx.match[1];
  const cleanNum = String(rawNum).replace(/\D/g, '');
  const serviceName = ctx.match[2] || 'Unknown';
  const countryName = ctx.match[3] || 'Unknown';

  await safeAnswerCb(ctx, 'Memeriksa OTP...');
  const otpRes = await ZelApiClient.getLatestOtp(cleanNum);

  let text = '';
  if (otpRes && otpRes.success && otpRes.has_otp) {
    stmtSaveOtpHistory.run(ctx.from.id, cleanNum, serviceName, otpRes.otp_code);

    text = `📩 <b>OTP MANUALLY DETECTED!</b>\n━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor Virtual:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n🔑 <b>Kode OTP:</b> <code>${otpRes.otp_code}</code>\n\n🕒 <b>Waktu Pengecekan:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\n<i>Kode SMS telah diterima dan disimpan di riwayat Anda.</i>`;
  } else {
    text = `⏳ <b>MENUNGGU SMS / OTP...</b>\n━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor Virtual:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n📌 <b>Status:</b> Belum Ada OTP Masuk\n\n🕒 <b>Pengecekan Terakhir:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\n💡 <i>Sistem akan terus memantau melalui polling otomatis di latar belakang. Tekan 'Cek OTP Manual' jika ingin memperbarui tampilan ini secara langsung.</i>`;
  }

  const changeBtnData = (serviceName !== 'Unknown' && countryName !== 'Unknown')
    ? `change_${cleanNum}_${serviceName}_${countryName}`
    : null;

  const row2 = [];
  if (changeBtnData) row2.push(Markup.button.callback('🔄 Ganti Lagi', changeBtnData));
  row2.push(Markup.button.callback('❌ Lepas Nomor', `rel_${cleanNum}_${serviceName}`));

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh Status OTP', ctx.match[0])],
    row2,
    [
      Markup.button.callback('📜 Riwayat OTP', 'menu_history'),
      Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')
    ],
    [
      Markup.button.callback('🌐 Kembali ke Service', 'menu_services'),
      Markup.button.callback('🏠 Menu Utama', 'menu_main')
    ]
  ]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action(/^rel_([^_]+)(?:_(.+))?$/, async (ctx) => {
  await safeAnswerCb(ctx, 'Melepaskan nomor...');
  const rawNum = ctx.match[1];
  const cleanNum = String(rawNum).replace(/\D/g, '');
  const serviceName = ctx.match[2] || 'Layanan';

  await ZelApiClient.releaseNumber(cleanNum);
  stmtReleaseActiveNumber.run(cleanNum, ctx.from.id);

  const text = `🗑️ <b>NOMOR BERHASIL DILEPASKAN!</b>\n━━━━━━━━━━━━━━━━━━━\n📱 <b>Nomor Virtual:</b> <code>${formatPhoneNumber(cleanNum)}</code>\n📌 <b>Layanan Terkait:</b> ${serviceName}\n\n🕒 <b>Waktu Pelepasan:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\n<i>Nomor ini telah resmi dikembalikan dan tidak lagi aktif dalam sistem Anda.</i>`;
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📜 Riwayat OTP', 'menu_history')],
    [Markup.button.callback('🌐 Kembali ke Service', 'menu_services')],
    [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
  ]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('menu_my_numbers', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat nomor aktif...');
  const activeDbNumbers = stmtGetUserActiveNumbers.all(ctx.from.id);

  if (!activeDbNumbers || activeDbNumbers.length === 0) {
    const text = `📭 <b>TIDAK ADA NOMOR AKTIF</b>\n━━━━━━━━━━━━━━━━━━━\nAnda saat ini tidak memiliki sewaan nomor virtual yang sedang berjalan.\n\n🕒 <b>Waktu Cek:</b> <code>${getWibTimestamp()}</code>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🌐 Pilih Layanan', 'menu_services')],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }

  const text = `📱 <b>DAFTAR NOMOR AKTIF ANDA (${activeDbNumbers.length})</b>\n━━━━━━━━━━━━━━━━━━━\nKlik pada tombol nomor di bawah untuk mengecek SMS/OTP, memperbarui status, atau melepaskan nomor.\n\n🕒 <b>Waktu Cek:</b> <code>${getWibTimestamp()}</code>`;
  
  const buttons = activeDbNumbers.map(item => [
    Markup.button.callback(`📱 ${formatPhoneNumber(item.number)} (${item.service})`, `otp_${item.number}_${item.service}_${item.country}`)
  ]);
  
  buttons.push([
    Markup.button.callback('📜 Riwayat OTP', 'menu_history'),
    Markup.button.callback('🌐 Kembali ke Service', 'menu_services')
  ]);
  buttons.push([Markup.button.callback('🏠 Menu Utama', 'menu_main')]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => {});
});

bot.action('menu_history', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat riwayat OTP...');
  const history = stmtGetUserOtpHistory.all(ctx.from.id);

  if (!history || history.length === 0) {
    const text = `📜 <b>RIWAYAT OTP KOSONG</b>\n━━━━━━━━━━━━━━━━━━━\nBelum ada catatan kode OTP yang diterima oleh akun Anda.\n\n🕒 <b>Waktu Cek:</b> <code>${getWibTimestamp()}</code>`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')],
      [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
    ]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
  }

  let text = `📜 <b>RIWAYAT SMS & OTP DITERIMA</b>\n━━━━━━━━━━━━━━━━━━━\n`;
  history.forEach((item, index) => {
    text += `${index + 1}. 📌 <b>${item.service}</b> | <code>${formatPhoneNumber(item.number)}</code>\n   🔑 <b>OTP:</b> <code>${item.otp_code}</code> (${item.created_at})\n\n`;
  });
  text += `🕒 <b>Waktu Pembaruan:</b> <code>${getWibTimestamp()}</code>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📱 Nomor Saya', 'menu_my_numbers')],
    [Markup.button.callback('🌐 Kembali ke Service', 'menu_services')],
    [Markup.button.callback('🏠 Menu Utama', 'menu_main')]
  ]);

  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.action('menu_stats', async (ctx) => {
  await safeAnswerCb(ctx, 'Memuat statistik...');
  const stats = await ZelApiClient.getStats();

  let text = '';
  if (stats) {
    text = `📊 <b>STATISTIK LAYANAN ZELAPI (HARIAN)</b>\n━━━━━━━━━━━━━━━━━━━\n📩 <b>Total OTP Sukses:</b> ${stats.otp_count || 0}\n🏳️ <b>Negara Tersedia:</b> ${stats.countries_count || 0}\n🌐 <b>Layanan Aktif:</b> ${stats.services_count || 0}\n📱 <b>Total Stok Nomor:</b> ${stats.available_numbers || 0}\n\n🕒 <b>Waktu Sinkronisasi:</b> <code>${getWibTimestamp()}</code>\n━━━━━━━━━━━━━━━━━━━\n<i>Statistik ini diperbarui secara real-time dari server ZELAPI.</i>`;
  } else {
    text = `❌ <b>GAGAL MEMUAT STATISTIK</b>\n━━━━━━━━━━━━━━━━━━━\nTerjadi kendala saat mengambil metrics server.\n\n🕒 <b>Waktu:</b> <code>${getWibTimestamp()}</code>`;
  }

  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Utama', 'menu_main')]]);
  return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {});
});

bot.catch((err, ctx) => {
  console.error(`Telegram Handler Error for ${ctx.updateType}:`, err.message);
});

bot.launch().then(() => {
  console.log('Bot ZELAPI Telegraf sedang berjalan...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
