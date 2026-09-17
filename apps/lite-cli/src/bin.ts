#!/usr/bin/env node

import { runWithAdaptiveHeap, settleLauncherExit } from "@cchistory/live-runtime/bootstrap";

settleLauncherExit(runWithAdaptiveHeap(async () => {
  const { runLiteCli } = await import("./index.js");
  return runLiteCli(process.argv.slice(2));
}));
