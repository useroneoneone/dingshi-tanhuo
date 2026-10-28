#!/usr/bin/env bash
set -Eeuo pipefail

[[ -f /.dockerenv && $EUID == 0 ]] || {
  printf 'Run this test only in a disposable root Linux Docker container.\n' >&2
  exit 1
}

source_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
installer="$source_root/scripts/install.sh"
test_root=$(mktemp -d /opt/tanhuo-installer-tests.XXXXXXXX)
trap 'rm -rf -- "$test_root"' EXIT
trap 'printf "FAIL: %s (line %s)\n" "${test_name:-setup}" "$LINENO" >&2' ERR
mkdir -p "$test_root/bin" "$test_root/release"
export MOCK_BIN="$test_root/bin"
export MOCK_DOCKER_SOURCE="$test_root/docker-source"

cat > "$test_root/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
output= url=
while (($#)); do
  case "$1" in
    --output|-o) output=$2; shift 2 ;;
    --retry|--connect-timeout|--proto|--proto-redir) shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf 'curl %s\n' "$url" >> "$MOCK_LOG"
[[ -n $output && $url == https://* ]] || exit 2
asset=${url##*/}
[[ ${MOCK_DOWNLOAD_FAIL:-} != "$asset" ]] || exit 22
if [[ $url == https://download.docker.com/linux/*/gpg ]]; then
  printf 'synthetic-test-key\n' > "$output"
else
  [[ $url == https://github.com/useroneoneone/dingshi-tanhuo/releases/download/v1.0.1/* ]] || exit 2
  cp -- "$MOCK_RELEASE/$asset" "$output"
fi
STUB

cat > "$test_root/docker-source" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker' >> "$MOCK_LOG"
printf ' %q' "$@" >> "$MOCK_LOG"
printf '\n' >> "$MOCK_LOG"
case "$1" in
  info) [[ ${MOCK_DAEMON_FAIL:-0} == 0 ]] ;;
  load) [[ -f $3 ]] ;;
  ps)
    project_filter=${@: -1}
    if [[ -f $MOCK_STATE/container && $project_filter == "label=com.docker.compose.project=$(< "$MOCK_STATE/project")" ]]; then
      printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
    fi ;;
  volume)
    volume=${@: -1}
    [[ -f $MOCK_STATE/volume && $volume == "$(< "$MOCK_STATE/project")_tanhuo-data" ]] || exit 1
    if [[ $3 == --format ]]; then
      case "$4" in
        *com.docker.compose.project*) printf '%s\n' "$(< "$MOCK_STATE/project")" ;;
        *com.docker.compose.volume*) printf 'tanhuo-data\n' ;;
        *) exit 2 ;;
      esac
    fi ;;
  image)
    [[ $2 == inspect && $3 == dingshi-tanhuo:1.0.1 ]] || exit 2
    case "${MOCK_ARCH:-x86_64}" in
      aarch64|arm64) printf 'linux/arm64\n' ;;
      *) printf 'linux/amd64\n' ;;
    esac ;;
  inspect)
    case "$3" in
      *com.docker.compose.project.working_dir*) printf '%s\n' "${MOCK_WORKING_DIR:-$(< "$MOCK_STATE/directory")}" ;;
      *com.docker.compose.service*) printf 'tanhuo\n' ;;
      *Destination*) printf '%s\n' "${MOCK_DATA_MOUNT:-volume:$(< "$MOCK_STATE/project")_tanhuo-data:true}" ;;
      *) printf '%s\n' "${MOCK_HEALTH:-healthy}" ;;
    esac ;;
  run)
    shift
    while [[ $1 != --entrypoint ]]; do shift; done
    [[ $2 == node ]] || exit 2
    shift 3
    exec node "$@" ;;
  compose)
    shift
    if [[ $1 == version ]]; then
      [[ ${MOCK_COMPOSE_MISSING:-0} == 0 ]]
      exit
    fi
    project= directory= env_file=
    while [[ $1 == --* ]]; do
      case "$1" in
        --project-name) project=$2 ;;
        --project-directory) directory=$2 ;;
        --env-file) env_file=$2 ;;
      esac
      shift 2
    done
    case "$1" in
      config)
        [[ ${MOCK_CONFIG_FAIL:-0} == 0 ]] || exit 1
        if [[ ${2:-} == --format && ${3:-} == json ]]; then
          case "${MOCK_DATA_LAYOUT:-standard}" in
            bind) printf '{"name":"%s","services":{"tanhuo":{"volumes":[{"type":"bind","source":"/other","target":"/app/data"}]}}}\n' "$project" ;;
            external) printf '{"name":"%s","services":{"tanhuo":{"volumes":[{"type":"volume","source":"tanhuo-data","target":"/app/data"}]}},"volumes":{"tanhuo-data":{"name":"%s_tanhuo-data","external":true}}}\n' "$project" "$project" ;;
            custom) printf '{"name":"%s","services":{"tanhuo":{"volumes":[{"type":"volume","source":"custom","target":"/app/data"}]}},"volumes":{"custom":{"name":"custom-data"}}}\n' "$project" ;;
            extra_volume) printf '{"name":"%s","services":{"tanhuo":{"volumes":[{"type":"volume","source":"tanhuo-data","target":"/app/data"},{"type":"bind","source":"/custom/master.key","target":"/app/data/master.key"}]}},"volumes":{"tanhuo-data":{"name":"%s_tanhuo-data"}}}\n' "$project" "$project" ;;
            *)
              extra=
              case "${MOCK_DATA_LAYOUT:-standard}" in
                data_dir) extra=',"environment":{"DATA_DIR":"/different"}' ;;
                empty_data_dir) extra=',"environment":{"DATA_DIR":""}' ;;
                encryption_key) extra=',"environment":{"ENCRYPTION_KEY":"synthetic-test-only"}' ;;
                command) extra=',"command":["node","custom.js"]' ;;
                entrypoint) extra=',"entrypoint":["node","custom.js"]' ;;
                working_dir) extra=',"working_dir":"/different"' ;;
              esac
              printf '{"name":"%s","services":{"tanhuo":{"volumes":[{"type":"volume","source":"tanhuo-data","target":"/app/data"}]%s}},"volumes":{"tanhuo-data":{"name":"%s_tanhuo-data"}}}\n' "$project" "$extra" "$project" ;;
          esac
        fi ;;
      up)
        [[ ${MOCK_UP_FAIL:-0} == 0 ]] || exit 1
        printf '%s' "$project" > "$MOCK_STATE/project"
        printf '%s' "$directory" > "$MOCK_STATE/directory"
        touch "$MOCK_STATE/container" "$MOCK_STATE/volume" ;;
      ps) printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n' ;;
      port)
        port=$(awk -F= '$1 == "HOST_PORT" { print $2 }' "$env_file")
        printf '127.0.0.1:%s\n' "${port:-3000}" ;;
      logs)
        printf 'Initial administrator: admin\n'
        printf 'Initial password: synthetic-test-only-not-a-real-password\n' ;;
      stop) exit 0 ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
