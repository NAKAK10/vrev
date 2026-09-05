# Publishing releases

`.github/workflows/release-package.yml` publishes `@vrev/cli`, `@vrev/plugin-sdk`, and the six `@vrev/*` feature packages to the public npm registry when a GitHub release is published. A manual dispatch with a release tag only recovers package versions that are still missing; it does not overwrite versions already present.

## Current beta release identity

The beta 2 release uses `1.0.0-beta.2` for all eight packages and all six plugin manifests, tag `v1.0.0-beta.2`, and npm dist-tag `beta`. It updates the CLI README with Japanese, English, and Simplified Chinese documentation links and ships the redesigned documentation site. Install it explicitly with `npm install --save-dev @vrev/cli@1.0.0-beta.2` or follow the [quick start](./getting-started) for the complete package set. Do not move the stable `latest` dist-tag when publishing a prerelease.

### Initial beta history

The initial beta used `1.0.0-beta` for all eight packages and all six plugin manifests. The packages were published publicly with MIT licenses and provenance on 2026-09-05 from tag `v1.0.0-beta`, using `--tag beta`. Keep published versions and the published tag immutable.

The registry currently also assigns `latest` to this initial beta. Attempting to remove it with the bootstrap token returned HTTP 403; tag administration is separate from publishing. Until this is adjusted through an authorized npm account, use `npx @vrev/cli@beta` explicitly. The workflow does not silently change or delete existing tags.

The GitHub repository is public. On 2026-09-05, all eight packages passed real GitHub OIDC → npm publish-scoped token exchange in [verification run 33944310011](https://github.com/NAKAK10/vrev/actions/runs/33944310011). The repository `NPM_TOKEN` secret and temporary npm token `vrev-bootstrap-beta` were then deleted. The workflow now uses OIDC only, with no bootstrap input or token fallback. Verification did not publish a new version; the next release's actual publish remains a separate operation.

## Authentication

Trusted publishing is the normal authentication mode. In npm, configure a GitHub Actions trusted publisher for **each** package with these exact values:

- Organization or user: `NAKAK10`
- Repository: `vrev`
- Workflow filename: `release-package.yml`
- Environment: leave blank (the workflow does not use a GitHub environment)
- Allow npm publish: enabled

The workflow tests and builds released tags on the supported minimum Node 20 runtime, then switches to Node 22 and npm 11.19.1 for publishing with `id-token: write` and provenance. Main-branch CI tests both Node 20 and 22. npm tries GitHub OIDC before checking registry credentials. Omitting `registry-url` avoids setup-node v5's placeholder token masking a failed OIDC exchange as a registry `E404`; that placeholder does not itself prevent OIDC authentication. Signing provenance is separate from npm publish authorization and does not prove trusted publishing is configured.

All eight existing package names are ready for OIDC publishing. Under the first-publication limitation encountered during this release, a new package name needs a separately approved first-publication procedure using an account that owns the name/scope, followed by trusted-publisher configuration and verification. Do not restore a persistent token fallback to the release workflow.

After configuring all eight packages in npm's browser UI, verify the setup from the updated default branch:

```sh
gh workflow run release-package.yml --ref main -f release_tag=v1.0.0-beta -f verify_only=true
```

The `verify_only` run requests a fresh GitHub OIDC ID token and performs npm's publish-scoped token exchange separately for each package. It does not load `NPM_TOKEN`, call `npm publish`, or change a registry version. A tokenless `npm whoami` is not a substitute because npm OIDC credentials are publish-scoped. Inspect the resulting Actions run and require all eight package-name success lines. npm browser success notifications alone are insufficient: confirm the configuration persists after reload and passes this exchange.

Do not assume an npm `E404` means only that a version is absent. For a publish `PUT`, npm deliberately also returns `E404` when the package or scope does not exist or the current identity lacks permission.

## Recovery checklist

1. Verify all package names and the `@vrev` scope are owned by the intended npm account or organization.
2. If adding a new package name, arrange its separately approved first publication as described above.
3. Configure the exact trusted-publisher settings on every package, including direct publish permission.
4. Run the `verify_only` command above and confirm all eight real npm token exchanges succeed.
5. Keep the workflow OIDC-only; no long-lived npm token secret is required.
6. For recovery, dispatch **Publish packages to npm** from the updated branch with the existing release tag and `verify_only: false`. Do not rerun an old failed run: it uses its original workflow. The updated workflow checks out the requested tag, skips versions already in the registry, and publishes only missing versions.

References: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers), [initial-publish limitation](https://github.com/npm/cli/issues/8544).

Never create a new GitHub release merely to retry npm authentication, and never retry until package ownership/authentication has been corrected.
