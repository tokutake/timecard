CREATE TABLE IF NOT EXISTS records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clock_in    TEXT NOT NULL,   -- ISO 8601 (UTC)
  clock_out   TEXT             -- NULL while working
);

CREATE INDEX IF NOT EXISTS idx_records_clock_in ON records (clock_in);
