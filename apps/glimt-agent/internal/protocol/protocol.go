// Package protocol holds the Go representation of the agent ↔ hub protocol
// (packages/protocol/agent-hub.schema.json). One JSON message per WebSocket
// frame, the field "type" first. All timestamps are Unix milliseconds UTC and
// byte rates are bytes per second.
package protocol

import (
	"encoding/json"
	"fmt"
)

// Version is the protocol version carried in hello.v.
const Version = 1

// Message types. Agent → hub: hello, snapshot, stream, log, logEnd, pong.
// Hub → agent: welcome, authFailed, subscribe, unsubscribe, logStart, logStop, rotate, ping.
const (
	TypeHello       = "hello"
	TypeSnapshot    = "snapshot"
	TypeStream      = "stream"
	TypeLog         = "log"
	TypeLogEnd      = "logEnd"
	TypePong        = "pong"
	TypeWelcome     = "welcome"
	TypeAuthFailed  = "authFailed"
	TypeSubscribe   = "subscribe"
	TypeUnsubscribe = "unsubscribe"
	TypeLogStart    = "logStart"
	TypeLogStop     = "logStop"
	TypeRotate      = "rotate"
	TypePing        = "ping"
)

// Docker modes reported in hello.dockerMode.
const (
	DockerNone   = "none"
	DockerSocket = "socket"
	DockerProxy  = "proxy"
)

// authFailed reasons.
const (
	ReasonInvalidKey    = "invalidKey"
	ReasonExpiredKey    = "expiredKey"
	ReasonInvalidToken  = "invalidToken"
	ReasonServerRemoved = "serverRemoved"
)

// logEnd reasons.
const (
	LogEndStopped     = "stopped"
	LogEndUnavailable = "unavailable"
	LogEndError       = "error"
	LogEndEOF         = "eof"
)

// Header is embedded first in every message so that "type" is the first key
// in the encoded JSON.
type Header struct {
	Type string `json:"type"`
}

func (h *Header) setType(t string) { h.Type = t }

// Message is implemented by pointers to all message structs.
type Message interface {
	MessageType() string
	setType(string)
}

// --- Agent → hub -----------------------------------------------------------

// Hello is sent once per connection. Exactly one of EnrolKey and Token is set.
type Hello struct {
	Header
	V            int    `json:"v"`
	EnrolKey     string `json:"enrolKey,omitempty"`
	Token        string `json:"token,omitempty"`
	Hostname     string `json:"hostname"`
	AgentVersion string `json:"agentVersion"`
	OS           OSInfo `json:"os"`
	Kernel       string `json:"kernel"`
	Arch         string `json:"arch"`
	Cores        int    `json:"cores"`
	RAMBytes     int64  `json:"ramBytes"`
	BootTime     int64  `json:"bootTime"`
	DockerMode   string `json:"dockerMode"`
}

// OSInfo comes from /etc/os-release.
type OSInfo struct {
	ID         string `json:"id"`
	VersionID  string `json:"versionId"`
	PrettyName string `json:"prettyName"`
}

// Snapshot is the full picture, sent every snapshotInterval.
type Snapshot struct {
	Header
	TS          int64        `json:"ts"`
	Host        Host         `json:"host"`
	Containers  []Container  `json:"containers,omitempty"`
	Services    *Services    `json:"services,omitempty"`
	Maintenance *Maintenance `json:"maintenance,omitempty"`
	Security    *Security    `json:"security,omitempty"`
}

// Stream is the fast-changing subset, sent every intervalMs while subscribed.
type Stream struct {
	Header
	TS            int64            `json:"ts"`
	Host          Host             `json:"host"`
	Containers    []ContainerStats `json:"containers,omitempty"`
	Processes     []Process        `json:"processes,omitempty"`
	ProcessTotals *ProcessTotals   `json:"processTotals,omitempty"`
}

// Log carries lines for an open log stream.
type Log struct {
	Header
	StreamID string    `json:"streamId"`
	Dropped  int       `json:"dropped,omitempty"`
	Lines    []LogLine `json:"lines"`
}

// LogLine is one line in a Log message.
type LogLine struct {
	TS        int64  `json:"ts"`
	Unit      string `json:"unit,omitempty"`
	Container string `json:"container,omitempty"`
	Priority  string `json:"priority,omitempty"`
	Message   string `json:"message"`
}

// LogEnd closes a log stream.
type LogEnd struct {
	Header
	StreamID string `json:"streamId"`
	Reason   string `json:"reason"`
	Message  string `json:"message,omitempty"`
}

// Pong answers Ping.
type Pong struct{ Header }

// --- Hub → agent -----------------------------------------------------------

// Welcome acknowledges Hello. Token is only present on enrolment or rotation.
type Welcome struct {
	Header
	ServerID            string `json:"serverId"`
	Token               string `json:"token,omitempty"`
	SnapshotInterval    int    `json:"snapshotInterval"`
	MaintenanceInterval int    `json:"maintenanceInterval"`
}

// AuthFailed rejects Hello.
type AuthFailed struct {
	Header
	Reason string `json:"reason"`
}

