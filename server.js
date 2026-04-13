const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { initializeDatabase, getDb } = require('./database');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// تهيئة قاعدة البيانات
initializeDatabase().catch(console.error);

// واجهة بدء حملة جديدة
app.post('/api/campaigns', async (req, res) => {
  const { numbers, message, token } = req.body;

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
    // بدء معاملة
    await db.run('BEGIN TRANSACTION');

    // إدراج الحملة
    await db.run(
      `INSERT INTO campaigns (campaign_id, user_token, message, total_numbers, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [campaignId, token, message, numbers.length]
    );

    // إدراج الأرقام
    const stmt = await db.prepare(
      `INSERT INTO campaign_numbers (campaign_id, phone_number, status) VALUES (?, ?, 'pending')`
    );
    for (const num of numbers) {
      await stmt.run(campaignId, num);
    }
    await stmt.finalize();

    await db.run('COMMIT');

    // بدء عملية الإرسال في الخلفية (غير متزامنة)
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

// واجهة استرجاع معلومات حملة (للمتابعة)
app.get('/api/campaigns/:campaignId', async (req, res) => {
  const { campaignId } = req.params;
  const db = getDb();

  try {
    const campaign = await db.get(
      `SELECT campaign_id, status, total_numbers, sent_count, failed_count, current_index,
              created_at, updated_at, message
       FROM campaigns WHERE campaign_id = ?`,
      [campaignId]
    );

    if (!campaign) {
      return res.status(404).json({ error: 'الحملة غير موجودة' });
    }

    // جلب قائمة الأرقام مع حالتها
    const numbers = await db.all(
      `SELECT phone_number, status, error_message, sent_at
       FROM campaign_numbers
       WHERE campaign_id = ?
       ORDER BY id`,
      [campaignId]
    );

    res.json({
      ...campaign,
      numbers
    });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({ error: 'خطأ في استرجاع البيانات' });
  }
});

// دالة تنفيذ الإرسال في الخلفية
async function startBackgroundSending(campaignId) {
  const db = getDb();

  // تحديث الحالة إلى processing
  await db.run(
    `UPDATE campaigns SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
    [campaignId]
  );

  // جلب الأرقام المعلقة
  const numbers = await db.all(
    `SELECT id, phone_number FROM campaign_numbers
     WHERE campaign_id = ? AND status = 'pending'
     ORDER BY id`,
    [campaignId]
  );

  // جلب بيانات الحملة (للتوكن والرسالة)
  const campaign = await db.get(
    `SELECT user_token, message FROM campaigns WHERE campaign_id = ?`,
    [campaignId]
  );

  if (!campaign) return;

  for (let i = 0; i < numbers.length; i++) {
    const { id, phone_number } = numbers[i];

    try {
      // إرسال الرسالة
      await sendWhatsAppMessage(phone_number, campaign.message, campaign.user_token);

      // تحديث الرقم كمرسل
      await db.run(
        `UPDATE campaign_numbers SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id]
      );
      // زيادة عداد المرسل في الحملة
      await db.run(
        `UPDATE campaigns SET sent_count = sent_count + 1, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
        [campaignId]
      );
    } catch (error) {
      console.error(`Failed to send to ${phone_number}:`, error.message);
      // تحديث الرقم كفاشل
      await db.run(
        `UPDATE campaign_numbers SET status = 'failed', error_message = ? WHERE id = ?`,
        [error.message, id]
      );
      await db.run(
        `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
        [campaignId]
      );
    }

    // تحديث المؤشر الحالي
    await db.run(
      `UPDATE campaigns SET current_index = ? WHERE campaign_id = ?`,
      [i + 1, campaignId]
    );

    // تأخير عشوائي بين 3 و 13 دقيقة (باستثناء آخر رقم)
    if (i < numbers.length - 1) {
      const minDelay = 3 * 60 * 1000;
      const maxDelay = 13 * 60 * 1000;
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // تحديث الحالة النهائية
  const finalStatus = await db.get(
    `SELECT sent_count, failed_count, total_numbers FROM campaigns WHERE campaign_id = ?`,
    [campaignId]
  );
  let status = 'completed';
  if (finalStatus.failed_count === finalStatus.total_numbers) status = 'failed';
  else if (finalStatus.sent_count === 0) status = 'failed';

  await db.run(
    `UPDATE campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
    [status, campaignId]
  );
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
    timeout: 30000 // 30 ثانية
  });

  return response.data;
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
