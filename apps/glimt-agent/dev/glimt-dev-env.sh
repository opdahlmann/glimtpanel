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

umask 077
mkdir -p /etc/glimt-agent
{
	echo "# Written by glimt-dev-env.service from the container environment."
	echo "GLIMT_HUB=${hub:-ws://host.docker.internal:5080/agent/ws}"
	echo "GLIMT_AGENT_KEY=${key:-gp_dev_local}"
	echo "GLIMT_AGENT_NAME=${name:-ubuntu-dev}"
	echo "GLIMT_HEARTBEAT_SECONDS=${heartbeat:-30}"
	echo "GLIMT_AGENT_DOCKER=socket"
} >/etc/glimt-agent/env.tmp
chmod 0600 /etc/glimt-agent/env.tmp
mv -f /etc/glimt-agent/env.tmp /etc/glimt-agent/env
echo "glimt-dev-env: wrote /etc/glimt-agent/env (hub=${hub:-default} name=${name:-ubuntu-dev})"
