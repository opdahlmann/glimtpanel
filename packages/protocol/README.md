# @glimt/protocol

JSON Schema (draft 2020-12) for meldingene mellom `glimt-agent` og `glimt-hub`, versjon 1, med eksempler i `examples/`.
Skjemaet er kontrakten: Go-agenten og .NET-huben har begge tester som validerer sine meldinger mot det, og `npm test` her
validerer eksemplene (kjøres i CI).

Retning agent → hub: `hello`, `snapshot` (hvert 30. s, alltid), `stream` (1 s eller 5 s, kun ved abonnement), `log`, `logEnd`, `pong`.
Retning hub → agent: `welcome`, `authFailed`, `subscribe`, `unsubscribe`, `logStart`, `logStop`, `rotate`, `ping`.

Regler: agenten har ingen skrivekommandoer; byte-rater er byte per sekund; tider er Unix-millisekunder UTC; `type` står først.
