SELECT id FROM sessions WHERE is_top_level = TRUE
ORDER BY last_message_at DESC NULLS LAST LIMIT $1 OFFSET $2;
