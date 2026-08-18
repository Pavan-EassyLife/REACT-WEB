/**
 * Migration v2 - Run once to:
 *   1. Add sign_in_location & sign_out_location columns
 *   2. Add a UNIQUE partial index on (employee_id, date) WHERE sign_out_time IS NULL
 *      → This prevents race-condition duplicate check-ins even under concurrent requests
 *
 * Usage: node migrate_v2.js
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
    console.log('🚀 Running migration v2...\n');

    // ── Step 1: Add location columns ──────────────────────────────────────────
    await client.query(`
      ALTER TABLE attendance_logs
        ADD COLUMN IF NOT EXISTS sign_in_location  TEXT,
        ADD COLUMN IF NOT EXISTS sign_out_location TEXT;
    `);
    console.log('✅ Columns "sign_in_location" and "sign_out_location" added (or already exist)');

    // ── Step 2: Add unique partial index to block concurrent duplicate check-ins
    //    Only one open (sign_out_time IS NULL) row is allowed per employee per day.
    //    The INSERT in app.js uses ON CONFLICT DO NOTHING, so concurrent cron calls
    //    will silently skip if one already succeeded.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_open_checkin
        ON attendance_logs (employee_id, date)
        WHERE sign_out_time IS NULL;
    `);
    console.log('✅ Unique partial index "idx_unique_open_checkin" created (or already exists)');

    // ── Step 3 (optional): Clean up existing duplicate open records ───────────
    //    Keeps the row with the lowest id (earliest created_at), deletes the rest.
    const cleanupResult = await client.query(`
      DELETE FROM attendance_logs
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY employee_id, date
                   ORDER BY id ASC         -- keep the first (lowest id)
                 ) AS rn
          FROM attendance_logs
          WHERE sign_out_time IS NULL
        ) ranked
        WHERE rn > 1
      )
      RETURNING id;
    `);
    if (cleanupResult.rows.length > 0) {
      console.log(`🧹 Removed ${cleanupResult.rows.length} duplicate open check-in row(s): IDs [${cleanupResult.rows.map(r => r.id).join(', ')}]`);
    } else {
      console.log('✅ No duplicate open check-in rows found — nothing to clean up');
    }

    // ── Step 4 (optional): Clean up duplicate fully-closed records too ────────
    //    For rows where sign_out_time IS NOT NULL, keep only the first per (employee_id, date).
    const cleanupClosed = await client.query(`
      DELETE FROM attendance_logs
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY employee_id, date
                   ORDER BY id ASC
                 ) AS rn
          FROM attendance_logs
          WHERE sign_out_time IS NOT NULL
        ) ranked
        WHERE rn > 1
      )
      RETURNING id;
    `);
    if (cleanupClosed.rows.length > 0) {
      console.log(`🧹 Removed ${cleanupClosed.rows.length} duplicate closed check-in row(s): IDs [${cleanupClosed.rows.map(r => r.id).join(', ')}]`);
    } else {
      console.log('✅ No duplicate closed check-in rows found — nothing to clean up');
    }

    console.log('\n🎉 Migration v2 completed successfully!');
  } catch (error) {
    console.error('❌ Migration v2 failed:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
