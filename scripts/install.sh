#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'HELP'
Install Tanhuo from a prebuilt GitHub Release. No application build occurs.

Usage:
  curl -fsSL https://github.com/useroneoneone/dingshi-tanhuo/releases/latest/download/install.sh | bash
  bash install.sh --dir /opt/tanhuo --project tanhuo --port 3000
  bash install.sh --offline-dir /path/to/extracted/offline-bundle
  bash install.sh --dir /existing/deployment --project EXISTING_PROJECT --adopt

Options:
  --offline-dir PATH     Use only local bundle files; never download or use apt.
                         Requires Docker Engine and Compose already installed.
  --dir PATH             Absolute install directory. Default: /opt/tanhuo.
  --project NAME         Compose project name. Default: tanhuo, or saved name.
  --port PORT            Initial host port. Default: 3000. Fresh installs only.
  --bind IPV4            Initial host address. Default: 127.0.0.1. Fresh only.
  --skip-docker-install  Require Docker and the Compose plugin to exist.
  --adopt                Explicitly adopt existing .env + compose.yaml.
                         Requires --project matching the original deployment.
  --help                 Show this help without root, Docker or network access.

Run as root, or pipe the download to sudo bash. Fresh Ubuntu/Debian hosts can
install Docker from its official apt repository. Existing Docker is never
reinstalled, and conflicting distro packages are never automatically removed.
Saved API keys, passwords and the Compose data volume are never reset.
HELP
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

download() {
  ((offline_mode == 0)) || fail 'Network downloads are disabled in offline mode.'
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 \
    --proto '=https' --proto-redir '=https' --output "$2" "$1"
}

verify_asset() {
  local asset=$1 hash name extra matches=0 expected=
  local -A seen=()
  while read -r hash name extra || [[ -n $hash || -n $name || -n $extra ]]; do
    [[ -z $hash && -z $name && -z $extra ]] && continue
    [[ $hash =~ ^[a-fA-F0-9]{64}$ && -z $extra ]] || fail 'Malformed SHA256SUMS.'
    case "$name" in
      compose.yaml|env.example|install.sh|install-offline.sh|README-OFFLINE.md|dingshi-tanhuo-1.0.1-linux-amd64.tar.gz|dingshi-tanhuo-1.0.1-linux-arm64.tar.gz|dingshi-tanhuo-1.0.1-linux-amd64.tar.gz.sha256|dingshi-tanhuo-1.0.1-linux-arm64.tar.gz.sha256) ;;
      *) fail "Unexpected checksum filename: $name" ;;
    esac
    [[ -z ${seen[$name]+present} ]] || fail "Duplicate checksum filename: $name"
    seen[$name]=1
    if [[ $name == "$asset" ]]; then
      matches=$((matches + 1))
      expected=$hash
    fi
  done < "$temporary/SHA256SUMS"
  [[ $matches == 1 ]] || fail "Expected exactly one checksum for $asset."
  (cd -- "$temporary"; printf '%s  %s\n' "$expected" "$asset" | sha256sum --check --status) \
    || fail "Checksum verification failed: $asset"
}

copy_offline_asset() {
  local name=$1 source="$offline_directory/$1"
  [[ -f $source && ! -L $source ]] || fail "Missing or unsafe offline asset (regular files only): $name"
  cp --no-dereference -- "$source" "$temporary/$name"
  [[ -f $temporary/$name && ! -L $temporary/$name ]] || fail "Unsafe copied offline asset: $name"
}

stage_offline_payload() {
  local asset=$1 entry hash name extra
  say "Using offline bundle: $offline_directory"
  for entry in SHA256SUMS compose.yaml env.example "$asset"; do copy_offline_asset "$entry"; done
  for entry in compose.yaml env.example "$asset"; do verify_asset "$entry"; done
  while read -r hash name extra || [[ -n $hash || -n $name || -n $extra ]]; do
    [[ -z $hash && -z $name && -z $extra ]] && continue
    if [[ ! -f $temporary/$name ]]; then copy_offline_asset "$name"; fi
    verify_asset "$name"
  done < "$temporary/SHA256SUMS"
}

