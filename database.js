const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let db;

async function initializeDatabase() {
  db = await open({
    filename: path.join(__dirname, 'campaigns.db'),
    driver: sqlite3.Database
  });

  // جدول الحملات الرئيسية
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

  // جدول الأرقام المفردة
  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      sent_at DATETIME,
      retry_count INTEGER DEFAULT 0,
      FOREIGN KEY (campaign_id) REFERENCES campaigns (campaign_id)
    )
  `);

  // التأكد من وجود عمود retry_count (للجداول القديمة)
  const tableInfo = await db.all(`PRAGMA table_info(campaign_numbers)`);
  const hasRetryCount = tableInfo.some(col => col.name === 'retry_count');
  
  if (!hasRetryCount) {
    console.log('جاري إضافة عمود retry_count إلى جدول campaign_numbers...');
    await db.exec(`ALTER TABLE campaign_numbers ADD COLUMN retry_count INTEGER DEFAULT 0`);
    console.log('تمت إضافة العمود بنجاح.');
  }

  console.log('قاعدة البيانات جاهزة.');
}

function getDb() {
  return db;
}

module.exports = { initializeDatabase, getDb };
