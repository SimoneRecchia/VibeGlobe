# Changelog

Every release of the `@vibeglobe` packages, newest first. Each entry is generated from the commit history when the
release is made (`node scripts/release/changelog.ts`, run by the release workflow); breaking changes are marked
**Breaking** and listed first. Conventional commit prefixes (`feat:`, `fix:`, `perf:`, `docs:`, `!` or a
`BREAKING CHANGE:` footer for a breaking change) choose the category; other commits are sorted by what they name
(`F123` feature entries, `KB-123` bug fixes).
