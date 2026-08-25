const mongoose = require('mongoose');
const { mongoUri } = require('./env');

async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(mongoUri);
  console.log(`[db] connected to ${mongoUri}`);
}

module.exports = { connectDb };
