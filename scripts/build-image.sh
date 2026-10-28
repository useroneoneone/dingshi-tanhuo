#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
Build a Linux image locally and export a compressed, checksum-protected archive.

Usage:
  bash scripts/build-image.sh --version 1.0.0
  bash scripts/build-image.sh --version 1.0.0 --platform linux/arm64
  bash scripts/build-image.sh --version 1.0.0 --base-image public.ecr.aws/docker/library/node:24-bookworm-slim
  bash scripts/build-image.sh --version 1.0.0 --image ghcr.io/OWNER/dingshi-tanhuo:1.0.0 --push

Options:
  --version      Archive version and default image tag. Default: 1.0.0.
  --platform     linux/amd64 or linux/arm64. Match the cloud server architecture.
  --image        Image reference. Default: dingshi-tanhuo:<version>.
  --base-image   Optional Dockerfile NODE_IMAGE override.
  --output-dir   Archive directory, relative to this project or absolute.
  --push         Explicitly push after export. Requires registry login.
  --help         Show help without building.

No registry publication occurs without --push. Existing archives are not replaced.
Archives contain the image only, never the application's runtime data volume.
HELP
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
version=1.0.0
platform=linux/amd64
image=
base_image=
output_dir=artifacts
push=false
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --push) push=true; shift ;;
    --version|--platform|--image|--base-image|--output-dir)
      (($# >= 2)) || fail "Missing value for $1"
      case "$1" in
        --version) version=$2 ;;
        --platform) platform=$2 ;;
        --image) image=$2 ;;
        --base-image) base_image=$2 ;;
        --output-dir) output_dir=$2 ;;
      esac
      shift 2
      ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[[ $version =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail 'Version must be a Docker tag without spaces or path separators.'
[[ $platform == linux/amd64 || $platform == linux/arm64 ]] || fail 'Platform must be linux/amd64 or linux/arm64.'
image=${image:-dingshi-tanhuo:$version}
[[ $image =~ ^[a-z0-9][A-Za-z0-9._:/-]*$ ]] || fail 'Invalid image reference.'
[[ -z $base_image || $base_image =~ ^[a-z0-9][A-Za-z0-9._:/-]*$ ]] || fail 'Invalid base image reference.'
[[ $push != true || $image == */* ]] || fail 'Use --image with a registry/owner repository when requesting --push.'
[[ -n $output_dir && $output_dir != *$'\n'* ]] || fail 'Output directory must not be empty or contain newlines.'
command -v docker >/dev/null || fail 'Docker is required.'
command -v gzip >/dev/null || fail 'gzip is required.'
if command -v sha256sum >/dev/null; then
  checksum_command=(sha256sum)
elif command -v shasum >/dev/null; then
  checksum_command=(shasum -a 256)
else
  fail 'sha256sum or shasum is required.'
fi

project_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ $output_dir == /* ]] || output_dir="$project_root/$output_dir"
mkdir -p -- "$output_dir"
output_dir=$(CDPATH= cd -- "$output_dir" && pwd -P)
archive_name="dingshi-tanhuo-$version-${platform//\//-}.tar.gz"
archive="$output_dir/$archive_name"
checksum="$archive.sha256"
[[ ! -e $archive && ! -L $archive && ! -e $checksum && ! -L $checksum ]] || fail "Output already exists: $archive"

build_arguments=(buildx build --platform "$platform" --load --provenance=false --tag "$image")
[[ -z $base_image ]] || build_arguments+=(--build-arg "NODE_IMAGE=$base_image")
printf 'Building %s for %s locally...\n' "$image" "$platform"
docker "${build_arguments[@]}" "$project_root"

temporary_tar=$(mktemp "$output_dir/.tanhuo-XXXXXXXX")
temporary_gzip=$(mktemp "$output_dir/.tanhuo-XXXXXXXX")
trap 'rm -f -- "$temporary_tar" "$temporary_gzip"' EXIT
docker image save --output "$temporary_tar" "$image"
gzip -n -c -- "$temporary_tar" > "$temporary_gzip"
mv -n -- "$temporary_gzip" "$archive"
[[ ! -e $temporary_gzip ]] || fail "Archive was created by another process: $archive"
(set -o noclobber; cd -- "$output_dir"; "${checksum_command[@]}" "$archive_name" > "$checksum")
printf 'Image:    %s\nArchive:  %s\nChecksum: %s\n' "$image" "$archive" "$checksum"
if [[ $push == true ]]; then
  printf 'Pushing %s...\n' "$image"
  docker image push "$image"
fi
