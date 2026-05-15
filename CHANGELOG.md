# Changelog

All notable changes to `chowbea-axios` will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the `2.0.0-alpha.*` line is active, breaking changes may land between alpha versions — see [SECURITY.md](SECURITY.md) for the supported-versions policy.

## [Unreleased]

_Nothing yet._

## [2.0.0-alpha.22] — 2026-05-15

The largest alpha shipped to date. Bundles the full "package review" hardening pass (PRs #55–#60) with the first round of enterprise-adoption-readiness fixes from a fresh internal audit ([docs/reviews/2026-05-04-adoption-readiness.md](docs/reviews/2026-05-04-adoption-readiness.md)). No breaking changes for adopters of `alpha.21`.

### Added

- New `release:experimental` npm script that does `npm ci → npm version prerelease → npm publish --tag experimental → git push --follow-tags` as one atomic operation. Replaces the brittle bare-`npm publish` flow that fails on fresh checkouts (`tsc: command not found`).
- `SECURITY.md` with a private vulnerability-disclosure policy (GitHub security advisory + `platforms@chowbea.com`), 7-day acknowledgement target, supported-versions statement, and scope definition.
- `LICENSE` and `SECURITY.md` explicitly whitelisted in `package.json#files` so they ship in every npm tarball (npm only includes `LICENSE` and `README` implicitly).
- `docs/reviews/2026-05-04-adoption-readiness.md` — full adoption-readiness audit covering security, code quality, and docs/legal/ops lanes. Living index linking each deferred finding to its GitHub issue (#61–#72).
- Emitted operation functions now include an `@remarks` JSDoc line documenting that path parameter values are URL-encoded by the underlying HTTP layer, removing an implicit safety guarantee that adopters previously had to discover.
- Vitest snapshot suite covering generator emission for petstore + edge-case OpenAPI fixtures (#48).
- Hardened CI template shipped to users under `templates/chowbea-axios-ci.yml`: default-deny permissions, concurrency cancel, scoped diff paths, pinned action SHAs.

### Changed

- `createOperations` in the emitted `api.operations.ts` template no longer takes `apiClient: any`. The parameter is now typed as a documented structural `ApiClient` interface. Adopters reading the generated code see a real type contract on the most-called API instead of a silent `any` escape hatch.
- TOML and YAML config values are now round-tripped via `JSON.stringify`-based escaping, removing a class of injection bugs where a stray `"` or `\n` in a config value could create stray top-level entries.
- Spec fetcher now validates URLs against an allowlist of schemes (`http:`/`https:`) before dispatching, rejecting `file:`, `ftp:`, and custom-scheme SSRF vectors (#56).
- Backup-and-restore semantics around the generator's destination tree are now atomic (temp-then-rename) for `api.types.ts`, `api.operations.ts`, and `api.contracts.ts`.

### Fixed

- Watch mode no longer thunders on rapid file changes; debounce + exponential backoff added (#57).
- Process manager no longer leaks orphaned child processes when the TUI exits abnormally (#57).
- Instance config drift between TUI state and disk is now reconciled on every save (#57).
- Cross-platform path handling on Windows: backslash normalization, drive-letter case, UNC paths (#57).
- Router fallback when an unknown screen ID is requested (#57).
- Env manager regex no longer consumes half-matched braces; `$VAR` and `${VAR}` are now distinct alternatives (#59).
- Deep-diff comparison no longer reports false positives on object key reordering (#59).
- Hex-color env values (`#abcdef`) are correctly preserved through the env round-trip (#59).
- Non-interactive `init` flow correctly honors `--non-interactive` for project-starter use cases (#59).
- `bun.lock` is now detected alongside `package-lock.json` for package-manager inference (#58).

### Security

- Spec fetcher URL allowlist (above) — closes SSRF vector for malicious or misconfigured OpenAPI endpoint URLs (#56).
- TOML/YAML config-value escaping (above) — prevents injection of stray top-level config entries via crafted string values (#56).
- `npm audit` cleaned to 0 vulnerabilities; dependency ranges pinned with `^`/`~` (no `*` or `latest`) (#58).

## [2.0.0-alpha.21] — 2026-04-23

Combined fixes from `fix/operation-types` and `fix/dotted-property-keys` released for end-to-end alpha validation.

### Fixed

- Emitted operation functions now reference named contract types from `api.contracts.ts` instead of doing path-keyed lookups against `api.types.ts`. Cmd-click in adopters' editors now jumps to the real interface declaration (#6).
- 2xx responses declared with `*/*` or JSON-variant media types (`application/vnd.api+json` etc.) now type correctly instead of falling back to `unknown` (#4728c18).
- Property keys that aren't valid TypeScript identifiers (`hub.mode`, `X-Custom-Header`, `0.5`) are now quoted in emitted object literals so the generated TypeScript remains syntactically valid (#cef33ef).
- `spec_file`-only configs (with no `endpoint`) are now supported across `validator`, `generate`, `watch`, `diff`, and `init` so adopters with local-only spec workflows aren't forced to declare a fake endpoint (#9).
- CLI progress is now visible by default; watch-mode heartbeats prevent the appearance of a stalled CLI on long-running specs (#10).

## [2.0.0-alpha.20] — 2026-04-21

Adds Basic Auth for Swagger spec endpoints and a substantial codegen-correctness pass for adopters with complex schemas.

### Added

- Basic Auth support for Swagger spec endpoints — useful for internal/staging environments that don't expose anonymous spec access (#5).
- Smart validation pass before generation, catching common spec errors with actionable messages (#3).
- `$ref` utilities — the generator now walks reference chains for `components/parameters`, `components/requestBodies`, and `components/responses`, not just `components/schemas` (#3).
- Vite codegen plugins (`surfacesCodegen`, `sidepanelsCodegen`) for adopters using Vite as their build tool (#3).
- Windows path compatibility — generator now handles backslash-separated paths, drive letters, and UNC paths on Windows hosts (#3).

### Fixed

- CLI progress visibility default (#f2631b3).

## [2.0.0-alpha.10] — 2026-03-25 (and earlier)

The pre-`alpha.20` history covers the project's initial scaffolding, OpenTUI conversion, and rapid early iteration. Notable milestones:

- **`alpha.10`** (2026-03-25): security, cross-platform, correctness, and quality fixes addressing CodeRabbit PR review findings.
- **`alpha.10`** also introduced the env manager, the process-runner redesign, and the first round of UI polish (#d4fa02b).
- **`alpha.5`** (2026-03-24): initial TUI conversion from the OCLIF CLI to an OpenTUI dashboard with endpoint inspector (#2).
- **`alpha.2`–`alpha.4`** (2026-03-24): initial publishes.

For full pre-`alpha.20` history, see `git log v2.0.0-alpha.2..v2.0.0-alpha.10`.

[Unreleased]: https://github.com/oddFEELING/chowbea-axios/compare/v2.0.0-alpha.22...HEAD
[2.0.0-alpha.22]: https://github.com/oddFEELING/chowbea-axios/compare/v2.0.0-alpha.21...v2.0.0-alpha.22
[2.0.0-alpha.21]: https://github.com/oddFEELING/chowbea-axios/compare/v2.0.0-alpha.20...v2.0.0-alpha.21
[2.0.0-alpha.20]: https://github.com/oddFEELING/chowbea-axios/compare/v2.0.0-alpha.10...v2.0.0-alpha.20
[2.0.0-alpha.10]: https://github.com/oddFEELING/chowbea-axios/releases/tag/v2.0.0-alpha.10
