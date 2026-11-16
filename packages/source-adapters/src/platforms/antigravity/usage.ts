import type { TokenUsageMetrics } from "@cchistory/domain";
import { scalar, type ProtoField } from "./protobuf.js";

/** ModelUsageStats input excludes cache; output includes thinking. Field 1 is
 * the model enum. Field 3 is aggregate output, 9/10 are its breakdown. */
export function decodeAntigravityUsage(fields: ProtoField[], model?: string): TokenUsageMetrics | undefined {
  const input = scalar(fields, 2);
  const reasoning = scalar(fields, 9);
  const response = scalar(fields, 10);
  const output = scalar(fields, 3) ?? (response !== undefined || reasoning !== undefined ? (response ?? 0) + (reasoning ?? 0) : undefined);
  const cacheWrite = scalar(fields, 4);
  const cacheRead = scalar(fields, 5);
  if ([input, output, cacheWrite, cacheRead, reasoning].every(value => value === undefined)) return undefined;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    cache_creation_input_tokens: cacheWrite ?? 0,
    cache_read_input_tokens: cacheRead ?? 0,
    reasoning_output_tokens: reasoning,
    model: model ?? (scalar(fields, 1) !== undefined ? `antigravity-model-${scalar(fields, 1)}` : undefined),
  };
}
