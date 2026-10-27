# VibeGlobe 0.1.0 (pre-release, not published)

The first pre-release of the `@vibeglobe` packages (owner, 2026-10-25), for installing from files while nothing is
on the npm registry. The tag `v0.1.0` on `main` is the release commit (every package at 0.1.0, engine
dependencies pinned to it, `CHANGELOG.md` with its entry). The tarballs themselves are not in git: build them from
the tag, in a few minutes. The tag is the owner's to push (this session's git access pushes only its branch): `git tag
-a v0.1.0 04f9286 -m "Release v0.1.0" && git push origin v0.1.0`, or a GitHub release draft on that commit, which
creates it. Until then, check out `04f9286` (the squash merge of #47 on `main`) instead:

```sh
git checkout v0.1.0
npm ci
npm run build          # tsc -b and the Web Component's browser build (the playground builds are not needed)
npm run release:pack   # writes the 14 tarballs into release-0.1.0/
```

`npm run build` builds the apps too; `npx tsc -b && npm run build:browser -w @vibeglobe/web-component` is enough
for the packages. The release dry run (`node scripts/release/release.ts 0.1.0`) checked them on 2026-10-25: every
tarball holds ESM JavaScript, declarations, an exports map whose targets exist and `LICENSE.md`, a strict TypeScript
consumer type-checks against the tarballs alone, and `npm publish --dry-run` names each `@vibeglobe/<name>@0.1.0`.

Packing is reproducible: tarballs built from the tag on Node 22 have these SHA-256 sums (`sha256sum *.tgz`):

```text
11f142863d189e7866c792f13405da0aef2a4eed9febfd2969c0a6724b9ae945  vibeglobe-controls-0.1.0.tgz
8e4542698ffd451898a1b9a961beb9a5060e70b9dd3d54dc99ee035ef37aaada  vibeglobe-core-0.1.0.tgz
00ed9154a2a2988d64e0981e6c533d0d6c27be20ad5fe0345b9d1ba2dd7a7fbe  vibeglobe-gis-0.1.0.tgz
05e51754466b1d0c4dfe078fed6c96f0914f4cd75293f65a7ffbf1d3393ae4b6  vibeglobe-layers-0.1.0.tgz
5994dde0c4acf46ff16be43b30b1a21096ff3c429f71608277845d9fb32dc059  vibeglobe-models-0.1.0.tgz
d19c8ade676eace5c8b5ae3b13cac32b9bc8fa678f77e254f30864f0a202c7d7  vibeglobe-offline-0.1.0.tgz
49483447e12343ecb75141a308f727f2ecda11f49b34ee1fb9eb5a8dd11d8769  vibeglobe-quality-0.1.0.tgz
249b8dfd00f44d6de8a00a1a15dfe3be6fceb6da2e349ed2e42ab4929263a133  vibeglobe-renderer-0.1.0.tgz
c3d7361ba9dcdb39a1be7dd2c92636fd8eda4d1b6ebafba3dfdbee7c2d3ddbf2  vibeglobe-sources-0.1.0.tgz
4b9da01408876db4248a238710c91d9dc7b516125490c69072c1f3fb056dfa95  vibeglobe-tools-0.1.0.tgz
9d496eea64a153e38e0e1e7aa528ec6b674a733366523465f0daed60eec8991c  vibeglobe-ui-0.1.0.tgz
d3dedbbcc97ec0983c0172f9cce8f0506d01238d11ce11a19d4ab69b1212b3b2  vibeglobe-vue-0.1.0.tgz
47eeb80326f7dfbef3228e6e3f249edf824d9e88ec4d5f644ba12cc96d077a86  vibeglobe-web-component-0.1.0.tgz
945889dea8f99fd80cf75111d66be24b2e233aa89c4b6b6df778b94654ad892c  vibeglobe-worker-0.1.0.tgz
```

To use them in an application (Nuxt 3, Vue 3), follow [docs/guides/cube-quickstart.md](../docs/guides/cube-quickstart.md):
copy the folder into the application and install the tarballs with `file:` dependencies and `overrides`.
Publishing to npm stays the owner's step (docs/open-questions.md, question 17; `.claude/skills/release/SKILL.md`).
