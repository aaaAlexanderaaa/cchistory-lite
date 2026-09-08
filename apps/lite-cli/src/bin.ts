#!/usr/bin/env node

import { settleLauncherExit } from "@cchistory/live-runtime/bootstrap";

settleLauncherExit((async () => {
  const { runLiteCli } = await import("./index.js");
  return runLiteCli(process.argv.slice(2));
})());
