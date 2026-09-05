# Publishing releases

`.github/workflows/release-package.yml` publishes `@vrev/cli`, `@vrev/plugin-sdk`, and the six `@vrev/*` feature packages to the public npm registry when a GitHub release is published. A manual dispatch with a release tag only recovers package versions that are still missing; it does not overwrite versions already present.

## Current beta release identity

All eight package versions and all six plugin manifest versions must be exactly `1.0.0-beta`. Create the GitHub release from tag `v1.0.0-beta` and publish npm packages with dist-tag `beta`; do not assign this prerelease to `latest`.

## Authentication

Trusted publishing is the normal authentication mode. In npm, configure a GitHub Actions trusted publisher for **each** package with these exact values:

- Organization or user: `NAKAK10`
- Repository: `vrev`
- Workflow filename: `release-package.yml`
- Environment: leave blank (the workflow does not use a GitHub environment)

The workflow tests and builds released tags on the supported minimum Node 20 runtime, then switches to Node 22 and npm 11.19.1 for publishing with `id-token: write` and provenance. Main-branch CI tests both Node 20 and 22. npm tries GitHub OIDC before checking registry credentials. Omitting `registry-url` avoids setup-node v5's placeholder token masking a failed OIDC exchange as a registry `E404`; that placeholder does not itself prevent OIDC authentication. Signing provenance is separate from npm publish authorization and does not prove trusted publishing is configured.

Trusted publishing cannot create a package on its first publish. Bootstrap every new package name once with an npm account that owns the name/scope. For the scoped packages, the publishing account must own or have publish access to the `@vrev` scope. Add a granular automation token as the repository Actions secret `NPM_TOKEN`, manually run the release recovery workflow with `bootstrap: true`, then configure the trusted publisher on every newly created npm package and remove `NPM_TOKEN`. The token must cover all package names and satisfy the npm account/package 2FA publishing policy.

Do not assume an npm `E404` means only that a version is absent. For a publish `PUT`, npm deliberately also returns `E404` when the package or scope does not exist or the current identity lacks permission.

## Recovery checklist

1. Verify all package names and the `@vrev` scope are owned by the intended npm account or organization.
2. Bootstrap names that do not yet exist using `NPM_TOKEN` as described above.
3. Configure the exact trusted-publisher settings on every package.
4. Remove the fallback `NPM_TOKEN` secret after trusted publishing works.
5. After merging the workflow changes, dispatch **Publish packages to npm** from the updated branch with the existing release tag and `bootstrap: false`. Do not rerun the old failed run: it uses its original workflow. The updated workflow checks out the requested tag, skips versions already in the registry, and publishes only missing versions.

Bootstrap credentials are only loaded for an explicitly requested manual bootstrap, after tests and package inspection. Normal release events remain tokenless.

References: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers), [initial-publish limitation](https://github.com/npm/cli/issues/8544).

Never create a new GitHub release merely to retry npm authentication, and never retry until package ownership/authentication has been corrected.
