# UntisBot

UntisBot is a multilingual (RU/EN/DE) Telegram bot for WebUntis timetable and homework.

## Features

- Daily timetable in Telegram
- Homework for the current week
- Notifications about canceled/irregular lessons
- Credential storage in MySQL with AES encryption

## Requirements

- Node.js 18+
- MySQL 8+ (or compatible)
- Telegram bot token

## Installation

1. Clone repository:
   ```bash
   git clone https://github.com/Nokertin/UntisTelegramBot.git
   cd UntisTelegramBot
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure `config.json`:
   - `token`, `owner`, `errChannel`
   - WebUntis settings: `school`, `domain`
   - MySQL settings: `host`, `user`, `password`, `dbname`
   - `onlyOwner` if you want private access mode

4. Set encryption key (required for stable decryption after restart):
   ```bash
   export UNTIS_CREDENTIALS_KEY="your-long-random-secret"
   ```

5. Start bot:
   ```bash
   node bot.js
   ```

## Database setup

The bot automatically creates/updates the `users` table on startup.

If you prefer manual preparation, create database and user in MySQL, then grant access:
```sql
CREATE DATABASE untisbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'untisbot'@'%' IDENTIFIED BY 'strong_password';
GRANT ALL PRIVILEGES ON untisbot.* TO 'untisbot'@'%';
FLUSH PRIVILEGES;
```

After that set the same credentials in `config.json`.

## Usage

### User commands
- `/start` — open main menu
- `/lang` — select language

### Admin commands
- `/sendall` — interactive broadcast mode
- `/sendall <message>` — one-line broadcast
- `/getallusers` — list all user telegram IDs
- `/getallusers data` — list users with service fields (without plaintext credentials)

## Security notes

- WebUntis credentials are stored encrypted (AES).
- Keep `UNTIS_CREDENTIALS_KEY` secret.
- ⚠️ Use the same key across restarts, otherwise old encrypted data cannot be decrypted.

## License

MIT, see [License.md](./License.md).