STUB

cat > "$test_root/bin/uname" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  -s) printf 'Linux\n' ;;
  -m) printf '%s\n' "${MOCK_ARCH:-x86_64}" ;;
  *) exit 2 ;;
esac
STUB

cat > "$test_root/bin/apt-get" <<'STUB'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> "$MOCK_LOG"
if [[ $* == *' docker-ce '* ]]; then
  cp -- "$MOCK_DOCKER_SOURCE" "$MOCK_BIN/docker"
  chmod 755 "$MOCK_BIN/docker"
fi
STUB

cat > "$test_root/bin/dpkg-query" <<'STUB'
#!/usr/bin/env bash
package=${@: -1}
if [[ ${MOCK_CONFLICT:-} == "$package" ]]; then
  printf installed
else
  exit 1
fi
STUB

cat > "$test_root/bin/dpkg" <<'STUB'
#!/usr/bin/env bash
[[ $1 == --print-architecture ]] || exit 2
printf amd64
STUB

cat > "$test_root/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$MOCK_LOG"
STUB

chmod 755 "$test_root/bin/"* "$test_root/docker-source"
export PATH="$test_root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cp -- "$source_root/compose.yaml" "$test_root/release/compose.yaml"
cp -- "$source_root/.env.example" "$test_root/release/env.example"
cp -- "$installer" "$test_root/release/install.sh"
for architecture in amd64 arm64; do
  printf 'synthetic image fixture for %s\n' "$architecture" > "$test_root/release/dingshi-tanhuo-1.0.1-linux-$architecture.tar.gz"
  (cd -- "$test_root/release"; sha256sum "dingshi-tanhuo-1.0.1-linux-$architecture.tar.gz" > "dingshi-tanhuo-1.0.1-linux-$architecture.tar.gz.sha256")
