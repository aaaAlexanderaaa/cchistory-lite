#!/usr/bin/env python3
# Role: Zero-dependency documentation governance checker for cchistory-lite (links, anchors, plain language, adapter/research sync, and modularity advisories).
# Out of scope: Mutating repository files, replacing PLAN.md, or duplicating Node workspace import checks.

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.dont_write_bytecode = True

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
FENCE_OPEN_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*([a-zA-Z0-9_-]*)\s*$")
LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)\s]+)\)")
INLINE_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
PLACEHOLDER_RE = re.compile(r"\{\{[^{}\n]+\}\}")
HTML_ANCHOR_RE = re.compile(r"""<a\s+[^>]*\b(?:id|name)=['"]([^'"]+)['"]""", re.IGNORECASE)
UNSANITIZED_USER_PATH_RE = re.compile(r"/Users/(?!mock_user/|tester/)[^/\s\"'`)]+/")

DISCLAIMER_CHAINS = (
    "does not by itself",
    "alone does not",
    "alone is not",
    "is not proof",
    "cannot establish",
    "proves no",
    "is not a substitute",
    "不能证明",
    "并不等于",
    "不等于",
    "不能替代",
)
BANNED_JARGON = (
    "context capsule",
    "上下文胶囊",
    "3-act",
    "scarce warm-terracotta",
    "技术内生模块",
    "技术内生约束",
    "双层溯源子图",
    "三幕剧",
)
CORE_ROOT_DOCS = ("AGENTS.md", "ARCHITECTURE.md", "CHANGELOG.md", "PLAN.md", "README.md", "RELEASING.md", "mock_data/README.md")
NORMATIVE_PROSE_FILES = {
    "AGENTS.md",
    "ARCHITECTURE.md",
    "README.md",
    "RELEASING.md",
    "docs/contracts/working-discipline.md",
    "docs/research/README.md",
    "docs/research/2026-11-16-working-discipline-sync.md",
}
NORMATIVE_PROSE_PREFIXES = ("docs/guide/", "skills/")
MONOLITH_LINE_BUDGET = 500
BANNED_CATCHALL_DIRS = {"utils", "helpers", "common", "misc"}
CODE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".py"}
SKIP_WALK_DIRS = {".git", "node_modules", "dist", "__pycache__", ".cache", "coverage", "tmp"}


@dataclass(frozen=True)
class Finding:
    rule_id: str
    severity: str
    path: str
    line: int
    message: str


def github_heading_slug(title: str) -> str:
    """Approximate GitHub Markdown heading anchor generation."""
    cleaned = INLINE_MD_LINK_RE.sub(r"\1", title).replace("`", "").strip().lower()
    cleaned = re.sub(r"[^\w\s-]", "", cleaned)
    return re.sub(r"\s", "-", cleaned)


def _frontmatter_end(lines: list[str]) -> int:
    if lines and lines[0].strip() == "---":
        for idx in range(1, len(lines)):
            if lines[idx].strip() == "---":
                return idx + 1
    return 0


def parse_markdown_info(text: str) -> tuple[set[str], list[tuple[str, int]], list[str]]:
    """Extract GitHub-style heading anchors, relative links, and fenced code languages."""
    lines = text.splitlines()
    slugs: set[str] = set()
    slug_counts: dict[str, int] = {}
    links: list[tuple[str, int]] = []
    fences: list[str] = []
    in_fence: tuple[str, int] | None = None

    for idx in range(_frontmatter_end(lines), len(lines)):
        line_no, raw = idx + 1, lines[idx]
        m_fence = FENCE_OPEN_RE.match(raw)
        if in_fence is not None:
            if m_fence and m_fence.group(1)[0] == in_fence[0] and len(m_fence.group(1)) >= in_fence[1] and not m_fence.group(2):
                in_fence = None
            continue
        if m_fence:
            in_fence = (m_fence.group(1)[0], len(m_fence.group(1)))
            if m_fence.group(2):
                fences.append(m_fence.group(2).lower())
            continue
        for anchor in HTML_ANCHOR_RE.findall(raw):
            slugs.add(anchor.lower())
        m_head = HEADING_RE.match(raw)
        if m_head:
            base_slug = github_heading_slug(m_head.group(2))
            if base_slug:
                seen = slug_counts.get(base_slug, 0)
                slug_counts[base_slug] = seen + 1
                slugs.add(base_slug if seen == 0 else f"{base_slug}-{seen}")
        for target in LINK_RE.findall(re.sub(r"`[^`]*`", "", raw)):
            links.append((target, line_no))
    return slugs, links, fences


