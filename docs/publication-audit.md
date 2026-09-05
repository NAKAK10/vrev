# Pre-publication audit

Audit date: 2026-09-05. Release code reviewed: `26d59cb` (`v1.3.4`, after the approved email-metadata rewrite).

## Scope and results

- Reviewed the source tree for credentials, personal absolute home paths, internal hostnames, and accidentally tracked runtime files.
- Ran Gitleaks with redacted output across all locally reachable Git refs (`--log-opts=--all`): no findings.
- Inspected reachable historical blobs for macOS, Linux, and Windows user-home paths: no findings.
- Built the project and created real npm tarballs with lifecycle scripts disabled for all eight public packages: `vrev`, the SDK, and the six feature packages.
- Extracted those tarballs into a private temporary directory and scanned their contents with Gitleaks and path/filename checks: no credential or personal-home-path findings. No `.env`, `.npmrc`, private-key files, `.git`, or `.vrev` runtime state was included.
- The tarballs used checkout package versions; the release workflow replaces version metadata with the requested release version. Re-audit the final release artifacts if build inputs or packaging change.

These are automated checks and targeted review, not proof that no sensitive information exists. GitHub issues, attachments, Actions logs/artifacts, unreachable Git objects, and external storage were not comprehensively audited.

## Decisions required before public exposure

- After the owner's explicit approval, the GitHub repository was made public on 2026-09-05. All eight npm packages were also published as `1.0.0-beta` with MIT licenses and provenance. The CLI package uses `@vrev/cli` because npm rejected the unscoped `vrev` name. See [releasing.md](releasing.md) for current tags and authentication follow-up.
- With the owner's explicit approval, all 80 existing commits and all 19 tags were rewritten so author, committer, and tagger email metadata uses `nakashima@fuku60.com`. The main branch and tags were pushed atomically with explicit old-ref leases; every commit's file tree was verified unchanged. A private backup was retained outside the repository. Future commits use the same address.
- Other clones must synchronize with the rewritten history. This rewrite does not purge old GitHub Actions logs/artifacts, cached commit pages, forks, or existing clones; GitHub-side removal may require a separate cleanup or support request before making the repository public.
- Package metadata and documentation intentionally identify the GitHub owner and repository. npm tarballs expose this identity even if GitHub remains private.
- Following the owner's request, the current source and all eight packages use the MIT license. Each package includes the same LICENSE notice. Previously created release tags retain their original license metadata until a new release is created.
- Private-network URLs in examples/tests are functional fixtures, not credentials. Review them if they were copied from a real environment.
- The free npm `@vrev` organization was created under the owner's account, and initial publication is complete. All eight packages passed real tokenless Trusted Publishing authentication in Actions run `33944310011`. The temporary npm token and repository `NPM_TOKEN` secret were removed afterward; the release workflow has no token fallback. See [releasing.md](releasing.md).

## Ongoing checks

`npm run check:secrets` now scans Git-tracked and non-ignored new files, including lockfiles and tracked credential paths. It detects additional token/home-path patterns, rejects sensitive credential filenames, and no longer silently skips files above 2 MB. Regression tests run through `npm test`.

Full-history and built-artifact scans remain separate release checks; see [SECURITY.md](../SECURITY.md). Reports containing potential findings should stay outside the repository and use redacted output.
