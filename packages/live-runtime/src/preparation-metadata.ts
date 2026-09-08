import type { SourceDefinition } from "@cchistory/domain";
import {
  assertSourceFileReadPlanCurrent,
  createSourceFileReadPlan,
  inspectSourceFilesLogicalSessionMetadata,
  type SourceFileLogicalSessionMetadata,
  type SourceFileReadPlan,
} from "@cchistory/source-adapters";

type InspectFiles = typeof inspectSourceFilesLogicalSessionMetadata;
type InspectOptions = NonNullable<Parameters<InspectFiles>[2]>;

interface MetadataEntry {
  metadata: SourceFileLogicalSessionMetadata;
  evidence: SourceFileReadPlan;
}

/** Owned by one scan attempt; never shared with a refresh or another query session. */
export class PreparationMetadata {
  private readonly entries = new Map<string, MetadataEntry>();

  constructor(private readonly inspectFiles: InspectFiles = inspectSourceFilesLogicalSessionMetadata) {}

  async inspect(
    source: SourceDefinition,
    files: readonly string[],
    options: InspectOptions,
  ): Promise<{ metadata: SourceFileLogicalSessionMetadata[]; evidence: readonly SourceFileReadPlan[] }> {
    // First cwd and full canonical cwd can disagree. Identity-only is a third contract.
    const mode = options.includeWorkspaceMetadata === false
      ? "identity"
      : options.workspaceScan === "first" ? "workspace-first" : "workspace-full";
    const key = (file: string) => JSON.stringify([source.id, source.platform, file, mode]);
    const reused = new Map<SourceFileReadPlan, string[]>();
    const missing: string[] = [];
    for (const file of new Set(files)) {
      const entry = this.entries.get(key(file));
      if (!entry) {
        missing.push(file);
        continue;
      }
      const paths = reused.get(entry.evidence) ?? [];
      paths.push(file);
      reused.set(entry.evidence, paths);
    }
    // A changed version ends this attempt; silently refreshing one cached row
    // would mix new evidence with earlier selection decisions.
    for (const [evidence, paths] of reused) await assertSourceFileReadPlanCurrent(evidence, paths);
    const evidence = [...reused.keys()];
    if (missing.length > 0) {
      const readPlan = await createSourceFileReadPlan(source, missing, true);
      const metadata = await this.inspectFiles(source.platform, missing, options);
      await assertSourceFileReadPlanCurrent(readPlan);
      if (metadata.length !== missing.length) throw new Error("Metadata inspection did not return one result per file.");
      for (const [index, file] of missing.entries()) {
        this.entries.set(key(file), { metadata: copyMetadata(metadata[index]!), evidence: readPlan });
      }
      evidence.push(readPlan);
    }
    return {
      metadata: files.map((file) => copyMetadata(this.entries.get(key(file))!.metadata)),
      evidence,
    };
  }
}

function copyMetadata(metadata: SourceFileLogicalSessionMetadata): SourceFileLogicalSessionMetadata {
  return {
    ...metadata,
    ...(metadata.relatedSessionRefs ? { relatedSessionRefs: [...metadata.relatedSessionRefs] } : {}),
  };
}
