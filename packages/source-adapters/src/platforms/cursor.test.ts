import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDefaultSourcesForHost, listSourceFiles, runSourceProbe, streamSourceProbe } from "../index.js";
import { 
  seedCursorStyleStateDb, 
  seedCursorPromptHistoryDb, 
  createSourceDefinition,
  getRepoMockDataRoot 
} from "../test-helpers.js";
import { encodeCursorProjectDirectoryName } from "./cursor/runtime.js";

test("encodeCursorProjectDirectoryName slugifies the way Cursor names ~/.cursor/projects folders", () => {
  assert.equal(encodeCursorProjectDirectoryName("/Users/test/my_app"), "Users-test-my-app");
  assert.equal(encodeCursorProjectDirectoryName("/Users/test/app.name"), "Users-test-app-name");
  assert.equal(encodeCursorProjectDirectoryName("c:/Users/test/my_app"), "c-Users-test-my-app");
  assert.equal(
    encodeCursorProjectDirectoryName("/Users/test/my_opensource/.worktrees/fix-cursor-parsing"),
    "Users-test-my-opensource-worktrees-fix-cursor-parsing",
  );
});

test("getDefaultSourcesForHost prefers official macOS Cursor and Antigravity user-data roots", () => {
  const homeDir = "/Users/tester";
  const sources = getDefaultSourcesForHost({
    homeDir,
    platform: "darwin",
    pathExists(targetPath) {
      return (
        targetPath === path.join(homeDir, "Library", "Application Support", "Cursor", "User") ||
        targetPath === path.join(homeDir, "Library", "Application Support", "Antigravity", "User")
      );
    },
  });

  const cursorSource = sources.find((source) => source.platform === "cursor");
  const antigravitySource = sources.find((source) => source.platform === "antigravity");

  assert.equal(cursorSource?.base_dir, path.join(homeDir, "Library", "Application Support", "Cursor", "User"));
  assert.equal(
    antigravitySource?.base_dir,
    path.join(homeDir, "Library", "Application Support", "Antigravity", "User"),
  );
  assert.equal(sources.some((source) => source.platform === "opencode"), false);
});

test("getDefaultSourcesForHost prefers official Windows Cursor and Antigravity user-data roots", () => {
  const homeDir = "C:/Users/tester";
  const appDataDir = "C:/Users/tester/AppData/Roaming";
  const sources = getDefaultSourcesForHost({
    homeDir,
    appDataDir,
    platform: "win32",
    pathExists(targetPath) {
      return (
        targetPath === path.join(appDataDir, "Cursor", "User") ||
        targetPath === path.join(appDataDir, "Antigravity", "User")
      );
    },
  });

  const cursorSource = sources.find((source) => source.platform === "cursor");
  const antigravitySource = sources.find((source) => source.platform === "antigravity");

  assert.equal(cursorSource?.base_dir, path.join(appDataDir, "Cursor", "User"));
  assert.equal(antigravitySource?.base_dir, path.join(appDataDir, "Antigravity", "User"));
});

test("getDefaultSourcesForHost keeps Cursor project transcripts but prefers official Antigravity user roots over brain artifacts", () => {
  const homeDir = "/Users/tester";
  const sources = getDefaultSourcesForHost({
    homeDir,
    platform: "darwin",
    pathExists(targetPath) {
      return (
        targetPath === path.join(homeDir, ".cursor", "projects") ||
        targetPath === path.join(homeDir, ".gemini", "antigravity", "brain") ||
        targetPath === path.join(homeDir, "Library", "Application Support", "Antigravity", "User")
      );
    },
  });

  const cursorSource = sources.find((source) => source.platform === "cursor");
  const antigravitySource = sources.find((source) => source.platform === "antigravity");

  assert.equal(cursorSource?.base_dir, path.join(homeDir, ".cursor", "projects"));
  assert.equal(
    antigravitySource?.base_dir,
    path.join(homeDir, "Library", "Application Support", "Antigravity", "User"),
  );
});

