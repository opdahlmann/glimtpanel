package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/collect"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/docker"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/journal"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/logs"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/sched"
)

// deps are the collectors shared by run, snapshot, stream and logs.
type deps struct {
	log     *slog.Logger
	docker  string // configured mode: none | socket | proxy
	system  collect.System
	engine  *docker.Engine // nil when docker is none
	journal *journal.Journal
	counter *journal.Counter
	maint   *sched.MaintenanceCache
}

// buildDeps wires the collectors. With docker on, the daemon is probed once
// so hello can report the mode truthfully; the engine keeps retrying later.
func buildDeps(ctx context.Context, o *options, log *slog.Logger) *deps {
	d := &deps{log: log, docker: o.docker}
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

// dockerMode is what hello reports: the configured mode when the daemon
// answered, otherwise none.
func (d *deps) dockerMode() string {
	if d.engine != nil && d.engine.Reachable() {
		return d.docker
	}
	return protocol.DockerNone
}

// containers returns the scheduler's container source, a nil interface when off.
func (d *deps) containers() sched.Containers {
	if d.engine == nil {
		return nil
	}
	return d.engine
}

func (d *deps) periodics() []sched.Periodic { return []sched.Periodic{d.counter} }

func (d *deps) schedConfig(sink sched.Sink, snapshot, maintenance time.Duration) sched.Config {
	return sched.Config{
		SnapshotInterval: snapshot, MaintenanceInterval: maintenance,
		System: d.system, Containers: d.containers(), Maintenance: d.maint, Periodics: d.periodics(),
		Sink: sink, Logger: d.log,
	}
}

func (d *deps) logsConfig(sink logs.Sink) logs.Config {
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
