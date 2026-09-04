# Security policy

This repository is intended to become public. Never commit credentials, tokens, cookies, private keys, `.env` files, review data from customer projects, or machine-specific absolute paths.

## Local-only data

Review files are written below the reviewed repository root's `.vrev/`, not this tool repository. Do not copy `.vrev/` from customer or private projects into this repository. Workspace settings and context use repository-relative paths only; runtime job/lease/lock files are ignored by `.vrev/.gitignore`.

Live targets accept plain HTTP on `localhost`, `127.0.0.1`, or `::1`. Public targets require HTTPS and run in script-free, read-only static mode. URL credentials, private/reserved DNS destinations, cross-origin redirects, and cookie or authorization forwarding are rejected. Framework source hints are reduced to repository-like relative paths before persistence.

## Reporting

Report a suspected secret exposure privately to the repository owner. Rotate the credential before removing it from Git history.

## Release checks

`npm test` runs `npm run check:secrets` before compilation and tests. CI uses the same command. A passing scanner reduces risk but does not replace manual review.
