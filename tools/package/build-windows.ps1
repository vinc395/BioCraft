# Builds the Windows installer, dist\BioCraft_<version>_x64-setup.exe: a per-user install (no admin
# rights needed) with a Start menu shortcut, .biocraft files opening in BioCraft, the icon library
# and THIRD-PARTY-NOTICES.txt. Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File tools\package\build-windows.ps1
# Needs Rust, Node.js and the Tauri CLI (cargo install tauri-cli --version "^2" --locked). The first
# run downloads NSIS, the installer maker, from Tauri's GitHub releases.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

node tools/package/notices.mjs
if ($LASTEXITCODE -ne 0) { throw "notices.mjs failed" }

# its own target folder: tauri-build copies the library beside the binary it builds, which must not
# happen to the development binaries (they read library\ itself, which libbuild updates)
$env:CARGO_TARGET_DIR = "$root\target\installer"
Push-Location app
try {
  cargo tauri build --bundles nsis --config tauri.installer.json
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force dist | Out-Null
Copy-Item "$env:CARGO_TARGET_DIR\release\bundle\nsis\*-setup.exe" dist\ -Force
Copy-Item tools\package\INSTALL.txt dist\ -Force
Get-ChildItem dist\*-setup.exe | ForEach-Object { "{0}  {1:N0} MB" -f $_.FullName, ($_.Length / 1MB) }