// Ping asks for a Pong.
type Ping struct{ Header }

// Subscribe starts or re-times the stream.
type Subscribe struct {
	Header
	IntervalMs int `json:"intervalMs"`
	TopProcs   int `json:"topProcs,omitempty"`
}

// Unsubscribe stops the stream.
type Unsubscribe struct{ Header }

// LogStart opens a log stream.
type LogStart struct {
	Header
	StreamID  string `json:"streamId"`
	Source    string `json:"source"`
	Unit      string `json:"unit,omitempty"`
	Container string `json:"container,omitempty"`
	Path      string `json:"path,omitempty"`
	Priority  string `json:"priority,omitempty"`
	SinceMs   int64  `json:"sinceMs,omitempty"`
	Tail      int    `json:"tail,omitempty"`
}

// LogStop closes a log stream.
type LogStop struct {
	Header
	StreamID string `json:"streamId"`
}

// Rotate delivers a new token; the old one stays valid for ten minutes.
type Rotate struct {
	Header
	Token string `json:"token"`
}

// --- Nested objects ----------------------------------------------------------

// Host is shared by Snapshot and Stream.
type Host struct {
	CPU       CPU       `json:"cpu"`
	Load      []float64 `json:"load,omitempty"`
	Mem       Mem       `json:"mem"`
	UptimeSec int64     `json:"uptimeSec"`
	Mounts    []Mount   `json:"mounts,omitempty"`
	Ifaces    []Iface   `json:"ifaces,omitempty"`
}

// CPU percentages since the previous reading.
type CPU struct {
	Total   float64   `json:"total"`
	User    float64   `json:"user"`
	System  float64   `json:"system"`
	IOWait  float64   `json:"iowait"`
	Steal   float64   `json:"steal"`
	PerCore []float64 `json:"perCore,omitempty"`
}

// Mem in bytes.
type Mem struct {
	Total     int64 `json:"total"`
	Used      int64 `json:"used"`
	Free      int64 `json:"free"`
	Buffers   int64 `json:"buffers"`
	Cached    int64 `json:"cached"`
	SwapTotal int64 `json:"swapTotal"`
	SwapUsed  int64 `json:"swapUsed"`
}

// Mount is one mounted file system.
type Mount struct {
	Path        string  `json:"path"`
	FS          string  `json:"fs"`
	Device      string  `json:"device,omitempty"`
	Total       int64   `json:"total"`
	Used        int64   `json:"used"`
	InodesTotal int64   `json:"inodesTotal"`
	InodesUsed  int64   `json:"inodesUsed"`
	ReadBps     float64 `json:"readBps"`
	WriteBps    float64 `json:"writeBps"`
}

// Iface is one network interface.
type Iface struct {
	Name  string   `json:"name"`
	IPs   []string `json:"ips,omitempty"`
	RxBps float64  `json:"rxBps"`
	TxBps float64  `json:"txBps"`
}

// Container is the full container record in Snapshot.
type Container struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Image        string   `json:"image"`
	ImageCreated int64    `json:"imageCreated"`
	State        string   `json:"state"`
	Health       string   `json:"health,omitempty"`
	RestartCount int      `json:"restartCount"`
	StartedAt    int64    `json:"startedAt"`
	CPUPct       float64  `json:"cpuPct"`
	MemBytes     int64    `json:"memBytes"`
	MemLimit     int64    `json:"memLimit"`
	RxBps        float64  `json:"rxBps"`
	TxBps        float64  `json:"txBps"`
	Ports        []string `json:"ports,omitempty"`
	Mounts       []string `json:"mounts,omitempty"`
	Compose      string   `json:"compose,omitempty"`
}

// ContainerStats is the fast-changing container subset in Stream.
type ContainerStats struct {
	ID       string  `json:"id"`
	CPUPct   float64 `json:"cpuPct"`
	MemBytes int64   `json:"memBytes"`
	MemLimit int64   `json:"memLimit"`
	RxBps    float64 `json:"rxBps"`
	TxBps    float64 `json:"txBps"`
	State    string  `json:"state,omitempty"`
}

// Process is one of the top processes in Stream.
type Process struct {
	PID       int     `json:"pid"`
	Name      string  `json:"name"`
	User      string  `json:"user"`
	CPUPct    float64 `json:"cpuPct"`
	RSSBytes  int64   `json:"rssBytes"`
	StartedAt int64   `json:"startedAt"`
	Cmdline   string  `json:"cmdline,omitempty"`
}

// ProcessTotals counts processes by state.
type ProcessTotals struct {
	Total   int `json:"total"`
	Running int `json:"running"`
	Blocked int `json:"blocked"`
}

// Services describes systemd units. Failed and NeedsRestart must be non-nil
// slices (the schema requires arrays, not null).
type Services struct {
	Units        []Unit   `json:"units,omitempty"`
	Failed       []string `json:"failed"`
	NeedsRestart []string `json:"needsRestart"`
}

// Unit is one systemd unit.
type Unit struct {
	Name         string `json:"name"`
	State        string `json:"state"`
	NeedsRestart bool   `json:"needsRestart"`
}

