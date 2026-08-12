import { parentPort } from "node:worker_threads";
import type { SourcePlatform } from "@cchistory/domain";
import { inspectSourceFileLogicalSessionMetadata } from "./session-grouping.js";

interface SessionMetadataWorkerRequest {
  index: number;
  platform: SourcePlatform;
  filePath: string;
  options?: { includeWorkspaceMetadata?: boolean };
}

const port = parentPort;
if (!port) throw new Error("Logical-session metadata worker requires a parent port.");

port.on("message", async (request: SessionMetadataWorkerRequest) => {
  const metadata = await inspectSourceFileLogicalSessionMetadata(request.platform, request.filePath, request.options);
  port.postMessage({ index: request.index, metadata });
});