def collect_markdown_files(root: Path) -> list[Path]:
    files = [root / rel for rel in CORE_ROOT_DOCS if (root / rel).is_file()]
    for folder in ("docs", "skills"):
        base = root / folder
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in sorted(dirnames) if d not in SKIP_WALK_DIRS]
            files.extend(Path(dirpath) / fn for fn in sorted(filenames) if fn.endswith(".md"))
    return sorted({path.resolve(): path for path in files}.values())


def scrub_examples(line: str) -> str:
    return re.sub(r"`[^`]*`|\"[^\"]*\"|'[^']*'|「[^」]*」|（[^）]*）", "", line).lower()


def is_normative_prose(rel_path: str) -> bool:
    return rel_path in NORMATIVE_PROSE_FILES or any(rel_path.startswith(p) for p in NORMATIVE_PROSE_PREFIXES)


def check_markdown_docs(root: Path, md_files: list[Path], findings: list[Finding]) -> None:
    root_res = root.resolve()
    parsed: dict[Path, tuple[set[str], list[tuple[str, int]], list[str]]] = {}
    for mp in md_files:
        text = mp.read_text(encoding="utf-8")
        parsed[mp.resolve()] = parse_markdown_info(text)
        rel = mp.relative_to(root).as_posix()
        check_prose = is_normative_prose(rel)
        in_fence: tuple[str, int] | None = None
        lines = text.splitlines()
        for idx in range(_frontmatter_end(lines), len(lines)):
            line_no, raw = idx + 1, lines[idx]
            m_fence = FENCE_OPEN_RE.match(raw)
            if in_fence is not None:
                if m_fence and m_fence.group(1)[0] == in_fence[0] and len(m_fence.group(1)) >= in_fence[1] and not m_fence.group(2):
                    in_fence = None
                continue
            if m_fence:
                in_fence = (m_fence.group(1)[0], len(m_fence.group(1)))
                continue
            if UNSANITIZED_USER_PATH_RE.search(raw):
                findings.append(Finding("unsanitized_path", "error", rel, line_no, "Unsanitized local `/Users/<name>/` path found in documentation."))
            if PLACEHOLDER_RE.search(re.sub(r"`[^`]*`", "", raw)):
                findings.append(Finding("unresolved_placeholder", "error", rel, line_no, "Unresolved `{{...}}` template placeholder found in documentation."))
            if check_prose:
                scrubbed = scrub_examples(raw)
                for phrase in DISCLAIMER_CHAINS:
                    if phrase in scrubbed:
                        findings.append(Finding("disclaimer_chain", "error", rel, line_no, f"Uses defensive disclaimer phrasing `{phrase}`; state scope directly."))
                for term in BANNED_JARGON:
                    if term in scrubbed:
                        findings.append(Finding("banned_jargon", "error", rel, line_no, f"Uses disallowed coined jargon `{term}`; use plain wording."))

    for mp in md_files:
        rel = mp.relative_to(root).as_posix()
        for raw_target, line_no in parsed[mp.resolve()][1]:
            if raw_target.startswith(("http://", "https://", "mailto:", "file://", "conversation://", "<")):
                continue
            split = urlsplit(unquote(raw_target))
            target_file = (mp.parent / split.path).resolve() if split.path else mp.resolve()
            if not target_file.is_relative_to(root_res):
                findings.append(Finding("link_escapes_repo", "error", rel, line_no, f"Link target escapes repository: `{raw_target}`."))
                continue
            if not target_file.exists():
                findings.append(Finding("broken_link", "error", rel, line_no, f"Broken local link target `{raw_target}`."))
                continue
            if split.fragment and target_file.is_file() and target_file.suffix.lower() == ".md":
                if target_file not in parsed:
                    parsed[target_file] = parse_markdown_info(target_file.read_text(encoding="utf-8"))
                if split.fragment.lower() not in parsed[target_file][0]:
                    findings.append(Finding("broken_fragment", "error", rel, line_no, f"Heading fragment `#{split.fragment}` not found in `{target_file.relative_to(root_res).as_posix()}`."))


