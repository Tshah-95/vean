#!/bin/bash
set -euo pipefail

repository_url="${1:?repository URL is required}"
source_ref="${2:?source ref is required}"
repository_path="${3:?guest repository path is required}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "bootstrap must execute inside the macOS guest" >&2
  exit 1
fi
if [[ "$(id -un)" != "admin" ]] || [[ "$HOME" != "/Users/admin" ]]; then
  echo "Tart guest agent must execute bootstrap as the prepared admin user" >&2
  exit 1
fi

if ! sudo -n true; then
  echo "guest admin must have non-interactive sudo before bootstrap" >&2
  exit 1
fi

developer_dir="$(xcode-select -p 2>/dev/null || true)"
if [[ ! -d "$developer_dir" ]] || [[ "$developer_dir" != /Applications/Xcode*.app/Contents/Developer ]]; then
  shopt -s nullglob
  xcode_candidates=(/Applications/Xcode*.app/Contents/Developer)
  shopt -u nullglob
  if [[ "${#xcode_candidates[@]}" -ne 1 ]]; then
    echo "xcode-select is invalid and exactly one Xcode developer directory was not found" >&2
    exit 1
  fi
  developer_dir="${xcode_candidates[0]}"
  sudo -n xcode-select --switch "$developer_dir"
fi
[[ "$(xcode-select -p)" == "$developer_dir" ]]
[[ "$(xcodebuild -version | head -1)" == "Xcode 26.5" ]]
sudo -n xcodebuild -license accept
sudo -n xcodebuild -runFirstLaunch
xcodebuild -checkFirstLaunchStatus

if ! command -v brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/libxml2/bin:$PATH"
brew update
brew install mlt ffmpeg libxml2 mise git

if [[ ! -x "$HOME/.bun/bin/bun" ]] || [[ "$($HOME/.bun/bin/bun --version)" != "1.3.14" ]]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
fi
export PATH="$HOME/.bun/bin:$PATH"
[[ "$(bun --version)" == "1.3.14" ]]

mise use --global node@24.15.0
eval "$(mise activate bash)"
[[ "$(node --version)" == "v24.15.0" ]]

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup toolchain install 1.95.0 --profile minimal
[[ "$(rustup run 1.95.0 rustc --version)" == rustc\ 1.95.0* ]]

mkdir -p "$(dirname "$repository_path")"
if [[ ! -d "$repository_path/.git" ]]; then
  git clone "$repository_url" "$repository_path"
fi
cd "$repository_path"
[[ "$(git remote get-url origin)" == "$repository_url" ]]
if [[ -n "$(git status --porcelain)" ]]; then
  echo "managed guest clone is dirty; refusing to discard guest state" >&2
  exit 1
fi
git fetch origin --prune
git checkout --detach "origin/$source_ref"
[[ -z "$(git status --porcelain)" ]]
[[ "$(git rev-parse HEAD)" == "$(git rev-parse "origin/$source_ref")" ]]

bun install --frozen-lockfile
bun install --cwd viewer --frozen-lockfile
bun install --cwd app --frozen-lockfile
bun install --cwd remotion --frozen-lockfile

mkdir -p "$HOME/.local/state/vean-vm"
cat >"$HOME/.local/state/vean-vm/bootstrap.json" <<EOF
{"repository":"$repository_path","remote":"$repository_url","source_ref":"$source_ref","source_sha":"$(git rev-parse HEAD)","bun":"$(bun --version)","node":"$(node --version)","rust":"$(rustup run 1.95.0 rustc --version | awk '{print $2}')"}
EOF

printf 'Vean guest bootstrap complete at %s (%s)\n' "$repository_path" "$(git rev-parse HEAD)"