done
(
  cd -- "$test_root/release"
  sha256sum compose.yaml env.example install.sh dingshi-tanhuo-*.tar.gz dingshi-tanhuo-*.tar.gz.sha256 > SHA256SUMS
)

new_case() {
  local case_name=$1
  test_name=$case_name
  case_root="$test_root/$case_name"
  mkdir -m 700 -- "$case_root"
  mkdir "$case_root/state"
  export MOCK_STATE="$case_root/state"
  cp -a -- "$test_root/release" "$case_root/release"
  export MOCK_RELEASE="$case_root/release"
  export MOCK_LOG="$case_root/commands"
  : > "$MOCK_LOG"
  cp -- "$test_root/docker-source" "$test_root/bin/docker"
  chmod 755 "$test_root/bin/docker"
  unset MOCK_ARCH MOCK_DAEMON_FAIL MOCK_COMPOSE_MISSING MOCK_DOWNLOAD_FAIL MOCK_CONFIG_FAIL MOCK_UP_FAIL MOCK_HEALTH MOCK_CONFLICT MOCK_WORKING_DIR MOCK_DATA_MOUNT MOCK_DATA_LAYOUT
}

existing_state() {
  printf '%s' "$1" > "$MOCK_STATE/project"
  printf '%s' "$case_root/deploy" > "$MOCK_STATE/directory"
  touch "$MOCK_STATE/volume" "$MOCK_STATE/container"
}

invoke() {
  bash "$installer" --dir "$case_root/deploy" "$@" > "$case_root/output" 2>&1
}

expect_failure() {
  if invoke "$@"; then
    cat "$case_root/output" >&2
    printf 'Expected installer failure in %s\n' "$test_name" >&2
    exit 1
  fi
  ! grep -Fq 'Installation successful:' "$case_root/output"
}

pass() { printf 'PASS: %s\n' "$test_name"; }

new_case help_without_docker
rm -- "$test_root/bin/docker"
bash "$installer" --help > "$case_root/output"
grep -Fq 'No application build occurs' "$case_root/output"
[[ ! -s $MOCK_LOG ]]
pass

new_case fresh_install
invoke --port 4123
grep -Fxq 'TANHUO_IMAGE=dingshi-tanhuo:1.0.1' "$case_root/deploy/.env"
grep -Fxq 'HOST_PORT=4123' "$case_root/deploy/.env"
grep -Fxq 'HOST_BIND=127.0.0.1' "$case_root/deploy/.env"
[[ $(stat -c '%a' "$case_root/deploy/.env") == 600 ]]
[[ $(stat -c '%a' "$case_root/deploy") == 700 ]]
[[ $(< "$case_root/deploy/.tanhuo-project") == tanhuo ]]
grep -Fq 'Installation successful:' "$case_root/output"
grep -Fq 'synthetic-test-only-not-a-real-password' "$case_root/output"
grep -Fq 'ssh -N -L 3000:127.0.0.1:4123 user@your-server' "$case_root/output"
grep -Fq 'up -d --pull never --no-build' "$MOCK_LOG"
! grep -Eq 'docker (build|buildx|.*down.*-v|.*prune)' "$MOCK_LOG"
[[ ! -e $case_root/deploy/.install-lock ]]
pass

