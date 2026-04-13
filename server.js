const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { initializeDatabase, getDb } = require('./database');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// تخزين مؤقت لمواعيد العد التنازلي (للحملات النشطة)
const countdownTimers = new Map(); // campaignId -> { endTime, timeoutId }

// تهيئة قاعدة البيانات
initializeDatabase().catch(console.error);

// ========== دوال مساعدة ==========

// إرسال تقرير عبر واتساب (نفس API الإرسال)
async function sendWhatsAppReport(to, body, token) {
  const url = 'https://whatsapp.tkwin.com.sa/api/v1/send';
  const payload = { to, message: body };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    console.log(`WhatsApp report sent to ${to}`);
    return response.data;
  } catch (error) {
    console.error(`Failed to send WhatsApp report to ${to}:`, error.message);
    // لا نرمي الخطأ لأن التقرير اختياري ولا نريد تعطيل الحملة
  }
}

// دالة إرسال رسالة واتساب واحدة مع إعادة المحاولة الذكية
async function sendWhatsAppMessage(to, message, token, maxRetries = 3) {
  const url = 'https://whatsapp.tkwin.com.sa/api/v1/send';
  const payload = { to, message };
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      // نجاح
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;

      // إذا كان الخطأ 429 (تجاوز حد السرعة) أو 403 (قد يكون حظر مؤقت) وحاولنا أقل من الحد الأقصى
      if ((status === 429 || status === 403) && attempt < maxRetries) {
        // حساب زمن الانتظار: 2^attempt ثواني (2، 4، 8 ثوان)
        const waitSeconds = Math.pow(2, attempt);
        console.log(`⏳ محاولة ${attempt}/${maxRetries} فشلت للرقم ${to} (${status}). الانتظار ${waitSeconds} ثواني...`);
        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        continue;
      }
      // إذا كان خطأ آخر أو انتهت المحاولات، ارمِ الخطأ
      break;
    }
  }
  // إذا وصلنا هنا، جميع المحاولات فشلت
  throw lastError;
}

