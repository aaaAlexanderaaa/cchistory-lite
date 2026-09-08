export {
  discoverDefaultSourcesForHost,
  discoverHostToolsForHost,
  getDefaultSources,
  getDefaultSourcesForHost,
  getSourceFormatProfiles,
  runSourceProbe,
  streamSourceProbe,
  projectFileSessionInputs,
  deriveSourceFileLogicalSessionKey,
  inspectSourceFileLogicalSessionMetadata,
  inspectSourceFilesLogicalSessionMetadata,
  getBuiltinMaskTemplates,
  inspectSourceFileInventory,
  listSourceFiles,
} from "./core/legacy.js";
export { buildStageRuns } from "./core/projections.js";
export {
  createSourceFileReadPlan,
  assertSourceFileReadPlanCurrent,
  SourceFileReadPlanChangedError,
} from "./core/file-read-plan.js";
export type { SourceFileReadPlan } from "./core/file-read-plan.js";
export { selectSourceSessionFiles } from "./core/probe.js";
export { selectTailBlob } from "@cchistory/domain";
export { applyMaskTemplates } from "./masks.js";
export { listPlatformAdapters, listPlatformAdaptersBySupportTier, listStablePlatformAdapters } from "./platforms/registry.js";
export {
  inspectGrokChatHistoryCatalog,
  parseGrokSessionLayout,
  previewSourceFileWorkingDirectory,
  resolveGrokSiblingSessionChatHistory,
} from "./platforms/grok.js";
export {
  sanitizeClaudeProjectFolder,
  sourceFileMayMatchDirectoryScope,
} from "./core/directory-preview.js";
export type { HostDiscoveryCandidate, HostDiscoveryEntry } from "./core/legacy.js";
export type { SourceFileInventory } from "./core/legacy.js";
export type { SourceFileLogicalSessionMetadata } from "./core/legacy.js";
export type { SourceProbeProgressEvent, SourceProbeProgressStage, SourceProbeEvent, SourceProbeFileChunk, SourceProbeFileSkipReason } from "./core/types.js";
export type {
  AdapterProjectionBoundary,
  AdapterSupportTier,
  PlatformAdapter,
  SupportedSourcePlatform,
} from "./platforms/types.js";

export { inspectCodexActivityEvidence, type CodexActivityEvidence } from "./platforms/codex/activity-evidence.js";

export { SourceReadBudgetExceededError } from "./core/read-budget.js";
export type { SourceReadBudget } from "./core/read-budget.js";
