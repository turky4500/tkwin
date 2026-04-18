const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { initializeDatabase, getDb } = require('./database');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// تخزين مؤقت لمواعيد العد التنازلي
const countdownTimers = new Map();

// أقصى عدد للمحاولات لكل رقم
const MAX_RETRIES = 3;

// فارق التوقيت: السعودية UTC+3
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

  const parseTime = (str) => {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
  };

  const startMin = parseTime(startStr);
  const endMin = parseTime(endStr);

  if (endMin >= startMin) {
    return currentMinutes >= startMin && currentMinutes < endMin;
  } else {
    return currentMinutes >= startMin || currentMinutes < endMin;
  }
}

function getMillisecondsUntilNextStart(startStr) {
  const now = getCurrentKsaTime();
  const [h, m] = startStr.split(':').map(Number);
  const startMin = h * 60 + m;
  const currentMin = now.getHours() * 60 + now.getMinutes();

  let minutesUntil;
  if (currentMin < startMin) {
    minutesUntil = startMin - currentMin;
  } else {
    minutesUntil = 24 * 60 - currentMin + startMin;
  }
  return minutesUntil * 60 * 1000;
}

async function waitWithControl(campaignId, delayMs, checkWindow = false) {
  const endTime = Date.now() + delayMs;
  countdownTimers.set(campaignId, { endTime });

  let remaining = delayMs;
  while (remaining > 0) {
    const db = getDb();
    const check = await db.query(
      `SELECT control_status, use_time_window, window_start FROM campaigns WHERE campaign_id = $1`,
      [campaignId]
    );
    
    if (check.rows.length === 0) return false;
    const c = check.rows[0];
    
    if (c.control_status === 'paused' || c.control_status === 'cancelled') {
      countdownTimers.delete(campaignId);
      return false;
    }

    if (checkWindow && c.use_time_window && c.window_start) {
      if (!isWithinTimeWindow(c.window_start, null)) {
        countdownTimers.delete(campaignId);
        return false;
      }
    }

    const sleep = Math.min(1000, remaining);
    await new Promise(resolve => setTimeout(resolve, sleep));
    remaining -= sleep;
  }
  
  countdownTimers.delete(campaignId);
  return true;
}

function clearCountdown(campaignId) {
  countdownTimers.delete(campaignId);
}

async function sendWhatsAppReport(to, body, token) {
  try {
    await axios.post('https://whatsapp.tkwin.com.sa/api/v1/send', { to, message: body }, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });
    console.log(`📨 تقرير واتساب أُرسل إلى ${to}`);
  } catch (error) {
    console.error(`❌ فشل إرسال التقرير:`, error.message);
  }
}

async function sendSingleMessage(to, message, token) {
  const response = await axios.post('https://whatsapp.tkwin.com.sa/api/v1/send', { to, message }, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });
  return response.data;
}

