#!/usr/bin/env python3
# Role: Unit tests for scripts/check_docs.py covering repository cleanliness and failure regressions.
# Out of scope: Modifying repository files or running Node package builds.

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from check_docs import run_checks  # noqa: E402


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def create_minimal_repo(tmp: Path) -> None:
    write_text(
        tmp / "AGENTS.md",
        "# Working here\n\nSee [Architecture](ARCHITECTURE.md#runtime-flow).\n",
    )
    write_text(
        tmp / "ARCHITECTURE.md",
        "# Architecture\n\n## Runtime flow\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
    )
    write_text(
        tmp / "README.md",
        "# Demo\n\n| Sources | **1** |\n\n## Supported sources\n\n| Slot | Tool | Default root | Tier |\n| --- | --- | --- | --- |\n| `codex` | Codex | `~/.codex` | stable |\n",
    )
    write_text(tmp / "PLAN.md", "# Plan\n")
    write_text(tmp / "docs/contracts/working-discipline.md", "# Discipline\n")
    write_text(tmp / "docs/guide/lite.md", "# Guide\n")
    write_text(tmp / "docs/research/README.md", "# Research\n\n- [Report](2026-11-16-note.md)\n")
    write_text(tmp / "docs/research/2026-11-16-note.md", "# Note\n")
    write_text(
        tmp / "packages/source-adapters/src/platforms/registry.ts",
        'import { codexAdapter } from "./codex.js";\nconst adapters = [\n  codexAdapter,\n] as const;\n',
    )
    write_text(
        tmp / "packages/source-adapters/src/platforms/codex.ts",
        'export const codexAdapter = {\n  platform: "codex",\n  supportTier: "stable",\n};\n',
    )


class CheckDocsTests(unittest.TestCase):
    def test_repository_docs_pass_with_zero_errors(self) -> None:
        findings, summary = run_checks(REPO_ROOT)
        errors = [f for f in findings if f.severity == "error"]
        self.assertEqual(errors, [], f"Unexpected doc errors: {errors}")
        self.assertGreaterEqual(summary["markdown_files"], 10)
        self.assertEqual(summary["registered_adapters"], 18)

    def test_detects_broken_link_and_fragment(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            create_minimal_repo(root)
            write_text(
                root / "docs/guide/lite.md",
                "# Guide\n\n[Missing](missing.md) and [Bad anchor](../../ARCHITECTURE.md#nope)\n",
            )
            findings, _ = run_checks(root)
            rules = {f.rule_id for f in findings if f.severity == "error"}
            self.assertIn("broken_link", rules)
            self.assertIn("broken_fragment", rules)

    def test_detects_adapter_count_and_tier_drift(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            create_minimal_repo(root)
            write_text(
                root / "README.md",
                "# Demo\n\n| Sources | **2** |\n\n## Supported sources\n\n| Slot | Tool | Default root | Tier |\n| --- | --- | --- | --- |\n| `codex` | Codex | `~/.codex` | experimental |\n",
            )
            findings, _ = run_checks(root)
            rules = {f.rule_id for f in findings if f.severity == "error"}
            self.assertIn("adapter_count_drift", rules)
            self.assertIn("adapter_tier_drift", rules)

    def test_detects_disclaimer_chain_and_unindexed_research(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            create_minimal_repo(root)
            write_text(
                root / "docs/guide/lite.md",
                "# Guide\n\nThis result does not by itself verify source history.\n",
            )
            write_text(root / "docs/research/2026-11-17-unlisted.md", "# Unlisted\n")
            findings, _ = run_checks(root)
            rules = {f.rule_id for f in findings if f.severity == "error"}
            self.assertIn("disclaimer_chain", rules)
            self.assertIn("unindexed_research_report", rules)

    def test_rejects_parallel_progress_file_and_unsanitized_path(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            create_minimal_repo(root)
            write_text(root / "progress-temp.md", "# Parallel log\n")
            write_text(root / "docs/guide/lite.md", "# Guide\n\nRead `/Users/real_person/project`.\n")
            findings, _ = run_checks(root)
            rules = {f.rule_id for f in findings if f.severity == "error"}
            self.assertIn("parallel_progress_file", rules)
            self.assertIn("unsanitized_path", rules)


if __name__ == "__main__":
    unittest.main()
