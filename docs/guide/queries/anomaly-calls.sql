-- Top anomalous model calls sorted by adjusted USD cost.
-- Example: cchistory-lite query --sql-file docs/guide/queries/anomaly-calls.sql --params '[20]' --no-dir
SELECT
  session_id,
  parent_session_id,
  seq,
  role,
  model,
  context_input_tokens,
  cache_hit_ratio,
  miss_cause,
  primary_tool,
  anomaly_kinds,
  adjusted_cost_usd
FROM calls
WHERE anomaly_kinds IS NOT NULL
ORDER BY adjusted_cost_usd DESC, total_tokens DESC
LIMIT $1;
