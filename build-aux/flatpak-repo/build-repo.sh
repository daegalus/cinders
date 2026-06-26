#!/usr/bin/env bash
set -euo pipefail

APP_ID="${APP_ID:-dev.yulian.Cinders}"
APP_NAME="${APP_NAME:-Cinders}"
BRANCH="${BRANCH:-stable}"
MANIFEST="${MANIFEST:-dev.yulian.Cinders.json}"
BUILD_DIR="${BUILD_DIR:-_build/flatpak-build}"
OUTPUT_DIR="${OUTPUT_DIR:-_build/flatpak}"
REPO_DIR="${REPO_DIR:-${OUTPUT_DIR}/repo}"
BUNDLE="${BUNDLE:-${OUTPUT_DIR}/${APP_ID}.flatpak}"
REMOTE_NAME="${REMOTE_NAME:-cinders}"
BASE_URL="${BASE_URL:-https://daegalus.github.io/cinders/flatpak}"
HOMEPAGE="${HOMEPAGE:-https://yulian.dev/cinders}"
RUNTIME_REPO="${RUNTIME_REPO:-https://flathub.org/repo/flathub.flatpakrepo}"
ICON_URL="${ICON_URL:-${BASE_URL%/}/${APP_ID}.svg}"
GPG_KEY_ID="${GPG_KEY_ID:-}"
GPG_KEY_FILE="${GPG_KEY_FILE:-}"
GPG_KEY_BASE64="${GPG_KEY_BASE64:-}"
DISABLE_DOWNLOAD="${DISABLE_DOWNLOAD:-0}"
if [ "$DISABLE_DOWNLOAD" = "1" ]; then
    SETUP_FLATHUB="${SETUP_FLATHUB:-0}"
else
    SETUP_FLATHUB="${SETUP_FLATHUB:-1}"
fi

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Missing required command: $1" >&2
        exit 1
    fi
}

base64_file() {
    if base64 --wrap=0 "$1" >/dev/null 2>&1; then
        base64 --wrap=0 "$1"
    else
        base64 "$1" | tr -d '\n'
    fi
}

write_gpg_key_line() {
    if [ -n "$GPG_KEY_BASE64" ]; then
        printf 'GPGKey=%s\n' "$GPG_KEY_BASE64"
    fi
}

require_command flatpak
require_command flatpak-builder
require_command base64

mkdir -p "$OUTPUT_DIR"

if [ -z "$GPG_KEY_BASE64" ] && [ -n "$GPG_KEY_FILE" ]; then
    GPG_KEY_BASE64="$(base64_file "$GPG_KEY_FILE")"
fi

if [ "$SETUP_FLATHUB" = "1" ]; then
    flatpak remote-add --user --if-not-exists flathub "$RUNTIME_REPO"
fi

sign_args=()
bundle_key_args=()
download_args=()
if [ -n "$GPG_KEY_ID" ]; then
    sign_args=(--gpg-sign="$GPG_KEY_ID")
fi
if [ -n "$GPG_KEY_FILE" ]; then
    bundle_key_args=(--gpg-keys="$GPG_KEY_FILE")
fi
if [ "$DISABLE_DOWNLOAD" = "1" ]; then
    download_args=(--disable-download)
fi

flatpak-builder \
    --force-clean \
    --disable-rofiles-fuse \
    --repo="$REPO_DIR" \
    --default-branch="$BRANCH" \
    "${download_args[@]}" \
    "${sign_args[@]}" \
    "$BUILD_DIR" \
    "$MANIFEST"

flatpak build-update-repo \
    --generate-static-deltas \
    "${sign_args[@]}" \
    "$REPO_DIR"

flatpak build-bundle \
    "${sign_args[@]}" \
    "${bundle_key_args[@]}" \
    --runtime-repo="$RUNTIME_REPO" \
    "$REPO_DIR" \
    "$BUNDLE" \
    "$APP_ID" \
    "$BRANCH"

cat >"${OUTPUT_DIR}/cinders.flatpakrepo" <<EOF
[Flatpak Repo]
Title=${APP_NAME}
Url=${BASE_URL%/}/repo/
Homepage=${HOMEPAGE}
Comment=Git forge notification client
Description=Signed Flatpak repository for ${APP_NAME}
Icon=${ICON_URL}
$(write_gpg_key_line)
EOF

cat >"${OUTPUT_DIR}/${APP_ID}.flatpakref" <<EOF
[Flatpak Ref]
Title=${APP_NAME}
Name=${APP_ID}
Branch=${BRANCH}
Url=${BASE_URL%/}/repo/
SuggestRemoteName=${REMOTE_NAME}
Homepage=${HOMEPAGE}
Icon=${ICON_URL}
RuntimeRepo=${RUNTIME_REPO}
IsRuntime=false
$(write_gpg_key_line)
EOF

cp data/dev.yulian.Cinders.svg "${OUTPUT_DIR}/${APP_ID}.svg"

cat <<EOF
Flatpak repository generated:
  Repository: ${REPO_DIR}
  Repo file:  ${OUTPUT_DIR}/cinders.flatpakrepo
  Ref file:   ${OUTPUT_DIR}/${APP_ID}.flatpakref
  Bundle:     ${BUNDLE}

Local unsigned smoke test:
  flatpak remote-add --user --if-not-exists --no-gpg-verify cinders-local ${REPO_DIR}
  flatpak install --user cinders-local ${APP_ID}//${BRANCH}
EOF
