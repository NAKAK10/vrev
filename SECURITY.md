# Security policy

This repository is intended to become public. Never commit credentials, tokens, cookies, private keys, `.env` files, review data from customer projects, or machine-specific absolute paths.

## Local-only data

Review files are written below the reviewed repository root's `.vrev/`, not this tool repository. Do not copy `.vrev/` from customer or private projects into this repository. Workspace settings and context use repository-relative paths only; runtime job/lease/lock files are ignored by `.vrev/.gitignore`.

Live targets accept plain HTTP on `localhost`, `127.0.0.1`, or `::1`. Public targets require HTTPS and run in script-free, read-only static mode. URL credentials, private/reserved DNS destinations, cross-origin redirects, and cookie or authorization forwarding are rejected. Framework source hints are reduced to repository-like relative paths before persistence.

## Reporting

Report a suspected secret exposure privately to the repository owner. Rotate the credential before removing it from Git history.

## Scanner scope and limitations

`npm run check:secrets` asks Git for the equivalent of:

```sh
git ls-files -z --cached --others --exclude-standard
```

It scans the current working-tree contents of tracked files and untracked, non-ignored files. This includes tracked `.env`/key/credential paths, lockfiles, and files larger than 2 MB. Ignored runtime data is outside the scan unless it is already tracked. Deleted files and submodule contents are not scanned; a tracked symbolic link's link text is scanned rather than the file it points to.

The scanner is a dependency-free, pattern-based guard for selected credential formats and machine-specific macOS, Linux, and Windows home paths. It can produce false positives and cannot recognize every secret, encoded value, binary format, generated artifact, dependency, ignored file, Git-history exposure, or release-archive mistake. Placeholder home paths are intentionally allowed. A passing result reduces risk; it is not a claim that the repository or package has zero risk.

## Audit and release checks

Run the automated source checks with:

```sh
npm run check:secrets
npm run test:secrets
```

Before release, manually review the complete staged change and the files npm plans to archive:

```sh
git diff --cached --check
git diff --cached
npm pack --dry-run
```

For a deeper archive audit, create a pack in a temporary directory, list and extract it there, inspect the extracted files for credentials and unexpected generated/private data, and then delete both the directory and tarball. Do not retain audit archives in the repository.

History requires a separate manual review. Inspect all refs and suspicious historical paths/content (for example with `git log --all --stat`, `git log -p --all -- <path>`, and appropriately chosen `git grep` searches over revisions). If a real credential ever entered history, rotate it first; rewriting history alone does not revoke it.

Release review should therefore cover current Git source scope, staged changes, relevant history, and the actual npm archive. None of these checks alone proves that no secret is present.