check_docker_ready() {
  if ! command -v docker >/dev/null; then
    ((offline_mode == 0)) \
      || fail 'Offline installation requires Docker Engine and the Compose plugin to be installed in advance; network installation is disabled.'
    install_docker
  fi
  docker info >/dev/null 2>&1 \
    || fail 'Docker is installed but its daemon is inaccessible. Start Docker and check root permissions; it will not be reinstalled.'
  docker compose version >/dev/null 2>&1 \
    || fail 'Docker Compose plugin is missing. Install it before retrying; the existing Engine will not be replaced and offline mode never installs packages.'
}

compose() (
  unset TANHUO_IMAGE HOST_BIND HOST_PORT ADMIN_USERNAME ADMIN_PASSWORD
  unset SECURE_COOKIE TRUST_PROXY ALLOW_PRIVATE_ENDPOINTS
  docker compose --project-name "$project" --project-directory "$directory" \
    --env-file "$directory/.env" --file "$directory/compose.yaml" "$@"
)

validate_compose() (
  unset TANHUO_IMAGE HOST_BIND HOST_PORT ADMIN_USERNAME ADMIN_PASSWORD
  unset SECURE_COOKIE TRUST_PROXY ALLOW_PRIVATE_ENDPOINTS
  docker compose --project-name "$project" --project-directory "$directory" \
    --env-file "$temporary/updated.env" --file "$temporary/compose.yaml" config --quiet
)

cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if ((result != 0 && configuration_applied)); then
    if [[ -n $backup ]]; then
      say 'Installation failed; restoring the previous deployment configuration.' >&2
      install -m 600 -- "$backup/.env" "$directory/.env"
      install -m 600 -- "$backup/compose.yaml" "$directory/compose.yaml"
      if [[ -f $backup/.tanhuo-project ]]; then
        install -m 600 -- "$backup/.tanhuo-project" "$directory/.tanhuo-project"
      else
        rm -f -- "$directory/.tanhuo-project"
      fi
      compose up -d --pull never --no-build >&2 \
        || say 'Automatic restart failed. Restore the backup and inspect Docker manually.' >&2
      say "Previous configuration backup: $backup" >&2
    elif ((start_attempted)); then
      say "Installation did not become healthy. Configuration and data are retained in $directory." >&2
      compose stop >&2
    else
      rm -f -- "$directory/.env" "$directory/compose.yaml" "$directory/.tanhuo-project" "$directory/.tanhuo-installed"
    fi
  fi
  if ((lock_acquired)); then rmdir -- "$directory/.install-lock"; fi
  if [[ -n $temporary && $temporary == /tmp/tanhuo-install.* && -d $temporary ]]; then
    rm -rf -- "$temporary"
  fi
  exit "$result"
}

