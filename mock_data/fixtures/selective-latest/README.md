# Selective latest evidence

Hand-authored Codex-shaped records, with no native user history. The five JSONL files contain
four nonempty sessions (two tied) and a newer empty session. All titles intentionally overlap.
`variants.json` supplies split-file, delegated, unknown-shape, family-tool, changed-evidence,
and ordinary-tool records. Tests copy only JSONL input into fresh temporary roots, apply a named
variant there, and advance mtimes explicitly. The oldest session gets the newest filesystem mtime.

The cost experiment expands the ordinary-tool seeds deterministically in temporary storage.
It measures fixture work and elapsed time; it makes no claim about native corpus coverage or
avoided source I/O. Raw experiment output and temporary expanded histories stay outside the repo.
