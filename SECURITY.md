# Security policy

## Supported versions

VibeGlobe has not had a release yet. Until 1.0.0, only the latest commit on `main` receives security fixes. From 1.0.0, the latest minor version of the current major version is supported.

## Reporting a vulnerability

Do not open a public issue for a vulnerability.

- Report it privately through GitHub's **Report a vulnerability** button on the repository's Security tab, or
- by email to recchia.sim@gmail.com.

Please include the affected version or commit, a description of the issue and its impact, and steps or a proof of concept to reproduce it. You will get an acknowledgement within 7 days. A fix starts with a failing regression test and is released as soon as it is ready; you are credited in the advisory unless you prefer otherwise.

## Scope

In scope: the `@vibeglobe/*` packages, the data-pipeline tools and the build and release workflows in this repository. Out of scope: tile servers, offline packages and engine assets that consumers host themselves, and third-party map providers.
