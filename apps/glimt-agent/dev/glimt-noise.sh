#!/bin/sh
# Dev container only: every 60 s write five journal lines and burn CPU for
# three seconds so the agent has something to show.
set -u
i=0
while :; do
	i=$((i + 1))
	logger -t noise "cycle $i: hello from the dev container"
	logger -t noise -p daemon.warning "cycle $i: disk latency above threshold (simulated)"
	logger -t noise -p daemon.err "cycle $i: simulated error: connection refused to 10.0.0.9:5432"
	logger -t sshd -p auth.info "Failed password for invalid user admin from 185.220.101.4 port 40122 ssh2"
	logger -t noise "cycle $i: burning CPU for 3 seconds"
	timeout 3 sha256sum /dev/zero >/dev/null 2>&1 || true
	sleep 60
done
