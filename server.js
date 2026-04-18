const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { initializeDatabase, getDb, getClient } = require('./database');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const countdownTimers = new Map();
const MAX_RETRIES = 3;
const KSA_OFFSET_HOURS = 3;

initializeDatabase().catch(console.error);

// ========== دوال مساعدة ==========
function getCurrentKsaTime() {
  const now = new Date();
  return new Date(now.getTime() + KSA_OFFSET_HOURS * 60 * 60 * 1000);
}

function isWithinTimeWindow(startStr, endStr) {
  if (!startStr || !endStr) return true;
  const now = getCurrentKsaTime();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const parseTime = (str) => { const [h,m] = str.split(':').map(Number); return h*60+m; };
  const startMin = parseTime(startStr);
  const endMin = parseTime(endStr);
  if (endMin >= startMin) return currentMinutes >= startMin && currentMinutes < endMin;
  else return currentMinutes >= startMin || currentMinutes < endMin;
}

function getMillisecondsUntilNextStart(startStr) {
  const now = getCurrentKsaTime();
  const [h,m] = startStr.split(':').map(Number);
  const startMin = h*60+m;
  const currentMin = now.getHours()*60 + now.getMinutes();
  let minutesUntil = (currentMin < startMin) ? startMin - currentMin : 24*60 - currentMin + startMin;
  return minutesUntil * 60 * 1000;
}

async function waitWithControl(campaignId, delayMs, checkWindow = false) {
  const endTime = Date.now() + delayMs;
  countdownTimers.set(campaignId, { endTime });
  let remaining = delayMs;
  while (remaining > 0) {
    const db = getDb();
    const check = await db.query(`SELECT control_status, use_time_window, window_start FROM campaigns WHERE campaign_id = $1`, [campaignId]);
    if (check.rows.length === 0) return false;
    const c = check.rows[0];
    if (c.control_status === 'paused' || c.control_status === 'cancelled') { countdownTimers.delete(campaignId); return false; }
    if (checkWindow && c.use_time_window && c.window_start && !isWithinTimeWindow(c.window_start, null)) { countdownTimers.delete(campaignId); return false; }
    const sleep = Math.min(1000, remaining);
    await new Promise(r => setTimeout(r, sleep));
    remaining -= sleep;
  }
  countdownTimers.delete(campaignId);
  return true;
}

function clearCountdown(campaignId) { countdownTimers.delete(campaignId); }

async function sendWhatsAppReport(to, body, token) {
  try {
    await axios.post('https://whatsapp.tkwin.com.sa/api/v1/send', { to, message: body }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000
    });
    console.log(`📨 تقرير إلى ${to}`);
  } catch(e) { console.error(`❌ فشل التقرير: ${e.message}`); }
}

async function sendSingleMessage(to, message, token) {
  const res = await axios.post('https://whatsapp.tkwin.com.sa/api/v1/send', { to, message }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000
  });
  return res.data;
}

