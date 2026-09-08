SELECT id, title, last_message_at FROM sessions
WHERE is_top_level = TRUE AND turn_count > 0
ORDER BY last_message_at DESC NULLS LAST
LIMIT $1;
