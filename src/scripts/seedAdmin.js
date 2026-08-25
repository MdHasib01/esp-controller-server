// Bootstraps the single admin user without going through the HTTP API.
// Usage: npm run seed:admin -- admin@example.com "SomeStrongPassword123"
const bcrypt = require('bcryptjs');
const { connectDb } = require('../config/db');
const User = require('../models/User');

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: npm run seed:admin -- <email> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  await connectDb();

  const existing = await User.findOne({ email });
  if (existing) {
    console.error(`User ${email} already exists`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await User.create({ email, passwordHash });
  console.log(`Created admin user ${email}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
