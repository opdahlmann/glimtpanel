#!/bin/sh
# Dev container only: rewrite /etc/glimt-agent/env from the variables Docker
# gave PID 1 (systemd), so `npm run dev:agent` controls the agent through -e.
set -eu

get() {
	tr '\0' '\n' </proc/1/environ | sed -n "s/^$1=//p" | head -n 1
}

hub="$(get GLIMT_AGENT_HUB_WS)"
key="$(get GLIMT_DEV_ENROL_KEY)"
name="$(get GLIMT_AGENT_NAME)"
heartbeat="$(get GLIMT_HEARTBEAT_SECONDS)"
loglevel="$(get GLIMT_LOG_LEVEL)"

umask 077
mkdir -p /etc/glimt-agent
{
	echo "# Written by glimt-dev-env.service from the container environment."
	echo "GLIMT_HUB=${hub:-ws://host.docker.internal:5080/agent/ws}"
	echo "GLIMT_AGENT_KEY=${key:-gp_dev_local}"
	echo "GLIMT_AGENT_NAME=${name:-ubuntu-dev}"
	echo "GLIMT_HEARTBEAT_SECONDS=${heartbeat:-30}"
	echo "GLIMT_LOG_LEVEL=${loglevel:-debug}"
	echo "GLIMT_AGENT_DOCKER=socket"
	# Containeren spiller en Ubuntu-server (systemd, journald, sshd); uten dette ville auto-deteksjonen (fase 12)
	# sett /.dockerenv og valgt containerprofilen, som krever GLIMT_TOKEN.
	echo "GLIMT_KIND=server"
} >/etc/glimt-agent/env.tmp
chmod 0600 /etc/glimt-agent/env.tmp
mv -f /etc/glimt-agent/env.tmp /etc/glimt-agent/env
echo "glimt-dev-env: wrote /etc/glimt-agent/env (hub=${hub:-default} name=${name:-ubuntu-dev} log=${loglevel:-debug})"

# The agent runs as DynamicUser. On a server, install.sh --docker simple adds
# SupplementaryGroups=docker; here the socket is bind-mounted from the host
# (Docker Desktop: root:root 660), so give the service the socket's group
# instead and reload units before glimt-agent.service starts.
if [ -S /var/run/docker.sock ]; then
	gid="$(stat -c %g /var/run/docker.sock)"
	grp="$(getent group "$gid" | cut -d: -f1)"
	if [ -z "$grp" ]; then
		grp="docker-host"
		groupadd -o -g "$gid" "$grp"
	fi
	mkdir -p /etc/systemd/system/glimt-agent.service.d
	printf '[Service]\nSupplementaryGroups=%s\n' "$grp" >/etc/systemd/system/glimt-agent.service.d/docker.conf
	systemctl daemon-reload
	echo "glimt-dev-env: agent gets SupplementaryGroups=$grp (gid $gid of /var/run/docker.sock)"
fi
