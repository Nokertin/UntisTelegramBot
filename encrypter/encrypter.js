const crypto = require('crypto');

const SECRET_KEY = process.env.UNTIS_CREDENTIALS_KEY || 'change-me-in-production';
const KEY = crypto.createHash('sha256').update(SECRET_KEY).digest();

const encrypt = (text) => {
  const value = `${text ?? ''}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

module.exports = Object.assign(encrypt, { default: encrypt });