check_directory() {
  local entry saved_project owner mode ancestor
  [[ $directory == /* && $directory != / && $directory != *$'\n'* && $directory != *$'\r'* ]] \
    || fail '--dir must be an absolute directory other than /.'
  directory=${directory%/}
  [[ $(realpath -m -- "$directory") == "$directory" ]] \
    || fail '--dir must be canonical and must not contain symlink components.'
  [[ ! -L $directory ]] || fail 'The install directory must not be a symlink.'
  ancestor=$(dirname -- "$directory")
  while :; do
    if [[ -e $ancestor ]]; then
      [[ -d $ancestor && ! -L $ancestor ]] || fail 'Install path ancestors must be real directories.'
      owner=$(stat -c '%u' -- "$ancestor")
      mode=$(stat -c '%a' -- "$ancestor")
      [[ $owner == 0 ]] || fail "Install path ancestor is not root-owned: $ancestor"
      if (( (8#$mode & 0022) != 0 )); then
        fail "Install path ancestor is writable by other users: $ancestor"
      fi
    fi
    [[ $ancestor != / ]] || break
    ancestor=$(dirname -- "$ancestor")
  done
  if [[ -e $directory ]]; then
    [[ -d $directory ]] || fail 'The install path is not a directory.'
    owner=$(stat -c '%u' -- "$directory")
    mode=$(stat -c '%a' -- "$directory")
    [[ $owner == 0 && $((8#$mode & 0022)) == 0 ]] \
      || fail 'The existing install directory must be root-owned and not group/world writable.'
  else
    install -d -m 700 -- "$directory"
  fi
  for entry in .env compose.yaml .tanhuo-project .tanhuo-installed backups .install-lock; do
    [[ ! -L $directory/$entry ]] || fail "Refusing symlink: $directory/$entry"
    if [[ -e $directory/$entry ]]; then
      owner=$(stat -c '%u' -- "$directory/$entry")
      mode=$(stat -c '%a' -- "$directory/$entry")
      [[ $owner == 0 && $((8#$mode & 0022)) == 0 ]] \
        || fail "Unsafe ownership or write permissions: $directory/$entry"
    fi
  done
  [[ ! -e $directory/.install-lock ]] || fail 'Another installation is running, or .install-lock is stale.'
  mkdir -- "$directory/.install-lock" || fail 'Unable to acquire the installation lock.'
  lock_acquired=1
  if [[ -e $directory/.tanhuo-project ]]; then
    [[ -f $directory/.tanhuo-project && -f $directory/.env && -f $directory/compose.yaml ]] \
      || fail 'Managed deployment is incomplete. Restore its configuration backup before retrying.'
    saved_project=$(< "$directory/.tanhuo-project")
    [[ $saved_project =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail 'Invalid saved Compose project.'
    if ((project_set)) && [[ $project != "$saved_project" ]]; then
      fail "The saved Compose project is $saved_project; changing it would select another data volume."
    fi
    project=$saved_project
    fresh=0
  elif ((adopt)); then
    ((project_set)) || fail '--adopt requires an explicit --project matching your original deployment.'
    [[ -f $directory/.env && -f $directory/compose.yaml ]] \
      || fail '--adopt requires regular .env and compose.yaml files.'
    fresh=0
  else
    shopt -s nullglob dotglob
    for entry in "$directory"/*; do
      [[ $entry == "$directory/.install-lock" ]] \
        || fail 'Refusing to overwrite an unmanaged directory. Use an empty directory, or --adopt with the original --project.'
    done
    shopt -u nullglob dotglob
  fi
  if ((!fresh && (port_set || bind_set))); then
    fail '--port and --bind are fresh-install options. Edit the existing .env to change them.'
  fi
}

check_existing_deployment() {
  local containers container working_directory service mount volume_exists=0 volume="${project}_tanhuo-data"
  containers=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$project")
  if ((fresh)) && [[ -n $containers ]]; then
    fail "Compose project $project already has containers. Select a different --project, or explicitly adopt the original deployment directory."
  fi
  for container in $containers; do
    [[ $container =~ ^[a-f0-9]{12,64}$ ]] || fail 'Unexpected Docker container identifier.'
    working_directory=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")
    service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")
    [[ $working_directory == "$directory" && $service == tanhuo ]] \
      || fail "Compose project $project belongs to a different directory or contains an unexpected service."
    mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Type}}:{{.Name}}:{{.RW}}{{end}}{{end}}' "$container")
    [[ $mount == "volume:$volume:true" ]] \
      || fail 'The existing container uses a different data mount. Automatic migration is refused.'
  done
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    volume_exists=1
    ((fresh == 0)) || fail "Data volume $volume already exists. Refusing a fresh install that could attach another deployment's data."
    [[ $(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume") == "$project" ]] \
      || fail 'The existing data volume has a different or missing Compose project label.'
    [[ $(docker volume inspect --format '{{index .Labels "com.docker.compose.volume"}}' "$volume") == tanhuo-data ]] \
      || fail 'The existing volume is not the managed tanhuo-data volume.'
  fi
  if ((!fresh)); then
    if ((adopt)) && [[ -z $containers && $volume_exists == 0 ]]; then
      fail 'No existing deployment was found for --project. Verify the original project name before adopting.'
    fi
    if [[ -f $directory/.tanhuo-installed && $volume_exists == 0 ]]; then
      fail 'The previously installed data volume is missing. Restore it instead of creating an empty database.'
    fi
    compose config --format json > "$temporary/existing-compose.json"
    docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --interactive --entrypoint node "$image" --input-type=module -e '
        import { readFileSync } from "node:fs";
        const project = process.argv[1];
        try {
          const config = JSON.parse(readFileSync(0, "utf8"));
          const services = Object.keys(config.services ?? {});
          const service = config.services?.tanhuo;
          const environment = service?.environment ?? {};
          const volumes = service?.volumes ?? [];
          const mounts = volumes.filter((v) => v.target === "/app/data");
          const mount = mounts[0];
          const volume = config.volumes?.["tanhuo-data"];
          if (config.name !== project || services.length !== 1 || services[0] !== "tanhuo" ||
              volumes.length !== 1 || mounts.length !== 1 || mount.type !== "volume" || mount.source !== "tanhuo-data" ||
              mount.read_only === true || !volume || volume.name !== `${project}_tanhuo-data` ||
              volume.external === true || (volume.driver && volume.driver !== "local") ||
              Object.keys(volume.driver_opts ?? {}).length > 0 ||
              (environment.DATA_DIR != null && environment.DATA_DIR !== "/app/data") ||
              (environment.ENCRYPTION_KEY != null && environment.ENCRYPTION_KEY !== "") ||
              service.command != null || service.entrypoint != null ||
              (service.working_dir != null && service.working_dir !== "/app")) {
            throw new Error("incompatible data mount");
          }
        } catch {
          console.error("Existing Compose data layout or runtime overrides are not compatible; custom volumes, data paths, encryption keys and commands require manual migration.");
          process.exit(1);
        }
      ' "$project" < "$temporary/existing-compose.json" \
      || fail 'Existing data-volume identity could not be verified. No active configuration was changed.'
  fi
}

install_docker() {
  local ID= VERSION_ID= VERSION_CODENAME= UBUNTU_CODENAME= suite package status architecture
  ((offline_mode == 0)) || fail 'Docker package installation is disabled in offline mode.'
  ((skip_docker_install == 0)) || fail 'Docker is missing and --skip-docker-install was selected.'
  [[ -f /etc/os-release ]] || fail 'Install Docker Engine and its Compose plugin before retrying.'
  . /etc/os-release
  [[ $ID == ubuntu || $ID == debian ]] \
    || fail 'Automatic Docker installation supports Ubuntu/Debian only. Install Docker and its Compose plugin first.'
  command -v apt-get >/dev/null && command -v dpkg-query >/dev/null \
    || fail 'The supported apt package manager was not found.'
  for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc docker-buildx; do
    status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
    [[ $status != installed ]] \
      || fail "Conflicting package $package is installed. Migrate it manually; this installer will not remove it."
  done
  suite=${VERSION_CODENAME:-}
  [[ $ID != ubuntu ]] || suite=${UBUNTU_CODENAME:-$suite}
  [[ $suite =~ ^[a-z0-9][a-z0-9.-]*$ ]] || fail 'Unsupported or missing distribution codename.'
  architecture=$(dpkg --print-architecture)
  [[ $architecture == amd64 || $architecture == arm64 ]] || fail 'Unsupported apt architecture.'
  say "Installing Docker Engine and Compose from Docker's official $ID apt repository..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl
  download "https://download.docker.com/linux/$ID/gpg" "$temporary/docker.asc"
  install -d -m 755 /etc/apt/keyrings
  install -m 644 -- "$temporary/docker.asc" /etc/apt/keyrings/docker.asc
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
    "$ID" "$suite" "$architecture" > "$temporary/docker.sources"
  install -m 644 -- "$temporary/docker.sources" /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if command -v systemctl >/dev/null; then
    systemctl enable --now docker
  elif command -v service >/dev/null; then
    service docker start
  fi
}

write_environment() {
  local source=$1
  awk -v image="$image" -v port="$port" -v bind="$bind" -v fresh="$fresh" '
    /^TANHUO_IMAGE=/ { images++; print "TANHUO_IMAGE=" image; next }
    fresh && /^HOST_PORT=/ { ports++; print "HOST_PORT=" port; next }
    fresh && /^HOST_BIND=/ { binds++; print "HOST_BIND=" bind; next }
    { print }
    END { if (images != 1 || (fresh && (ports != 1 || binds != 1))) exit 1 }
  ' "$source" > "$temporary/updated.env" \
    || fail 'The configuration must contain exactly one TANHUO_IMAGE= line (and HOST_PORT/HOST_BIND for fresh installs).'
}

wait_for_health() {
  local container status attempt
  container=$(compose ps --all --quiet tanhuo)
  [[ $container =~ ^[a-f0-9]{12,64}$ ]] || return 1
  for ((attempt=0; attempt<60; attempt++)); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container") \
      || return 1
    case "$status" in
      healthy) return 0 ;;
      unhealthy|exited|dead|removing) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

print_access() {
  local address host host_port
  say 'Use an HTTPS reverse proxy or an SSH tunnel for remote access.'
  if address=$(compose port tanhuo 3000 2>/dev/null) \
    && [[ $address =~ ^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)$ ]]; then
    host=${BASH_REMATCH[1]}
    host_port=${BASH_REMATCH[2]}
    say "Published address: $address"
    if [[ $host == 0.0.0.0 ]]; then
      say 'Warning: the application is bound to all IPv4 interfaces. Restrict the firewall and use HTTPS.'
      host=127.0.0.1
    fi
    printf '  ssh -N -L 3000:%s:%s user@your-server\n' "$host" "$host_port"
    say 'Then open http://127.0.0.1:3000 locally.'
  else
    printf 'Check the published address: cd %q && docker compose -p %q port tanhuo 3000\n' "$directory" "$project"
    say 'Configure the SSH tunnel destination using that published address.'
  fi
  say 'Never submit passwords or API keys over public HTTP.'
}

main() {
  local version=1.0.1 repository=useroneoneone/dingshi-tanhuo base platform machine asset entry
  directory=/opt/tanhuo
  project=tanhuo
  port=3000
  bind=127.0.0.1
  offline_directory=
  offline_mode=0
  project_set=0 port_set=0 bind_set=0 adopt=0 skip_docker_install=0
  temporary= backup= lock_acquired=0 configuration_applied=0 start_attempted=0 fresh=1
  while (($#)); do
    case "$1" in
      --help|-h) usage; return 0 ;;
      --adopt) adopt=1; shift ;;
      --skip-docker-install) skip_docker_install=1; shift ;;
      --dir|--project|--port|--bind|--offline-dir)
        (($# >= 2)) || fail "Missing value for $1"
        case "$1" in
          --dir) directory=$2 ;;
          --project) project=$2; project_set=1 ;;
          --port) port=$2; port_set=1 ;;
          --bind) bind=$2; bind_set=1 ;;
          --offline-dir) offline_directory=$2; offline_mode=1 ;;
        esac
        shift 2 ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  [[ $project =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail 'Invalid Compose project name.'
  [[ $port =~ ^[1-9][0-9]{0,4}$ ]] && ((10#$port <= 65535)) || fail 'Port must be between 1 and 65535.'
  [[ $bind =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail '--bind must be an IPv4 address.'
  IFS=. read -r -a octets <<< "$bind"
  for entry in "${octets[@]}"; do ((10#$entry <= 255)) || fail 'Invalid IPv4 address.'; done
  [[ $(uname -s) == Linux ]] || fail 'This installer supports Linux servers only.'
  [[ $EUID == 0 ]] || fail 'Run as root, or pipe the download to sudo bash.'
  machine=$(uname -m)
  case "$machine" in
    x86_64|amd64) platform=amd64 ;;
    aarch64|arm64) platform=arm64 ;;
    *) fail "Unsupported server architecture: $machine" ;;
  esac
  for entry in sha256sum mktemp realpath stat awk install dirname; do
    command -v "$entry" >/dev/null || fail "Required command is missing: $entry"
  done
  if ((offline_mode)); then
    for entry in cp cmp; do
      command -v "$entry" >/dev/null || fail "Required offline command is missing: $entry"
    done
    [[ -d $offline_directory && ! -L $offline_directory && $offline_directory != *$'\n'* && $offline_directory != *$'\r'* ]] \
      || fail '--offline-dir must refer to an existing, non-symlink bundle directory.'
    offline_directory=$(realpath -e -- "$offline_directory")
    check_docker_ready
  else
    command -v curl >/dev/null || fail 'Required command is missing: curl'
  fi
  umask 077
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  check_directory
  temporary=$(mktemp -d /tmp/tanhuo-install.XXXXXXXX)
  base="https://github.com/$repository/releases/download/v$version"
  asset="dingshi-tanhuo-$version-linux-$platform.tar.gz"
  image="dingshi-tanhuo:$version"
  if ((offline_mode)); then
    stage_offline_payload "$asset"
    if ((!fresh)); then
      cmp --silent -- "$directory/compose.yaml" "$temporary/compose.yaml" \
        || fail 'Offline updates require the existing compose.yaml to match the bundled stock template exactly. Custom Compose files require manual migration; no Compose parsing or remote include was attempted.'
    fi
  else
    say "Downloading Tanhuo $version for linux/$platform..."
    for entry in SHA256SUMS compose.yaml env.example "$asset"; do
      download "$base/$entry" "$temporary/$entry"
    done
    for entry in compose.yaml env.example "$asset"; do verify_asset "$entry"; done
    check_docker_ready
  fi
  say 'Loading the verified prebuilt image (no compilation)...'
  docker load --input "$temporary/$asset"
  [[ $(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}') == "linux/$platform" ]] \
    || fail 'The loaded image does not match the requested tag and architecture.'
  check_existing_deployment
  if ((fresh)); then
    write_environment "$temporary/env.example"
  else
    write_environment "$directory/.env"
  fi
  validate_compose
  if ((!fresh)); then
    [[ ! -e $directory/backups || -d $directory/backups ]] || fail 'backups must be a directory.'
    install -d -m 700 -- "$directory/backups"
    backup=$(mktemp -d "$directory/backups/install-XXXXXXXX")
    install -m 600 -- "$directory/.env" "$backup/.env"
    install -m 600 -- "$directory/compose.yaml" "$backup/compose.yaml"
    if [[ -f $directory/.tanhuo-project ]]; then
      install -m 600 -- "$directory/.tanhuo-project" "$backup/.tanhuo-project"
    fi
  fi
  configuration_applied=1
  printf '%s\n' "$project" > "$temporary/.tanhuo-project"
  install -m 600 -- "$temporary/.tanhuo-project" "$directory/.tanhuo-project"
  install -m 600 -- "$temporary/updated.env" "$directory/.env"
  install -m 600 -- "$temporary/compose.yaml" "$directory/compose.yaml"
  start_attempted=1
  compose up -d --pull never --no-build
  wait_for_health || fail 'The container did not become healthy; installation was not successful.'
  printf '%s\n' "$version" > "$temporary/.tanhuo-installed"
  install -m 600 -- "$temporary/.tanhuo-installed" "$directory/.tanhuo-installed"
  configuration_applied=0
  say "Installation successful: Tanhuo $version is healthy."
  say "Directory: $directory"
  say "Compose project: $project (keep this name to retain the same data volume)"
  [[ -z $backup ]] || say "Previous configuration backup: $backup"
  if ((fresh)); then
    say 'First-start logs (a new administrator password is printed only once):'
    compose logs --no-color --tail 20 tanhuo \
      || say 'Unable to read first-start logs; inspect docker compose logs manually.' >&2
  fi
  printf 'Manage: cd %q && docker compose -p %q up -d --pull never --no-build\n' "$directory" "$project"
  print_access
  say 'Never use docker compose down -v; it deletes the database and encryption key.'
}

main "$@"
