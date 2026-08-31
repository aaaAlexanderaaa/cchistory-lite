/**
 * Lite CLI version.
 *
 * Held as a constant rather than read from `package.json` at runtime: the
 * standalone release artifact ships only `apps/lite-cli/dist`, so there is no
 * manifest beside the entrypoint to read. Tests assert this value matches the
 * package manifest so the two cannot drift; `release-prepare.mjs` rewrites
 * this literal when cutting a release.
 */
export const VERSION = "0.4.3";
