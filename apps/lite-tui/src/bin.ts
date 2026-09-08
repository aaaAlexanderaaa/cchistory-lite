#!/usr/bin/env node

import { settleLauncherExit } from "@cchistory/live-runtime/bootstrap";

settleLauncherExit((async () => {
  const { runLiteTui } = await import("./index.js");
  return runLiteTui(process.argv.slice(2));
})());