def load_registered_adapters(root: Path) -> list[tuple[str, str]]:
    """Return `(slot_id, support_tier)` pairs declared in the adapter registry."""
    registry_path = root / "packages" / "source-adapters" / "src" / "platforms" / "registry.ts"
    if not registry_path.is_file():
        return []
    text = registry_path.read_text(encoding="utf-8")
    import_map = {
        sym: (registry_path.parent / (rel[:-3] + ".ts" if rel.endswith(".js") else rel + ".ts")).resolve()
        for sym, rel in re.findall(r"""import\s+\{\s*([A-Za-z0-9_]+)\s*\}\s+from\s+["']([^"']+)["']""", text)
    }
    m_arr = re.search(r"const\s+adapters\s*=\s*\[(.*?)\]", text, flags=re.S)
    if not m_arr:
        return []
    registered: list[tuple[str, str]] = []
    for sym in re.findall(r"\b([A-Za-z0-9_]+)\b", m_arr.group(1)):
        adapter_path = import_map.get(sym)
        if not adapter_path or not adapter_path.is_file():
            continue
        adapter_text = adapter_path.read_text(encoding="utf-8")
        m_plat = re.search(r"""\bplatform\s*:\s*["']([^"']+)["']""", adapter_text)
        m_tier = re.search(r"""\bsupportTier\s*:\s*["']([^"']+)["']""", adapter_text)
        if m_plat and m_tier:
            registered.append((m_plat.group(1), m_tier.group(1)))
    return registered


def check_single_source_consistency(root: Path, findings: list[Finding]) -> int:
    adapters = load_registered_adapters(root)
    readme_path = root / "README.md"
    if adapters and readme_path.is_file():
        readme_text = readme_path.read_text(encoding="utf-8")
        m_sources_row = re.search(r"^\|\s*Sources\s*\|\s*\*\*(\d+)\*\*\s*\|", readme_text, flags=re.M)
        if m_sources_row and int(m_sources_row.group(1)) != len(adapters):
            line_no = readme_text[: m_sources_row.start()].count("\n") + 1
            findings.append(Finding("adapter_count_drift", "error", "README.md", line_no, f"README comparison table states {m_sources_row.group(1)} sources, while registry.ts registers {len(adapters)}."))
        documented_tiers: dict[str, str] = {}
        for raw in readme_text.splitlines():
            m_row = re.match(r"^\|\s*`([^`]+)`\s*\|\s*[^|]+\|\s*[^|]+\|\s*(stable|experimental)\s*\|$", raw.strip())
            if m_row:
                documented_tiers[m_row.group(1)] = m_row.group(2)
        for slot, tier in adapters:
            if slot not in documented_tiers:
                findings.append(Finding("missing_readme_adapter", "error", "README.md", 1, f"Registered source adapter `{slot}` is missing from README.md Supported sources table."))
            elif documented_tiers[slot] != tier:
                findings.append(Finding("adapter_tier_drift", "error", "README.md", 1, f"README.md lists `{slot}` as `{documented_tiers[slot]}`, while adapter declares `{tier}`."))

    arch_path = root / "ARCHITECTURE.md"
    if arch_path.is_file() and "mermaid" not in parse_markdown_info(arch_path.read_text(encoding="utf-8"))[2]:
        findings.append(Finding("missing_architecture_mermaid", "error", "ARCHITECTURE.md", 1, "ARCHITECTURE.md must retain at least one Mermaid runtime/failure flow diagram."))

    research_dir = root / "docs" / "research"
    research_index = research_dir / "README.md"
    if research_dir.is_dir() and research_index.is_file():
        index_text = research_index.read_text(encoding="utf-8")
        for report in sorted(research_dir.glob("20*.md")):
            if report.name not in index_text:
                findings.append(Finding("unindexed_research_report", "error", "docs/research/README.md", 1, f"Research report `{report.name}` is missing from docs/research/README.md."))

    for entry in sorted(root.iterdir()):
        if entry.is_file() and (entry.name.startswith("progress-") or entry.name.endswith("-context-latest.md")):
            findings.append(Finding("parallel_progress_file", "error", entry.name, 1, "Use PLAN.md as the single execution record instead of root progress/context files."))
    return len(adapters)