// ========== الدالة الرئيسية للإرسال ==========
async function startBackgroundSending(campaignId) {
  const db = getDb();
  await db.query(`UPDATE campaigns SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = $1`, [campaignId]);

  const campaignRes = await db.query(
    `SELECT user_token, message, phone_number, control_status, use_time_window, window_start, window_end
     FROM campaigns WHERE campaign_id = $1`,
    [campaignId]
  );
  if (campaignRes.rows.length === 0) return;
  const campaign = campaignRes.rows[0];

  let round = 1;
  let keepRunning = true;

  while (keepRunning) {
    const current = await db.query(`SELECT control_status FROM campaigns WHERE campaign_id = $1`, [campaignId]);
    if (current.rows.length === 0) return;
    const ctrl = current.rows[0];
    
    if (ctrl.control_status === 'cancelled') {
      await db.query(`UPDATE campaigns SET status = 'cancelled' WHERE campaign_id = $1`, [campaignId]);
      clearCountdown(campaignId);
      return;
    }
    if (ctrl.control_status === 'paused') {
      await db.query(`UPDATE campaigns SET status = 'paused' WHERE campaign_id = $1`, [campaignId]);
      clearCountdown(campaignId);
      return;
    }

    let numbersRes;
    if (round === 1) {
      numbersRes = await db.query(
        `SELECT id, phone_number, retry_count FROM campaign_numbers
         WHERE campaign_id = $1 AND status = 'pending' ORDER BY id`,
        [campaignId]
      );
    } else {
      numbersRes = await db.query(
        `SELECT id, phone_number, retry_count FROM campaign_numbers
         WHERE campaign_id = $1 AND status = 'pending_retry' AND retry_count < $2 ORDER BY id`,
        [campaignId, MAX_RETRIES]
      );
    }

    const numbers = numbersRes.rows;
    if (numbers.length === 0) {
      if (round === 1) { round = 2; continue; }
      else { keepRunning = false; break; }
    }

    for (let i = 0; i < numbers.length; i++) {
      const check = await db.query(`SELECT control_status FROM campaigns WHERE campaign_id = $1`, [campaignId]);
      if (check.rows.length === 0) return;
      const ctrl2 = check.rows[0];
      
      if (ctrl2.control_status === 'paused') {
        await db.query(`UPDATE campaigns SET current_index = $1, status = 'paused' WHERE campaign_id = $2`, [i, campaignId]);
        clearCountdown(campaignId);
        return;
      }
      if (ctrl2.control_status === 'cancelled') {
        await db.query(`UPDATE campaigns SET status = 'cancelled' WHERE campaign_id = $1`, [campaignId]);
        clearCountdown(campaignId);
        return;
      }

      const { id, phone_number, retry_count: currentRetries } = numbers[i];
      const attemptNumber = (currentRetries || 0) + 1;
      await db.query(`UPDATE campaigns SET current_index = $1 WHERE campaign_id = $2`, [i + 1, campaignId]);

      // التحقق من النافذة الزمنية
      if (campaign.use_time_window) {
        while (!isWithinTimeWindow(campaign.window_start, campaign.window_end)) {
          await db.query(`UPDATE campaigns SET status = 'waiting_window' WHERE campaign_id = $1`, [campaignId]);
          
          const waitMs = getMillisecondsUntilNextStart(campaign.window_start);
          const waitMinutes = Math.floor(waitMs / 60000);
          console.log(`⏰ خارج النافذة الزمنية. انتظار ${waitMinutes} دقيقة حتى ${campaign.window_start}`);
          
          const continued = await waitWithControl(campaignId, waitMs, true);
          if (!continued) return;
          
          const newCheck = await db.query(`SELECT control_status FROM campaigns WHERE campaign_id = $1`, [campaignId]);
          if (newCheck.rows.length === 0) return;
          if (newCheck.rows[0].control_status !== 'active') return;
          await db.query(`UPDATE campaigns SET status = 'processing' WHERE campaign_id = $1`, [campaignId]);
        }
      }

      try {
        await sendSingleMessage(phone_number, campaign.message, campaign.user_token);
        await db.query(`UPDATE campaign_numbers SET status = 'sent', sent_at = CURRENT_TIMESTAMP, retry_count = $1 WHERE id = $2`, [attemptNumber, id]);
        await db.query(`UPDATE campaigns SET sent_count = sent_count + 1 WHERE campaign_id = $1`, [campaignId]);
        console.log(`✅ ${phone_number} (محاولة ${attemptNumber})`);
      } catch (error) {
        const status = error.response?.status;
        const isRetryable = (status === 429 || status === 403 || status === 520);
        const shouldRetry = isRetryable && attemptNumber < MAX_RETRIES;
        if (shouldRetry) {
          await db.query(
            `UPDATE campaign_numbers SET status = 'pending_retry', retry_count = $1, error_message = $2 WHERE id = $3`,
            [attemptNumber, `محاولة ${attemptNumber}: ${error.message}`, id]
          );
          console.log(`🔄 ${phone_number} مؤجل للمحاولة ${attemptNumber+1} (${status})`);
        } else {
          await db.query(`UPDATE campaign_numbers SET status = 'failed', retry_count = $1, error_message = $2 WHERE id = $3`, [attemptNumber, error.message, id]);
          await db.query(`UPDATE campaigns SET failed_count = failed_count + 1 WHERE campaign_id = $1`, [campaignId]);
          console.log(`❌ ${phone_number} فشل نهائي (${status})`);
        }
      }

      const isLastInRound = (i === numbers.length - 1);
      const isLastRound = (round > 1 && numbers.length === 0) || keepRunning === false;
      if (!isLastInRound || !isLastRound) {
        const minDelay = 3 * 60 * 1000;
        const maxDelay = 13 * 60 * 1000;
        const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
        const mins = Math.floor(delay / 60000);
        const secs = Math.floor((delay % 60000) / 1000);
        console.log(`⏳ انتظار ${mins}:${secs.toString().padStart(2,'0')} قبل الرقم التالي...`);
        
        const continued = await waitWithControl(campaignId, delay);
        if (!continued) return;
      }
    }

    if (round === 1) { round = 2; }
    else {
      const remaining = await db.query(
        `SELECT COUNT(*) FROM campaign_numbers WHERE campaign_id = $1 AND status = 'pending_retry' AND retry_count < $2`,
        [campaignId, MAX_RETRIES]
      );
      keepRunning = parseInt(remaining.rows[0].count) > 0;
    }
  }

  // إنهاء الحملة
  const final = await db.query(`SELECT sent_count, failed_count, total_numbers, phone_number, user_token FROM campaigns WHERE campaign_id = $1`, [campaignId]);
  if (final.rows.length === 0) return;
  const f = final.rows[0];
  let finalStatus = (f.failed_count === f.total_numbers) ? 'failed' : 'completed';
  await db.query(`UPDATE campaigns SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = $2`, [finalStatus, campaignId]);
  console.log(`🏁 حملة ${campaignId} انتهت. ناجح: ${f.sent_count}, فاشل: ${f.failed_count}`);

  if (f.phone_number) {
    const report = `📊 تقرير حملة ${campaignId}\n✅ تم الإرسال بنجاح: ${f.sent_count}\n❌ فشل: ${f.failed_count}\n📋 الإجمالي: ${f.total_numbers}`;
    await sendWhatsAppReport(f.phone_number, report, f.user_token);
  }
}

