#!/bin/sh
# Glimtpanel agent installer.
#
#   curl -fsSL https://get.glimtpanel.com/install | sudo sh -s -- --key gp_xxx
#
# Options:
#   --key KEY            enrolment key from the dashboard (required on first install)
#   --hub URL            hub WebSocket URL (default wss://api.glimtpanel.com/agent/ws)
#   --docker MODE        proxy (default, recommended) | simple | none
#   --version X.Y.Z      agent version to download (default $GLIMT_AGENT_VERSION or "latest")
#   --local              use the binary already at /usr/local/bin/glimt-agent, no download
#   --uninstall          remove the agent
#
# The whole script lives in main() and main is called on the last line, so a
# truncated download runs nothing. The agent only reads; it never changes
# anything on this server.

main() {
	set -eu

	repo="opdahlmann/glimtpanel"
	bin="/usr/local/bin/glimt-agent"
	unit="/etc/systemd/system/glimt-agent.service"
	dropin_dir="/etc/systemd/system/glimt-agent.service.d"
	env_dir="/etc/glimt-agent"
	env_file="$env_dir/env"
	state_dir="/var/lib/glimt-agent"

	hub="wss://api.glimtpanel.com/agent/ws"
	key=""
	docker="proxy"
	version="${GLIMT_AGENT_VERSION:-latest}"
	local_bin=0
	uninstall=0

	# Root is required; re-run through sudo when the script is a real file.
	if [ "$(id -u)" -ne 0 ]; then
		if command -v sudo >/dev/null 2>&1 && [ -f "$0" ]; then
			exec sudo -- sh "$0" "$@"
		fi
		echo "glimt-agent install: run as root, e.g. ... | sudo sh -s -- --key gp_xxx" >&2
		exit 1
	fi

	while [ $# -gt 0 ]; do
		case "$1" in
		--key) key="$2"; shift 2 ;;
		--key=*) key="${1#--key=}"; shift ;;
		--hub) hub="$2"; shift 2 ;;
		--hub=*) hub="${1#--hub=}"; shift ;;
		--docker) docker="$2"; shift 2 ;;
		--docker=*) docker="${1#--docker=}"; shift ;;
		--version) version="$2"; shift 2 ;;
		--version=*) version="${1#--version=}"; shift ;;
		--local) local_bin=1; shift ;;
		--uninstall) uninstall=1; shift ;;
		-h | --help)
			sed -n '2,15p' "$0" 2>/dev/null || echo "see the script header for options"
			exit 0
			;;
		*)
			echo "glimt-agent install: unknown option $1" >&2
			exit 2
			;;
		esac
	done

	if [ "$uninstall" -eq 1 ]; then
		do_uninstall
		return 0
	fi

	case "$docker" in
	proxy | simple | none) ;;
	socket) docker="simple" ;;
	*)
		echo "glimt-agent install: --docker must be proxy, simple or none" >&2
		exit 2
		;;
	esac

	case "$hub" in
	ws://* | wss://*) ;;
	*)
		echo "glimt-agent install: --hub must start with ws:// or wss://" >&2
		exit 2
		;;
	esac

	# Reinstalling without --key keeps the previous key or the stored token.
	if [ -z "$key" ] && [ -f "$env_file" ]; then
		key="$(sed -n 's/^GLIMT_AGENT_KEY=//p' "$env_file" | head -n 1)"
	fi
	if [ -z "$key" ] && [ ! -f "$state_dir/token" ]; then
		echo "glimt-agent install: --key is required (create one in the Glimtpanel dashboard)" >&2
		exit 2
	fi

	systemd_running=0
	if [ -d /run/systemd/system ]; then
		systemd_running=1
	fi

	# 1. Binary
	if [ "$local_bin" -eq 1 ]; then
		if [ ! -x "$bin" ]; then
			echo "glimt-agent install: --local given but $bin is missing" >&2
			exit 1
		fi
		echo "Using existing $bin"
	else
		install_binary "$repo" "$version" "$bin"
	fi
	chmod 0755 "$bin"

	# 2. Environment file (0600, root only). The key is only used until a token exists.
	umask 077
	mkdir -p "$env_dir"
	case "$docker" in
	proxy) docker_mode="proxy" ;;
	simple) docker_mode="socket" ;;
	*) docker_mode="none" ;;
	esac
	env_tmp="$env_file.tmp"
	{
		echo "# Written by the Glimtpanel installer. The agent reads this file at start."
		echo "GLIMT_HUB=$hub"
		echo "GLIMT_AGENT_KEY=$key"
		echo "GLIMT_AGENT_DOCKER=$docker_mode"
		# The installer sets up a server. Without this, auto-detection picks the container profile on hosts whose
		# pid 1 sits in a Docker cgroup (systemd in Docker) and the agent refuses to start without GLIMT_TOKEN.
		echo "GLIMT_KIND=server"
	} >"$env_tmp"
	chmod 0600 "$env_tmp"
	mv -f "$env_tmp" "$env_file"
	umask 022

	# 3. static system user: systemctl does not work under DynamicUser (dbus rejects dynamic uids),
	#    so the services list needs a real user. No home, no login shell, writes only to StateDirectory.
	if ! id -u glimt-agent >/dev/null 2>&1; then
		useradd --system --no-create-home --home-dir /var/lib/glimt-agent --shell /usr/sbin/nologin --user-group glimt-agent
	fi

	# 4. systemd unit and docker drop-in
	unit_tmp="$unit.tmp"
	cat > "$unit_tmp" <<'UNIT'
