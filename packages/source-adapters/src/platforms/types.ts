import type { SourcePlatform } from "@cchistory/domain";

export type AdapterSupportTier = "stable" | "experimental";

/**
 * The smallest batch that can be projected without changing canonical
 * semantics. Every adapter declares this explicitly so the live runtime never
 * guesses that file-oriented storage is independently projectable.
 */
export type AdapterProjectionBoundary = "logical_session" | "source";

export type SupportedSourcePlatform =
  | "codex"
  | "claude_code"
  | "factory_droid"
  | "amp"
  | "cursor"
  | "antigravity"
  | "gemini"
  | "openclaw"
  | "opencode"
  | "lobechat"
  | "codebuddy"
  | "accio"
  | "zcode"
  | "kimi";

export interface DefaultSourceResolutionOptions {
  homeDir?: string;
  hostname?: string;
  platform?: NodeJS.Platform;
  appDataDir?: string;
  pathExists?: (targetPath: string) => boolean;
  includeMissing?: boolean;
}

export interface PlatformAdapter {
  platform: SupportedSourcePlatform;
  supportTier: AdapterSupportTier;
  getDefaultBaseDirCandidates(options: DefaultSourceResolutionOptions): string[];
  getSourceRoots?(baseDir: string): string[];
  matchesSourceFile(filePath: string): boolean;
  /** Describes how a targeted probe narrows work before canonical projection. */
  sessionTargeting: "file" | "container" | "hybrid";
  /**
   * Declares the adapter's minimum safe canonical projection batch. A source
   * boundary is the conservative default for formats whose files share
   * metadata, relations, or containers. A logical-session boundary may only
   * be used after parity with source-wide projection has been established.
   */
  projectionBoundary: AdapterProjectionBoundary;
  getSourceFilePriority?(filePath: string): number;
  getSupplementalSourceRoots?(baseDir: string): string[];
  getCompanionEvidencePaths?(baseDir: string, filePath: string): string[] | Promise<string[]>;
}

export function isSupportedSourcePlatform(platform: SourcePlatform): platform is SupportedSourcePlatform {
  return (
    platform === "codex" ||
    platform === "claude_code" ||
    platform === "factory_droid" ||
    platform === "amp" ||
    platform === "cursor" ||
    platform === "antigravity" ||
    platform === "gemini" ||
    platform === "openclaw" ||
    platform === "opencode" ||
    platform === "lobechat" ||
    platform === "codebuddy" ||
    platform === "accio" ||
    platform === "zcode" ||
    platform === "kimi"
  );
}
