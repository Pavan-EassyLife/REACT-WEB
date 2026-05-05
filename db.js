const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Test connection on startup
pool.query('SELECT NOW()')
  .then(res => console.log('✅ Supabase PostgreSQL connected:', res.rows[0].now))
  .catch(err => console.error('❌ Supabase connection error:', err.message));

module.exports = { pool };
