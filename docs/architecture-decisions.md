# Architekturentscheidungen (ADRs)

Format je Eintrag: Kontext → Entscheidung → Konsequenzen. Nummerierung ist chronologisch.

## ADR-001: pnpm 10 mit exakter `packageManager`-Version

Die Spezifikation verlangt `"packageManager": "pnpm@10"`. Corepack akzeptiert nur exakte Semver-Versionen. **Entscheidung:** `corepack use pnpm@10` pinnt die jeweils aktuelle 10.x exakt. Corepack ist ab Node 25 nicht mehr gebündelt → README dokumentiert `npm i -g pnpm@10` als Fallback.

## ADR-002: Node-Ziel `>=22`, Entwicklung auf 24.18.0

Spec-Ziel ist Node 22 LTS. Auf der Maschine ist Node 24.x via asdf installiert (ebenfalls LTS, better-sqlite3 liefert Prebuilds für beide). **Entscheidung:** `engines.node: ">=22"`, committete `.tool-versions` mit `nodejs 24.18.0`. Kein Code nutzt APIs jenseits von Node 22.

## ADR-003: TypeScript auf ~5.9 gepinnt

Zum Umsetzungszeitpunkt ist TypeScript 7 (nativer Compiler) aktuell. Projekt-References/`tsc -b`, vue-tsc und typescript-eslint sind auf der 5.9-Linie garantiert kompatibel. **Entscheidung:** `typescript: ~5.9.3` im Catalog; Upgrade auf 6/7 ist eine einzelne Catalog-Zeile, sobald die Toolchain nachgezogen ist.

## ADR-004: Drag & Drop mit `@atlaskit/pragmatic-drag-and-drop`

@dnd-kit ist React-only und scheidet aus. **Entscheidung:** Pragmatic Drag and Drop (framework-agnostisch, kein React-Runtime-Dependency, `canDrop`-Hook) mit zwei kleinen Vue-Composables. Die Transition-Validierung des Boards nutzt dieselben Daten wie das Backend (`@agent/shared`).

## ADR-005: Orchestrator-Artefakte in `<worktree>/.agent/`, Ausschluss per Pathspec

Codex läuft sandboxed auf den Worktree begrenzt und muss PLAN.md lesen können; zusätzlich ordnet `OWNER.json` den Worktree eindeutig einem Job zu. Die Dateien dürfen nicht in Commits/Diffs auftauchen. `info/exclude` ist worktree-übergreifend geteilt und würde die Repo-Konfiguration des Nutzers mutieren. **Entscheidung:** Alle git-Aufrufe (add/diff/status) schließen `.agent/` konsequent per Pathspec `':(exclude).agent'` aus. Kopien der fachlichen Artefakte liegen zusätzlich in der Datenbank. Der Plan bleibt unveränderlich; Abweichungen stehen im strukturierten Implementierungsbericht.

## ADR-006: Der Orchestrator schreibt PLAN.md/REVIEW.md — Claude bleibt physisch lesend

Claude arbeitet in Plan- und Review-Phase ohne Bash/Edit/Write (`--tools "Read,Glob,Grep" --permission-mode plan`). **Entscheidung:** Der Orchestrator validiert Claudes strukturiertes stdout-Ergebnis und rendert daraus `.agent/PLAN.md` bzw. `.agent/REVIEW.md`. Damit ist „Claude verändert keine Dateien" technisch garantiert; die Toolgrenze ist jedoch keine allgemeine OS-Lesesandbox.

## ADR-007: Pause ist checkpoint-fähig, Cancel ist hart

