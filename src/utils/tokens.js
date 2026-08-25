const jwt = require('jsonwebtoken');
const {
  jwtAccessSecret,
  jwtRefreshSecret,
  accessTokenTtl,
  refreshTokenTtl,
} = require('../config/env');

function signAccessToken(user) {
  return jwt.sign({ sub: user._id.toString() }, jwtAccessSecret, { expiresIn: accessTokenTtl });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user._id.toString() }, jwtRefreshSecret, { expiresIn: refreshTokenTtl });
}

function verifyAccessToken(token) {
  return jwt.verify(token, jwtAccessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, jwtRefreshSecret);
}

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken };
