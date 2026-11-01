-- Existing handles remain inert legacy data. New phone accounts need no handle.
-- Keep users, contact IDs, chats and sessions intact during this transition.
ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
