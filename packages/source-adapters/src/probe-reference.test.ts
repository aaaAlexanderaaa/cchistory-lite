import { runSourceProbe as collectSourceProbe } from "./index.js";
import { interpretSessionEvidence } from "../../canonical/dist/index.js";
import type { ProbeOptions } from "./core/types.js";
import type { SourceDefinition } from "@cchistory/domain";

export { buildSubmissionGroups, buildTurnsAndContext } from "../../canonical/dist/session-interpreter.js";
export function runSourceProbe(options: ProbeOptions = {}, sources?: readonly SourceDefinition[]) {
  return collectSourceProbe(interpretSessionEvidence, options, sources);
}
