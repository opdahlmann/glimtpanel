package main

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/collect"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/docker"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/health"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/journal"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/logs"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/sched"
)

// deps are the collectors shared by run, snapshot, stream and logs. The
// server profile has all of them; the container profile (fase 12) has the
// container system, the health checker and the file log source only.
type deps struct {
	log       *slog.Logger
	kind      string // protocol.KindServer | KindContainer
	docker    string // configured mode: none | socket | proxy
	system    collect.System
	container *collect.ContainerSystem // container profile only
	health    *health.Checker          // container profile; nil when nothing is configured
	logPaths  []string                 // container profile: GLIMT_LOG_PATHS
	engine    *docker.Engine           // nil when docker is none or in a container
	journal   *journal.Journal
	counter   *journal.Counter
	maint     *sched.MaintenanceCache
}

// buildDeps wires the collectors for the resolved kind. With docker on, the
// daemon is probed once so hello can report the mode truthfully; the engine
// keeps retrying later.
func buildDeps(ctx context.Context, o *options, log *slog.Logger) *deps {
	if o.kind == protocol.KindContainer {
		return buildContainerDeps(o, log)
	}
	d := &deps{log: log, kind: protocol.KindServer, docker: o.docker}
	d.journal = journal.New(log, nil)
	d.counter = journal.NewCounter(log, nil, nil)
	d.system = collect.NewSystem(collect.Options{Counts: d.counter, Logger: log})
	d.maint = sched.NewMaintenanceCache(d.system, nil)

	if o.docker != protocol.DockerNone {
		endpoint := docker.DefaultSocket
		if o.docker == protocol.DockerProxy {
			endpoint = o.proxyURL
		}
		ep, err := docker.ParseEndpoint(endpoint)
		if err != nil {
			log.Error("docker endpoint invalid; containers disabled", "endpoint", endpoint, "err", err)
			d.docker = protocol.DockerNone
			return d
		}
		d.engine = docker.NewEngine(docker.Options{Client: docker.NewClient(ep, 10*time.Second), Logger: log})
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if list, err := d.engine.List(pctx); err != nil {
			log.Warn("docker not reachable; hello reports dockerMode none until it answers", "endpoint", ep.String(), "mode", o.docker, "err", err)
		} else {
			log.Info("docker reachable", "endpoint", ep.String(), "mode", o.docker, "api", d.engine.Client().Version(), "containers", len(list))
		}
	}
	return d
}

// buildContainerDeps is the container profile: no systemd, journald or
// Docker; cgroup or process sums, health URL, TCP checks, file logs.
func buildContainerDeps(o *options, log *slog.Logger) *deps {
	d := &deps{log: log, kind: protocol.KindContainer, docker: protocol.DockerNone}
	d.container = collect.NewContainerSystem(collect.ContainerOptions{Logger: log})
	d.system = d.container
	targets, err := health.ParseChecks(o.checks)
	if err != nil {
		log.Error("checks ignored", "err", err)
	}
	if o.healthURL != "" || len(targets) > 0 {
		d.health = &health.Checker{URL: o.healthURL, Targets: targets}
	}
	for _, p := range strings.Split(o.logPaths, ",") {
		if p = strings.TrimSpace(p); p != "" {
			d.logPaths = append(d.logPaths, p)
		}
	}
	caps := d.container.Capabilities()
	log.Info("container profile", "cgroup", caps.Cgroup, "cgroupDir", orNone(d.container.CgroupDir()), "procAll", caps.ProcAll, "netns", caps.Netns,
		"health", o.healthURL != "", "checks", len(targets), "logPaths", len(d.logPaths))
	return d
}

// dockerMode is what hello reports: the configured mode when the daemon
// answered, otherwise none.
func (d *deps) dockerMode() string {
	if d.engine != nil && d.engine.Reachable() {
		return d.docker
	}
	return protocol.DockerNone
}

// capabilities is hello.capabilities for container nodes, nil for servers.
func (d *deps) capabilities() *protocol.Capabilities {
	if d.container == nil {
		return nil
	}
	c := d.container.Capabilities()
	return &protocol.Capabilities{Cgroup: c.Cgroup, ProcAll: c.ProcAll, Netns: c.Netns, Health: d.health != nil && d.health.URL != ""}
}

// containers returns the scheduler's container source, a nil interface when off.
func (d *deps) containers() sched.Containers {
	if d.engine == nil {
		return nil
	}
	return d.engine
}

func (d *deps) periodics() []sched.Periodic {
	if d.counter == nil {
		return nil
	}
	return []sched.Periodic{d.counter}
}

func (d *deps) healthChecker() sched.HealthChecker {
	if d.health == nil {
		return nil
	}
	return d.health
}

func (d *deps) schedConfig(sink sched.Sink, snapshot, maintenance time.Duration) sched.Config {
	return sched.Config{
		SnapshotInterval: snapshot, MaintenanceInterval: maintenance,
		System: d.system, Containers: d.containers(), Maintenance: d.maint, Periodics: d.periodics(), Health: d.healthChecker(),
		Sink: sink, Logger: d.log,
	}
}

func (d *deps) logsConfig(sink logs.Sink) logs.Config {
	if d.kind == protocol.KindContainer {
		return logs.Config{Sink: sink, File: logs.FileOpener(d.logPaths), Logger: d.log}
	}
	return logs.Config{
		Sink:      sink,
		Journal:   logs.JournalOpener(d.journal),
		Web:       logs.WebOpener(journal.WebLogPaths),
		Container: logs.ContainerOpener(d.engine),
		Logger:    d.log,
	}
}

// fileLookup resolves environment variables with /etc/glimt-agent/env as a
// fallback, so the support subcommands see the installed configuration.
func fileLookup() func(string) string {
	fileEnv := readEnvFile(configFile)
	return func(name string) string {
		if v := os.Getenv(name); v != "" {
			return v
		}
		return fileEnv[name]
	}
}
