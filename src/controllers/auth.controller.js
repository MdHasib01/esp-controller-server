const bcrypt = require('bcryptjs');
const { z } = require('zod');
const User = require('../models/User');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require('../utils/tokens');

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const REFRESH_COOKIE = 'refreshToken';
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/api/auth',
};

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, REFRESH_COOKIE_OPTS);
}

// Bootstraps the single admin account. Self-disables once a user exists.
async function register(req, res, next) {
  try {
    const existing = await User.countDocuments();
    if (existing > 0) {
      return res.status(403).json({ error: 'Registration is closed — an admin already exists' });
    }

    const { email, password } = credentialsSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, passwordHash });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    setRefreshCookie(res, refreshToken);

    res.status(201).json({ accessToken, user: { id: user._id, email: user.email } });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = credentialsSchema.parse(req.body);
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    setRefreshCookie(res, refreshToken);

    res.json({ accessToken, user: { id: user._id, email: user.email } });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  try {
    const payload = verifyRefreshToken(token);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const accessToken = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);
    setRefreshCookie(res, newRefreshToken);

    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
}

async function logout(req, res) {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  res.status(204).send();
}

async function me(req, res) {
  const user = await User.findById(req.user.id).select('email role createdAt');
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
}

module.exports = { register, login, refresh, logout, me };
