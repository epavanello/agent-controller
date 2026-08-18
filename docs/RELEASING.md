# Releasing Agent Controller

This is the maintainer checklist for a signed, notarized macOS release. It is intentionally kept
out of the product-focused README.

## One-time signing setup

Install the Developer ID Application certificate in the login keychain, then store the Apple
notarization credentials under a keychain profile:

```sh
xcrun notarytool store-credentials agent-controller \
  --apple-id "<developer Apple ID>" \
  --team-id "<10-character team ID>" \
  --password "<app-specific password>"
```

No signing secret belongs in the repository.

## Build and verify

Update `package.json` to the release version and commit it before creating artifacts.

The release script rebuilds the icon set, runs every check, compiles the native helper, signs and
notarizes the app, validates Gatekeeper and Stapler, and writes the SHA-256 checksums:

```sh
npm ci
npm run release:mac -- --install
```

`--install` is optional. It safely closes the running app, replaces
`/Applications/Agent Controller.app` with the verified build, validates it again, and launches it.

Verify the exact app and DMG that will be uploaded:

```sh
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Agent Controller.app"
spctl -a -vvv -t exec "dist/mac-arm64/Agent Controller.app"
xcrun stapler validate "dist/Agent Controller-<version>-arm64.dmg"
shasum -a 256 "dist/Agent Controller-<version>-arm64.dmg" \
  "dist/Agent Controller-<version>-arm64-mac.zip" > dist/SHA256SUMS.txt
```

The Gatekeeper result must be `accepted`, and Stapler must report a successful validation.

## Publish on GitHub

Once the release commit is on `main`, the same script can create and push the version tag and
publish the DMG, ZIP, and checksums:

```sh
npm run release:mac -- --install --publish --notes docs/releases/v<version>.md
```

Without `--notes`, GitHub generates release notes from the commits since the previous tag. The
script refuses to publish from a dirty worktree, a branch other than `main`, or a commit that does
not exactly match `origin/main`.

Do not upload blockmaps, builder debug files, or an unpacked `.app` directory.
