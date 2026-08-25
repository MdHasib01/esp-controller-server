const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function generateApiKey() {
  return `dk_${crypto.randomBytes(24).toString('hex')}`;
}

async function hashApiKey(rawKey) {
  return bcrypt.hash(rawKey, 10);
}

async function compareApiKey(rawKey, hash) {
  return bcrypt.compare(rawKey, hash);
}

module.exports = { generateApiKey, hashApiKey, compareApiKey };
