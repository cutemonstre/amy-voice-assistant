-- Round 3: long-term memory (the remember / forget tools) and the web sources a reply cited.

CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT NOT NULL,          -- one short fact, e.g. "Sam is learning Mandarin"
  session_id  TEXT,                   -- where it was learned (no FK: memories outlive deleted sessions)
  created_at  INTEGER NOT NULL
);

-- assistant messages: the links a web-searched reply cited, as JSON [{"title": "...", "url": "..."}] (NULL when it did not search)
ALTER TABLE messages ADD COLUMN sources TEXT;
