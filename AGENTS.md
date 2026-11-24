# Agent instructions

## Releases

`main` is the release line; every merged PR ships as a new version.

- Every PR bumps the version: run `make bump` (patch) in the PR branch and commit `manifest.json`. Use `make bump LEVEL=minor` or `LEVEL=major` only when Ar says so. The bump is computed from the last tag, so re-running it is safe.
- After merging to `main`, run `make tag` (`make tag DRY_RUN=1` to preview). It tags `main`'s head with the manifest version, pushes the tag, and publishes a GitHub release marked Latest with notes for the PRs since the last tag. It exits 0 if `main`'s head is already tagged.
