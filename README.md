# 📱 Telegram Bot OTP - ZELAPI Virtual Number

Bot Telegram interaktif berbasis **Node.js** & **Telegraf** yang terintegrasi dengan [ZELAPI OTP API](https://smsku.zelapi.eu.cc). Bot ini memungkinkan pengguna untuk menyewa nomor virtual, menerima kode SMS OTP secara otomatis via polling, melepaskan nomor, hingga berganti nomor secara instan.

## 🌟 Fitur Utama

- 🔄 **Polling OTP Otomatis**: Mendeteksi dan mengirimi notifikasi saat SMS/OTP masuk tanpa perlu menyegarkan halaman secara manual.
- 📱 **Sewa & Ganti Nomor Instan**: Bebas mengganti nomor ke negara yang sama secara langsung (*one-click replacement*).
- 📜 **Riwayat SMS & OTP**: Menyimpan histori seluruh OTP yang pernah masuk ke basis data internal (`better-sqlite3`).
- 👤 **Verifikasi Kontak**: Fitur integrasi *Contact Request* Telegram untuk otentikasi identitas pengguna.
- ⏱️ **Timestamp WIB (Asia/Jakarta)**: Seluruh tampilan status dan notifikasi dilengkapi format waktu 24 jam real-time.
- 🛡️ **Anti-Crash & Safe Handler**: Penanganan error khusus (*safe callback handler*) untuk mencegah bot mati akibat timeout query dari Telegram.

---

## 🛠️ Prasyarat (Prerequisites)

- **Node.js**: v18.0.0 atau lebih baru
- **Bot Token**: Dapatkan dari [@BotFather](https://t.me/BotFather) di Telegram

---

## 🚀 Panduan Instalasi

1. **Clone Repositori**
   ```bash
   git clone https://github.com/jakisoft/telegram-bot-otp.git
   cd telegram-bot-otp
   ```

2. **Install Dependensi**
   ```bash
   npm install
   ```

3. **Konfigurasi Environment Variable**
   Salin file `.env.example` menjadi `.env` lalu sesuaikan isinya:
   ```bash
   cp .env.example .env
   ```

4. **Jalankan Bot**
   - Mode Production:
     ```bash
     npm start
     ```
   - Mode Development (Auto-reload):
     ```bash
     npm run dev
     ```

---

## ⚙️ Konfigurasi `.env.example`

Buat file bernama `.env.example` di direktori utama repositori Anda:

```env
# Telegram Bot Token dari @BotFather
BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyZ
```

---

## 🗂️ Struktur Proyek

```text
.
├── main.js             # Kode utama bot Telegram (Telegraf logic)
├── zelapi_bot.db       # Database SQLite (dibuat otomatis saat bot berjalan)
├── package.json        # Manifest dependensi & script Node.js
├── .env.example        # Template konfigurasi environment variable
└── README.md           # Dokumentasi proyek
```

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah lisensi **MIT**.
