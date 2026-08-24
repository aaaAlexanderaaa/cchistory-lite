#!/usr/bin/env node

import { runWithAdaptiveNodeMemory, settleLauncherExit } from "@cchistory/live-runtime/bootstrap";

settleLauncherExit(runWithAdaptiveNodeMemory(async () => {
  const { runLiteTui } = await import("./index.js");
  return runLiteTui(process.argv.slice(2));
}));