new_case repeat_preserves_configuration_and_files
invoke --project original
printf 'ADMIN_PASSWORD=synthetic-custom-password\nTANHUO_IMAGE=dingshi-tanhuo:0.9.0\nHOST_PORT=4444\nHOST_BIND=127.0.0.1\nSECURE_COOKIE=true\nCUSTOM_SETTING=leave-me-alone\n' > "$case_root/deploy/.env"
mkdir "$case_root/deploy/local-data"
printf 'synthetic-persistent-key' > "$case_root/deploy/local-data/master.key"
cp "$case_root/deploy/.env" "$case_root/before.env"
: > "$MOCK_LOG"
invoke
[[ $(< "$case_root/deploy/.tanhuo-project") == original ]]
diff <(sed '/^TANHUO_IMAGE=/d' "$case_root/before.env") <(sed '/^TANHUO_IMAGE=/d' "$case_root/deploy/.env")
[[ $(< "$case_root/deploy/local-data/master.key") == synthetic-persistent-key ]]
! grep -Fq 'synthetic-test-only-not-a-real-password' "$case_root/output"
! grep -Fq ' logs ' "$MOCK_LOG"
grep -Fq -- '--project-name original' "$MOCK_LOG"
[[ $(find "$case_root/deploy/backups" -name .env -type f | wc -l) == 1 ]]
pass

new_case corrupt_archive
printf changed >> "$MOCK_RELEASE/dingshi-tanhuo-1.0.1-linux-amd64.tar.gz"
expect_failure
grep -Fq 'Checksum verification failed' "$case_root/output"
[[ ! -e $case_root/deploy/.env && ! -e $case_root/deploy/compose.yaml ]]
! grep -Fq docker "$MOCK_LOG"
[[ ! -e $case_root/deploy/.install-lock ]]
pass

new_case download_failure
export MOCK_DOWNLOAD_FAIL=compose.yaml
expect_failure
[[ ! -e $case_root/deploy/.env ]]
! grep -Fq docker "$MOCK_LOG"
pass

new_case untrusted_checksum_paths
printf '%064d  ../../outside\n' 0 >> "$MOCK_RELEASE/SHA256SUMS"
expect_failure
grep -Fq 'Unexpected checksum filename' "$case_root/output"
[[ ! -e $case_root/deploy/.env ]]
pass

new_case duplicate_checksum
grep '  install.sh$' "$MOCK_RELEASE/SHA256SUMS" >> "$case_root/duplicate"
cat "$case_root/duplicate" >> "$MOCK_RELEASE/SHA256SUMS"
expect_failure
grep -Fq 'Duplicate checksum filename' "$case_root/output"
[[ ! -e $case_root/deploy/.env ]]
pass

new_case arm64_archive
export MOCK_ARCH=aarch64
invoke
grep -Fq '/dingshi-tanhuo-1.0.1-linux-arm64.tar.gz' "$MOCK_LOG"
! grep -Fq '/dingshi-tanhuo-1.0.1-linux-amd64.tar.gz' "$MOCK_LOG"
pass

new_case unsupported_architecture
export MOCK_ARCH=riscv64
expect_failure
grep -Fq 'Unsupported server architecture' "$case_root/output"
[[ ! -e $case_root/deploy && ! -s $MOCK_LOG ]]
pass

new_case unmanaged_directory
mkdir -m 700 "$case_root/deploy"
printf existing > "$case_root/deploy/compose.yaml"
printf 'TANHUO_IMAGE=old\n' > "$case_root/deploy/.env"
expect_failure
grep -Fq 'unmanaged directory' "$case_root/output"
[[ $(< "$case_root/deploy/compose.yaml") == existing ]]
[[ ! -s $MOCK_LOG ]]
pass

new_case explicit_manual_adoption
mkdir -m 700 "$case_root/deploy"
printf existing > "$case_root/deploy/compose.yaml"
printf 'TANHUO_IMAGE=old\nHOST_PORT=7777\nCUSTOM=preserve\n' > "$case_root/deploy/.env"
existing_state legacy
expect_failure --adopt
grep -Fq -- '--adopt requires an explicit --project' "$case_root/output"
invoke --adopt --project legacy
[[ $(< "$case_root/deploy/.tanhuo-project") == legacy ]]
grep -Fxq 'HOST_PORT=7777' "$case_root/deploy/.env"
grep -Fxq 'CUSTOM=preserve' "$case_root/deploy/.env"
grep -Fq -- '--project-name legacy' "$MOCK_LOG"
[[ $(find "$case_root/deploy/backups" -name compose.yaml -type f | wc -l) == 1 ]]
pass

for layout in bind external custom extra_volume data_dir empty_data_dir encryption_key command entrypoint working_dir; do
  new_case "adoption_rejects_${layout}_data_mount"
  mkdir -m 700 "$case_root/deploy"
  printf existing > "$case_root/deploy/compose.yaml"
  printf 'TANHUO_IMAGE=old\nHOST_PORT=7777\n' > "$case_root/deploy/.env"
  existing_state legacy
  export MOCK_DATA_LAYOUT=$layout
  cp "$case_root/deploy/.env" "$case_root/before.env"
  cp "$case_root/deploy/compose.yaml" "$case_root/before.compose"
  expect_failure --adopt --project legacy
  grep -Fq 'data-volume identity could not be verified' "$case_root/output"
  diff "$case_root/before.env" "$case_root/deploy/.env"
  diff "$case_root/before.compose" "$case_root/deploy/compose.yaml"
  [[ ! -e $case_root/deploy/.tanhuo-project ]]
  pass
done

new_case adoption_project_typo_refused
mkdir -m 700 "$case_root/deploy"
printf existing > "$case_root/deploy/compose.yaml"
printf 'TANHUO_IMAGE=old\n' > "$case_root/deploy/.env"
existing_state legacy
expect_failure --adopt --project typo
grep -Fq 'No existing deployment was found' "$case_root/output"
[[ $(< "$case_root/deploy/compose.yaml") == existing ]]
pass

new_case fresh_project_collision_refused
existing_state tanhuo
expect_failure
grep -Fq 'already has containers' "$case_root/output"
[[ ! -e $case_root/deploy/.env ]]
! grep -Fq 'up -d' "$MOCK_LOG"
pass

new_case fresh_volume_collision_refused
existing_state tanhuo
rm "$MOCK_STATE/container"
expect_failure
grep -Fq 'Refusing a fresh install' "$case_root/output"
[[ ! -e $case_root/deploy/.env ]]
! grep -Fq 'up -d' "$MOCK_LOG"
pass

new_case managed_foreign_directory_refused
invoke
cp "$case_root/deploy/.env" "$case_root/before.env"
export MOCK_WORKING_DIR=/another/deployment
expect_failure
grep -Fq 'different directory' "$case_root/output"
diff "$case_root/before.env" "$case_root/deploy/.env"
pass

new_case actual_container_mount_mismatch
invoke
export MOCK_DATA_MOUNT=bind::true
expect_failure
grep -Fq 'different data mount' "$case_root/output"
pass

new_case missing_managed_data_volume
invoke
rm "$MOCK_STATE/volume" "$MOCK_STATE/container"
expect_failure
grep -Fq 'previously installed data volume is missing' "$case_root/output"
! grep -Fq 'empty database' "$case_root/deploy/.env"
pass

new_case project_mismatch_and_existing_bind_override
invoke --project existing
cp "$case_root/deploy/.env" "$case_root/before.env"
expect_failure --project another
grep -Fq 'changing it would select another data volume' "$case_root/output"
diff "$case_root/before.env" "$case_root/deploy/.env"
expect_failure --port 5000
grep -Fq 'fresh-install options' "$case_root/output"
diff "$case_root/before.env" "$case_root/deploy/.env"
pass

new_case symlink_rejected
mkdir -m 700 "$case_root/real"
ln -s "$case_root/real" "$case_root/deploy"
expect_failure
grep -Eq 'symlink|canonical' "$case_root/output"
[[ -z $(find "$case_root/real" -mindepth 1 -print -quit) ]]
pass

new_case unsafe_existing_permissions
mkdir -m 777 "$case_root/deploy"
expect_failure
grep -Fq 'not group/world writable' "$case_root/output"
pass

new_case unsafe_ancestor_permissions
mkdir -m 777 "$case_root/unsafe-parent"
if bash "$installer" --dir "$case_root/unsafe-parent/deploy" > "$case_root/output" 2>&1; then
  exit 1
fi
grep -Fq 'ancestor is writable by other users' "$case_root/output"
[[ ! -e $case_root/unsafe-parent/deploy ]]
pass

new_case unsafe_ancestor_owner
mkdir -m 755 "$case_root/foreign-parent"
chown 12345:12345 "$case_root/foreign-parent"
if bash "$installer" --dir "$case_root/foreign-parent/deploy" > "$case_root/output" 2>&1; then
  exit 1
