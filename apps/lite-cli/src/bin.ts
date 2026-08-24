#!/usr/bin/env node

import { runWithAdaptiveNodeMemory, settleLauncherExit } from "@cchistory/live-runtime/bootstrap";

settleLauncherExit(runWithAdaptiveNodeMemory(async () => {
  const { runLiteCli } = await import("./index.js");
  return runLiteCli(process.argv.slice(2));
}));
