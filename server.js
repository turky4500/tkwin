const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { initializeDatabase, getDb } = require('./database');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// تخزين مؤقت لمواعيد العد التنازلي (للحملات النشطة)
const countdownTimers = new Map(); // campaignId -> { endTime }

// أقصى عدد للمحاولات لكل رقم (بما فيها المحاولة الأولى)
const MAX_RETRIES = 3;

// تهيئة قاعدة البيانات
initializeDatabase().catch(console.error);

// ========== دوال مساعدة ==========

// إرسال تقرير عبر واتساب (يستخدم نفس التوكن)
async function sendWhatsAppReport(to, body, token) {
  const url = 'https://whatsapp.tkwin.com.sa/api/v1/send';
  const payload = { to, message: body };

  try {
    await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    console.log(`📨 تقرير واتساب أُرسل إلى ${to}`);
  } catch (error) {
    console.error(`❌ فشل إرسال التقرير إلى ${to}:`, error.message);
  }
}

// دالة إرسال رسالة واحدة (محاولة واحدة فقط)
async function sendSingleMessage(to, message, token) {
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

// دالة التأخير الذكي مع دعم الإيقاف المؤقت والإلغاء
async function waitWithControl(campaignId, delayMs) {
  const endTime = Date.now() + delayMs;
  countdownTimers.set(campaignId, { endTime });

  let remaining = delayMs;
  while (remaining > 0) {
    const db = getDb();
    const check = await db.get(
      `SELECT control_status FROM campaigns WHERE campaign_id = ?`,
      [campaignId]
    );
    
    // إذا تم إيقاف الحملة مؤقتاً أو إلغاؤها، نخرج من الانتظار
    if (check.control_status === 'paused' || check.control_status === 'cancelled') {
      countdownTimers.delete(campaignId);
      return false; // لم يكتمل الانتظار بسبب الإيقاف
    }
    
    const sleep = Math.min(1000, remaining);
    await new Promise(resolve => setTimeout(resolve, sleep));
    remaining -= sleep;
  }
  
  countdownTimers.delete(campaignId);
  return true; // اكتمل الانتظار بنجاح
}

// مسح العداد التنازلي
function clearCountdown(campaignId) {
  countdownTimers.delete(campaignId);
}

// ========== الدالة الرئيسية للإرسال في الخلفية (الترحيل الذكي) ==========
async function startBackgroundSending(campaignId) {
  const db = getDb();

  // تحديث الحالة إلى "قيد المعالجة"
  await db.run(
    `UPDATE campaigns SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
    [campaignId]
  );

  // جلب بيانات الحملة
  const campaign = await db.get(
    `SELECT user_token, message, phone_number, control_status FROM campaigns WHERE campaign_id = ?`,
    [campaignId]
  );
  if (!campaign) return;

  let round = 1; // الجولة الأولى للأرقام الجديدة، الجولة الثانية لإعادة المحاولة
  let keepRunning = true;

  while (keepRunning) {
    // التحقق من حالة التحكم قبل كل جولة
    const current = await db.get(
      `SELECT control_status, status FROM campaigns WHERE campaign_id = ?`,
      [campaignId]
    );
    
    if (current.control_status === 'cancelled') {
      await db.run(`UPDATE campaigns SET status = 'cancelled' WHERE campaign_id = ?`, [campaignId]);
      clearCountdown(campaignId);
      return;
    }
    
    if (current.control_status === 'paused') {
      await db.run(`UPDATE campaigns SET status = 'paused' WHERE campaign_id = ?`, [campaignId]);
      clearCountdown(campaignId);
      return;
    }

    // جلب الأرقام المطلوبة لهذه الجولة
    let numbers;
    if (round === 1) {
      // الجولة الأولى: الأرقام الجديدة (status = 'pending')
      numbers = await db.all(
        `SELECT id, phone_number, retry_count FROM campaign_numbers
         WHERE campaign_id = ? AND status = 'pending'
         ORDER BY id`,
        [campaignId]
      );
    } else {
      // الجولات التالية: الأرقام التي فشلت مؤقتاً (status = 'pending_retry') ولم تتجاوز الحد
      numbers = await db.all(
        `SELECT id, phone_number, retry_count FROM campaign_numbers
         WHERE campaign_id = ? AND status = 'pending_retry' AND retry_count < ?
         ORDER BY id`,
        [campaignId, MAX_RETRIES]
      );
    }

    // إذا لم تكن هناك أرقام في هذه الجولة
    if (numbers.length === 0) {
      if (round === 1) {
        round = 2; // ننتقل لجولة إعادة المحاولة
        continue;
      } else {
        keepRunning = false; // لا مزيد من الأرقام، ننهي الحملة
        break;
      }
    }

    // معالجة الأرقام واحداً تلو الآخر
    for (let i = 0; i < numbers.length; i++) {
      // إعادة فحص حالة التحكم قبل كل رقم
      const check = await db.get(
        `SELECT control_status FROM campaigns WHERE campaign_id = ?`,
        [campaignId]
      );
      
      if (check.control_status === 'paused') {
        // حفظ التقدم والخروج
        await db.run(
          `UPDATE campaigns SET current_index = ?, status = 'paused' WHERE campaign_id = ?`,
          [i, campaignId]
        );
        clearCountdown(campaignId);
        return;
      }
      
      if (check.control_status === 'cancelled') {
        await db.run(`UPDATE campaigns SET status = 'cancelled' WHERE campaign_id = ?`, [campaignId]);
        clearCountdown(campaignId);
        return;
      }

      const { id, phone_number, retry_count: currentRetries } = numbers[i];
      const attemptNumber = (currentRetries || 0) + 1;

      // تحديث المؤشر الحالي
      await db.run(
        `UPDATE campaigns SET current_index = ? WHERE campaign_id = ?`,
        [i + 1, campaignId]
      );

      try {
        // محاولة الإرسال
        await sendSingleMessage(phone_number, campaign.message, campaign.user_token);
        
        // نجاح - تحديث الرقم إلى "مرسل"
        await db.run(
          `UPDATE campaign_numbers SET status = 'sent', sent_at = CURRENT_TIMESTAMP, retry_count = ? WHERE id = ?`,
          [attemptNumber, id]
        );
        await db.run(
          `UPDATE campaigns SET sent_count = sent_count + 1 WHERE campaign_id = ?`,
          [campaignId]
        );
        
        console.log(`✅ ${phone_number} - نجح (محاولة ${attemptNumber})`);
        
      } catch (error) {
        const status = error.response?.status;
        // تحديد ما إذا كان الخطأ قابلاً لإعادة المحاولة
        const isRetryable = (status === 429 || status === 403 || status === 520);
        const shouldRetry = isRetryable && attemptNumber < MAX_RETRIES;

        if (shouldRetry) {
          // الخطأ مؤقت ولم نتجاوز الحد -> نضعه في وضع "انتظار إعادة المحاولة"
          await db.run(
            `UPDATE campaign_numbers SET status = 'pending_retry', retry_count = ?, error_message = ? WHERE id = ?`,
            [attemptNumber, `محاولة ${attemptNumber}: ${error.message}`, id]
          );
          console.log(`🔄 ${phone_number} - مؤجل للمحاولة ${attemptNumber + 1} (خطأ ${status})`);
        } else {
          // فشل نهائي
          await db.run(
            `UPDATE campaign_numbers SET status = 'failed', retry_count = ?, error_message = ? WHERE id = ?`,
            [attemptNumber, error.message, id]
          );
          await db.run(
            `UPDATE campaigns SET failed_count = failed_count + 1 WHERE campaign_id = ?`,
            [campaignId]
          );
          console.log(`❌ ${phone_number} - فشل نهائي (خطأ ${status})`);
        }
      }

      // تطبيق التأخير العشوائي بعد كل رقم، ما لم يكن هذا آخر رقم في آخر جولة
      const isLastInRound = (i === numbers.length - 1);
      const isLastRound = (round > 1 && numbers.length === 0) || keepRunning === false;
      
      if (!isLastInRound || !isLastRound) {
        // تأخير عشوائي بين 3 و 13 دقيقة
        const minDelay = 3 * 60 * 1000;
        const maxDelay = 13 * 60 * 1000;
        const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
        
        const mins = Math.floor(delay / 60000);
        const secs = Math.floor((delay % 60000) / 1000);
        console.log(`⏳ انتظار ${mins}:${secs.toString().padStart(2, '0')} قبل الرقم التالي...`);
        
        const continued = await waitWithControl(campaignId, delay);
        if (!continued) {
          // تم إيقاف الحملة أثناء الانتظار
          return;
        }
      }
    }

    // بعد انتهاء الجولة الأولى، ننتقل للجولة الثانية
    if (round === 1) {
      round = 2;
    } else {
      // بعد الجولة الثانية، نتحقق إذا كانت هناك أرقام متبقية للإعادة
      const remaining = await db.get(
        `SELECT COUNT(*) as count FROM campaign_numbers 
         WHERE campaign_id = ? AND status = 'pending_retry' AND retry_count < ?`,
        [campaignId, MAX_RETRIES]
      );
      keepRunning = remaining.count > 0;
    }
  }

  // ========== إنهاء الحملة ==========
  const final = await db.get(
    `SELECT sent_count, failed_count, total_numbers, phone_number, user_token 
     FROM campaigns WHERE campaign_id = ?`,
    [campaignId]
  );
  
  let finalStatus = 'completed';
  if (final.failed_count === final.total_numbers) finalStatus = 'failed';
  
  await db.run(
    `UPDATE campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?`,
    [finalStatus, campaignId]
  );

  console.log(`🏁 حملة ${campaignId} انتهت. ناجح: ${final.sent_count}, فاشل: ${final.failed_count}`);

  // إرسال تقرير واتساب إذا طلب المستخدم
  if (final.phone_number) {
    const report = `📊 تقرير حملة ${campaignId}\n✅ تم الإرسال بنجاح: ${final.sent_count}\n❌ فشل: ${final.failed_count}\n📋 الإجمالي: ${final.total_numbers}`;
    await sendWhatsAppReport(final.phone_number, report, final.user_token);
  }
}

// ========== نقاط النهاية API ==========

// إنشاء حملة جديدة
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
      `INSERT INTO campaign_numbers (campaign_id, phone_number, status, retry_count) VALUES (?, ?, 'pending', 0)`
    );
    for (const num of numbers) {
      await stmt.run(campaignId, num);
    }
    await stmt.finalize();

    await db.run('COMMIT');

    // بدء الإرسال في الخلفية
    startBackgroundSending(campaignId).catch(err => {
      console.error(`خطأ غير متوقع في حملة ${campaignId}:`, err);
    });

    res.status(201).json({
      success: true,
      campaignId,
      message: 'تم إنشاء الحملة وبدأ الإرسال'
    });
  } catch (error) {
    await db.run('ROLLBACK');
    console.error('خطأ في إنشاء الحملة:', error);
    res.status(500).json({ error: 'فشل في إنشاء الحملة' });
  }
});

// جلب تفاصيل حملة (للمتابعة)
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
      `SELECT phone_number, status, error_message, sent_at, retry_count
       FROM campaign_numbers
       WHERE campaign_id = ?
       ORDER BY id`,
      [campaignId]
    );

    // حساب العد التنازلي إن وجد
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
    console.error('خطأ في جلب الحملة:', error);
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

// نقطة نهاية لفحص النبض (Health Check)
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

// تشغيل الخادم
app.listen(port, () => {
  console.log(`🚀 الخادم يعمل على المنفذ ${port}`);
});