test("runSourceProbe ingests Cursor agent transcripts from project history roots", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-source-adapters-"));

  try {
    const sessionId = "cursor-transcript-session";
    const transcriptDir = path.join(tempRoot, ".cursor", "projects", "workspace-a", "agent-transcripts", sessionId);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      [
        {
          role: "user",
          title: "Cursor transcript fixture",
          content: "Investigate Cursor transcript ingestion.",
        },
        {
          role: "assistant",
          updatedAt: "2026-03-10T08:00:01.000Z",
          usage: {
            inputTokens: 6,
            outputTokens: 4,
            totalTokens: 10,
          },
          stopReason: "end_turn",
          content: "Cursor transcript ingestion is working.",
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );

    const [payload] = (
      await runSourceProbe(
        {},
        [createSourceDefinition("src-cursor-transcript", "cursor", path.join(tempRoot, ".cursor", "projects"))],
      )
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.contexts.length, 1);
    assert.match(payload.turns[0]?.canonical_text ?? "", /Cursor transcript ingestion/);
    const projectObservation = payload.candidates.find((candidate) => candidate.candidate_kind === "project_observation");
    assert.equal(projectObservation?.evidence.source_native_project_ref, "workspace-a");
    assert.ok(
      payload.atoms.some(
        (atom) => atom.actor_kind === "assistant" && typeof atom.payload.text === "string" && atom.payload.text.includes("is working"),
      ),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe ingests Cursor chat-store metadata and minimal readable fragments as an experimental slice", async () => {
  const mockDataRoot = getRepoMockDataRoot();
  const source = createSourceDefinition("src-cursor-chat-store", "cursor", path.join(mockDataRoot, ".cursor", "chats"));

  const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;

  assert.ok(payload);
  assert.equal(payload.source.sync_status, "healthy");
  assert.equal(payload.sessions.length, 3);
  assert.equal(payload.turns.length, 3);
  assert.equal(payload.contexts.length, 3);
  assert.equal(payload.sessions.every((session) => session.working_directory === undefined), true);
  assert.equal(payload.sessions.some((session) => session.title === "MCP Service Guide"), true);
  assert.equal(payload.sessions.some((session) => session.title === "Custom API Settings"), true);
  assert.equal(payload.sessions.some((session) => session.title === "Requirement Review"), true);
  assert.equal(payload.turns.some((turn) => turn.canonical_text.includes("Research stable MCP servers")), true);
  assert.equal(payload.turns.some((turn) => turn.canonical_text.includes("Design a simple API settings panel")), true);
  assert.equal(payload.turns.some((turn) => turn.canonical_text.includes("Read @requirement.md")), true);
  assert.ok(
    payload.contexts.some((context) =>
      context.assistant_replies.some((reply) => reply.content.includes("Prefer filesystem, fetch, and GitHub examples")),
    ),
  );
  assert.ok(
    payload.loss_audits.some((audit) => audit.diagnostic_code === "cursor_chat_store_blob_graph_opaque"),
  );
});

test("runSourceProbe falls back to Cursor prompt history with workspace-linked synthetic sessions", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-source-adapters-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    const workspaceDir = path.join(cursorUserDir, "workspaceStorage", "cursor-prompt-history");
    await mkdir(workspaceDir, { recursive: true });

    seedCursorPromptHistoryDb(path.join(workspaceDir, "state.vscdb"), {
      title: "Cursor prompt history",
      prompt: "Inspect the Cursor prompt fallback.",
      observedAt: "2026-03-10T10:00:00.000Z",
    });
    await writeFile(
      path.join(workspaceDir, "workspace.json"),
      JSON.stringify({ folder: "/workspace/cursor-prompt-history" }),
      "utf8",
    );

    const [payload] = (
      await runSourceProbe(
        { limit_files_per_source: 1 },
        [createSourceDefinition("src-cursor-prompt-history", "cursor", cursorUserDir)],
      )
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.contexts.length, 1);
    assert.equal(payload.sessions[0]?.working_directory, "/workspace/cursor-prompt-history");
    assert.equal(payload.turns[0]?.session_id, payload.sessions[0]?.id);
    assert.equal(payload.turns[0]?.canonical_text, "Inspect the Cursor prompt fallback.");
    assert.equal(payload.contexts[0]?.assistant_replies.length, 0);
    assert.ok(payload.candidates.some((candidate) => candidate.candidate_kind === "project_observation"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe skips unreadable Cursor global state DBs and still ingests workspaceStorage", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-source-adapters-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    const workspaceDir = path.join(cursorUserDir, "workspaceStorage", "cursor-workspace");
    const globalDir = path.join(cursorUserDir, "globalStorage");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });

    seedCursorStyleStateDb(path.join(workspaceDir, "state.vscdb"), {
      workspacePath: "/workspace/cursor-priority",
      composerId: "cursor-priority",
      title: "Cursor priority fixture",
      storageMode: "composerData",
    });
    await writeFile(path.join(workspaceDir, "workspace.json"), JSON.stringify({ folder: "/workspace/cursor-priority" }), "utf8");
    await writeFile(path.join(globalDir, "state.vscdb"), "not-a-sqlite-database", "utf8");

    const [payload] = (
      await runSourceProbe(
        { limit_files_per_source: 2 },
        [createSourceDefinition("src-cursor-priority", "cursor", cursorUserDir)],
      )
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.sessions[0]?.working_directory, "/workspace/cursor-priority");
    assert.ok(
      payload.blobs.some((blob) => blob.origin_path === path.join(globalDir, "state.vscdb")),
      "expected unreadable globalStorage DB to remain visible as a captured blob",
    );
    assert.ok(
      payload.loss_audits.some(
        (audit) =>
          audit.detail.includes("Failed to process captured source file") &&
          audit.stage_kind === "extract_records",
      ),
      "expected unreadable DB to produce a loss audit instead of aborting the source probe",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe prioritizes Cursor workspaceStorage before globalStorage when file limits apply", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-source-adapters-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    const workspaceDir = path.join(cursorUserDir, "workspaceStorage", "cursor-workspace");
    const globalDir = path.join(cursorUserDir, "globalStorage");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(globalDir, { recursive: true });

    seedCursorStyleStateDb(path.join(workspaceDir, "state.vscdb"), {
      workspacePath: "/workspace/cursor-limited",
      composerId: "cursor-limited",
      title: "Cursor limited fixture",
      storageMode: "composerData",
    });
    await writeFile(path.join(workspaceDir, "workspace.json"), JSON.stringify({ folder: "/workspace/cursor-limited" }), "utf8");
    await writeFile(path.join(globalDir, "state.vscdb"), "not-a-sqlite-database", "utf8");

    const [payload] = (
      await runSourceProbe(
        { limit_files_per_source: 1 },
        [createSourceDefinition("src-cursor-limited", "cursor", cursorUserDir)],
      )
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.blobs.length, 1);
    assert.equal(payload.blobs[0]?.origin_path, path.join(workspaceDir, "state.vscdb"));
    assert.equal(payload.sessions[0]?.working_directory, "/workspace/cursor-limited");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("listSourceFiles walks Cursor project transcripts, User state DBs, and chat stores together", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-roots-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const chatsRoot = path.join(tempRoot, ".cursor", "chats");
    const userRoot = path.join(tempRoot, "Library", "Application Support", "Cursor", "User");
    const transcriptPath = path.join(
      projectsRoot,
      "workspace-a",
      "agent-transcripts",
      "sess-a",
      "sess-a.jsonl",
    );
    const storePath = path.join(chatsRoot, "abc123", "agent-a", "store.db");
    const statePath = path.join(userRoot, "workspaceStorage", "ws-a", "state.vscdb");

    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await mkdir(path.dirname(storePath), { recursive: true });
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({ role: "user", content: "Hello from transcript." })}\n`, "utf8");
    await writeFile(storePath, "not-a-sqlite-database", "utf8");
    await writeFile(statePath, "not-a-sqlite-database", "utf8");

    const cursorSource = getDefaultSourcesForHost({
      homeDir: tempRoot,
      platform: "darwin",
    }).find((source) => source.platform === "cursor");
    assert.ok(cursorSource);
    assert.equal(cursorSource.base_dir, projectsRoot);

    const files = await listSourceFiles("cursor", cursorSource.base_dir);
    assert.equal(files.includes(transcriptPath), true);
    assert.equal(files.includes(statePath), true);
    assert.equal(files.includes(storePath), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe probes an oversized Cursor state DB instead of skipping it", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-oversized-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    const workspaceDir = path.join(cursorUserDir, "workspaceStorage", "cursor-oversized");
    await mkdir(workspaceDir, { recursive: true });
    const dbPath = path.join(workspaceDir, "state.vscdb");
    seedCursorStyleStateDb(dbPath, {
      workspacePath: "/workspace/cursor-oversized",
      composerId: "cursor-oversized",
      title: "Cursor oversized fixture",
      storageMode: "composerData",
    });
    const padding = new DatabaseSync(dbPath);
    try {
      padding.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("padding", "x".repeat(1024));
    } finally {
      padding.close();
    }
    await writeFile(path.join(workspaceDir, "workspace.json"), JSON.stringify({ folder: "/workspace/cursor-oversized" }), "utf8");
    const dbSize = (await stat(dbPath)).size;
    assert.ok(dbSize > 256, "fixture sqlite must exceed the test size cap");

    const source = createSourceDefinition("src-cursor-oversized", "cursor", cursorUserDir);
    const probeOptions = {
      source_ids: [source.id],
      max_file_bytes: 256,
    };
    const [payload] = (await runSourceProbe(probeOptions, [source])).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.source.error_message, undefined);
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Inspect Cursor oversized fixture.");

    const fileEvents = [];
    for await (const event of streamSourceProbe(probeOptions, [source])) {
      if (event.kind === "file_error" || event.kind === "file_skip" || event.kind === "file_chunk") {
        fileEvents.push(event);
      }
    }
    assert.equal(fileEvents.filter((event) => event.kind === "file_error" || event.kind === "file_skip").length, 0);
    const fileChunk = fileEvents.find((event) => event.kind === "file_chunk");
    assert.ok(fileChunk);
    assert.equal(fileChunk.kind, "file_chunk");
    for (const bytes of fileChunk.chunk.trusted_bytes_by_blob_id.values()) {
      assert.ok(
        bytes.byteLength < dbSize,
        `oversized sqlite must not be fully materialized (${bytes.byteLength} >= ${dbSize})`,
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe projects Cursor composer workspace path, model, and unwrapped user_query text", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-usable-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    await mkdir(path.join(cursorUserDir, "globalStorage"), { recursive: true });
    seedCursorComposerUsableMetadataDb(path.join(cursorUserDir, "globalStorage", "state.vscdb"), {
      composerId: "composer-usable",
      title: "Cursor usable composer",
      workspacePath: "/Users/test/my_app",
      modelName: "composer-2",
      userText: [
        "<timestamp>label: Saturday, Aug 15, 2026, 6:32 PM (UTC+8)</timestamp>",
        "<user_query>",
        "Inspect the Cursor workspace path.",
        "</user_query>",
      ].join("\n"),
      assistantText: "Workspace path loaded.",
    });

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-usable", "cursor", cursorUserDir)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/my_app");
    assert.equal(payload.sessions[0]?.model, "composer-2");
    assert.equal(payload.turns[0]?.canonical_text, "Inspect the Cursor workspace path.");
    assert.doesNotMatch(payload.turns[0]?.canonical_text ?? "", /<timestamp>|<user_query>/u);
    assert.doesNotMatch(payload.sessions[0]?.title ?? "", /<timestamp>|<user_query>/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe maps Cursor composerHeaders workspaceId to workspaceStorage folder", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-workspace-id-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    const workspaceId = "ws-storage-usable";
    await mkdir(path.join(cursorUserDir, "globalStorage"), { recursive: true });
    await mkdir(path.join(cursorUserDir, "workspaceStorage", workspaceId), { recursive: true });
    seedCursorComposerWorkspaceIdDb(path.join(cursorUserDir, "globalStorage", "state.vscdb"), {
      composerId: "composer-workspace-id",
      workspaceId,
      title: "Cursor workspace id composer",
      userText: "Inspect the mapped workspace folder.",
      assistantText: "Mapped workspace folder loaded.",
    });
    await writeFile(
      path.join(cursorUserDir, "workspaceStorage", workspaceId, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/test/mapped_app" }),
      "utf8",
    );

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-workspace-id", "cursor", cursorUserDir)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/mapped_app");
    assert.equal(payload.turns[0]?.canonical_text, "Inspect the mapped workspace folder.");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe unwraps Cursor transcript prompts and resolves encoded project directories", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-transcript-path-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const encodedProject = "Users-test-my-app";
    const sessionId = "cursor-transcript-usable";
    const transcriptDir = path.join(projectsRoot, encodedProject, "agent-transcripts", sessionId);
    const workspaceDir = path.join(
      tempRoot,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "workspaceStorage",
      "ws-transcript",
    );
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      [
        {
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: [
                  "<timestamp>label: Saturday, Aug 15, 2026, 6:32 PM (UTC+8)</timestamp>",
                  "<user_query>",
                  "Inspect the Cursor transcript prompt.",
                  "</user_query>",
                ].join("\n"),
              },
            ],
          },
        },
        {
          role: "assistant",
          message: {
            content: [{ type: "text", text: "Cursor transcript prompt loaded." }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspaceDir, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/test/my_app" }),
      "utf8",
    );

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-transcript-path", "cursor", projectsRoot)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/my_app");
    assert.equal(payload.turns[0]?.canonical_text, "Inspect the Cursor transcript prompt.");
    assert.doesNotMatch(payload.turns[0]?.canonical_text ?? "", /<timestamp>|<user_query>/u);
    assert.doesNotMatch(payload.sessions[0]?.title ?? "", /<timestamp>|<user_query>/u);
    assert.equal(
      payload.fragments.filter((fragment) => fragment.fragment_kind === "workspace_signal").length,
      1,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe does not mint a basename session for an oversized Cursor state DB with no composer seeds", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-empty-oversized-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    const workspaceDir = path.join(cursorUserDir, "workspaceStorage", "cursor-empty-oversized");
    await mkdir(workspaceDir, { recursive: true });
    const dbPath = path.join(workspaceDir, "state.vscdb");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
      db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("padding", "x".repeat(1024));
    } finally {
      db.close();
    }
    const dbSize = (await stat(dbPath)).size;
    assert.ok(dbSize > 256, "fixture sqlite must exceed the test size cap");

    const [payload] = (
      await runSourceProbe(
        { max_file_bytes: 256 },
        [createSourceDefinition("src-cursor-empty-oversized", "cursor", cursorUserDir)],
      )
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.error_message, undefined);
    assert.equal(payload.sessions.some((session) => session.id === "sess:cursor:state"), false);
    assert.equal(payload.sessions.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe does not mint basename sessions for small seedless Cursor sqlite containers", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-empty-small-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const transcriptDir = path.join(projectsRoot, "workspace-a", "agent-transcripts", "sess-a");
    const userDir = path.join(tempRoot, "Library", "Application Support", "Cursor", "User");
    const workspaceDir = path.join(userDir, "workspaceStorage", "ws-empty");
    const chatsStoreDir = path.join(tempRoot, ".cursor", "chats", "opaque-chat", "agent-a");
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(chatsStoreDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, "sess-a.jsonl"),
      `${JSON.stringify({ role: "user", content: "Keep the transcript session." })}\n`,
      "utf8",
    );
    seedSeedlessCursorStateDb(path.join(workspaceDir, "state.vscdb"));
    seedOpaqueCursorChatStore(path.join(chatsStoreDir, "store.db"));

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-empty-small", "cursor", projectsRoot)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.error_message, undefined);
    assert.equal(payload.sessions.some((session) => session.id === "sess:cursor:state"), false);
    assert.equal(payload.sessions.some((session) => session.id === "sess:cursor:store"), false);
    assert.equal(
      payload.turns.some((turn) => turn.canonical_text === "phantom from sqlite bytes"),
      false,
    );
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.some((turn) => turn.canonical_text === "Keep the transcript session."), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("listSourceFiles does not crawl Cursor User History for state.vscdb decoys", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-user-walk-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const userRoot = path.join(tempRoot, "Library", "Application Support", "Cursor", "User");
    const workspaceStatePath = path.join(userRoot, "workspaceStorage", "ws-a", "state.vscdb");
    const historyDecoyPath = path.join(userRoot, "History", "state.vscdb");
    await mkdir(path.dirname(workspaceStatePath), { recursive: true });
    await mkdir(path.dirname(historyDecoyPath), { recursive: true });
    await writeFile(workspaceStatePath, "not-a-sqlite-database", "utf8");
    await writeFile(historyDecoyPath, "not-a-sqlite-database", "utf8");

    const filesFromProjects = await listSourceFiles("cursor", projectsRoot);
    assert.equal(filesFromProjects.includes(workspaceStatePath), true);
    assert.equal(filesFromProjects.includes(historyDecoyPath), false);

    const filesFromUser = await listSourceFiles("cursor", userRoot);
    assert.equal(filesFromUser.includes(workspaceStatePath), true);
    assert.equal(filesFromUser.includes(historyDecoyPath), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe keeps one Cursor turn when composer bubbles and agent transcripts share a session id", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-dup-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const composerId = "composer-shared-session";
    const transcriptDir = path.join(
      projectsRoot,
      "Users-test-my-app",
      "agent-transcripts",
      composerId,
    );
    const userDir = path.join(tempRoot, "Library", "Application Support", "Cursor", "User");
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(path.join(userDir, "globalStorage"), { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${composerId}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "Inspect from transcript." }] },
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Transcript reply." }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );
    seedCursorComposerUsableMetadataDb(path.join(userDir, "globalStorage", "state.vscdb"), {
      composerId,
      title: "Cursor shared composer",
      workspacePath: "/Users/test/my_app",
      modelName: "composer-2",
      userText: "Inspect from composer.",
      assistantText: "Composer reply.",
    });

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-dup", "cursor", projectsRoot)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Inspect from composer.");
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/my_app");
    assert.equal(payload.sessions[0]?.model, "composer-2");
    assert.equal(
      payload.blobs.some((blob) => blob.origin_path.endsWith(`${composerId}.jsonl`)),
      true,
    );
    assert.equal(
      payload.blobs.some((blob) => blob.origin_path.endsWith("state.vscdb")),
      true,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe keeps extra transcript turns when they outnumber composer bubbles", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-richer-transcript-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const composerId = "composer-richer-transcript";
    const transcriptDir = path.join(projectsRoot, "Users-test-my-app", "agent-transcripts", composerId);
    const userDir = path.join(tempRoot, "Library", "Application Support", "Cursor", "User");
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(path.join(userDir, "globalStorage"), { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${composerId}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "Inspect from transcript." }] },
          createdAt: "2026-03-10T03:30:00.000Z",
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Transcript reply." }] },
          createdAt: "2026-03-10T03:30:01.000Z",
        },
        {
          role: "user",
          message: { content: [{ type: "text", text: "Follow up from transcript." }] },
          createdAt: "2026-03-10T03:31:00.000Z",
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Second transcript reply." }] },
          createdAt: "2026-03-10T03:31:01.000Z",
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );
    seedCursorComposerUsableMetadataDb(path.join(userDir, "globalStorage", "state.vscdb"), {
      composerId,
      title: "Cursor shared composer",
      workspacePath: "/Users/test/my_app",
      modelName: "composer-2",
      userText: "Inspect from composer.",
      assistantText: "Composer reply.",
    });

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-richer-transcript", "cursor", projectsRoot)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 2);
    assert.equal(payload.turns.some((turn) => turn.canonical_text === "Follow up from transcript."), true);
    assert.equal(payload.sessions[0]?.title, "Cursor shared composer");
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/my_app");
    assert.equal(payload.sessions[0]?.model, "composer-2");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe keeps extra transcript turns when composer has more tool bubbles but fewer user asks", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-tool-heavy-composer-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const composerId = "composer-tool-heavy";
    const transcriptDir = path.join(projectsRoot, "Users-test-my-app", "agent-transcripts", composerId);
    const userDir = path.join(tempRoot, "Library", "Application Support", "Cursor", "User");
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(path.join(userDir, "globalStorage"), { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${composerId}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "Inspect from transcript." }] },
          createdAt: "2026-03-10T03:30:00.000Z",
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Transcript reply." }] },
          createdAt: "2026-03-10T03:30:01.000Z",
        },
        {
          role: "user",
          message: { content: [{ type: "text", text: "Follow up from transcript." }] },
          createdAt: "2026-03-10T03:31:00.000Z",
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Second transcript reply." }] },
          createdAt: "2026-03-10T03:31:01.000Z",
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );
    seedCursorComposerUsableMetadataDb(path.join(userDir, "globalStorage", "state.vscdb"), {
      composerId,
      title: "Cursor tool-heavy composer",
      workspacePath: "/Users/test/my_app",
      modelName: "composer-2",
      userText: "Inspect from composer.",
      assistantText: "Composer reply.",
      extraBubbles: [
        { bubbleId: "bubble-tool-1", type: 2, text: "Searching files." },
        { bubbleId: "bubble-tool-2", type: 2, text: "Reading a file." },
        { bubbleId: "bubble-tool-3", type: 2, text: "Running a command." },
      ],
    });

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-tool-heavy", "cursor", projectsRoot)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 2);
    assert.equal(payload.turns.some((turn) => turn.canonical_text === "Follow up from transcript."), true);
    assert.equal(payload.sessions[0]?.title, "Cursor tool-heavy composer");
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/my_app");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe resolves Cursor composer bubbles stored as composer-prefixed cursorDiskKV keys", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-disk-kv-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    const workspaceDir = path.join(cursorUserDir, "globalStorage");
    await mkdir(workspaceDir, { recursive: true });
    const dbPath = path.join(workspaceDir, "state.vscdb");
    seedCursorComposerPrefixedBubblesDb(dbPath, {
      headerComposerId: "composer-with-headers",
      orphanComposerId: "composer-without-headers",
    });

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-disk-kv", "cursor", cursorUserDir)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 2);
    assert.equal(payload.turns.length, 2);
    assert.equal(
      payload.turns.some((turn) => turn.canonical_text.includes("Inspect composer-prefixed bubbles.")),
      true,
    );
    assert.equal(
      payload.turns.some((turn) => turn.canonical_text.includes("Inspect headerless composer bubbles.")),
      true,
    );
    assert.ok(
      payload.contexts.some((context) =>
        context.assistant_replies.some((reply) => reply.content.includes("Composer-prefixed bubbles loaded.")),
      ),
    );
    assert.ok(
      payload.contexts.some((context) =>
        context.assistant_replies.some((reply) => reply.content.includes("Headerless composer bubbles loaded.")),
      ),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe keeps one Cursor turn when composerData and allComposers share a composer id", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-both-keys-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    await mkdir(path.join(cursorUserDir, "globalStorage"), { recursive: true });
    seedCursorComposerBothKeyFormatsDb(path.join(cursorUserDir, "globalStorage", "state.vscdb"), {
      composerId: "composer-both-keys",
      title: "Cursor both key formats",
      userText: "Inspect from both composer keys.",
      assistantText: "Both composer keys loaded.",
    });

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-both-keys", "cursor", cursorUserDir)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Inspect from both composer keys.");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe keeps one Cursor turn when global and workspace composer DBs share a composer id", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-global-workspace-"));

  try {
    const cursorUserDir = path.join(tempRoot, "Cursor", "User");
    const workspaceDir = path.join(cursorUserDir, "workspaceStorage", "ws-shared");
    await mkdir(path.join(cursorUserDir, "globalStorage"), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    seedCursorComposerUsableMetadataDb(path.join(cursorUserDir, "globalStorage", "state.vscdb"), {
      composerId: "composer-global-workspace",
      title: "Cursor global composer",
      workspacePath: "/Users/test/global_app",
      modelName: "composer-2",
      userText: "Inspect from global composer.",
      assistantText: "Global composer loaded.",
    });
    seedCursorComposerUsableMetadataDb(path.join(workspaceDir, "state.vscdb"), {
      composerId: "composer-global-workspace",
      title: "Cursor workspace composer",
      workspacePath: "/Users/test/workspace_app",
      modelName: "composer-2",
      userText: "Inspect from workspace composer.",
      assistantText: "Workspace composer loaded.",
    });
    await writeFile(
      path.join(workspaceDir, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/test/workspace_app" }),
      "utf8",
    );

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-global-workspace", "cursor", cursorUserDir)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Inspect from workspace composer.");
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/workspace_app");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe keeps workspace composer metadata when a later global composer overlaps a transcript", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-three-way-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const composerId = "composer-three-way";
    const transcriptDir = path.join(projectsRoot, "Users-test-workspace-app", "agent-transcripts", composerId);
    const userDir = path.join(tempRoot, "Library", "Application Support", "Cursor", "User");
    const workspaceDir = path.join(userDir, "workspaceStorage", "ws-three-way");
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(path.join(userDir, "globalStorage"), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${composerId}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "Inspect from transcript." }] },
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Transcript reply." }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );
    seedCursorComposerUsableMetadataDb(path.join(userDir, "globalStorage", "state.vscdb"), {
      composerId,
      title: "Cursor global composer",
      workspacePath: "/Users/test/global_app",
      modelName: "composer-global",
      userText: "Inspect from global composer.",
      assistantText: "Global composer loaded.",
    });
    seedCursorComposerUsableMetadataDb(path.join(workspaceDir, "state.vscdb"), {
      composerId,
      title: "Cursor workspace composer",
      workspacePath: "/Users/test/workspace_app",
      modelName: "composer-workspace",
      userText: "Inspect from workspace composer.",
      assistantText: "Workspace composer loaded.",
    });
    await writeFile(
      path.join(workspaceDir, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/test/workspace_app" }),
      "utf8",
    );

    const [payload] = (
      await runSourceProbe({}, [createSourceDefinition("src-cursor-three-way", "cursor", projectsRoot)])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0]?.title, "Cursor workspace composer");
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/workspace_app");
    assert.equal(payload.sessions[0]?.model, "composer-workspace");
    assert.equal(payload.turns[0]?.canonical_text, "Inspect from workspace composer.");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function seedCursorComposerUsableMetadataDb(
  dbPath: string,
  options: {
    composerId: string;
    title: string;
    workspacePath: string;
    modelName: string;
    userText: string;
    assistantText: string;
    extraBubbles?: Array<{ bubbleId: string; type: number; text: string }>;
  },
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insertComposer(insert, {
      composerId: options.composerId,
      title: options.title,
      includeHeaders: true,
      userBubbleId: "bubble-user-usable",
      assistantBubbleId: "bubble-assistant-usable",
      userText: options.userText,
      assistantText: options.assistantText,
      workspacePath: options.workspacePath,
      modelName: options.modelName,
      extraBubbles: options.extraBubbles,
    });
  } finally {
    db.close();
  }
}

function seedCursorComposerWorkspaceIdDb(
  dbPath: string,
  options: {
    composerId: string;
    workspaceId: string;
    title: string;
    userText: string;
    assistantText: string;
  },
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
    db.exec(
      "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT)",
    );
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insertComposer(insert, {
      composerId: options.composerId,
      title: options.title,
      includeHeaders: true,
      userBubbleId: "bubble-user-workspace-id",
      assistantBubbleId: "bubble-assistant-workspace-id",
      userText: options.userText,
      assistantText: options.assistantText,
      workspaceIdentifier: { id: options.workspaceId },
    });
    db.prepare(
      "INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      options.composerId,
      options.workspaceId,
      1,
      1,
      0,
      0,
      1,
      1,
      JSON.stringify({
        composerId: options.composerId,
        name: options.title,
        workspaceIdentifier: { id: options.workspaceId },
      }),
    );
  } finally {
    db.close();
  }
}

function seedCursorComposerBothKeyFormatsDb(
  dbPath: string,
  options: {
    composerId: string;
    title: string;
    userText: string;
    assistantText: string;
  },
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insertComposer(insert, {
      composerId: options.composerId,
      title: options.title,
      includeHeaders: true,
      userBubbleId: "bubble-user-both-keys",
      assistantBubbleId: "bubble-assistant-both-keys",
      userText: options.userText,
      assistantText: options.assistantText,
    });
    insert.run(
      "composer.composerData",
      JSON.stringify({
        allComposers: [
          {
            composerId: options.composerId,
            name: options.title,
            fullConversationHeadersOnly: [
              { bubbleId: "bubble-user-both-keys", type: 1 },
              { bubbleId: "bubble-assistant-both-keys", type: 2 },
            ],
          },
        ],
      }),
    );
  } finally {
    db.close();
  }
}

function seedCursorComposerPrefixedBubblesDb(
  dbPath: string,
  options: { headerComposerId: string; orphanComposerId: string },
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insertComposer(insert, {
      composerId: options.headerComposerId,
      title: "Composer prefixed bubbles",
      includeHeaders: true,
      userBubbleId: "bubble-user-1",
      assistantBubbleId: "bubble-assistant-1",
      userText: "Inspect composer-prefixed bubbles.",
      assistantText: "Composer-prefixed bubbles loaded.",
    });
    insertComposer(insert, {
      composerId: options.orphanComposerId,
      title: "Headerless composer bubbles",
      includeHeaders: false,
      userBubbleId: "bubble-user-2",
      assistantBubbleId: "bubble-assistant-2",
      userText: "Inspect headerless composer bubbles.",
      assistantText: "Headerless composer bubbles loaded.",
    });
  } finally {
    db.close();
  }
}

function insertComposer(
  insert: { run(key: string, value: string): unknown },
  options: {
    composerId: string;
    title: string;
    includeHeaders: boolean;
    userBubbleId: string;
    assistantBubbleId: string;
    userText: string;
    assistantText: string;
    workspacePath?: string;
    modelName?: string;
    workspaceIdentifier?: Record<string, unknown>;
    extraBubbles?: Array<{ bubbleId: string; type: number; text: string }>;
  },
): void {
  const extraBubbles = options.extraBubbles ?? [];
  insert.run(
    `composerData:${options.composerId}`,
    JSON.stringify({
      composerId: options.composerId,
      name: options.title,
      modelConfig: options.modelName ? { maxMode: false, modelName: options.modelName } : undefined,
      workspaceIdentifier:
        options.workspaceIdentifier ??
        (options.workspacePath
          ? {
              id: "ws-from-path",
              uri: {
                $mid: 1,
                fsPath: options.workspacePath,
                path: options.workspacePath,
                scheme: "file",
              },
            }
          : undefined),
      fullConversationHeadersOnly: options.includeHeaders
        ? [
            { bubbleId: options.userBubbleId, type: 1 },
            { bubbleId: options.assistantBubbleId, type: 2 },
            ...extraBubbles.map((bubble) => ({ bubbleId: bubble.bubbleId, type: bubble.type })),
          ]
        : [],
    }),
  );
  insert.run(
    `bubbleId:${options.composerId}:${options.userBubbleId}`,
    JSON.stringify({
      bubbleId: options.userBubbleId,
      type: 1,
      createdAt: "2026-03-10T03:30:00.000Z",
      text: options.userText,
    }),
  );
  insert.run(
    `bubbleId:${options.composerId}:${options.assistantBubbleId}`,
    JSON.stringify({
      bubbleId: options.assistantBubbleId,
      type: 2,
      createdAt: "2026-03-10T03:30:01.000Z",
      text: options.assistantText,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      stopReason: "end_turn",
    }),
  );
  extraBubbles.forEach((bubble, index) => {
    insert.run(
      `bubbleId:${options.composerId}:${bubble.bubbleId}`,
      JSON.stringify({
        bubbleId: bubble.bubbleId,
        type: bubble.type,
        createdAt: `2026-03-10T03:30:0${2 + index}.000Z`,
        text: bubble.text,
      }),
    );
  });
}

function seedSeedlessCursorStateDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "padding",
      `\n{"role":"user","content":"phantom from sqlite bytes"}\n`,
    );
  } finally {
    db.close();
  }
}

function seedOpaqueCursorChatStore(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE blobs (id TEXT, data BLOB)");
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "0",
      Buffer.from(JSON.stringify({ agentId: "opaque-agent", name: "Opaque store" }), "utf8").toString("hex"),
    );
  } finally {
    db.close();
  }
}