// دالة تنفيذ الإرسال في الخلفية (معدلة لدعم الإيقاف المؤقت/الإلغاء)
async function startBackgroundSending(campaignId) {
  const db = getDb();

  await db.run(
    `UPDATE campaigns SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
    [campaignId]
  );

  let numbers = await db.all(
    `SELECT id, phone_number FROM campaign_numbers
     WHERE campaign_id = ? AND status = 'pending'
     ORDER BY id`,
    [campaignId]
  );

  let campaign = await db.get(
    `SELECT user_token, message, phone_number, control_status FROM campaigns WHERE campaign_id = ?`,
    [campaignId]
  );

  if (!campaign) return;

  let index = 0;
  while (index < numbers.length) {
    const currentCampaign = await db.get(
      `SELECT control_status, status FROM campaigns WHERE campaign_id = ?`,
      [campaignId]
    );
    
    if (currentCampaign.control_status === 'cancelled') {
      await db.run(
        `UPDATE campaigns SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
        [campaignId]
      );
      clearCountdown(campaignId);
      return;
    }
    
    if (currentCampaign.control_status === 'paused') {
      await db.run(
        `UPDATE campaigns SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
        [campaignId]
      );
      clearCountdown(campaignId);
      return;
    }

    const { id, phone_number } = numbers[index];

    await db.run(
      `UPDATE campaigns SET current_index = ? WHERE campaign_id = ?`,
      [index + 1, campaignId]
    );

    try {
      await sendWhatsAppMessage(phone_number, campaign.message, campaign.user_token);
      
      await db.run(
        `UPDATE campaign_numbers SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id]
      );
      await db.run(
        `UPDATE campaigns SET sent_count = sent_count + 1, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
        [campaignId]
      );
    } catch (error) {
      console.error(`❌ فشل نهائي للإرسال إلى ${phone_number}:`, error.message);
      await db.run(
        `UPDATE campaign_numbers SET status = 'failed', error_message = ? WHERE id = ?`,
        [error.message, id]
      );
      await db.run(
        `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
        [campaignId]
      );
    }

    index++;

    if (index >= numbers.length) break;

    // تأخير عشوائي بين 3 و 13 دقيقة
    const minDelay = 3 * 60 * 1000;
    const maxDelay = 13 * 60 * 1000;
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    
    const endTime = Date.now() + delay;
    countdownTimers.set(campaignId, { endTime, timeoutId: null });
    
    let remaining = delay;
    while (remaining > 0) {
      const check = await db.get(
        `SELECT control_status FROM campaigns WHERE campaign_id = ?`,
        [campaignId]
      );
      if (check.control_status === 'paused' || check.control_status === 'cancelled') {
        clearCountdown(campaignId);
        await db.run(
          `UPDATE campaigns SET current_index = ?, status = ? WHERE campaign_id = ?`,
          [index, check.control_status === 'paused' ? 'paused' : 'cancelled', campaignId]
        );
        return;
      }
      const sleep = Math.min(1000, remaining);
      await new Promise(resolve => setTimeout(resolve, sleep));
      remaining -= sleep;
    }
    
    countdownTimers.delete(campaignId);
  }

  // إنهاء الحملة
  const final = await db.get(
    `SELECT sent_count, failed_count, total_numbers, phone_number, user_token FROM campaigns WHERE campaign_id = ?`,
    [campaignId]
  );
  let finalStatus = 'completed';
  if (final.failed_count === final.total_numbers) finalStatus = 'failed';
  
  await db.run(
    `UPDATE campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
    [finalStatus, campaignId]
  );

  // إرسال تقرير واتساب إذا طلب المستخدم
  if (final.phone_number) {
    const report = `📊 تقرير حملة ${campaignId}\n✅ تم الإرسال بنجاح: ${final.sent_count}\n❌ فشل: ${final.failed_count}\n📋 الإجمالي: ${final.total_numbers}`;
    await sendWhatsAppReport(final.phone_number, report, final.user_token);
  }
}

function clearCountdown(campaignId) {
  countdownTimers.delete(campaignId);
}

// ========== نقاط النهاية API ==========

app.post('/api/campaigns', async (req, res) => {
  const { numbers, message, token, phone } = req.body;

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'قائمة الأرقام مطلوبة' });
  }
  if (!message) {
    return res.status(400).json({ error: 'نص الرسالة مطلوب' });
  }
  if (!token) {
    return res.status(400).json({ error: 'رمز المصادقة (Bearer Token) مطلوب' });
  }

  const campaignId = uuidv4();
  const db = getDb();

  try {
    await db.run('BEGIN TRANSACTION');

    await db.run(
      `INSERT INTO campaigns (campaign_id, user_token, message, total_numbers, status, phone_number, control_status)
       VALUES (?, ?, ?, ?, 'pending', ?, 'active')`,
      [campaignId, token, message, numbers.length, phone || null]
    );

    const stmt = await db.prepare(
      `INSERT INTO campaign_numbers (campaign_id, phone_number, status) VALUES (?, ?, 'pending')`
    );
    for (const num of numbers) {
      await stmt.run(campaignId, num);
    }
    await stmt.finalize();

    await db.run('COMMIT');

    startBackgroundSending(campaignId).catch(err => {
      console.error(`Campaign ${campaignId} failed:`, err);
    });

    res.status(201).json({
      success: true,
      campaignId,
      message: 'تم إنشاء الحملة وبدأ الإرسال'
    });
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('Error creating campaign:', error);
    res.status(500).json({ error: 'فشل في إنشاء الحملة' });
  }
});

app.get('/api/campaigns/:campaignId', async (req, res) => {
  const { campaignId } = req.params;
  const db = getDb();

  try {
    const campaign = await db.get(
      `SELECT campaign_id, status, total_numbers, sent_count, failed_count, current_index,
              created_at, updated_at, message, phone_number, control_status
       FROM campaigns WHERE campaign_id = ?`,
      [campaignId]
    );

    if (!campaign) {
      return res.status(404).json({ error: 'الحملة غير موجودة' });
    }

    const numbers = await db.all(
      `SELECT phone_number, status, error_message, sent_at
       FROM campaign_numbers
       WHERE campaign_id = ?
       ORDER BY id`,
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

    res.json({
      ...campaign,
      numbers,
      countdown
    });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({ error: 'خطأ في استرجاع البيانات' });
  }
});

app.post('/api/campaigns/:campaignId/pause', async (req, res) => {
  const { campaignId } = req.params;
  const db = getDb();
  try {
    await db.run(
      `UPDATE campaigns SET control_status = 'paused', status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
      [campaignId]
    );
    clearCountdown(campaignId);
    res.json({ success: true, message: 'تم الإيقاف المؤقت' });
  } catch (error) {
    res.status(500).json({ error: 'فشل الإيقاف' });
  }
});

app.post('/api/campaigns/:campaignId/resume', async (req, res) => {
  const { campaignId } = req.params;
  const db = getDb();
  try {
    await db.run(
      `UPDATE campaigns SET control_status = 'active', status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
      [campaignId]
    );
    startBackgroundSending(campaignId).catch(console.error);
    res.json({ success: true, message: 'تم الاستئناف' });
  } catch (error) {
    res.status(500).json({ error: 'فشل الاستئناف' });
  }
});

app.post('/api/campaigns/:campaignId/cancel', async (req, res) => {
  const { campaignId } = req.params;
  const db = getDb();
  try {
    await db.run(
      `UPDATE campaigns SET control_status = 'cancelled', status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
      [campaignId]
    );
    clearCountdown(campaignId);
    res.json({ success: true, message: 'تم الإلغاء' });
  } catch (error) {
    res.status(500).json({ error: 'فشل الإلغاء' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
