package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/opdahlmann/glimtpanel/apps/glimt-agent/internal/protocol"
)

// De syntetiske meldingene må se ut som ekte: type-feltet satt, tomme lister som [] (skjemaet krever arrays), 64-tegns container-id.
func TestSyntheticMessagesLookReal(t *testing.T) {
	s := &fakeSession{id: 7, st: &stats{}}
	snap, err := json.Marshal(s.snapshot())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"type":"snapshot"`, `"failed":[]`, `"needsRestart":[]`, `"path":"/"`} {
		if !strings.Contains(string(snap), want) {
			t.Errorf("snapshot mangler %s: %s", want, snap)
		}
	}
	for _, c := range s.containers() {
		if len(c.ID) != 64 {
			t.Errorf("container-id %q har %d tegn, vil ha 64", c.ID, len(c.ID))
		}
	}
	var stream protocol.Stream
	if err := json.Unmarshal(mustJSON(t, s.stream(3)), &stream); err != nil {
		t.Fatal(err)
	}
	if stream.Type != protocol.TypeStream || len(stream.Processes) != 3 || len(stream.Containers) != 3 {
		t.Errorf("uventet stream: %+v", stream)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
