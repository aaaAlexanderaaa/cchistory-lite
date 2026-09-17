#!/usr/bin/env node

import { runWithAdaptiveHeap, settleLauncherExit } from "@cchistory/live-runtime/bootstrap";

settleLauncherExit(runWithAdaptiveHeap(async () => {
  const { runLiteTui } = await import("./index.js");
  return runLiteTui(process.argv.slice(2));
}));