async function startBackgroundSending(campaignId) {
  const db = getDb();
  await db.query(`UPDATE campaigns SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = $1`, [campaignId]);
  const campaignRes = await db.query(`SELECT user_token, message, phone_number, control_status, use_time_window, window_start, window_end FROM campaigns WHERE campaign_id = $1`, [campaignId]);
  if (campaignRes.rows.length === 0) return;
  const campaign = campaignRes.rows[0];
  let round = 1, keepRunning = true;

  while (keepRunning) {
    const ctrl = await db.query(`SELECT control_status FROM campaigns WHERE campaign_id = $1`, [campaignId]);
    if (ctrl.rows[0]?.control_status === 'cancelled') { await db.query(`UPDATE campaigns SET status = 'cancelled' WHERE campaign_id = $1`, [campaignId]); clearCountdown(campaignId); return; }
    if (ctrl.rows[0]?.control_status === 'paused') { await db.query(`UPDATE campaigns SET status = 'paused' WHERE campaign_id = $1`, [campaignId]); clearCountdown(campaignId); return; }

    let numbersRes = (round === 1) ?
      await db.query(`SELECT id, phone_number, retry_count FROM campaign_numbers WHERE campaign_id = $1 AND status = 'pending' ORDER BY id`, [campaignId]) :
      await db.query(`SELECT id, phone_number, retry_count FROM campaign_numbers WHERE campaign_id = $1 AND status = 'pending_retry' AND retry_count < $2 ORDER BY id`, [campaignId, MAX_RETRIES]);
    
    const numbers = numbersRes.rows;
    if (numbers.length === 0) { round === 1 ? round = 2 : keepRunning = false; continue; }

    for (let i=0; i<numbers.length; i++) {
      const check = await db.query(`SELECT control_status FROM campaigns WHERE campaign_id = $1`, [campaignId]);
      if (check.rows[0]?.control_status === 'paused') { await db.query(`UPDATE campaigns SET current_index=$1, status='paused' WHERE campaign_id=$2`, [i, campaignId]); clearCountdown(campaignId); return; }
      if (check.rows[0]?.control_status === 'cancelled') { await db.query(`UPDATE campaigns SET status='cancelled' WHERE campaign_id=$1`, [campaignId]); clearCountdown(campaignId); return; }

      const { id, phone_number, retry_count: currentRetries } = numbers[i];
      const attemptNumber = (currentRetries || 0) + 1;
      await db.query(`UPDATE campaigns SET current_index = $1 WHERE campaign_id = $2`, [i+1, campaignId]);

      if (campaign.use_time_window) {
        while (!isWithinTimeWindow(campaign.window_start, campaign.window_end)) {
          await db.query(`UPDATE campaigns SET status = 'waiting_window' WHERE campaign_id = $1`, [campaignId]);
          const waitMs = getMillisecondsUntilNextStart(campaign.window_start);
          console.log(`⏰ انتظار ${Math.floor(waitMs/60000)} دقيقة حتى ${campaign.window_start}`);
          if (!await waitWithControl(campaignId, waitMs, true)) return;
          const newCheck = await db.query(`SELECT control_status FROM campaigns WHERE campaign_id = $1`, [campaignId]);
          if (newCheck.rows[0]?.control_status !== 'active') return;
          await db.query(`UPDATE campaigns SET status = 'processing' WHERE campaign_id = $1`, [campaignId]);
        }
      }

      try {
        await sendSingleMessage(phone_number, campaign.message, campaign.user_token);
        await db.query(`UPDATE campaign_numbers SET status='sent', sent_at=CURRENT_TIMESTAMP, retry_count=$1 WHERE id=$2`, [attemptNumber, id]);
        await db.query(`UPDATE campaigns SET sent_count = sent_count + 1 WHERE campaign_id=$1`, [campaignId]);
        console.log(`✅ ${phone_number} (محاولة ${attemptNumber})`);
      } catch(e) {
        const status = e.response?.status;
        const shouldRetry = (status === 429 || status === 403 || status === 520) && attemptNumber < MAX_RETRIES;
        if (shouldRetry) {
          await db.query(`UPDATE campaign_numbers SET status='pending_retry', retry_count=$1, error_message=$2 WHERE id=$3`, [attemptNumber, e.message, id]);
          console.log(`🔄 ${phone_number} مؤجل (${status})`);
        } else {
          await db.query(`UPDATE campaign_numbers SET status='failed', retry_count=$1, error_message=$2 WHERE id=$3`, [attemptNumber, e.message, id]);
          await db.query(`UPDATE campaigns SET failed_count = failed_count + 1 WHERE campaign_id=$1`, [campaignId]);
          console.log(`❌ ${phone_number} فشل نهائي (${status})`);
        }
      }

      if (!(i === numbers.length-1 && !keepRunning)) {
        const delay = Math.floor(Math.random() * (13*60*1000 - 3*60*1000 + 1)) + 3*60*1000;
        console.log(`⏳ انتظار ${Math.floor(delay/60000)} دقيقة...`);
        if (!await waitWithControl(campaignId, delay)) return;
      }
    }
    if (round === 1) round = 2;
    else { const rem = await db.query(`SELECT COUNT(*) FROM campaign_numbers WHERE campaign_id=$1 AND status='pending_retry' AND retry_count<$2`, [campaignId, MAX_RETRIES]); keepRunning = parseInt(rem.rows[0].count) > 0; }
  }

  const final = await db.query(`SELECT sent_count, failed_count, total_numbers, phone_number, user_token FROM campaigns WHERE campaign_id=$1`, [campaignId]);
  if (final.rows.length) {
    const f = final.rows[0];
    let finalStatus = f.failed_count === f.total_numbers ? 'failed' : 'completed';
    await db.query(`UPDATE campaigns SET status=$1, updated_at=CURRENT_TIMESTAMP WHERE campaign_id=$2`, [finalStatus, campaignId]);
    console.log(`🏁 حملة ${campaignId} انتهت.`);
    if (f.phone_number) await sendWhatsAppReport(f.phone_number, `📊 تقرير حملة ${campaignId}\n✅ ناجح: ${f.sent_count}\n❌ فشل: ${f.failed_count}`, f.user_token);
  }
}

