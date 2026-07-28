# agent-platform

Lokale Agenten-Orchestrierungsplattform. Linear-Tickets werden über ihren Identifier importiert und anschließend über ein lokales Board kontrolliert ausgeführt: Claude erstellt einen strukturierten Plan, Codex implementiert in einem jobgebundenen Git-Worktree, konfigurierte Projektprüfungen laufen in einer OS-Sandbox, und Claude führt ein strukturiertes Review durch — mit begrenzten Nacharbeitsschleifen. Der gesamte Workflow läuft lokal. Linear bleibt Datenquelle; ausschließlich ein optional aktivierter Abschlusskommentar darf geschrieben werden.

- Kein automatischer Merge, kein Force-Push, keine Branch-Löschung; ein normaler Push ist nur als explizite GitHub-Review-Aktion möglich.
- Keine Linear-Statusänderungen. Kommentare sind optional und standardmäßig aus.
- Agenten mutieren **nie** Workflowzustände — validierte Ergebnisse werden allein von der deterministischen State Machine auf Übergänge abgebildet.
- `ready_for_human` bedeutet „Agentenarbeit übergabebereit"; erst ein Mensch setzt lokal auf `done`.
- Läuft auf macOS (Apple Silicon/Intel) und Linux (Ubuntu/Debian/VPS ohne GUI).

---

## Inhalt

