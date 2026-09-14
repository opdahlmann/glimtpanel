package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// repoRoot walks up from the working directory until it finds example.env.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "example.env")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("repo root (example.env) not found; skipping example round trip")
		}
		dir = parent
	}
}

func TestExamplesRoundTrip(t *testing.T) {
	root := repoRoot(t)
	files, err := filepath.Glob(filepath.Join(root, "packages", "protocol", "examples", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Skip("no examples found")
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			in, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			msg, err := Decode(in)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := Encode(msg)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			var want, got map[string]any
			if err := json.Unmarshal(in, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(out, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(want, got) {
				t.Errorf("round trip differs\n in: %s\nout: %s", in, out)
			}
			if !bytes.HasPrefix(out, []byte(`{"type":`)) {
				t.Errorf("type is not the first field: %s", out[:40])
			}
			if got["type"] != msg.MessageType() {
				t.Errorf("type %v != %s", got["type"], msg.MessageType())
			}
		})
	}
}

func TestEncodeSetsTypeAndVersion(t *testing.T) {
	out, err := Encode(&Hello{Hostname: "h", EnrolKey: "gp_x"})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	if m["type"] != "hello" || m["v"] != float64(1) {
		t.Errorf("got %s", out)
	}
	if _, has := m["token"]; has {
		t.Errorf("empty token should be omitted: %s", out)
	}
	pong, _ := Encode(&Pong{})
	if string(pong) != `{"type":"pong"}` {
		t.Errorf("pong = %s", pong)
	}
}

func TestDecodeErrors(t *testing.T) {
	_, err := Decode([]byte(`{"type":"teleport"}`))
	var ute *UnknownTypeError
	if !errors.As(err, &ute) || ute.Type != "teleport" {
		t.Errorf("want UnknownTypeError, got %v", err)
	}
	if _, err := Decode([]byte(`{"foo":1}`)); err == nil {
		t.Error("missing type should fail")
	}
	if _, err := Decode([]byte(`not json`)); err == nil {
		t.Error("invalid JSON should fail")
	}
	if _, err := Decode([]byte(`{"type":"subscribe","intervalMs":"fast"}`)); err == nil {
		t.Error("wrong field type should fail")
	}
}

func TestDecodeAllTypes(t *testing.T) {
	for _, typ := range []string{TypeHello, TypeSnapshot, TypeStream, TypeLog, TypeLogEnd, TypePong, TypeBye,
		TypeWelcome, TypeAuthFailed, TypePing, TypeSubscribe, TypeUnsubscribe, TypeLogStart, TypeLogStop, TypeRotate} {
		msg, err := Decode([]byte(`{"type":"` + typ + `","extraField":true}`))
		if err != nil {
			t.Errorf("%s: %v", typ, err)
			continue
		}
		if msg.MessageType() != typ {
			t.Errorf("%s decoded as %s", typ, msg.MessageType())
		}
	}
}

func TestSubscribeDecode(t *testing.T) {
	msg, err := Decode([]byte(`{"type":"subscribe","intervalMs":5000,"topProcs":40}`))
	if err != nil {
		t.Fatal(err)
	}
	s := msg.(*Subscribe)
	if s.IntervalMs != 5000 || s.TopProcs != 40 {
		t.Errorf("got %+v", s)
	}
}
