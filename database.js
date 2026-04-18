const { Pool } = require('pg');

// استخدام متغير البيئة DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // ضروري لـ Supabase
  }
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // جدول الحملات الرئيسية
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        campaign_id TEXT PRIMARY KEY,
        user_token TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        total_numbers INTEGER DEFAULT 0,
        sent_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        current_index INTEGER DEFAULT 0,
        phone_number TEXT,
        control_status TEXT DEFAULT 'active',
        use_time_window INTEGER DEFAULT 0,
        window_start TEXT,
        window_end TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // جدول الأرقام المفردة
    await client.query(`
      CREATE TABLE IF NOT EXISTS campaign_numbers (
        id SERIAL PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
        phone_number TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        sent_at TIMESTAMP,
        retry_count INTEGER DEFAULT 0
      )
    `);

    console.log('✅ تم الاتصال بقاعدة بيانات Supabase (PostgreSQL).');
  } catch (error) {
    console.error('❌ خطأ في تهيئة قاعدة البيانات:', error);
    throw error;
  } finally {
    client.release();
  }
}

function getDb() {
  return pool;
}

module.exports = { initializeDatabase, getDb };
