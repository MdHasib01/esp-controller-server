const mongoose = require('mongoose');
const app = require('../src/app');
const { mongoUri } = require('../src/config/env');

// Serverless functions can be reused across invocations while "warm" — cache
// the connection promise so concurrent/warm requests share one connection
// instead of each opening a fresh one against MongoDB.
let connectionPromise = null;

function ensureDbConnected() {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!connectionPromise) {
    mongoose.set('strictQuery', true);
    connectionPromise = mongoose.connect(mongoUri).catch((err) => {
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

module.exports = async (req, res) => {
  try {
    await ensureDbConnected();
  } catch (err) {
    console.error('[api] MongoDB connection failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'Database connection failed',
        detail: err.message,
      })
    );
    return;
  }
  return app(req, res);
};