// ========== نقاط النهاية ==========
app.post('/api/campaigns', async (req, res) => {
  const { numbers, message, token, phone, useTimeWindow, windowStart, windowEnd } = req.body;

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'قائمة الأرقام مطلوبة' });
  }
  if (!message) return res.status(400).json({ error: 'نص الرسالة مطلوب' });
  if (!token) return res.status(400).json({ error: 'رمز المصادقة مطلوب' });

  const campaignId = uuidv4();
  const db = getDb();
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO campaigns (campaign_id, user_token, message, total_numbers, status, phone_number, control_status,
        use_time_window, window_start, window_end)
       VALUES ($1, $2, $3, $4, 'pending', $5, 'active', $6, $7, $8)`,
      [campaignId, token, message, numbers.length, phone || null,
       useTimeWindow ? 1 : 0, windowStart || null, windowEnd || null]
    );

    for (const num of numbers) {
      await client.query(
        `INSERT INTO campaign_numbers (campaign_id, phone_number, status, retry_count) VALUES ($1, $2, 'pending', 0)`,
        [campaignId, num]
      );
    }

    await client.query('COMMIT');

    startBackgroundSending(campaignId).catch(err => console.error(`خطأ في حملة ${campaignId}:`, err));

    res.status(201).json({ success: true, campaignId, message: 'تم إنشاء الحملة وبدأ الإرسال' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('خطأ في إنشاء الحملة:', error);
    res.status(500).json({ error: 'فشل في إنشاء الحملة' });
  } finally {
    client.release();
  }
});

app.get('/api/campaigns/:campaignId', async (req, res) => {
  const { campaignId } = req.params;
  const db = getDb();
  try {
    const campaignRes = await db.query(
      `SELECT campaign_id, status, total_numbers, sent_count, failed_count, current_index,
              created_at, updated_at, message, phone_number, control_status,
              use_time_window, window_start, window_end
       FROM campaigns WHERE campaign_id = $1`,
      [campaignId]
    );
    if (campaignRes.rows.length === 0) return res.status(404).json({ error: 'الحملة غير موجودة' });

    const campaign = campaignRes.rows[0];
    const numbersRes = await db.query(
      `SELECT phone_number, status, error_message, sent_at, retry_count
       FROM campaign_numbers WHERE campaign_id = $1 ORDER BY id`,
      [campaignId]
    );

    let countdown = null;
    const timer = countdownTimers.get(campaignId);
    if (timer && campaign.status === 'processing' && campaign.control_status === 'active') {
      const remaining = Math.max(0, timer.endTime - Date.now());
      if (remaining > 0) {
        countdown = {
          minutes: Math.floor(remaining / 60000),
          seconds: Math.floor((remaining % 60000) / 1000),
          totalSeconds: Math.floor(remaining / 1000)
        };
      }
    }

    res.json({ ...campaign, numbers: numbersRes.rows, countdown });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'خطأ في استرجاع البيانات' });
  }
});

app.post('/api/campaigns/:campaignId/pause', async (req, res) => {
  const db = getDb();
  await db.query(`UPDATE campaigns SET control_status = 'paused', status = 'paused' WHERE campaign_id = $1`, [req.params.campaignId]);
  clearCountdown(req.params.campaignId);
  res.json({ success: true });
});

app.post('/api/campaigns/:campaignId/resume', async (req, res) => {
  const db = getDb();
  await db.query(`UPDATE campaigns SET control_status = 'active', status = 'processing' WHERE campaign_id = $1`, [req.params.campaignId]);
  startBackgroundSending(req.params.campaignId).catch(console.error);
  res.json({ success: true });
});

app.post('/api/campaigns/:campaignId/cancel', async (req, res) => {
  const db = getDb();
  await db.query(`UPDATE campaigns SET control_status = 'cancelled', status = 'cancelled' WHERE campaign_id = $1`, [req.params.campaignId]);
  clearCountdown(req.params.campaignId);
  res.json({ success: true });
});

app.put('/api/campaigns/:campaignId/timewindow', async (req, res) => {
  const { campaignId } = req.params;
  const { useTimeWindow, windowStart, windowEnd } = req.body;
  const db = getDb();

  try {
    await db.query(
      `UPDATE campaigns SET 
        use_time_window = $1,
        window_start = $2,
        window_end = $3,
        updated_at = CURRENT_TIMESTAMP
       WHERE campaign_id = $4`,
      [useTimeWindow ? 1 : 0, windowStart || null, windowEnd || null, campaignId]
    );
    
    const campaignRes = await db.query(`SELECT status FROM campaigns WHERE campaign_id = $1`, [campaignId]);
    if (campaignRes.rows.length > 0 && campaignRes.rows[0].status === 'waiting_window') {
      startBackgroundSending(campaignId).catch(console.error);
    }
    
    res.json({ success: true, message: 'تم تحديث النافذة الزمنية' });
  } catch (error) {
    console.error('خطأ في تحديث النافذة الزمنية:', error);
    res.status(500).json({ error: 'فشل تحديث النافذة الزمنية' });
  }
});

app.get('/ping', (req, res) => res.send('OK'));

app.listen(port, () => console.log(`🚀 الخادم يعمل على المنفذ ${port}`));
