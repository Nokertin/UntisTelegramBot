const crypto = require('crypto');

const SECRET_KEY = process.env.UNTIS_CREDENTIALS_KEY || 'change-me-in-production';
const KEY = crypto.createHash('sha256').update(SECRET_KEY).digest();

const decrypt = (text) => {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  const parts = text.split(':');
  if (parts.length !== 3) {
    return text;
  }

  try {
    const [ivHex, tagHex, encryptedHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch (error) {
    return text;
  }
}

module.exports = Object.assign(decrypt, { default: decrypt });
