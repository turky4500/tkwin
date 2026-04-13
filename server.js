const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { initializeDatabase, getDb } = require('./database');

// مكتبة Twilio لإرسال SMS (اختياري)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log('Twilio configured – SMS reports enabled.');
} else {
  console.log('Twilio not configured – SMS reports disabled.');
}

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// تخزين مؤقت لمواعيد العد التنازلي (للحملات النشطة)
const countdownTimers = new Map(); // campaignId -> { endTime, timeoutId }

// تهيئة قاعدة البيانات
initializeDatabase().catch(console.error);

// ========== دوال مساعدة ==========

// إرسال رسالة SMS (باستخدام Twilio)
async function sendSMS(to, body) {
  if (!twilioClient) {
    console.log('SMS would be sent to:', to, 'Body:', body);
    return;
  }
  try {
    await twilioClient.messages.create({
      body,
      to,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    console.log(`SMS sent to ${to}`);
  } catch (error) {
    console.error('SMS failed:', error.message);
  }
}

// دالة إرسال رسالة واتساب واحدة
async function sendWhatsAppMessage(to, message, token) {
  const url = 'https://whatsapp.tkwin.com.sa/api/v1/send';
  const payload = { to, message };

  const response = await axios.post(url, payload, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  return response.data;
}

// دالة تنفيذ الإرسال في الخلفية (معدلة لدعم الإيقاف المؤقت/الإلغاء)
async function startBackgroundSending(campaignId) {
  const db = getDb();

  // تحديث الحالة إلى processing إذا كانت active
  await db.run(
    `UPDATE campaigns SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
    [campaignId]
  );

  // جلب الأرقام المعلقة
  let numbers = await db.all(
    `SELECT id, phone_number FROM campaign_numbers
     WHERE campaign_id = ? AND status = 'pending'
     ORDER BY id`,
    [campaignId]
  );

  // جلب بيانات الحملة
  let campaign = await db.get(
    `SELECT user_token, message, phone_number, control_status FROM campaigns WHERE campaign_id = ?`,
    [campaignId]
  );

  if (!campaign) return;

  let index = 0;
  while (index < numbers.length) {
    // التحقق من حالة التحكم قبل كل إرسال
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
      return; // سيتابع عند الاستئناف
    }

    const { id, phone_number } = numbers[index];

    // تحديث المؤشر الحالي
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
      console.error(`Failed to send to ${phone_number}:`, error.message);
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

    // إعادة جلب القائمة إذا تغيرت (في حال استؤنفت)
    if (index >= numbers.length) break;

    // تأخير عشوائي مع تفقد حالة التوقف كل ثانية (لمدة أقصاها 13 دقيقة)
    const minDelay = 3 * 60 * 1000;
    const maxDelay = 13 * 60 * 1000;
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    
    // تسجيل نهاية العد التنازلي
    const endTime = Date.now() + delay;
    countdownTimers.set(campaignId, { endTime, timeoutId: null });
    
    // الانتظار مع إمكانية الإيقاف المبكر
    let remaining = delay;
    while (remaining > 0) {
      // تحقق من حالة الحملة كل 1 ثانية
      const check = await db.get(
        `SELECT control_status FROM campaigns WHERE campaign_id = ?`,
        [campaignId]
      );
      if (check.control_status === 'paused' || check.control_status === 'cancelled') {
        // إلغاء العد التنازلي وحفظ التقدم
        clearCountdown(campaignId);
        // تحديث المؤشر ليكون قبل الرقم الحالي (لأنه لم يرسل بعد)
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
    
    // إزالة العداد بعد انتهاء المدة
    countdownTimers.delete(campaignId);
  }

  // إنهاء الحملة (مكتملة أو فشلت كلها)
  const final = await db.get(
    `SELECT sent_count, failed_count, total_numbers, phone_number FROM campaigns WHERE campaign_id = ?`,
    [campaignId]
  );
  let finalStatus = 'completed';
  if (final.failed_count === final.total_numbers) finalStatus = 'failed';
  
  await db.run(
    `UPDATE campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
    [finalStatus, campaignId]
  );

  // إرسال تقرير SMS إذا طلب المستخدم
  if (final.phone_number) {
    const report = `حملة ${campaignId} انتهت. تم إرسال ${final.sent_count} من ${final.total_numbers} بنجاح. فشل: ${final.failed_count}.`;
    await sendSMS(final.phone_number, report);
  }
}

// مساعد لمسح العداد التنازلي
function clearCountdown(campaignId) {
  const timer = countdownTimers.get(campaignId);
  if (timer) {
    countdownTimers.delete(campaignId);
  }
}

// ========== نقاط النهاية API ==========

// إنشاء حملة جديدة (يدعم رقم الجوال اختياري)
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

    // بدء الإرسال في الخلفية
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

// جلب تفاصيل حملة (للمتابعة) – مع العد التنازلي
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

    // إضافة العد التنازلي إن وجد
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

// إيقاف مؤقت
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

// استئناف
app.post('/api/campaigns/:campaignId/resume', async (req, res) => {
  const { campaignId } = req.params;
  const db = getDb();
  try {
    await db.run(
      `UPDATE campaigns SET control_status = 'active', status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
      [campaignId]
    );
    // إعادة تشغيل عملية الإرسال
    startBackgroundSending(campaignId).catch(console.error);
    res.json({ success: true, message: 'تم الاستئناف' });
  } catch (error) {
    res.status(500).json({ error: 'فشل الاستئناف' });
  }
});

// إلغاء نهائي
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
