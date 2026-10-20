#!/bin/sh
# Builds the macOS installer, dist/BioCraft_<version>_universal.dmg: one app for Apple silicon and
# Intel Macs, macOS 12 Monterey or later (its webview needs Safari 15), with the icon library,
# .biocraft files opening in BioCraft and THIRD-PARTY-NOTICES.txt. Apple's tools only run on a Mac,
# so run this on one, from the project folder (or the unzipped build kit):
#   sh tools/package/build-mac.sh
# It installs what it needs if missing: the Xcode command-line tools (a dialog; run it again after),
# Rust (from rustup.rs) and the Tauri CLI. The first build takes 15–30 minutes, later ones a few.
# While making the .dmg, macOS may ask whether Terminal may control Finder: allow it (it lays out
# the window that opens with the .dmg).
set -e
cd "$(dirname "$0")/../.."

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Installing the Xcode command-line tools: finish the dialog that opens, then run this script again."
  xcode-select --install || true
  exit 1
fi
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust (rustup.rs)…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  . "$HOME/.cargo/env"
fi
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo tauri --version >/dev/null 2>&1 || cargo install tauri-cli --version "^2" --locked
for f in library/index.json THIRD-PARTY-NOTICES.txt; do
  [ -f "$f" ] || { echo "Missing $f: copy the whole project folder (or the build kit), not just the code."; exit 1; }
done

# its own target folder: tauri-build copies the library beside the binary it builds
export CARGO_TARGET_DIR="$PWD/target/installer"
(cd app && cargo tauri build --target universal-apple-darwin --bundles dmg --config tauri.installer.json)

mkdir -p dist
cp "$CARGO_TARGET_DIR"/universal-apple-darwin/release/bundle/dmg/*.dmg dist/
cp tools/package/INSTALL.txt dist/
ls -lh dist/*.dmg
