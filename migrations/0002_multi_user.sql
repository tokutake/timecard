-- 利用者テーブル（Cloudflare Access で認証されたメールアドレスごとに 1 行）
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- 記録の所有者。既存の記録は user_id が NULL のまま残り、どの利用者からも見えない
ALTER TABLE records ADD COLUMN user_id INTEGER REFERENCES users (id);

CREATE INDEX IF NOT EXISTS idx_records_user_clock_in ON records (user_id, clock_in);
