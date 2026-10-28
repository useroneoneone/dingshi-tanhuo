# Tanhuo Offline Installation

This package contains a prebuilt Linux container image and deployment files.
Installation does not download, pull or build anything.

## Requirements

- An x86-64 Linux server for an amd64 package, or ARM64 for an arm64 package.
- Docker Engine running and the Docker Compose v2 plugin already installed.
- Bash, tar, gzip, sha256sum and standard Linux core utilities.
- Root access, or sudo.

Docker Engine, Compose and operating-system packages are NOT included.
Install them before disconnecting the server. Normal task execution still needs
network access to the API endpoints configured in the application.

## Install

Transfer the archive and its .sha256 file to the server, then run:

```bash
sha256sum -c {{BUNDLE_NAME}}.tar.gz.sha256
tar -xzf {{BUNDLE_NAME}}.tar.gz
cd {{BUNDLE_NAME}}
sudo bash install-offline.sh
```

If already root, omit sudo. The default installation directory is /opt/tanhuo.
The unpacked package must be separate from the installation directory.
Only the files listed in SHA256SUMS are used; no developer environment, saved
passwords, API keys, databases or runtime volumes are included.

The default administrator is admin. A random initial password is printed once
after the first successful installation. Change it after logging in.

## Access

The application binds to 127.0.0.1:3000 by default. From your own computer:

```bash
ssh -N -L 13000:127.0.0.1:3000 user@your-server
```

Open http://127.0.0.1:13000 on your own computer. Alternatively, configure an HTTPS
reverse proxy. Do not submit passwords or API keys over public HTTP.

## Custom Installation

```bash
sudo bash install-offline.sh --dir /opt/tanhuo --project tanhuo --port 3000
```

Run bash install-offline.sh --help for all options. Install directories and their
parent directories must be root-owned and not writable by other users.

## Upgrade and Persistence

Upload and extract the new package into a separate directory, then run its
install-offline.sh using the ORIGINAL installation directory and project name:

```bash
sudo bash install-offline.sh --dir /opt/tanhuo
```

Existing .env settings, administrator credentials, tasks and API encryption keys
are retained. Do not repeat --port or --bind on an existing installation; edit its
.env instead. Do not change the Compose project name.

Offline upgrades require the existing compose.yaml to match the package's stock
compose.yaml. Custom Compose files are refused to prevent implicit network
downloads through remote includes or extensions. Review custom deployments and
upgrade them manually. The stock Compose file with customized .env is supported.

Back up the entire data volume, including master.key, BEFORE upgrading. Failure
recovery restores configuration, not a database snapshot. Never run
docker compose down -v: it deletes the database and encryption key.

## Management

```bash
cd /opt/tanhuo
sudo docker compose -p tanhuo ps
sudo docker compose -p tanhuo logs --tail 50 tanhuo
sudo docker compose -p tanhuo restart
```

Adapt the directory and project name if customized. The default data volume is
tanhuo_tanhuo-data. Keep this volume and the original installation directory.
