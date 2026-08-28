# Security policy

This repository is intended to become public. Never commit credentials, tokens, cookies, private keys, `.env` files, review data from customer projects, or machine-specific absolute paths.

## Local-only data

Review files are written into the repository being reviewed, not this tool repository. Do not copy `.code/visual-reviews/` from customer or private projects into this repository.

Live targets accept plain HTTP only on `localhost`, `127.0.0.1`, or `::1`; credentials in URLs and external targets are rejected. Framework source hints are reduced to repository-like relative paths before persistence.

## Reporting

Report a suspected secret exposure privately to the repository owner. Rotate the credential before removing it from Git history.

## Release checks

`npm test` runs `npm run check:secrets` before compilation and tests. CI uses the same command. A passing scanner reduces risk but does not replace manual review.
