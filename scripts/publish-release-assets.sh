#!/usr/bin/env bash
#
# Attach the installers produced by a packaging workflow to the GitHub release
# for the tagged version.
#
# Draft releases cannot be addressed through the `/releases/tags/<tag>`
# endpoint (it answers 404 until the draft is published), so every lookup goes
# through the release list and the numeric release id. The release is created as
# a draft and only published once every platform attached its complete asset
# set, which keeps a failed or cancelled platform out of the public release.
set -euo pipefail

usage() {
  echo "Usage: publish-release-assets.sh --tag <tag> --assets <directory> --platform <macos|linux>" >&2
  exit 2
}

tag=''
assets_dir=''
platform=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    --assets)
      assets_dir="${2:-}"
      shift 2
      ;;
    --platform)
      platform="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [ -z "$tag" ] || [ -z "$assets_dir" ] || { [ "$platform" != 'macos' ] && [ "$platform" != 'linux' ]; }; then
  usage
fi
: "${GH_TOKEN:?GH_TOKEN must be set to upload release assets}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

version="${tag#v}"
api="https://api.github.com/repos/${GITHUB_REPOSITORY}"
uploads="https://uploads.github.com/repos/${GITHUB_REPOSITORY}"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

api_call() {
  curl -fsSL \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$@"
}

tag_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H 'Accept: application/vnd.github+json' \
  "${api}/git/ref/tags/${tag}")"
if [ "$tag_status" != '200' ]; then
  echo "Release tag ${tag} does not exist (HTTP ${tag_status}); refusing to publish." >&2
  exit 1
fi

project_version="$(node -p "require('./package.json').version")"
if [ "v${project_version}" != "$tag" ]; then
  echo "Tag ${tag} does not match the packaged version ${project_version}." >&2
  exit 1
fi

release_id="$(api_call "${api}/releases?per_page=100" \
  | jq -r --arg tag "$tag" '[.[] | select(.tag_name == $tag)][0].id // empty')"
if [ -z "$release_id" ]; then
  notes_file="docs/release-notes/${version}.md"
  if [ -f "$notes_file" ]; then
    jq -n --rawfile body "$notes_file" --arg tag "$tag" --arg name "Twilight Echo ${version}" \
      '{tag_name: $tag, name: $name, draft: true, body: $body}' > "${workdir}/release.json"
  else
    jq -n --arg tag "$tag" --arg name "Twilight Echo ${version}" \
      '{tag_name: $tag, name: $name, draft: true}' > "${workdir}/release.json"
  fi
  release_id="$(api_call -X POST "${api}/releases" \
    -H 'Content-Type: application/json' --data-binary "@${workdir}/release.json" \
    | jq -r '.id // empty')"
fi
if [ -z "$release_id" ]; then
  echo "Unable to find or create the draft release for ${tag}." >&2
  exit 1
fi
echo "Release ${tag} resolved to id ${release_id}"

api_call "${api}/releases/${release_id}/assets?per_page=100" > "${workdir}/remote-assets.json"

for file in "${assets_dir}"/*; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  existing_id="$(jq -r --arg name "$name" '.[] | select(.name == $name) | .id' \
    "${workdir}/remote-assets.json" | head -n 1)"
  if [ -n "$existing_id" ]; then
    api_call -X DELETE "${api}/releases/assets/${existing_id}" > /dev/null
  fi
  api_call -X POST "${uploads}/releases/${release_id}/assets?name=${name}" \
    -H 'Content-Type: application/octet-stream' \
    --data-binary "@${file}" > /dev/null
  echo "Uploaded ${name}"
done

api_call "${api}/releases/${release_id}/assets?per_page=100" \
  | jq '[.[] | {name, size}]' > "${workdir}/release-assets.json"

node scripts/release-assets.cjs verify \
  --assets "${workdir}/release-assets.json" --version "$version" --platform "$platform"

if node scripts/release-assets.cjs verify \
  --assets "${workdir}/release-assets.json" --version "$version" --platform all; then
  if [ "$(api_call "${api}/releases/${release_id}" | jq -r '.draft')" = 'true' ]; then
    api_call -X PATCH "${api}/releases/${release_id}" \
      -H 'Content-Type: application/json' -d '{"draft":false}' > /dev/null
    echo "Published release ${tag}."
  else
    echo "Release ${tag} is already published."
  fi
else
  echo "Waiting for the remaining platform packages; the release stays draft."
fi
