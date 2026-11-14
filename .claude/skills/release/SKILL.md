---
name: release
description: Cut a CalVer release (vYYYY.MM.N) of freeport. Use when asked to release, cut a release, or tag a version.
---

1. Stop if the tree is dirty or not on `main`. Run `npm test`; stop if it fails.
2. Version is `YYYY.MM.N` (today's year/month, N = next number for that month, from 0). Check `git tag`.
3. Set `"version"` in `package.json`, commit `Release vX`. No co-author lines.
4. Show the version and the commits since the last tag. Wait for user OK.
5. `git tag vX && git push origin main vX`
6. `gh release create vX --generate-notes`
