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

## ADR-005: `PLAN.md`/`REVIEW.md` in `<worktree>/.agent/`, Ausschluss per Pathspec

Codex läuft sandboxed auf den Worktree begrenzt und muss PLAN.md lesen sowie Planabweichungen dokumentieren können → die Dateien müssen im Worktree liegen. Sie dürfen aber nicht in Commits/Diffs auftauchen. `info/exclude` ist worktree-übergreifend geteilt und würde die Repo-Konfiguration des Nutzers mutieren. **Entscheidung:** Alle git-Aufrufe (add/diff/status/clean) schließen `.agent/` konsequent per Pathspec `':(exclude).agent'` bzw. `clean -e .agent` aus. Kopien aller Artefakte liegen zusätzlich in der Datenbank.

## ADR-006: Der Orchestrator schreibt PLAN.md/REVIEW.md — Claude bleibt physisch lesend

Claude arbeitet in Plan- und Review-Phase strikt lesend (`--tools "Read,Glob,Grep" --permission-mode plan`). **Entscheidung:** Claudes stdout-Ergebnis wird vom Orchestrator in `.agent/PLAN.md` bzw. `.agent/REVIEW.md` geschrieben. Damit ist "Claude verändert keine Dateien" technisch garantiert, nicht nur promptbasiert.

## ADR-007: Pause ist soft, Cancel ist hart

"Systemzustände dürfen bei laufendem Job nicht manuell verändert werden" kollidiert mit Pause mitten im Lauf. **Entscheidung:** Pause setzt ein persistiertes Flag, das an Phasengrenzen ausgewertet wird (laufende Phase endet regulär, dann → `paused`). Cancel killt die Prozessgruppe sofort → `failed` („Vom Benutzer abgebrochen").

## ADR-008: Ein Rework-Zähler; am Limit immer `needs_human`; `failed` nur für Infrastruktur

Test-Fehlschlag-Schleifen (`testing→rework`) wären sonst unbegrenzt. **Entscheidung:** Ein Zähler (`jobs.review_loop_count`), inkrementiert bei jedem Eintritt in `rework`. Am Limit geht der Job immer nach `needs_human` — dafür wird die Transitions-Map der Spec um `testing → needs_human` erweitert (dokumentierte Abweichung). `failed` ist für Infrastrukturfehler reserviert (Spawn-Fehler, Timeout, Abbruch, kaputter Worktree). Der Zähler wird bei jedem manuellen Eintritt in `agent_ready` zurückgesetzt.

## ADR-009: Restart-Recovery über persistierte Prozessgruppen-IDs

Nach einem Crash können Agenten-Kindprozesse weiterlaufen und Worktrees mutieren. **Entscheidung:** PGIDs werden pro Lauf persistiert; beim Boot werden Überlebende per `kill(-pgid)` beendet (ESRCH-tolerant), danach werden Jobs in aktiven Zuständen auf `failed` („Durch Neustart unterbrochen") gesetzt. Retry ist ausschließlich explizit.

## ADR-010: Commits pro Iteration durch den Orchestrator

Stabile, auditierbare Diffs für Review und Rework. **Entscheidung:** Nach jeder Codex-Iteration committet der Orchestrator (`git add -A -- . ':(exclude).agent'`) mit Identität aus `GIT_AUTHOR_*`/`GIT_COMMITTER_*`-Umgebungsvariablen — die globale Git-Konfiguration des Nutzers wird nie berührt. Review-Diff = `git diff <base>...HEAD` ohne `.agent/`. Push, Merge, Force-Push und Branch-Löschung existieren im GitService nicht.

## ADR-011: ProcessRunner-Typ in `@agent/shared`, Implementierung in `@agent/agents`

`@agent/git` und `@agent/agents` brauchen dieselbe sichere Prozessausführung; shared muss browser-tauglich bleiben. **Entscheidung:** Das Interface (nur Typen) liegt in shared, die `spawn`-Implementierung in agents, `@agent/git` erhält den Runner per Konstruktor-Injektion. Keine Paketzyklen.

## ADR-012: WebSocket verlustbehaftet, Datenbank kanonisch

Hochvolumige Agentenausgabe darf langsame Clients nicht destabilisieren. **Entscheidung:** Pro Client wird bei `bufferedAmount`-Überlauf gedroppt/koalesziert (`log_truncated`-Marker). Events tragen monotone Sequenz-IDs (AUTOINC aus `job_events`); Clients erkennen Lücken nach Reconnect und refetchen per REST. Kein Polling.

## ADR-013: Eigener Migrations-Mini-Runner

Nummerierte SQL-Dateien + `schema_migrations`-Tabelle, Ausführung in Transaktion, läuft beim Orchestrator-Boot vor der Recovery sowie via `pnpm db:migrate`. Kein zusätzliches Dependency.

## ADR-014: Projekt-Testbefehle als Strings mit striktem Tokenizer, ohne Shell

Die Spec definiert Befehle als Strings („pnpm lint"). **Entscheidung:** Ein kleiner, quote-fähiger Tokenizer (keine Shell-Features; Metazeichen `;|&<>$` und Backtick werden abgelehnt) zerlegt den String, Ausführung via `spawn(argv0, argv, {shell:false})`.

## ADR-015: CLI-Aufrufe gegen installierte Binaries verifiziert

Claude 2.1.197: `-p --output-format json --tools "Read,Glob,Grep" --permission-mode plan --no-session-persistence [--model …] [--max-budget-usd …]`; **`--max-turns` existiert nicht mehr** → Budget-Flag + eigene Wall-Clock-Timeouts. `--bare` bewusst nicht default (bräche macOS-Keychain-OAuth). Codex 0.144.1: `exec --sandbox workspace-write -C <worktree> --ephemeral --ignore-user-config --color never --json`; stdin wird geschlossen übergeben (offenes stdin ließe codex auf einen `<stdin>`-Block warten). Niemals `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`; Netzwerk in der workspace-write-Sandbox bleibt deaktiviert.

## ADR-016: Env-Whitelist für Kindprozesse

Kinder erhalten nur PATH, HOME, LANG, `NO_COLOR=1`, `CI=1` sowie — falls gesetzt — `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`. Nie `LINEAR_API_KEY` oder sonstige Secrets. ANSI-Sequenzen werden vor Persistenz/Streaming gestrippt.

## ADR-017: Dev via tsx + tsconfig-paths, Prod via `tsc -b` + dist

Dev: `tsx watch` mit einer tsconfig, deren `paths` `@agent/*` auf Paket-Quellcode mappen (tsx nutzt genau eine tsconfig prozessweit). Prod: Projekt-References bauen `dist/` je Paket; emittierte `@agent/*`-Importe werden zur Laufzeit über Workspace-Symlinks auf `dist` aufgelöst. Vitest löst `@agent/*` über eine gemeinsame Alias-Datei (`vitest.alias.mjs`) auf Quellcode auf.

## ADR-018: Unklare Agenten-Ergebnisse eskalieren zum Menschen

Review-Ausgaben ohne parsebares `VERDICT: PASS|FAIL` (fehlend, mehrdeutig, Output gekappt) sowie Codex-Läufe ohne jegliche Dateiänderung führen zu `needs_human` mit Begründung — nie zu stillem Rework oder Fake-Erfolg.