fi
grep -Fq 'ancestor is not root-owned' "$case_root/output"
[[ ! -e $case_root/foreign-parent/deploy ]]
pass

new_case concurrent_installation
mkdir -m 700 "$case_root/deploy"
mkdir "$case_root/deploy/.install-lock"
expect_failure
grep -Fq 'Another installation is running' "$case_root/output"
[[ -d $case_root/deploy/.install-lock && ! -s $MOCK_LOG ]]
pass

new_case missing_docker_explicit_skip
rm "$test_root/bin/docker"
expect_failure --skip-docker-install
grep -Fq 'Docker is missing' "$case_root/output"
! grep -Fq apt-get "$MOCK_LOG"
[[ ! -e $case_root/deploy/.env ]]
pass

new_case existing_docker_inaccessible
export MOCK_DAEMON_FAIL=1
expect_failure
grep -Fq 'daemon is inaccessible' "$case_root/output"
! grep -Eq 'apt-get|docker load|systemctl' "$MOCK_LOG"
pass

new_case existing_docker_missing_compose
export MOCK_COMPOSE_MISSING=1
expect_failure
grep -Fq 'Compose plugin is missing' "$case_root/output"
! grep -Eq 'apt-get|docker load|systemctl' "$MOCK_LOG"
pass

new_case fresh_docker_conflict_refused
rm "$test_root/bin/docker"
export MOCK_CONFLICT=containerd
expect_failure
grep -Fq 'Conflicting package containerd' "$case_root/output"
! grep -Fq apt-get "$MOCK_LOG"
pass

new_case invalid_compose_does_not_mutate_existing
invoke
cp "$case_root/deploy/.env" "$case_root/before.env"
cp "$case_root/deploy/compose.yaml" "$case_root/before.compose"
export MOCK_CONFIG_FAIL=1
expect_failure
diff "$case_root/before.env" "$case_root/deploy/.env"
diff "$case_root/before.compose" "$case_root/deploy/compose.yaml"
[[ ! -d $case_root/deploy/backups ]]
pass

new_case fresh_health_failure
export MOCK_HEALTH=unhealthy
expect_failure
grep -Fq 'did not become healthy' "$case_root/output"
grep -Fq 'Configuration and data are retained' "$case_root/output"
[[ -f $case_root/deploy/.env && -f $case_root/deploy/.tanhuo-project ]]
grep -Fq ' stop' "$MOCK_LOG"
pass

new_case update_health_failure_rolls_back
invoke
printf 'TANHUO_IMAGE=dingshi-tanhuo:0.9.0\nADMIN_PASSWORD=synthetic-retained-password\nHOST_PORT=4321\n' > "$case_root/deploy/.env"
printf 'old-compose-content\n' > "$case_root/deploy/compose.yaml"
cp "$case_root/deploy/.env" "$case_root/before.env"
cp "$case_root/deploy/compose.yaml" "$case_root/before.compose"
export MOCK_HEALTH=unhealthy
: > "$MOCK_LOG"
expect_failure
diff "$case_root/before.env" "$case_root/deploy/.env"
diff "$case_root/before.compose" "$case_root/deploy/compose.yaml"
grep -Fq 'restoring the previous deployment configuration' "$case_root/output"
[[ $(grep -Fc 'up -d --pull never --no-build' "$MOCK_LOG") == 2 ]]
pass

new_case download_truncation_does_not_run_main
head -n -1 "$installer" | bash
[[ ! -e $case_root/deploy && ! -s $MOCK_LOG ]]
pass

new_case fresh_docker_official_repository_bootstrap
rm "$test_root/bin/docker"
invoke
grep -Fq "Installing Docker Engine and Compose from Docker's official" "$case_root/output"
grep -Fq 'https://download.docker.com/linux/debian/gpg' "$MOCK_LOG"
grep -Fq 'docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin' "$MOCK_LOG"
! grep -Eq 'apt-get .*remove|get.docker.com' "$MOCK_LOG"
grep -Fq 'Installation successful:' "$case_root/output"
pass

printf 'All installer tests passed.\n'