// Maintenance describes pending updates and reboots.
type Maintenance struct {
	RebootRequired       bool     `json:"rebootRequired"`
	RebootPkgs           []string `json:"rebootPkgs,omitempty"`
	Updates              int      `json:"updates"`
	SecurityUpdates      int      `json:"securityUpdates"`
	CheckedAt            int64    `json:"checkedAt"`
	NeedrestartAvailable bool     `json:"needrestartAvailable"`
}

// Security describes ports, logins, SSH failures and the firewall.
type Security struct {
	ListeningPorts []ListeningPort `json:"listeningPorts,omitempty"`
	LoggedIn       []Login         `json:"loggedIn,omitempty"`
	SSHFailed      *SSHFailed      `json:"sshFailed,omitempty"`
	Firewall       *Firewall       `json:"firewall,omitempty"`
}

// ListeningPort is one listening socket.
type ListeningPort struct {
	Port    int    `json:"port"`
	Proto   string `json:"proto"`
	Process string `json:"process,omitempty"`
	PID     int    `json:"pid,omitempty"`
}

// Login is one logged-in user.
type Login struct {
	User  string `json:"user"`
	From  string `json:"from,omitempty"`
	TTY   string `json:"tty,omitempty"`
	Since int64  `json:"since,omitempty"`
}

// SSHFailed counts failed SSH logins.
type SSHFailed struct {
	Hour int          `json:"hour"`
	Day  int          `json:"day"`
	Last []SSHAttempt `json:"last,omitempty"`
}

// SSHAttempt is one failed SSH login.
type SSHAttempt struct {
	User string `json:"user,omitempty"`
	From string `json:"from,omitempty"`
	At   int64  `json:"at"`
}

// Firewall summarises ufw and fail2ban.
type Firewall struct {
	UFW      string `json:"ufw"`
	Fail2ban string `json:"fail2ban"`
	Banned   int    `json:"banned"`
	Blocked  int    `json:"blocked"`
}

// --- MessageType ---------------------------------------------------------------

func (*Hello) MessageType() string       { return TypeHello }
func (*Snapshot) MessageType() string    { return TypeSnapshot }
func (*Stream) MessageType() string      { return TypeStream }
func (*Log) MessageType() string         { return TypeLog }
func (*LogEnd) MessageType() string      { return TypeLogEnd }
func (*Pong) MessageType() string        { return TypePong }
func (*Welcome) MessageType() string     { return TypeWelcome }
func (*AuthFailed) MessageType() string  { return TypeAuthFailed }
func (*Ping) MessageType() string        { return TypePing }
func (*Subscribe) MessageType() string   { return TypeSubscribe }
func (*Unsubscribe) MessageType() string { return TypeUnsubscribe }
func (*LogStart) MessageType() string    { return TypeLogStart }
func (*LogStop) MessageType() string     { return TypeLogStop }
func (*Rotate) MessageType() string      { return TypeRotate }

// New returns an empty message for a type, or nil for an unknown type.
func New(typ string) Message {
	switch typ {
	case TypeHello:
		return &Hello{}
	case TypeSnapshot:
		return &Snapshot{}
	case TypeStream:
		return &Stream{}
	case TypeLog:
		return &Log{}
	case TypeLogEnd:
		return &LogEnd{}
	case TypePong:
		return &Pong{}
	case TypeWelcome:
		return &Welcome{}
	case TypeAuthFailed:
		return &AuthFailed{}
	case TypePing:
		return &Ping{}
	case TypeSubscribe:
		return &Subscribe{}
	case TypeUnsubscribe:
		return &Unsubscribe{}
	case TypeLogStart:
		return &LogStart{}
	case TypeLogStop:
		return &LogStop{}
	case TypeRotate:
		return &Rotate{}
	}
	return nil
}

// UnknownTypeError is returned by Decode for a type this agent does not know.
type UnknownTypeError struct{ Type string }

func (e *UnknownTypeError) Error() string {
	if e.Type == "" {
		return "protocol: message without type"
	}
	return "protocol: unknown message type " + strconv(e.Type)
}

func strconv(s string) string { return fmt.Sprintf("%q", s) }

// Decode reads "type" and unmarshals the frame into the matching struct.
// Unknown fields are ignored so newer hubs can add fields freely.
func Decode(data []byte) (Message, error) {
	var h Header
	if err := json.Unmarshal(data, &h); err != nil {
		return nil, fmt.Errorf("protocol: invalid JSON: %w", err)
	}
	msg := New(h.Type)
	if msg == nil {
		return nil, &UnknownTypeError{Type: h.Type}
	}
	if err := json.Unmarshal(data, msg); err != nil {
		return nil, fmt.Errorf("protocol: invalid %s: %w", h.Type, err)
	}
	return msg, nil
}

// Encode marshals a message, making sure "type" (and hello.v) is set.
func Encode(msg Message) ([]byte, error) {
	if msg == nil {
		return nil, fmt.Errorf("protocol: nil message")
	}
	msg.setType(msg.MessageType())
	if h, ok := msg.(*Hello); ok && h.V == 0 {
		h.V = Version
	}
	return json.Marshal(msg)
}
