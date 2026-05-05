const express = require('express');
const cors = require('cors');
const moment = require('moment-timezone');
const { pool } = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Configuration ──────────────────────────────────────────────
const EMPLOYEE_ID = process.env.ATTENDANCE_EMPLOYEE_ID || 'EL-0026';
const EMPLOYEE_NAME = process.env.ATTENDANCE_EMPLOYEE_NAME || 'Pawan Prasad';
const MAX_DAYS = parseInt(process.env.ATTENDANCE_MAX_DAYS) || 7;
const TIMEZONE = 'Asia/Kolkata';
const PORT = process.env.PORT || 4000;

// ─── Day counter (resets at midnight IST automatically) ─────────
let dayCounter = 0;
let lastResetDate = moment().tz(TIMEZONE).format('YYYY-MM-DD');

function checkAndResetCounter() {
  const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
  if (today !== lastResetDate) {
    console.log('\n🔄 Day changed — resetting day counter');
    dayCounter = 0;
    lastResetDate = today;
  }
}

// ─── Helper: Generate deterministic random minute ───────────────
function getTargetMinute(dateString, startMin, endMin, salt) {
  let hash = 0;
  const str = dateString + salt;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const range = endMin - startMin + 1;
  return startMin + (Math.abs(hash) % range);
}