// ========== API ==========
app.post('/api/campaigns', async (req, res) => {
  const { numbers, message, token, phone, useTimeWindow, windowStart, windowEnd } = req.body;
  if (!numbers?.length) return res.status(400).json({ error: 'الأرقام مطلوبة' });
  if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });
  if (!token) return res.status(400).json({ error: 'التوكن مطلوب' });

  const campaignId = uuidv4();
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO campaigns (campaign_id, user_token, message, total_numbers, status, phone_number, control_status, use_time_window, window_start, window_end) VALUES ($1,$2,$3,$4,'pending',$5,'active',$6,$7,$8)`,
      [campaignId, token, message, numbers.length, phone || null, useTimeWindow ? 1 : 0, windowStart || null, windowEnd || null]);
    for (const num of numbers) {
      await client.query(`INSERT INTO campaign_numbers (campaign_id, phone_number, status, retry_count) VALUES ($1, $2, 'pending', 0)`, [campaignId, num]);
    }
    await client.query('COMMIT');
    startBackgroundSending(campaignId).catch(e => console.error(e));
    res.status(201).json({ success: true, campaignId });
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('خطأ في إنشاء الحملة:', e);
    res.status(500).json({ error: 'فشل في إنشاء الحملة: ' + e.message });
  } finally { client.release(); }
});

app.get('/api/campaigns/:campaignId', async (req, res) => {
  try {
    const db = getDb();
    const camp = await db.query(`SELECT * FROM campaigns WHERE campaign_id=$1`, [req.params.campaignId]);
    if (!camp.rows.length) return res.status(404).json({ error: 'الحملة غير موجودة' });
    const nums = await db.query(`SELECT phone_number, status, error_message, sent_at, retry_count FROM campaign_numbers WHERE campaign_id=$1 ORDER BY id`, [req.params.campaignId]);
    let countdown = null;
    const timer = countdownTimers.get(req.params.campaignId);
    if (timer) { const rem = timer.endTime - Date.now(); if (rem>0) countdown = { minutes: Math.floor(rem/60000), seconds: Math.floor((rem%60000)/1000) }; }
    res.json({ ...camp.rows[0], numbers: nums.rows, countdown });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/campaigns/:campaignId/pause', async (req, res) => {
  await getDb().query(`UPDATE campaigns SET control_status='paused', status='paused' WHERE campaign_id=$1`, [req.params.campaignId]);
  clearCountdown(req.params.campaignId);
  res.json({ success: true });
});
app.post('/api/campaigns/:campaignId/resume', async (req, res) => {
  await getDb().query(`UPDATE campaigns SET control_status='active', status='processing' WHERE campaign_id=$1`, [req.params.campaignId]);
  startBackgroundSending(req.params.campaignId).catch(console.error);
  res.json({ success: true });
});
app.post('/api/campaigns/:campaignId/cancel', async (req, res) => {
  await getDb().query(`UPDATE campaigns SET control_status='cancelled', status='cancelled' WHERE campaign_id=$1`, [req.params.campaignId]);
  clearCountdown(req.params.campaignId);
  res.json({ success: true });
});
app.put('/api/campaigns/:campaignId/timewindow', async (req, res) => {
  const { useTimeWindow, windowStart, windowEnd } = req.body;
  await getDb().query(`UPDATE campaigns SET use_time_window=$1, window_start=$2, window_end=$3, updated_at=CURRENT_TIMESTAMP WHERE campaign_id=$4`,
    [useTimeWindow ? 1 : 0, windowStart || null, windowEnd || null, req.params.campaignId]);
  const camp = await getDb().query(`SELECT status FROM campaigns WHERE campaign_id=$1`, [req.params.campaignId]);
  if (camp.rows[0]?.status === 'waiting_window') startBackgroundSending(req.params.campaignId).catch(console.error);
  res.json({ success: true });
});
app.get('/ping', (req, res) => res.send('OK'));

app.listen(port, () => console.log(`🚀 الخادم يعمل على ${port}`));
