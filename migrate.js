/**
 * Migration script - Run once to create the attendance_logs table in Supabase PostgreSQL
 * Usage: node migrate.js
 */
const { Pool } = require('pg');
require('dotenv').config();

// Use DIRECT_URL for migrations (not the pooler)
const pool = new Pool({
  connectionString: process.env.DIRECT_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Running migration...\n');

    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance_logs (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) NOT NULL,
        employee_name VARCHAR(255) NOT NULL,
        sign_in_time TIMESTAMP,
        sign_out_time TIMESTAMP,
        date DATE NOT NULL,
        status VARCHAR(50) DEFAULT 'full_day',
        work_hours NUMERIC(10, 4) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "attendance_logs" created (or already exists)');

    // Create index for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_employee_date 
      ON attendance_logs (employee_id, date);
    `);
    console.log('✅ Index "idx_attendance_employee_date" created (or already exists)');

    console.log('\n🎉 Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
