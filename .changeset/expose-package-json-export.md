---
"@narulabs/naru": patch
---

Expose the `./package.json` subpath in the package `exports` map so tooling that reads the manifest (e.g. `require("@narulabs/naru/package.json")`) no longer throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.
