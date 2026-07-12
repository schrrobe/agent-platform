# agent-platform

Lokale Agenten-Orchestrierungsplattform. Linear-Tickets werden über ihren Identifier importiert und anschließend vollständig über ein lokales Kanban-Board bearbeitet: Claude erstellt einen Plan, Codex implementiert in einem isolierten Git-Worktree, konfigurierte Projektprüfungen laufen als Testphase, und Claude führt ein striktes Review durch — mit begrenzten Nacharbeitsschleifen. Der gesamte Workflow läuft lokal; **Linear ist ausschließlich Datenquelle** und wird nie verändert.

- Kein automatischer Merge, kein Push, kein Force-Push, keine Branch-Löschung.
- Keine Linear-Statusänderungen. Kommentare nur optional und standardmäßig aus.
- Agenten entscheiden **nie** über Workflowzustände — das tut allein die deterministische State Machine.
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
- [Hermes-Integration (geplant)](#hermes-integration-geplant)

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
                                                       ├── ClaudeCodeAdapter (Plan + Review, lesend)
                                                       └── CodexCliAdapter (Implementierung, Sandbox)
```

Details zu den wichtigsten Entscheidungen in [`docs/architecture-decisions.md`](docs/architecture-decisions.md).

## Workflow

Lokale Zustände: `inbox → agent_ready → planning → implementing → testing → review → done`.
Bei Review-`FAIL`: `review → rework → implementing → testing → review`. Nach `MAX_REVIEW_LOOPS`
Schleifen (Standard 3) endet der Job in `needs_human`. `failed` ist Infrastrukturfehlern
(Prozessabbruch, Timeout, Worktree-Fehler) vorbehalten; `paused` hält an einer Phasengrenze.

Nur die Verschiebung **Inbox → Agent Ready** startet den Workflow. System-Zustände
(`planning`/`implementing`/`testing`/`review`) sind während eines laufenden Jobs nicht manuell
verschiebbar — dort greifen **Pause** (weich, an der nächsten Phasengrenze) und **Abbruch** (hart).

Phasen pro Job:

1. **Worktree**: `git worktree add agent/<id>` (idempotent; repariert/übernimmt Bestehendes).
2. **Plan** (Claude, strikt lesend): erzeugt `.agent/PLAN.md`.
3. **Implementierung** (Codex, workspace-write-Sandbox): setzt den Plan im Worktree um; der Orchestrator committet die Iteration.
4. **Testphase**: konfigurierte Befehle (`format`/`lint`/`typecheck`/`test`/`build`) sequenziell mit Timeout und Ausgabe-Erfassung. Rote Pflichtprüfung ⇒ Nacharbeit oder `needs_human`.
5. **Review** (Claude, strikt lesend): Ausgabe beginnt mit `VERDICT: PASS` oder `VERDICT: FAIL`. Bei `FAIL` wird `.agent/REVIEW.md` erzeugt und Codex arbeitet nach; bei `PASS` wird der Job `done` (ohne Merge/Push).

## Voraussetzungen

- **Node.js ≥ 22** (getestet mit 24.x). `.tool-versions` pinnt `nodejs 24.18.0` für asdf.
- **pnpm 10** (per Corepack). Kein npm/Yarn.
- **git ≥ 2.30** (Worktree-Unterstützung).
- **Claude Code CLI** (`claude`) und **Codex CLI** (`codex`) auf dem `PATH`, wenn echte Agentenläufe gewünscht sind. Ohne sie funktionieren Import, Board und Tests dennoch.
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
sudo apt-get install -y git build-essential
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

| Variable | Standard | Zweck |
|---|---|---|
| `NODE_ENV` | `development` | Betriebsmodus |
| `HOST` | `127.0.0.1` | Bind-Adresse (VPS: `0.0.0.0`) |
| `PORT` | `8787` | Port des Orchestrators |
| `DATABASE_PATH` | `./data/orchestrator.db` | SQLite-Datei (relativ zum Aufrufverzeichnis) |
| `DATA_DIR` | `./data` | Datenverzeichnis (Logs, Codex-Ausgaben) |
| `LINEAR_API_KEY` | – | Linear Personal API Key (nur lesend genutzt) |
| `LINEAR_WRITE_COMMENTS` | `false` | Wenn `true`, darf ein Abschlusskommentar nach Linear geschrieben werden |
| `REPO_ROOT` / `WORKTREE_ROOT` | – | Vorschlagswerte für neue Projekte |
| `BASE_BRANCH` | `main` | Standard-Basisbranch |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | Pfad/Name der CLIs |
| `CLAUDE_MODEL` / `CODEX_MODEL` | – | Optionale Modell-Overrides |
| `CLAUDE_MAX_BUDGET_USD` | – | Optionales Kostenlimit pro Claude-Aufruf |
| `MAX_REVIEW_LOOPS` | `3` | Maximale Nacharbeitsschleifen |
| `MAX_JOB_RUNTIME_MINUTES` | `60` | Hartes Job-Zeitlimit |
| `MAX_AGENT_OUTPUT_MB` | `10` | Obergrenze erfasster Agentenausgabe |
| `MAX_CONCURRENT_JOBS` | `1` | Gleichzeitig laufende Jobs |
| `TEST_COMMAND_TIMEOUT_MINUTES` | `10` | Timeout je Prüfbefehl |
| `LOG_LEVEL` | `info` | Pino-Loglevel |

### Linear-API-Key

Einen Personal API Key unter **Linear → Settings → Security & access → Personal API keys**
erstellen und als `LINEAR_API_KEY` setzen. Der Key wird nur für lesende Abfragen (`issue(...)`)
verwendet und **niemals an Kindprozesse (Claude/Codex/Testbefehle) weitergegeben**. Import per
Identifier, z. B. `APP-123`.

### Claude-Code- und Codex-Konfiguration

Die Adapter rufen die installierten CLIs sandboxed auf (verifiziert gegen Claude CLI 2.1.x /
Codex CLI 0.144.x, siehe ADR-015):

- **Claude (Plan/Review, strikt lesend)**
  `claude -p --output-format json --tools "Read,Glob,Grep" --permission-mode plan --no-session-persistence [--model …] [--max-budget-usd …]`
- **Codex (Implementierung/Nacharbeit)**
  `codex exec --sandbox workspace-write -C <worktree> --ephemeral --ignore-user-config --color never …`

Es werden **keine** Sandbox-/Freigabe-umgehenden Flags genutzt
(`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`). Auf einem
headless VPS die CLIs zuvor authentifizieren (Claude: `ANTHROPIC_API_KEY` bzw. `claude`-Login;
Codex: `~/.codex/auth.json`). Nur die für die Authentifizierung nötigen Variablen sind in der
Env-Whitelist für Kindprozesse enthalten.

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

- **Prompt-Injection**: Untrusted-Inhalte werden in Prompts klar als Daten gerahmt; Instruktionen kommen nur vom Orchestrator; das Review-`VERDICT` wird strikt aus den ersten Zeilen geparst (mehrdeutig ⇒ `needs_human`, nie stilles Rework).
- **Prozessausführung**: `spawn` ohne Shell, getrennte Argumente, explizites Arbeitsverzeichnis, gefilterte Env-Whitelist, Timeouts, Ausgabe-Obergrenze (Kopf + Tail), Prozessgruppen-Kill (SIGTERM → SIGKILL).
- **Git**: Push, Merge, Force-Push und Branch-Löschung existieren im Code nicht. Commits nur im Worktree mit Identität aus Umgebungsvariablen — die globale Git-Konfiguration bleibt unangetastet. `.agent/` (PLAN/REVIEW) ist von Commits/Diffs/Status per Pathspec ausgeschlossen.
- **Sandbox**: Codex läuft in `workspace-write` (nur der Worktree ist schreibbar; Netzwerk aus); Claude strikt lesend. Keine Bypass-Flags. Agenten lesen keine SSH-Schlüssel, Browserprofile oder Home-Verzeichnisse — die Env-Whitelist und die Sandbox verhindern dies.
- **Pfadvalidierung**: Ticket-Identifier per Regex; Worktree-Pfade müssen innerhalb des konfigurierten Worktree-Roots liegen; Löschungen nie außerhalb.
- **Linear**: nur lesend; Kommentare ausschließlich hinter `LINEAR_WRITE_COMMENTS=true`.
- **UI**: Markdown wird mit DOMPurify sanitisiert gerendert.

## Backup

Der gesamte veränderliche Zustand liegt unter `DATA_DIR` (Standard `./data`):

- `orchestrator.db` (+ `-wal`/`-shm`) — Projekte, Tickets, Jobs, Events, Artefakte.
- `logs/<jobId>.ndjson` — Live-Logs.

Backup bei gestopptem Orchestrator per Kopie des `data/`-Verzeichnisses, oder online mit
`sqlite3 data/orchestrator.db ".backup data/backup.db"`. Die Git-Worktrees selbst liegen im
konfigurierten `worktreeRoot` und lassen sich aus dem Repository jederzeit neu erzeugen.

## Fehlerbehebung

- **`rtk gain`/Corepack-Fehler**: `corepack enable` erneut ausführen; bei Node ≥ 25 `npm i -g pnpm@10`.
- **`better-sqlite3` baut aus Quellen / Install-Script blockiert**: sicherstellen, dass `better-sqlite3` unter `onlyBuiltDependencies` in `pnpm-workspace.yaml` steht (bereits konfiguriert), dann `pnpm rebuild better-sqlite3`.
- **Import schlägt fehl (`LINEAR_ERROR`)**: `LINEAR_API_KEY` gesetzt? Identifier korrekt (`APP-123`)?
- **Job endet sofort `failed` mit „Ungültiger Ticket-Identifier"**: Identifier muss dem Muster `ABC-123` entsprechen.
- **Job „Durch Neustart unterbrochen"**: Der Orchestrator wurde während eines Laufs beendet; per **Erneut** neu starten.
- **Agent hängt / Zeitlimit**: `MAX_JOB_RUNTIME_MINUTES` bzw. `TEST_COMMAND_TIMEOUT_MINUTES` prüfen; der Job wird beim Limit hart beendet.
- **WebSocket „closed"**: Der Client reconnectet automatisch und lädt danach den Zustand neu; Board bleibt konsistent.
- **CLIs nicht gefunden**: `CLAUDE_BIN`/`CODEX_BIN` auf absolute Pfade setzen.

## Bekannte Einschränkungen

- Keine eingebaute Authentifizierung/Mandantentrennung — für lokalen Betrieb bzw. hinter Reverse-Proxy gedacht.
- Job-Queue ist in-process (kein verteiltes Scheduling); Standard-Parallelität 1, pro Projekt ein Schreibjob.
- Kein automatischer Merge/PR — bewusst; der erzeugte Branch bleibt zur manuellen Prüfung stehen.
- Windows wird nicht offiziell unterstützt (Prozessgruppen-Semantik ist POSIX; macOS/Linux getestet).
- Der Linear-Sync ist ein Import-Snapshot (Re-Import aktualisiert), kein kontinuierlicher Live-Sync.

## Hermes-Integration (geplant)

Die Agentenschicht ist über ein schmales `AgentAdapter`-Interface abstrahiert
(`execute()` / `cancel()`), das aktuell `ClaudeCodeAdapter` und `CodexCliAdapter` implementieren.
Hermes ist als übergeordnete Bedien- und Delegationsschicht vorgesehen: Ein künftiger
`HermesAdapter` (bzw. Hermes-Skill) tritt an dieselbe Stelle und ersetzt die direkten CLI-Aufrufe,
ohne dass Pipeline, Queue oder State Machine sich ändern.

**Grenze (unveränderlich):** Hermes darf — wie die anderen Agenten — **nicht** über
Statuswechsel, Merge oder Review-Limits entscheiden. Diese Entscheidungen bleiben ausschließlich
bei der deterministischen Workflow-Engine. Der geplante Hermes-Skill kapselt lediglich die
Ausführung eines Plan-/Implementierungs-/Review-Schritts und liefert ein Ergebnis zurück; die
Interpretation (PASS/FAIL, Schleifenzählung, Zustandsübergang) verbleibt im Orchestrator.
