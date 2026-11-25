CREATE TABLE IF NOT EXISTS sb_items (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL CHECK (board IN ('moodboard', 'styleboard')),
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'site')),
  gx INTEGER NOT NULL,
  gy INTEGER NOT NULL,
  gw INTEGER NOT NULL,
  gh INTEGER NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  natw REAL,
  nath REAL,
  natr REAL
);
CREATE INDEX IF NOT EXISTS sb_items_board_id ON sb_items(board, id);
