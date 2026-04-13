const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let db;

async function initializeDatabase() {
  db = await open({
    filename: path.join(__dirname, 'campaigns.db'),
    driver: sqlite3.Database
  });

  // جدول الحملات الرئيسية – أضفنا أعمدة للهاتف وحالة التحكم
  await db.exec(`
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // جدول الأرقام المفردة (بدون تغيير)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      sent_at DATETIME,
      FOREIGN KEY (campaign_id) REFERENCES campaigns (campaign_id)
    )
  `);

  console.log('Database initialized with new fields.');
}

function getDb() {
  return db;
}

module.exports = { initializeDatabase, getDb };
