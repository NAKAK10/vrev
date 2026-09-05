# Publishing releases

`.github/workflows/release-package.yml` publishes `@vrev/cli`, `@vrev/plugin-sdk`, and the six `@vrev/*` feature packages to the public npm registry when a GitHub release is published. A manual dispatch with a release tag only recovers package versions that are still missing; it does not overwrite versions already present.

## Current beta release identity

All eight package versions and all six plugin manifest versions are `1.0.0-beta`. The packages were published publicly with MIT licenses and provenance on 2026-09-05 from tag `v1.0.0-beta`, using `--tag beta`. Keep published versions and the published tag immutable.

The registry currently also assigns `latest` to this initial beta. Attempting to remove it with the bootstrap token returned HTTP 403; tag administration is separate from publishing. Until this is adjusted through an authorized npm account, use `npx @vrev/cli@beta` explicitly. The workflow does not silently change or delete existing tags.

The GitHub repository is now public. First publication succeeded using the temporary `NPM_TOKEN` (expires 2026-09-12). Configuring and validating Trusted Publishing on all eight packages remains necessary before removing that token. Normal release events are not yet verified without bootstrap credentials. Keep the bootstrap path and secret until the package owner completes verification.

## Authentication

Trusted publishing is the normal authentication mode. In npm, configure a GitHub Actions trusted publisher for **each** package with these exact values:

- Organization or user: `NAKAK10`
- Repository: `vrev`
- Workflow filename: `release-package.yml`
- Environment: leave blank (the workflow does not use a GitHub environment)

The workflow tests and builds released tags on the supported minimum Node 20 runtime, then switches to Node 22 and npm 11.19.1 for publishing with `id-token: write` and provenance. Main-branch CI tests both Node 20 and 22. npm tries GitHub OIDC before checking registry credentials. Omitting `registry-url` avoids setup-node v5's placeholder token masking a failed OIDC exchange as a registry `E404`; that placeholder does not itself prevent OIDC authentication. Signing provenance is separate from npm publish authorization and does not prove trusted publishing is configured.

Trusted publishing cannot create a package on its first publish. Bootstrap every new package name once with an npm account that owns the name/scope. For the scoped packages, the publishing account must own or have publish access to the `@vrev` scope. Add a granular automation token as the repository Actions secret `NPM_TOKEN`, manually run the release recovery workflow with `bootstrap: true`, then configure the trusted publisher on every newly created npm package and remove `NPM_TOKEN`. The token must cover all package names and satisfy the npm account/package 2FA publishing policy.

After configuring all eight packages in npm's browser UI, verify the setup from the updated default branch:

```sh
gh workflow run release-package.yml --ref main -f release_tag=v1.0.0-beta -f verify_only=true -f bootstrap=false
```

The `verify_only` run requests a fresh GitHub OIDC ID token and performs npm's publish-scoped token exchange separately for each package. It does not load `NPM_TOKEN`, call `npm publish`, or change a registry version. A tokenless `npm whoami` is not a substitute because npm OIDC credentials are publish-scoped. Inspect the resulting Actions run and require all eight package-name success lines before removing the secret or bootstrap path.

Do not assume an npm `E404` means only that a version is absent. For a publish `PUT`, npm deliberately also returns `E404` when the package or scope does not exist or the current identity lacks permission.

## Recovery checklist

1. Verify all package names and the `@vrev` scope are owned by the intended npm account or organization.
2. Bootstrap names that do not yet exist using `NPM_TOKEN` as described above.
3. Configure the exact trusted-publisher settings on every package.
4. Run the `verify_only` command above and confirm all eight real npm token exchanges succeed.
5. Remove the fallback `NPM_TOKEN` secret and bootstrap path only after the parent has verified the npm setup.
6. For recovery, dispatch **Publish packages to npm** from the updated branch with the existing release tag, `verify_only: false`, and `bootstrap: false`. Do not rerun an old failed run: it uses its original workflow. The updated workflow checks out the requested tag, skips versions already in the registry, and publishes only missing versions.

Bootstrap credentials are only loaded for an explicitly requested manual bootstrap, after tests and package inspection. Normal release events remain tokenless.

References: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers), [initial-publish limitation](https://github.com/npm/cli/issues/8544).

Never create a new GitHub release merely to retry npm authentication, and never retry until package ownership/authentication has been corrected.