"Systemzustände dürfen bei laufendem Job nicht manuell verändert werden" kollidiert mit Pause mitten im Lauf. **Entscheidung:** Pause setzt ein persistiertes Flag, das an Phasengrenzen ausgewertet wird (laufende Phase endet regulär, nächste Phase wird als `resume_phase` gespeichert, dann → `paused`). Fortsetzen beginnt an diesem Checkpoint. Cancel killt die Prozessgruppe sofort → `failed` („Vom Benutzer abgebrochen").

## ADR-008: Ein Rework-Zähler; am Limit immer `needs_human`; `failed` nur für Infrastruktur

Test-Fehlschlag-Schleifen (`testing→rework`) wären sonst unbegrenzt. **Entscheidung:** Ein Zähler (`jobs.review_loop_count`), inkrementiert bei jedem Eintritt in `rework`. Am Limit geht der Job immer nach `needs_human` — dafür wird die Transitions-Map der Spec um `testing → needs_human` erweitert (dokumentierte Abweichung). `failed` ist für Infrastrukturfehler reserviert (Spawn-Fehler, Timeout, Abbruch, kaputter Worktree). Der Zähler wird bei jedem manuellen Eintritt in `agent_ready` zurückgesetzt.

## ADR-009: Restart-Recovery über persistierte Prozessgruppen-IDs

Nach einem Crash können Agenten- oder Test-Kindprozesse weiterlaufen und Worktrees mutieren. **Entscheidung:** PGIDs werden für Agentenläufe und den jeweils aktiven Projektbefehl persistiert; beim Boot werden eindeutige Überlebende per `kill(-pgid)` beendet (ESRCH-tolerant), laufende Agenten-/Testläufe abgebrochen und Jobs in aktiven Zuständen auf `failed` („Durch Neustart unterbrochen") gesetzt. Eine unterbrochene GitHub-Nacharbeit behält dagegen ihren terminalen Jobzustand: Nach Eigentümerprüfung werden nur uncommittierte Reste auf den zuletzt persistierten, geprüften HEAD verworfen und der Aktionsstatus freigegeben. Bei fehlenden oder widersprüchlichen Metadaten wird nichts verworfen und ein manueller Hinweis gespeichert. Retry eines unterbrochenen Agentenlaufs ist ausschließlich explizit. Ausgenommen ist die reine Warteschlange: `agent_ready` heißt „vom Menschen gestartet, wartet auf einen Slot" und lebt nur im Prozessspeicher — solche Jobs werden beim Boot wieder eingereiht, weil sie sonst ohne Fehlermeldung dauerhaft liegen bleiben und für sie noch kein Agent lief.

## ADR-010: Commits pro Iteration durch den Orchestrator

Stabile, auditierbare Diffs für Review und Rework. **Entscheidung:** Nach jeder Codex-Iteration committet der Orchestrator (`git add -A -- . ':(exclude).agent'`) mit Identität aus `GIT_AUTHOR_*`/`GIT_COMMITTER_*`-Umgebungsvariablen — die globale Git-Konfiguration des Nutzers wird nie berührt. Review-Diff = `git diff <base>...HEAD` ohne `.agent/`. Push, Merge, Force-Push und Branch-Löschung existieren im GitService nicht. Eine davon getrennte, ausdrücklich vom Nutzer gestartete GitHub-Review-Aktion darf den aktuellen Job-Branch ohne Force auf seinen bereits konfigurierten Upstream pushen; erst nach erfolgreichem Push löst sie von Codex als vollständig erledigt gemeldete Review-Threads über die GitHub-API auf.

## ADR-011: ProcessRunner-Typ in `@agent/shared`, Implementierung in `@agent/agents`

`@agent/git` und `@agent/agents` brauchen dieselbe sichere Prozessausführung; shared muss browser-tauglich bleiben. **Entscheidung:** Das Interface (nur Typen) liegt in shared, die `spawn`-Implementierung in agents, `@agent/git` erhält den Runner per Konstruktor-Injektion. Keine Paketzyklen.

## ADR-012: WebSocket verlustbehaftet, Datenbank kanonisch

Hochvolumige Agentenausgabe darf langsame Clients nicht destabilisieren. **Entscheidung:** Pro Client wird bei `bufferedAmount`-Überlauf gedroppt/koalesziert (`log_truncated`-Marker). Events tragen monotone Sequenz-IDs (AUTOINC aus `job_events`); Clients erkennen Lücken nach Reconnect und refetchen per REST. Kein Polling.

## ADR-013: Eigener Migrations-Mini-Runner

Nummerierte SQL-Dateien + `schema_migrations`-Tabelle, Ausführung in Transaktion, läuft beim Orchestrator-Boot vor der Recovery sowie via `pnpm db:migrate`. Kein zusätzliches Dependency.

## ADR-014: Projekt-Testbefehle als Strings mit striktem Tokenizer, ohne Shell

Die Spec definiert Befehle als Strings („pnpm lint"). **Entscheidung:** Ein kleiner, quote-fähiger Tokenizer (keine Shell-Features; Metazeichen `;|&<>$` und Backtick werden abgelehnt) zerlegt den String, Ausführung via `spawn(argv0, argv, {shell:false})`.

## ADR-015: CLI-Aufrufe gegen installierte Binaries verifiziert

Claude 2.1.197: `-p --output-format json --tools "Read,Glob,Grep" --permission-mode plan --safe-mode --no-session-persistence --json-schema <phase-schema> [--model …] [--max-budget-usd …]`; **`--max-turns` existiert nicht mehr** → Budget-Flag + eigene Wall-Clock-Timeouts. `--safe-mode` deaktiviert CLAUDE.md, Skills, Plugins, Hooks und MCP, ohne wie `--bare` macOS-Keychain-OAuth abzuschalten. Codex 0.144.1: `exec --sandbox workspace-write -C <worktree> --ephemeral --ignore-user-config --color never`; stdin wird geschlossen übergeben. Niemals `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`; Netzwerk in der workspace-write-Sandbox bleibt deaktiviert.

## ADR-016: Getrennte Env-Whitelists pro Vertrauensdomäne

Claude und Codex erhalten jeweils nur ihre eigene Auth-Konfiguration; Git erhält ein isoliertes HOME sowie deaktivierte System-/Globalkonfiguration; Projektbefehle erhalten ein temporäres HOME und keinerlei Modell-/Linear-Credentials. Nie werden Agenten-Credentials an Tests vererbt. ANSI-Sequenzen werden vor Persistenz/Streaming gestrippt.

## ADR-017: Dev via tsx + tsconfig-paths, Prod via `tsc -b` + dist

Dev: `tsx watch` mit einer tsconfig, deren `paths` `@agent/*` auf Paket-Quellcode mappen (tsx nutzt genau eine tsconfig prozessweit). Prod: Projekt-References bauen `dist/` je Paket; emittierte `@agent/*`-Importe werden zur Laufzeit über Workspace-Symlinks auf `dist` aufgelöst. Vitest löst `@agent/*` über eine gemeinsame Alias-Datei (`vitest.alias.mjs`) auf Quellcode auf.

## ADR-018: Unklare oder gekappte Agenten-Ergebnisse eskalieren zum Menschen

Plan, Implementierungsbericht und Review sind strikte, versionierte JSON-Verträge. Claude validiert Plan/Review zusätzlich bereits per `--json-schema`; der Orchestrator validiert alle Verträge mit Zod. Inkonsistente Verdicts (z. B. PASS mit Findings), ungültiges JSON, gekappte Ausgabe sowie Codex-Läufe ohne Dateiänderung führen zu `needs_human` — nie zu stillem Rework oder Fake-Erfolg. Der alte Zeilenparser bleibt nur als isolierte Legacy-Hilfe, nicht als Pipeline-Vertrag.

## ADR-019: Projektcode läuft standardmäßig über Anthropic Sandbox Runtime

Ein konfigurierter Befehl wie `pnpm test` kann vom Agenten veränderte Package-Skripte und damit beliebigen Code starten; `spawn({shell:false})` und eine Env-Whitelist allein sind keine OS-Isolation. **Entscheidung:** Der Standardmodus `sandboxed` startet Setup/Checks über `srt` (macOS `sandbox-exec`, Linux `bubblewrap`), sperrt Netzwerk, schützt bekannte Credential-Pfade, setzt ein temporäres HOME und erlaubt Schreiben nur in Worktree/Sandbox-Temp. `trusted` ist ein expliziter, in der UI markierter Opt-out. Beide Modi verwenden eine credential-freie Testumgebung.

## ADR-020: Worktrees gehören einem Job und werden niemals automatisch bereinigt

Ticketweite Branches kollidieren bei Wiederholungen; `reset --hard`/`clean -fd` kann manuelle Arbeit vernichten. **Entscheidung:** Branch und Pfad enthalten eine Job-ID, der freie Branchname wird vor Worktree-Erstellung persistiert, und `OWNER.json` bindet Job, Repository, Branch und Basis-SHA. Unbekannte, falsch zugeordnete, beschädigte oder bereits schmutzige Worktrees eskalieren. Der normale Workflow löscht keine Verzeichnisse und verwirft keine Änderungen. Eine explizite Post-Run-Aktion darf nur nach dokumentiert sauberem Ausgangszustand ihre eigenen, noch nicht committeten Änderungen auf genau den zuvor gespeicherten HEAD zurücksetzen. Commits deaktivieren Hooks und Signierung; Diff-Aufrufe deaktivieren externe Treiber. Aktive `.gitattributes`-Filter werden vor Checkout und Staging fail-closed abgelehnt. Review-Diffs referenzieren den gespeicherten Basis-Commit statt einen beweglichen Branchnamen.

## ADR-021: Planfreigabe und Handoff sind eigene Zustände

Ein Ticket ist häufig keine vollständige Spezifikation, und „Review bestanden" bedeutet ohne Push/Merge nicht „erledigt". **Entscheidung:** `awaiting_plan_approval` hält bei entsprechender Projektpolicy sowie immer bei hohem Risiko/offenen Fragen. Freigabehinweise werden als Artefakt übergeben. Ein bestandenes Review führt zu `ready_for_human`; nur ein Mensch setzt lokal `done`. Basis-/Head-SHA, Stale-Status, Diffstat und Checks stehen im Handoff-Artefakt.

## ADR-022: Deterministischer Completion-Contract

LLM-PASS allein genügt nicht. **Entscheidung:** Vor der Übergabe müssen Baseline (falls aktiviert), alle aggregiert ausgeführten Pflichtchecks, sauberer Worktree, unverändertes Test-HEAD, ungekappte Ausgaben, Diffgrößen-/Dateilimits, Binärdatei-Gate, gesperrte Pfade, Owner-Metadaten und unveränderte Basis bestehen. Verletzungen führen zu `needs_human`; die Agenten können die Gates nicht verändern.

## ADR-023: GitHub-Nacharbeit ist eine transaktionale Queue-Aktion

PR-Review-Nacharbeit schreibt in denselben Worktree und Git-Objektspeicher wie die normale Pipeline. **Entscheidung:** Die Aktion reserviert einen normalen Queue-/Projektschreibslot und führt ein AbortSignal über Codex, Prüfungen, Git und GitHub. Der Job bleibt während Warten und Ausführung sichtbar aktiv. Ausgangspunkt ist zwingend ein sauberer, eigentümergeprüfter Worktree; dessen HEAD wird vor externen Aufrufen als Recovery-Anker persistiert. Codex-Änderungen werden vollständig gestaged, gegen Policies geprüft und noch vor dem Commit getestet. Fehler bis zu diesem Commit verwerfen ausschließlich den Aktions-Diff gegen den gespeicherten Ausgangs-HEAD. Ein erfolgreicher Commit ersetzt sofort den Recovery-Anker; verifizierter Code bleibt bei Crash-, Push- oder API-Fehlern für einen sicheren Retry erhalten. Jeder Retry synchronisiert und verifiziert den Upstream unabhängig davon, ob er selbst einen neuen Commit erstellt hat. Erst dann dürfen vollständig adressierte und vollständig paginierte Review-Threads aufgelöst werden.