- [Architekturübersicht](#architekturübersicht)
- [Workflow](#workflow)
- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation-mit-pnpm)
- [macOS-Setup](#macos-setup) · [Linux-Setup](#linux-setup) · [VPS-Betrieb](#vps-betrieb)
- [Konfiguration (Umgebungsvariablen)](#konfiguration-umgebungsvariablen)
- [Linear-API-Key](#linear-api-key)
- [Claude-Code- & Codex-Konfiguration](#claude-code--und-codex-konfiguration)
- [Entwicklung, Build, Tests, Migrationen](#entwicklung-build-tests-migrationen)
- [Sicherheitsmodell](#sicherheitsmodell)
- [Backup](#backup) · [Fehlerbehebung](#fehlerbehebung) · [Bekannte Einschränkungen](#bekannte-einschränkungen)
- [Hermes-Integration (in Vorbereitung)](#hermes-integration-in-vorbereitung)

---

## Architekturübersicht

pnpm-Monorepo mit zwei Apps und sechs Paketen:

```
agent-platform/
├── apps/
│   ├── dashboard/       @agent/dashboard   Vue 3 + Vite Frontend (Kanban, Detail, Live-Logs)
│   └── orchestrator/    @agent/orchestrator Fastify-Backend, WebSockets, Queue, Pipeline
├── packages/
│   ├── shared/          @agent/shared      Typen, Zustände, Transitions, Zod-Schemas, WS-Events
│   ├── database/        @agent/database    SQLite (better-sqlite3), Migrationen, Repositories
│   ├── workflow/        @agent/workflow    Deterministische State Machine
│   ├── linear/          @agent/linear      Linear-Import (nur lesend)
│   ├── git/             @agent/git         Worktree-Service (kein push/merge/force/delete)
│   └── agents/          @agent/agents      Prozessausführung + Claude-/Codex-Adapter
├── docs/architecture-decisions.md          Architekturentscheidungen (ADRs)
├── pnpm-workspace.yaml  ·  tsconfig.base.json  ·  .env.example
```

Datenfluss:

```
Vue-Dashboard ──REST──▶ Fastify-Orchestrator ──▶ JobQueue ──▶ JobPipeline
      ▲            │  ▲                               │
      └──── WS ◀───┘  └── SQLite ◀────────────────────┤ WorkflowEngine (Zustände, Limits)
                                                       ├── GitService (Worktrees, Diff, Commits)
                                                       ├── ProcessExecutor (spawn, Timeout, Kill)
                                                       ├── TestSandbox (SRT: sandbox-exec/bubblewrap)
                                                       ├── ClaudeCodeAdapter (Plan + Review, lesend)
                                                       └── CodexCliAdapter (Implementierung, Sandbox)
```

Details zu den wichtigsten Entscheidungen in [`docs/architecture-decisions.md`](docs/architecture-decisions.md).

## Workflow

Lokale Zustände: `inbox → agent_ready → preflight → planning → implementing → testing → review → ready_for_human → done`.
Je nach Projektpolicy hält die Pipeline nach der Planung in `awaiting_plan_approval`; hohe Risiken oder offene Fragen erzwingen diese Freigabe auch im Automatikmodus. Bei Review-`FAIL`: `review → rework → implementing → testing → review`. Nach `MAX_REVIEW_LOOPS`
Schleifen (Standard 3) endet der Job in `needs_human`. `failed` ist Infrastrukturfehlern
(Prozessabbruch, Timeout, Worktree-Fehler) vorbehalten; `paused` hält an einer Phasengrenze.

Nur die Verschiebung **Inbox → Agent Ready** startet den Workflow. System-Zustände
(`preflight`/`planning`/`implementing`/`testing`/`review`/`rework`) sind während eines laufenden Jobs nicht manuell
verschiebbar — dort greifen **Pause** (weich, an der nächsten Phasengrenze) und **Abbruch** (hart).

Phasen pro Job:

1. **Worktree**: eigener Branch `fix|chore|feature/<ticket>/<job>` auf einem gespeicherten Basis-Commit. Die Kategorie wird einmalig aus Titel und Labels abgeleitet und der freie Branchname vor der Worktree-Erstellung persistiert; Re-Imports oder Restarts verändern ihn nicht. Unbekannte oder schmutzige Worktrees werden niemals automatisch gelöscht oder zurückgesetzt; `.agent/` ist als Orchestratorpfad reserviert und darf im Zielrepository nicht getrackt sein.
2. **Preflight**: optionales Setup und Baseline-Prüfungen. Eine bereits rote Basis stoppt vor der Implementierung.
3. **Plan** (Claude, lesend): validierter JSON-Vertrag, daraus `.agent/PLAN.md`. Je nach Policy folgt die menschliche Freigabe; Antworten werden als eigenes Artefakt gespeichert.
4. **Implementierung** (Codex, workspace-write-Sandbox): setzt den unveränderlichen Plan um und liefert einen validierten Implementierungsbericht; der Orchestrator committet ohne Git-Hooks.
5. **Testphase**: `setup` sowie rein prüfende Befehle (`format`/`lint`/`typecheck`/`test`/`build`) mit Timeout. Unabhängige Checks werden gesammelt ausgeführt. Änderungen am Worktree/Git-HEAD oder gekappte Ausgabe ⇒ `needs_human`.
6. **Review** (Claude, lesend): validierter Vertrag mit Verdict, Findings und offenen Akzeptanzkriterien. `FAIL` führt begrenzt zur Nacharbeit; `PASS` erzeugt einen Handoff-Bericht und endet in `ready_for_human` (ohne Merge/Push).

Nach dem Durchgang kann in `ready_for_human` oder `done` die Aktion **GitHub-Kommentare mit Codex** gestartet werden. Sie belegt denselben Queue-/Projektschreibslot wie die normale Pipeline, lädt alle offenen Review-Threads samt paginierten Antworten und lässt Codex berechtigte Hinweise im Worktree umsetzen. Der gestagte Diff wird gegen die Projektlimits geprüft und die konfigurierten Projektprüfungen laufen noch vor dem Commit. Bei Fehlern davor werden ausschließlich die Änderungen dieser Aktion auf den zuvor sauberen HEAD zurückgesetzt. Erst nach bestandenen Checks wird committet, der Upstream synchronisiert und sein SHA verifiziert; anschließend werden die von Codex vollständig erledigten Threads als resolved markiert. Die Aktion bleibt bis dahin sichtbar aktiv und kann normal abgebrochen werden. Voraussetzung sind ein offener Pull Request, ein Upstream für den Job-Branch sowie eine funktionierende lokale `gh`- und GitHub-Git-Anmeldung.

Pause speichert die nächste Phase als Checkpoint. Fortsetzen beginnt dort und führt Planung, Implementierung oder Tests nicht unnötig erneut aus.

## Voraussetzungen

- **Node.js ≥ 22** (getestet mit 24.x). `.tool-versions` pinnt `nodejs 24.18.0` für asdf.
- **pnpm 10** (per Corepack). Kein npm/Yarn.
- **git ≥ 2.30** (Worktree-Unterstützung).
- **Claude Code CLI** (`claude`) und **Codex CLI** (`codex`) auf dem `PATH`, wenn echte Agentenläufe gewünscht sind. Ohne sie funktionieren Import, Board und Tests dennoch.
- **GitHub CLI** (`gh`) mit Anmeldung sowie ein bereits gepushter Branch mit Upstream, wenn GitHub-Review-Kommentare aus dem Dashboard bearbeitet werden sollen.
- **Sandbox Runtime** (`srt`) wird als pnpm-Abhängigkeit installiert. Unter Linux benötigt sie `bubblewrap`, `socat` und `ripgrep`; macOS nutzt das vorhandene `sandbox-exec`.
- Ein **Linear-API-Key** für den Ticketimport (optional; ohne Key sind alle anderen Funktionen nutzbar).

## Installation mit pnpm

```bash
corepack enable            # aktiviert pnpm (in Node 22/24 gebündelt)
pnpm install
pnpm db:migrate            # legt data/orchestrator.db an und migriert
pnpm dev                   # startet Orchestrator (:8787) und Dashboard (:5173) parallel
```

> `pnpm dev` startet beide Apps. Das Dashboard proxyt `/api` und `/ws` auf den Orchestrator —
> im Browser `http://localhost:5173` öffnen.

### Erster Lauf

1. Unter **Projekte** Repository, Basisbranch und eine Worktree-Wurzel außerhalb des Repositories anlegen.
2. Planfreigabe, Sandboxmodus, Baseline und Diff-Limits wählen; `format` muss ein prüfender Befehl wie `format:check` sein.
3. Ein Ticket per Linear-Identifier importieren und von **Inbox** nach **Agent Ready** ziehen.
4. Falls der Job auf **Planfreigabe** hält, `PLAN.md` prüfen, offene Fragen beantworten und freigeben.
5. In **Ready for Human** Handoff, exakten Base-/Head-SHA, Diff und Testergebnisse prüfen. Für einen bereits vorhandenen Pull Request können offene Review-Threads per **GitHub-Kommentare mit Codex** nachbearbeitet werden. Erst danach lokal als `done` bestätigen oder den Branch außerhalb der Plattform mergen.

### macOS-Setup

```bash
# Node über asdf (empfohlen) oder nvm
asdf install nodejs 24.18.0    # respektiert .tool-versions
corepack enable
pnpm install && pnpm db:migrate
```

Keine Abhängigkeit von Homebrew. `better-sqlite3` wird als Prebuild für darwin-arm64/-x64 geladen.

### Linux-Setup

```bash
# Ubuntu/Debian
sudo apt-get install -y git build-essential bubblewrap socat ripgrep
# Node 22/24 via nvm oder asdf, dann:
corepack enable
pnpm install && pnpm db:migrate
```

Prebuilds für linux-x64/arm64 (inkl. musl) sind vorhanden; ein C++-Toolchain wird nur als Fallback benötigt.

### VPS-Betrieb

```bash
pnpm install
pnpm build
HOST=0.0.0.0 PORT=8787 pnpm --filter @agent/orchestrator start
```

Im Produktions-Build serviert der Orchestrator das gebaute Dashboard (`apps/dashboard/dist`) direkt
mit — ein einziger Prozess, kein separater Webserver nötig. **Es gibt keine eingebaute
Authentifizierung.** Auf einem VPS daher hinter einen SSH-Tunnel oder einen authentifizierenden
Reverse-Proxy (nginx/Caddy) legen; nicht ungeschützt ins Internet binden. `systemd` ist optional
und nicht erforderlich.

## Konfiguration (Umgebungsvariablen)

Kopiere `.env.example` nach `.env`. Die Konfiguration wird beim Start mit Zod validiert; bei
ungültigen Werten bricht der Orchestrator mit einer verständlichen Meldung ab.

| Variable                         | Standard                 | Zweck                                                                   |
| -------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `NODE_ENV`                       | `development`            | Betriebsmodus                                                           |
| `HOST`                           | `127.0.0.1`              | Bind-Adresse (VPS: `0.0.0.0`)                                           |
| `PORT`                           | `8787`                   | Port des Orchestrators                                                  |
| `DATABASE_PATH`                  | `./data/orchestrator.db` | SQLite-Datei (relativ zum Aufrufverzeichnis)                            |
| `DATA_DIR`                       | `./data`                 | Datenverzeichnis (Logs, Codex-Ausgaben)                                 |
| `LINEAR_API_KEY`                 | –                        | Linear-Import und optional aktivierter Handoff-Kommentar                |
| `LINEAR_WRITE_COMMENTS`          | `false`                  | Wenn `true`, darf ein Abschlusskommentar nach Linear geschrieben werden |
| `REPO_ROOT` / `WORKTREE_ROOT`    | –                        | Vorschlagswerte für neue Projekte                                       |
| `BASE_BRANCH`                    | `main`                   | Standard-Basisbranch                                                    |
| `GIT_AUTHOR_NAME`                | `Robert Schreiner`       | Autor und Committer automatischer Git-Commits                           |
| `GIT_AUTHOR_EMAIL`               | `robsch@stagedates.com`  | E-Mail für Autor und Committer automatischer Git-Commits                |
| `CLAUDE_BIN` / `CODEX_BIN`       | `claude` / `codex`       | Pfad/Name der CLIs                                                      |
| `SRT_BIN`                        | `srt`                    | Sandbox-Runtime für Projektbefehle                                      |
| `CLAUDE_MODEL` / `CODEX_MODEL`   | `claude-opus-5` / `gpt-5.6-sol` | Modell-Overrides; leer verwendet den jeweiligen CLI-Default      |
| `CLAUDE_EFFORT` / `CODEX_EFFORT` | `high` / `medium`        | Reasoning-Effort der jeweiligen CLI                                     |
| `CLAUDE_MAX_BUDGET_USD`          | –                        | Optionales Kostenlimit pro Claude-Aufruf                                |
| `MAX_REVIEW_LOOPS`               | `3`                      | Maximale Nacharbeitsschleifen                                           |
| `MAX_JOB_RUNTIME_MINUTES`        | `60`                     | Hartes Job-Zeitlimit                                                    |
| `MAX_AGENT_OUTPUT_MB`            | `10`                     | Obergrenze erfasster Agenten-/Prüfausgabe; Kürzung eskaliert            |
| `MAX_CONCURRENT_JOBS`            | `1`                      | Gleichzeitig laufende Jobs                                              |
| `TEST_COMMAND_TIMEOUT_MINUTES`   | `10`                     | Timeout je Prüfbefehl                                                   |
| `LOG_LEVEL`                      | `info`                   | Pino-Loglevel                                                           |

Projektbezogene Policies werden im Dashboard gespeichert:

- **Planfreigabe**: immer bestätigen oder niedrige Risiken automatisch; hohe Risiken/offene Fragen halten stets an.
- **Testausführung**: `sandboxed` (Standard, Netzwerk gesperrt) oder bewusst unsicherer `trusted`-Hostmodus.
- **Baseline**: konfigurierte Checks vor jeder neuen Implementierung auf dem unveränderten Basisstand.
- **Diff-Grenzen**: maximale Dateianzahl, maximale Bytegröße und gesperrte Pfadpräfixe; binäre Änderungen eskalieren immer zur Sichtprüfung.
- **Setup**: optionaler, idempotenter Offline-Befehl wie `pnpm install --offline --frozen-lockfile`. Er läuft in derselben Sandbox wie die Checks.

Neue Job-Branches enthalten Kategorie, Ticket-Identifier und einen lesbaren Titel-Slug, zum
Beispiel `fix/web-438/iframe-rundung-korrigieren`. Nur bei einer Namenskollision wird `-2`, `-3`
usw. ergänzt. Automatische Commits verwenden die über `GIT_AUTHOR_NAME` und
`GIT_AUTHOR_EMAIL` konfigurierte Identität.

### Linear-API-Key

Einen Personal API Key unter **Linear → Settings → Security & access → Personal API keys**
erstellen und als `LINEAR_API_KEY` setzen. Ticketbeschreibungen werden nur durch die explizite
Aktion **„In Linear speichern“** in der Detailansicht geändert; Status und andere Ticketfelder
bleiben unverändert. Mit `LINEAR_WRITE_COMMENTS=true` wird zusätzlich der ausdrücklich
aktivierte Handoff-Kommentar geschrieben. Der Key wird **niemals an Kindprozesse
(Claude/Codex/Testbefehle) weitergegeben**. Beim Import können bis zu 100 Identifier gemeinsam
einem Projekt zugeordnet werden, z. B. `APP-123`, `APP-124` und `WEB-42`.

### Claude-Code- und Codex-Konfiguration

Die Adapter rufen die installierten CLIs nichtinteraktiv auf (verifiziert gegen Claude CLI 2.1.x /
Codex CLI 0.144.x, siehe ADR-015):

- **Claude (Plan/Review, schreibende Tools technisch entfernt)**
  `claude -p --output-format json --tools "Read,Glob,Grep" --permission-mode plan --safe-mode --no-session-persistence --json-schema <phase-schema> [--model …] [--max-budget-usd …]`
- **Codex (Implementierung/Nacharbeit)**
  `codex exec --sandbox workspace-write -C <worktree> --ephemeral --ignore-user-config --color never …`

Es werden **keine** Sandbox-/Freigabe-umgehenden Flags genutzt
(`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`). Auf einem
headless VPS die CLIs zuvor authentifizieren (Claude: `ANTHROPIC_API_KEY` bzw. `claude`-Login;
Codex: `~/.codex/auth.json`). Claude und Codex erhalten getrennte Auth-Umgebungen. Git erhält ein isoliertes `HOME`; Projektcode erhält ein temporäres `HOME` und niemals Modell-/Linear-Credentials. Plan, Implementierungsbericht und Review werden gegen strikte Zod-Verträge validiert; ungültige oder gekappte Antworten eskalieren zu `needs_human`.

## Entwicklung, Build, Tests, Migrationen

```bash
pnpm dev            # Orchestrator + Dashboard (Watch)
pnpm build          # baut alle Pakete/Apps (topologisch)
pnpm test           # Vitest in allen Paketen (Mocks für Linear/CLIs/Git)
pnpm typecheck      # tsc/vue-tsc
pnpm lint           # ESLint
pnpm format         # Prettier (schreibend) · pnpm format:check zum Prüfen
pnpm db:migrate     # Datenbankmigrationen anwenden
```

Produktion:

```bash
pnpm build
pnpm --filter @agent/orchestrator start
```

**Datenbankmigrationen** liegen als nummerierte SQL-Dateien in
`packages/database/migrations`. Sie werden beim Orchestrator-Start automatisch angewendet und
zusätzlich über `pnpm db:migrate`. Eine neue Migration = neue Datei `NNN_name.sql`; bereits
angewendete werden übersprungen (`schema_migrations`).

## Sicherheitsmodell

Alle folgenden Inhalte gelten als **nicht vertrauenswürdig**: Linear-Beschreibungen,
Repository-Dateien, Markdown, Agentenantworten, Testausgaben, Git-Diffs.

- **Prompt-Injection und Verträge**: Untrusted-Inhalte werden als Daten gerahmt. Claude läuft im `--safe-mode`, der CLAUDE.md, Skills, Plugins, Hooks und MCP-Konfigurationen deaktiviert. Plan und Review werden bereits per CLI-JSON-Schema und danach nochmals mit Zod geprüft; auch der Implementierungsbericht ist ein versionierter Zod-Vertrag. Inkonsistente, ungültige oder gekappte Ergebnisse ⇒ `needs_human`.
- **Prozessausführung**: `spawn` ohne Shell, getrennte Argumente, explizites Arbeitsverzeichnis, Timeouts, Ausgabe-Obergrenze (Kopf + Tail) und Prozessgruppen-Kill. Claude-, Codex-, Git- und Testumgebungen sind getrennt; Tests erhalten keine Agenten-Secrets.
- **Git**: Der normale Workflow pusht und mergt nicht. Die explizite GitHub-Review-Aktion darf ausschließlich den aktuellen Job-Branch ohne Force auf dessen bereits konfigurierten Upstream pushen; Merge, Force-Push und Branch-Löschung existieren weiterhin nicht. Review-Threads werden erst nach verifiziertem Remote-SHA aufgelöst. Jeder Job besitzt Branch, Pfad, Eigentümerdatei und Basis-SHA. Fremde oder bereits schmutzige Worktrees werden nie bereinigt; nur wenn die GitHub-Aktion selbst auf einem zuvor nachweislich sauberen Worktree fehlschlägt, verwirft sie ihre noch nicht committeten Änderungen gegen den zuvor gespeicherten HEAD. Commits laufen mit deaktivierten Hooks. `.agent/` bleibt aus Commits/Diffs/Status ausgeschlossen.
- **Sandbox**: Codex läuft in `workspace-write` mit deaktiviertem Netzwerk. Claude besitzt ausschließlich Read/Glob/Grep, keine schreibenden/Bash-Tools und keine Projekt-Customizations; diese Toolgrenze ist dennoch keine allgemeine OS-Lesesandbox. Projektbefehle laufen standardmäßig über Anthropic Sandbox Runtime (`sandbox-exec`/`bubblewrap`) mit gesperrtem Netzwerk, temporärem `HOME`, geschützten Credential-Pfaden und Schreibrechten nur für Worktree/Sandbox-Temp. `trusted` ist ein expliziter, sichtbar markierter Opt-out.
- **Completion-Policy**: Baseline, alle Pflichtchecks, sauberer Worktree, unverändertes Git-HEAD, Diff-Limits, Binärdateien, gesperrte Pfade und unveränderte Basis werden deterministisch geprüft. Agenten können diese Gates nicht überspringen.
- **Pfadvalidierung**: Ticket-/Job-Identifier werden validiert; Worktree-Pfade müssen innerhalb des konfigurierten Roots liegen. Unbekannte Verzeichnisse werden nie automatisch entfernt.
- **Linear**: lesender Import; ausschließlich Abschlusskommentare hinter `LINEAR_WRITE_COMMENTS=true`.
- **UI**: Markdown wird mit DOMPurify sanitisiert gerendert.

## Backup

Der persistierte **Orchestratorzustand** liegt unter `DATA_DIR` (Standard `./data`):

- `orchestrator.db` (+ `-wal`/`-shm`) — Projekte, Tickets, Jobs, Events, Artefakte.
- `logs/<jobId>.ndjson` — Live-Logs.
- `test-sandboxes/<jobId>/` — während eines Laufs temporäre Homes/Policies ohne Agenten-Credentials; sie werden am Laufende bestmöglich entfernt.

Backup bei gestopptem Orchestrator per Kopie des `data/`-Verzeichnisses, oder online mit
`sqlite3 data/orchestrator.db ".backup data/backup.db"`. Die Git-Worktrees selbst liegen im
konfigurierten `worktreeRoot`. Die erzeugten Commits liegen jedoch im Git-Objektspeicher des konfigurierten Repositories und sind **nicht** vollständig in `DATA_DIR` enthalten. Ein vollständiges Backup umfasst daher zusätzlich das Repository beziehungsweise ein Git-Bundle der Job-Branches, z. B. `git -C <repo> bundle create job-backup.bundle --branches='feature/*' --branches='fix/*' --branches='chore/*'`. Worktrees sind erst dann aus dem Repository rekonstruierbar, wenn diese Git-Objekte gesichert wurden.

## Fehlerbehebung

- **Corepack-/pnpm-Fehler**: `corepack enable` erneut ausführen; bei Node ≥ 25 `npm i -g pnpm@10`.
- **`better-sqlite3` baut aus Quellen / Install-Script blockiert**: sicherstellen, dass `better-sqlite3` unter `onlyBuiltDependencies` in `pnpm-workspace.yaml` steht (bereits konfiguriert), dann `pnpm rebuild better-sqlite3`.
- **Import schlägt fehl (`LINEAR_ERROR`)**: `LINEAR_API_KEY` gesetzt? Identifier korrekt (`APP-123`)?
- **Job endet sofort `failed` mit „Ungültiger Ticket-Identifier"**: Identifier muss dem Muster `ABC-123` entsprechen.
- **Job „Durch Neustart unterbrochen"**: Der Orchestrator wurde während eines Laufs beendet; per **Erneut** neu starten.
- **GitHub-Nacharbeit durch Neustart unterbrochen**: Der Job bleibt in `ready_for_human`/`done`; sichere uncommittierte Aktionsreste wurden entfernt. Bei einem zusätzlichen Aufräumhinweis den Worktree manuell prüfen, danach die Aktion erneut starten.
- **Sandbox Runtime startet nicht**: Linux-Pakete `bubblewrap socat ripgrep` installieren und `SRT_BIN` prüfen. Nur für vollständig vertrauenswürdige Repositories den Projektmodus bewusst auf `trusted` setzen.
- **Baseline ist rot**: Basisbranch beziehungsweise Projekt-Setup außerhalb des Agentenlaufs reparieren; erst danach erneut starten. Die Plattform lässt bekannte rote Pflichtchecks nicht still passieren.
- **„Prüfung hat den Worktree verändert"**: einen lesenden Check konfigurieren (`format:check` statt `format`); Testgeneratoren müssen ihre Ausgaben ignorieren oder außerhalb getrackter Pfade schreiben.
- **„Worktree enthält lokale Änderungen"**: Änderungen manuell prüfen und committen/sichern. Die Plattform verwirft sie absichtlich nicht mehr automatisch.
- **Agent hängt / Zeitlimit**: `MAX_JOB_RUNTIME_MINUTES` bzw. `TEST_COMMAND_TIMEOUT_MINUTES` prüfen; der Job wird beim Limit hart beendet.
- **WebSocket „closed"**: Der Client reconnectet automatisch und lädt danach den Zustand neu; Board bleibt konsistent.
- **CLIs nicht gefunden**: `CLAUDE_BIN`/`CODEX_BIN` auf absolute Pfade setzen.

## Bekannte Einschränkungen

- Keine eingebaute Authentifizierung/Mandantentrennung — für lokalen Betrieb bzw. hinter Reverse-Proxy gedacht.
- Job-Queue ist in-process (kein verteiltes Scheduling); Standard-Parallelität 1, pro Projekt ein Schreibjob einschließlich GitHub-Nacharbeit.
- Kein automatischer Merge/PR — bewusst; `ready_for_human` ist ein Agent-Ausführungsstatus und kein Linear-Ticketstatus.
- `trusted`-Testmodus besitzt keine OS-Isolation und ist ausschließlich für vollständig vertrauenswürdige Repositories vorgesehen.
- Der sichere Testmodus sperrt Netzwerk vollständig; eine granulare projektbezogene Domain-Allowlist ist noch nicht vorhanden.
- Anthropic Sandbox Runtime ist noch vor Version 1.0; Start-/Backendfehler werden deshalb fail-closed zu `needs_human` eskaliert.
- Repositories mit aktiven `.gitattributes`-Filtern (z. B. Git LFS) werden derzeit fail-closed abgelehnt, weil Checkout/`git add` sonst externe Filterprozesse außerhalb der Agentensandbox starten könnten.
- Windows wird nicht offiziell unterstützt (Prozessgruppen-Semantik ist POSIX; macOS/Linux getestet).
- Der Linear-Sync ist ein Import-Snapshot (Re-Import aktualisiert), kein kontinuierlicher Live-Sync.

## Hermes-Integration (in Vorbereitung)

Die Agentenschicht ist über ein schmales `AgentAdapter`-Interface abstrahiert
(`execute()` / `cancel()`), während die Phasen versionierte Verträge (`PlanResult`, `ImplementationResult`, `ReviewResult`) verwenden. `ClaudeCodeAdapter`, `CodexCliAdapter` und der vorbereitete `HermesAdapter` implementieren dieselbe Ausführungsgrenze.
Hermes ist als übergeordnete Bedien- und Delegationsschicht vorgesehen: Der `HermesAdapter`
(beziehungsweise ein Hermes-Skill) tritt an dieselbe Stelle wie die direkten CLI-Adapter, ohne
dass Queue oder State Machine sich ändern.

Der erste Integrationsschnitt ist vorhanden: Die Pipeline hängt nur noch vom allgemeinen
`AgentAdapter` ab und `@agent/agents` enthält einen `HermesAdapter` für den nichtinteraktiven
NousResearch-Hermes-One-shot-Modus. Er deaktiviert Benutzerregeln, Memory und Skills, setzt pro
Phase explizite Toolsets und verwendet weiterhin die vorhandenen versionierten Zod-Verträge.
Produktiv ist Hermes noch nicht auswählbar: Hermes bestätigt im One-shot-Modus Toolaufrufe
automatisch. Vor der Konfigurationsverdrahtung muss deshalb eine phasenspezifische OS-Sandbox
Schreibzugriffe für Plan/Review sperren und Implementierungen auf den Job-Worktree begrenzen.

**Grenze (unveränderlich):** Hermes darf — wie die anderen Agenten — **nicht** über
Statuswechsel, Merge oder Review-Limits entscheiden. Diese Entscheidungen bleiben ausschließlich
bei der deterministischen Workflow-Engine. Der geplante Hermes-Skill kapselt lediglich die
Ausführung eines Plan-/Implementierungs-/Review-Schritts und liefert den jeweiligen validierbaren Vertrag zurück; die Interpretation (PASS/FAIL, Policy-Gates, Schleifenzählung, Zustandsübergang) verbleibt im Orchestrator.