// ─── Core: Insert / Update attendance in Supabase PostgreSQL ────
async function insertAttendance(type) {
  checkAndResetCounter();

  if (MAX_DAYS > 0 && dayCounter >= MAX_DAYS) {
    const msg = `⏸️  Attendance tracking stopped. Reached max days: ${MAX_DAYS}`;
    console.log(msg);
    return { success: false, message: msg };
  }

  try {
    const nowIST = moment().tz(TIMEZONE);
    const date = nowIST.format('YYYY-MM-DD');
    const datetimeIST = nowIST.format('YYYY-MM-DD HH:mm:ss');
    const datetimeUTC = nowIST.clone().utc().format('YYYY-MM-DD HH:mm:ss');

    if (type === 'checkin') {
      // Check if already checked in today
      const existing = await pool.query(
        `SELECT id FROM attendance_logs WHERE employee_id = $1 AND date = $2 AND sign_out_time IS NULL`,
        [EMPLOYEE_ID, date]
      );

      if (existing.rows.length > 0) {
        const msg = `⚠️  Already checked in today (${date}). Skipping duplicate check-in.`;
        console.log(msg);
        return { success: false, message: msg };
      }

      // Insert new check-in record
      const query = `
        INSERT INTO attendance_logs (employee_id, employee_name, sign_in_time, date, status, created_at)
        VALUES ($1, $2, $3, $4, 'full_day', NOW())
        RETURNING id
      `;
      const result = await pool.query(query, [EMPLOYEE_ID, EMPLOYEE_NAME, datetimeUTC, date]);

      const response = {
        success: true,
        type: 'checkin',
        record_id: result.rows[0].id,
        employee_id: EMPLOYEE_ID,
        employee_name: EMPLOYEE_NAME,
        date,
        time_ist: datetimeIST,
        time_utc: datetimeUTC,
        day_counter: `${dayCounter + 1}/${MAX_DAYS > 0 ? MAX_DAYS : '∞'}`
      };

      console.log(`✅ CHECKIN recorded for ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`);
      console.log(`📅 Date: ${date} | ⏰ IST: ${datetimeIST} | UTC: ${datetimeUTC}`);
      return response;

    } else if (type === 'checkout') {
      // Check if there's an open check-in to close
      const openRecord = await pool.query(
        `SELECT id FROM attendance_logs WHERE employee_id = $1 AND date = $2 AND sign_out_time IS NULL ORDER BY id DESC LIMIT 1`,
        [EMPLOYEE_ID, date]
      );

      if (openRecord.rows.length === 0) {
        const msg = `⚠️  No open check-in found for today (${date}). Cannot check out.`;
        console.log(msg);
        return { success: false, message: msg };
      }

      // Update with checkout time and calculate work hours
      const query = `
        UPDATE attendance_logs
        SET sign_out_time = $1,
            work_hours = EXTRACT(EPOCH FROM ($1::timestamp - sign_in_time)) / 3600,
            updated_at = NOW()
        WHERE employee_id = $2
          AND date = $3
          AND sign_out_time IS NULL
        RETURNING id, sign_in_time, work_hours
      `;
      const result = await pool.query(query, [datetimeUTC, EMPLOYEE_ID, date]);

      // Increment day counter after checkout
      dayCounter++;

      const response = {
        success: true,
        type: 'checkout',
        record_id: result.rows[0].id,
        employee_id: EMPLOYEE_ID,
        employee_name: EMPLOYEE_NAME,
        date,
        sign_in_time: result.rows[0].sign_in_time,
        sign_out_time: datetimeUTC,
        work_hours: parseFloat(result.rows[0].work_hours).toFixed(2),
        time_ist: datetimeIST,
        time_utc: datetimeUTC,
        day_counter: `${dayCounter}/${MAX_DAYS > 0 ? MAX_DAYS : '∞'}`
      };

      console.log(`✅ CHECKOUT recorded for ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`);
      console.log(`📅 Date: ${date} | ⏰ IST: ${datetimeIST} | UTC: ${datetimeUTC}`);
      console.log(`📊 Day Counter: ${dayCounter}/${MAX_DAYS > 0 ? MAX_DAYS : '∞'}`);
      return response;
    }
  } catch (error) {
    console.error(`❌ Error recording ${type}:`, error.message);
    return { success: false, message: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
//  API ENDPOINTS (called from external cron server)
// ═══════════════════════════════════════════════════════════════

/**
 * POST /api/login
 * Records a check-in for the configured employee
 * Call this from your external cron between 09:00-09:30 IST Mon-Sat
 */
app.post('/api/login', async (req, res) => {
  console.log('\n🔔 /api/login called');
  const result = await insertAttendance('checkin');
  const statusCode = result.success ? 200 : 400;
  res.status(statusCode).json(result);
});

/**
 * POST /api/logout
 * Records a check-out for the configured employee
 * Call this from your external cron between 18:30-19:00 IST Mon-Sat
 */
app.post('/api/logout', async (req, res) => {
  console.log('\n🔔 /api/logout called');
  const result = await insertAttendance('checkout');
  const statusCode = result.success ? 200 : 400;
  res.status(statusCode).json(result);
});

/**
 * GET /api/status
 * Check current status — useful for debugging
 */
app.get('/api/status', async (req, res) => {
  checkAndResetCounter();
  const nowIST = moment().tz(TIMEZONE);
  const date = nowIST.format('YYYY-MM-DD');

  try {
    const todayRecords = await pool.query(
      `SELECT * FROM attendance_logs WHERE employee_id = $1 AND date = $2 ORDER BY id DESC`,
      [EMPLOYEE_ID, date]
    );

    res.json({
      status: 'running',
      employee_id: EMPLOYEE_ID,
      employee_name: EMPLOYEE_NAME,
      current_time_ist: nowIST.format('YYYY-MM-DD HH:mm:ss'),
      today_date: date,
      day_counter: `${dayCounter}/${MAX_DAYS > 0 ? MAX_DAYS : '∞'}`,
      today_records: todayRecords.rows,
      // Suggested cron times for external server
      suggested_checkin_minute: `09:${getTargetMinute(date, 0, 30, 'checkin').toString().padStart(2, '0')} IST`,
      suggested_checkout_minute: `18:${getTargetMinute(date, 30, 59, 'checkout').toString().padStart(2, '0')} IST`
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET / — Health check
 */
app.get('/', (req, res) => {
  res.json({
    service: 'Attendance Tracker',
    version: '1.0.0',
    database: 'Supabase PostgreSQL',
    endpoints: {
      login: 'POST /api/login',
      logout: 'POST /api/logout',
      status: 'GET /api/status'
    }
  });
});

// ─── Start Server ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Attendance API server running on port ${PORT}`);
  console.log(`👤 Tracking: ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`);
  console.log(`📅 Max Days: ${MAX_DAYS > 0 ? MAX_DAYS : 'Unlimited'}`);
  console.log(`🌍 Timezone: ${TIMEZONE}`);
  console.log(`\n📡 Endpoints:`);
  console.log(`   POST http://localhost:${PORT}/api/login   → Check-in`);
  console.log(`   POST http://localhost:${PORT}/api/logout  → Check-out`);
  console.log(`   GET  http://localhost:${PORT}/api/status  → Current status`);
});
