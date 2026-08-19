const express = require('express');
const cors = require('cors');
const moment = require('moment-timezone');
const { pool } = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Configuration ──────────────────────────────────────────────
const EMPLOYEE_ID   = process.env.ATTENDANCE_EMPLOYEE_ID   || 'EL-0026';
const EMPLOYEE_NAME = process.env.ATTENDANCE_EMPLOYEE_NAME || 'Pawan Prasad';
const MAX_DAYS      = parseInt(process.env.ATTENDANCE_MAX_DAYS) || 7;
const TIMEZONE      = 'Asia/Kolkata';
const PORT          = process.env.PORT || 4000;

// Default locations (override per-request via body, or set in .env)
const DEFAULT_SIGNIN_LOCATION  = process.env.SIGNIN_LOCATION  || 'Mumbai, Maharashtra, India';
const DEFAULT_SIGNOUT_LOCATION = process.env.SIGNOUT_LOCATION || 'P/S Mumbai, Maharashtra, India';

// ─── Day counter (resets at midnight IST automatically) ─────────
let dayCounter    = 0;
let lastResetDate = moment().tz(TIMEZONE).format('YYYY-MM-DD');

function checkAndResetCounter() {
  const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
  if (today !== lastResetDate) {
    console.log('\n🔄 Day changed — resetting day counter');
    dayCounter    = 0;
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
/**
 * @param {'checkin'|'checkout'} type
 * @param {string|null} signInLocation  - location string for check-in
 * @param {string|null} signOutLocation - location string for check-out
 */
async function insertAttendance(type, signInLocation, signOutLocation) {
  checkAndResetCounter();

  if (MAX_DAYS > 0 && dayCounter >= MAX_DAYS) {
    const msg = `⏸️  Attendance tracking stopped. Reached max days: ${MAX_DAYS}`;
    console.log(msg);
    return { success: false, message: msg };
  }

  try {
    const nowIST      = moment().tz(TIMEZONE);
    const date        = nowIST.format('YYYY-MM-DD');
    const datetimeIST = nowIST.format('YYYY-MM-DD HH:mm:ss');
    const datetimeUTC = nowIST.clone().utc().format('YYYY-MM-DD HH:mm:ss');

    if (type === 'checkin') {
      // ── INSERT with ON CONFLICT DO NOTHING ──────────────────────────────────
      // The unique partial index idx_unique_open_checkin on (employee_id, date)
      // WHERE sign_out_time IS NULL ensures concurrent cron calls cannot create
      // duplicate open check-ins — even if the SELECT-before-INSERT race fires.
      const query = `
        INSERT INTO attendance_logs
          (employee_id, employee_name, sign_in_time, date, status, sign_in_location, created_at)
        VALUES ($1, $2, $3, $4, 'full_day', $5, NOW())
        ON CONFLICT (employee_id, date) WHERE sign_out_time IS NULL DO NOTHING
        RETURNING id
      `;
      const result = await pool.query(query, [
        EMPLOYEE_ID, EMPLOYEE_NAME, datetimeUTC, date, signInLocation
      ]);

      // ON CONFLICT DO NOTHING → no rows returned when duplicate
      if (result.rows.length === 0) {
        const msg = `⚠️  Already checked in today (${date}). Duplicate blocked by DB constraint.`;
        console.log(msg);
        return { success: false, message: msg };
      }

      const response = {
        success: true,
        type: 'checkin',
        record_id: result.rows[0].id,
        employee_id: EMPLOYEE_ID,
        employee_name: EMPLOYEE_NAME,
        date,
        time_ist: datetimeIST,
        time_utc: datetimeUTC,
        day_counter: `${dayCounter + 1}/${MAX_DAYS > 0 ? MAX_DAYS : '∞'}`,
        sign_in_location: signInLocation,
        sign_out_location: null,
      };

      console.log(`✅ CHECKIN recorded for ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`);
      console.log(`📅 Date: ${date} | ⏰ IST: ${datetimeIST} | UTC: ${datetimeUTC}`);
      console.log(`📍 Location: ${signInLocation}`);
      return response;

    } else if (type === 'checkout') {
      // Check if there's an open check-in to close
      const openRecord = await pool.query(
        `SELECT id FROM attendance_logs
          WHERE employee_id = $1 AND date = $2 AND sign_out_time IS NULL
          ORDER BY id ASC LIMIT 1`,
        [EMPLOYEE_ID, date]
      );

      if (openRecord.rows.length === 0) {
        const msg = `⚠️  No open check-in found for today (${date}). Cannot check out.`;
        console.log(msg);
        return { success: false, message: msg };
      }

      // Update with checkout time, work hours, and location
      const query = `
        UPDATE attendance_logs
        SET sign_out_time    = $1,
            work_hours       = EXTRACT(EPOCH FROM ($1::timestamp - sign_in_time)) / 3600,
            sign_out_location = $2,
            updated_at       = NOW()
        WHERE employee_id    = $3
          AND date           = $4
          AND sign_out_time  IS NULL
        RETURNING id, sign_in_time, work_hours, sign_in_location
      `;
      const result = await pool.query(query, [datetimeUTC, signOutLocation, EMPLOYEE_ID, date]);

      // Increment day counter after successful checkout
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
        day_counter: `${dayCounter}/${MAX_DAYS > 0 ? MAX_DAYS : '∞'}`,
        sign_in_location: result.rows[0].sign_in_location,
        sign_out_location: signOutLocation,
      };

      console.log(`✅ CHECKOUT recorded for ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`);
      console.log(`📅 Date: ${date} | ⏰ IST: ${datetimeIST} | UTC: ${datetimeUTC}`);
      console.log(`📍 Location: ${signOutLocation}`);
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
 * Records a check-in for the configured employee.
 * Call this from your external cron between 09:00-09:30 IST Mon-Sat.
 *
 * Optional body:
 *   { "sign_in_location": "Mumbai, Maharashtra, India" }
 */
app.post('/api/login', async (req, res) => {
  console.log('\n🔔 /api/login called');

  // ── Time-window guard: only allow sign-in between 8:30 AM – 10:30 AM IST ──
  // Pass { "force": true } in the request body to bypass (for manual corrections)
  const force = req.body?.force === true;
  if (!force) {
    const nowIST = moment().tz(TIMEZONE);
    const hour   = nowIST.hours();
    const min    = nowIST.minutes();
    const totalMin = hour * 60 + min;
    const windowStart = 8 * 60 + 30;   // 08:30 IST
    const windowEnd   = 10 * 60 + 30;  // 10:30 IST
    if (totalMin < windowStart || totalMin > windowEnd) {
      const msg = `⛔ Sign-in blocked outside allowed window (08:30–10:30 IST). Current IST: ${nowIST.format('HH:mm')}. Use { "force": true } to override.`;
      console.log(msg);
      return res.status(403).json({ success: false, message: msg });
    }
  }

  const signInLocation = req.body?.sign_in_location || DEFAULT_SIGNIN_LOCATION;
  const result = await insertAttendance('checkin', signInLocation, null);
  const statusCode = result.success ? 200 : 400;
  res.status(statusCode).json(result);
});

/**
 * POST /api/logout
 * Records a check-out for the configured employee.
 * Call this from your external cron between 18:30-19:00 IST Mon-Sat.
 *
 * Optional body:
 *   { "sign_out_location": "P/S Mumbai, Maharashtra, India" }
 */
app.post('/api/logout', async (req, res) => {
  console.log('\n🔔 /api/logout called');

  // ── Time-window guard: only allow sign-out between 6:00 PM – 7:30 PM IST ──
  // Pass { "force": true } in the request body to bypass (for manual corrections)
  const force = req.body?.force === true;
  if (!force) {
    const nowIST = moment().tz(TIMEZONE);
    const hour   = nowIST.hours();
    const min    = nowIST.minutes();
    const totalMin = hour * 60 + min;
    const windowStart = 18 * 60 + 0;   // 18:00 IST
    const windowEnd   = 19 * 60 + 30;  // 19:30 IST
    if (totalMin < windowStart || totalMin > windowEnd) {
      const msg = `⛔ Sign-out blocked outside allowed window (18:00–19:30 IST). Current IST: ${nowIST.format('HH:mm')}. Use { "force": true } to override.`;
      console.log(msg);
      return res.status(403).json({ success: false, message: msg });
    }
  }

  const signOutLocation = req.body?.sign_out_location || DEFAULT_SIGNOUT_LOCATION;
  const result = await insertAttendance('checkout', null, signOutLocation);
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
  const date   = nowIST.format('YYYY-MM-DD');

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
      suggested_checkin_minute:  `09:${getTargetMinute(date, 0, 30, 'checkin').toString().padStart(2, '0')} IST`,
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
    version: '2.0.0',
    database: 'Supabase PostgreSQL',
    endpoints: {
      login:  'POST /api/login',
      logout: 'POST /api/logout',
      status: 'GET  /api/status'
    }
  });
});

// ─── Start Server ───────────────────────────────────────────────
// Export for Vercel serverless (module.exports is required by @vercel/node)
module.exports = app;

// Also start locally when run directly with `node app.js`
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 Attendance API server running on port ${PORT}`);
    console.log(`👤 Tracking: ${EMPLOYEE_NAME} (${EMPLOYEE_ID})`);
    console.log(`📅 Max Days: ${MAX_DAYS > 0 ? MAX_DAYS : 'Unlimited'}`);
    console.log(`🌍 Timezone: ${TIMEZONE}`);
    console.log(`📍 Default sign-in  location: ${DEFAULT_SIGNIN_LOCATION}`);
    console.log(`📍 Default sign-out location: ${DEFAULT_SIGNOUT_LOCATION}`);
    console.log(`\n📡 Endpoints:`);
    console.log(`   POST http://localhost:${PORT}/api/login   → Check-in`);
    console.log(`   POST http://localhost:${PORT}/api/logout  → Check-out`);
    console.log(`   GET  http://localhost:${PORT}/api/status  → Current status`);
  });
}