[Unit]
Description=Glimtpanel agent (read-only)
Documentation=https://github.com/opdahlmann/glimtpanel#readme
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/local/bin/glimt-agent run
EnvironmentFile=-/etc/glimt-agent/env
User=glimt-agent
Group=glimt-agent
StateDirectory=glimt-agent
SupplementaryGroups=systemd-journal adm
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
CapabilityBoundingSet=CAP_SYS_PTRACE
AmbientCapabilities=CAP_SYS_PTRACE
UMask=0077
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
PrivateDevices=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
RemoveIPC=yes
ProtectControlGroups=yes
MemoryDenyWriteExecute=yes
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @obsolete @mount @swap @reboot @raw-io @module @debug @cpu-emulation @clock
SystemCallErrorNumber=EPERM
MemoryMax=192M
Restart=always
RestartSec=5
RestartPreventExitStatus=2

[Install]
WantedBy=multi-user.target
UNIT
	chmod 0644 "$unit_tmp"
	mv -f "$unit_tmp" "$unit"

	if [ "$docker" = "simple" ]; then
		mkdir -p "$dropin_dir"
		printf '[Service]\nSupplementaryGroups=docker\n' >"$dropin_dir/docker.conf"
		chmod 0644 "$dropin_dir/docker.conf"
	else
		rm -f "$dropin_dir/docker.conf"
		rmdir "$dropin_dir" 2>/dev/null || true
	fi

	# 5. Enable and start
	if [ "$systemd_running" -eq 1 ]; then
		systemctl daemon-reload
		systemctl enable glimt-agent.service >/dev/null 2>&1
		systemctl restart glimt-agent.service
		echo "glimt-agent.service is $(systemctl is-active glimt-agent.service 2>/dev/null || echo unknown)"
	else
		if ! systemctl enable glimt-agent.service >/dev/null 2>&1; then
			mkdir -p /etc/systemd/system/multi-user.target.wants
			ln -sf "$unit" /etc/systemd/system/multi-user.target.wants/glimt-agent.service
		fi
		echo "systemd is not running here; glimt-agent.service is enabled and starts at boot."
	fi

	# 6. Docker advice
	case "$docker" in
	proxy)
		cat <<'PROXY'

Containers: the agent expects a read-only Docker socket proxy on 127.0.0.1:2375.
Start one with (nothing else is needed, POST=0 blocks every write):

  docker run -d --name docker-socket-proxy --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -p 127.0.0.1:2375:2375 \
    -e CONTAINERS=1 -e IMAGES=1 -e EVENTS=1 -e INFO=1 -e POST=0 \
    tecnativa/docker-socket-proxy

Check with: glimt-agent check
PROXY
		;;
	simple)
		cat <<'SIMPLE'

WARNING: --docker simple puts the agent in the "docker" group. Membership in that
group is equivalent to root on this server. The agent still only reads, but a
compromised agent could do anything through the socket. Prefer --docker proxy.
SIMPLE
		;;
	esac

	echo
	echo "Glimtpanel agent reads CPU, memory, disk, network, processes, containers and logs. It cannot change anything on this server."
}

install_binary() {
	repo="$1"
	version="$2"
	bin="$3"

	case "$(uname -m)" in
	x86_64 | amd64) arch="amd64" ;;
	aarch64 | arm64) arch="arm64" ;;
	*)
		echo "glimt-agent install: unsupported architecture $(uname -m)" >&2
		exit 1
		;;
	esac
	file="glimt-agent-linux-$arch"
	if [ "$version" = "latest" ]; then
		base="https://github.com/$repo/releases/latest/download"
	else
		base="https://github.com/$repo/releases/download/agent/v$version"
	fi

	if command -v curl >/dev/null 2>&1; then
		fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
	elif command -v wget >/dev/null 2>&1; then
		fetch() { wget -q -O "$2" "$1"; }
	else
		echo "glimt-agent install: curl or wget is required" >&2
		exit 1
	fi

	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	echo "Downloading $base/$file"
	fetch "$base/$file" "$tmp/$file"
	fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
	(
		cd "$tmp"
		grep " $file\$" SHA256SUMS | sha256sum -c - >/dev/null
	) || {
		echo "glimt-agent install: checksum verification failed" >&2
		exit 1
	}
	install -m 0755 "$tmp/$file" "$bin"
	echo "Installed $bin ($("$bin" version))"
}

do_uninstall() {
	if [ -x /usr/local/bin/glimt-agent ]; then
		/usr/local/bin/glimt-agent uninstall
		return 0
	fi
	if [ -d /run/systemd/system ]; then
		systemctl disable --now glimt-agent.service >/dev/null 2>&1 || true
	fi
	rm -rf /etc/systemd/system/glimt-agent.service /etc/systemd/system/glimt-agent.service.d \
		/etc/systemd/system/multi-user.target.wants/glimt-agent.service /etc/glimt-agent /var/lib/glimt-agent
	if [ -d /run/systemd/system ]; then
		systemctl daemon-reload || true
	fi
	echo "removed"
}

main "$@"
