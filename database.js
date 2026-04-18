const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    console.log('🔄 جاري الاتصال بقاعدة البيانات...');
    await client.query('SELECT NOW()');
    console.log('✅ تم الاتصال بقاعدة البيانات بنجاح.');

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
    console.log('✅ جدول campaigns جاهز.');

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
    console.log('✅ جدول campaign_numbers جاهز.');
  } catch (error) {
    console.error('❌ خطأ في تهيئة قاعدة البيانات:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function getClient() {
  return await pool.connect();
}

function getDb() {
  return pool;
}

module.exports = { initializeDatabase, getDb, getClient };