def collect_modularity_advisories(root: Path, findings: list[Finding]) -> None:
    for top in ("apps", "packages", "scripts"):
        base = root / top
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in sorted(dirnames) if d not in SKIP_WALK_DIRS]
            for d in dirnames:
                if d.lower() in BANNED_CATCHALL_DIRS:
                    findings.append(Finding("catchall_directory", "advisory", (Path(dirpath) / d).relative_to(root).as_posix(), 1, f"Catch-all directory `{d}` should be named by concrete capability."))
            for fn in sorted(filenames):
                full = Path(dirpath) / fn
                if full.suffix.lower() not in CODE_SUFFIXES or fn.endswith((".test.ts", ".test.mjs", ".test.py", ".spec.ts")) or fn == "test-helpers.ts":
                    continue
                line_count = len(full.read_text(encoding="utf-8", errors="ignore").splitlines())
                if line_count > MONOLITH_LINE_BUDGET:
                    findings.append(Finding("oversized_source_file", "advisory", full.relative_to(root).as_posix(), 1, f"Production file has {line_count} lines (soft budget {MONOLITH_LINE_BUDGET}); split before substantial expansion."))


def run_checks(root: Path, *, strict: bool = False) -> tuple[list[Finding], dict[str, int]]:
    findings: list[Finding] = []
    md_files = collect_markdown_files(root)
    check_markdown_docs(root, md_files, findings)
    adapter_count = check_single_source_consistency(root, findings)
    collect_modularity_advisories(root, findings)
    if strict:
        findings = [Finding(f.rule_id, "error", f.path, f.line, f.message) if f.severity == "advisory" else f for f in findings]
    summary = {
        "markdown_files": len(md_files),
        "registered_adapters": adapter_count,
        "errors": sum(1 for f in findings if f.severity == "error"),
        "advisories": sum(1 for f in findings if f.severity != "error"),
    }
    return findings, summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate cchistory-lite documentation integrity and single-source alignment.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--strict", action="store_true", help="Promote modularity advisories to errors.")
    parser.add_argument("--advisories", action="store_true", help="Print non-blocking modularity advisories.")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)

    findings, summary = run_checks(args.root.resolve(), strict=args.strict)
    if args.format == "json":
        sys.stdout.write(json.dumps({"ok": summary["errors"] == 0, "summary": summary, "findings": [f.__dict__ for f in findings]}, ensure_ascii=False, indent=2) + "\n")
        return 1 if summary["errors"] else 0

    for f in findings:
        if f.severity == "advisory" and not args.advisories:
            continue
        tag = "ERROR" if f.severity == "error" else "ADVISORY"
        print(f"[{tag}] ({f.rule_id}) {f.path}:{f.line} — {f.message}", file=sys.stderr if f.severity == "error" else sys.stdout)

    if summary["errors"] > 0:
        print(f"check_docs: FAILED ({summary['errors']} error(s), {summary['advisories']} advisory(s))", file=sys.stderr)
        return 1
    print(f"check_docs: OK ({summary['markdown_files']} docs, {summary['registered_adapters']} adapters, {summary['advisories']} advisories)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
