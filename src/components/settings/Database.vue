<template>
    <div class="db-panel">
        <header class="db-header">
            <h2 class="db-title">{{ $t("Database") }}</h2>
            <p class="db-subtitle">
                {{ $t("databasePanelSubtitle") }}
            </p>
        </header>

        <section class="db-section">
            <div class="db-section-label">{{ $t("Status") }}</div>
            <dl class="db-status">
                <dt>{{ $t("Active backend") }}</dt>
                <dd>
                    <span class="db-chip" :data-kind="$root.info.dbType">
                        {{ $root.info.dbType || "—" }}
                    </span>
                </dd>

                <template v-if="databaseSize !== null">
                    <dt>{{ $t("Size on disk") }}</dt>
                    <dd class="db-mono">{{ formatBytes(databaseSize) }}</dd>
                </template>
            </dl>
        </section>

        <section v-if="$root.info.dbType === 'sqlite'" class="db-section">
            <div class="db-section-label">{{ $t("Migrate to PostgreSQL") }}</div>
            <p class="db-section-intro">
                {{ $t("migrateToPostgresIntro") }}
            </p>

            <fieldset class="db-fieldset" :disabled="migrating">
                <div class="db-field db-field--full">
                    <span class="db-field-label">{{ $t("Input mode") }}</span>
                    <div class="db-segmented" role="tablist">
                        <button
                            type="button"
                            role="tab"
                            :aria-selected="!form.useConnectionString"
                            :class="{ active: !form.useConnectionString }"
                            @click="form.useConnectionString = false"
                        >
                            {{ $t("Fields") }}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            :aria-selected="form.useConnectionString"
                            :class="{ active: form.useConnectionString }"
                            @click="form.useConnectionString = true"
                        >
                            {{ $t("Connection URL") }}
                        </button>
                    </div>
                </div>

                <div v-if="form.useConnectionString" class="db-field db-field--full">
                    <label class="db-field-label" for="pgUrlField">DATABASE_URL</label>
                    <textarea
                        id="pgUrlField"
                        v-model="form.url"
                        class="db-input db-mono"
                        rows="2"
                        spellcheck="false"
                        placeholder="postgres://user:pass@host:5432/db"
                    />
                </div>

                <template v-else>
                    <div class="db-field">
                        <label class="db-field-label" for="pgHost">{{ $t("Hostname") }}</label>
                        <input id="pgHost" v-model="form.hostname" class="db-input" autocomplete="off" placeholder="db.internal" />
                    </div>
                    <div class="db-field db-field--split">
                        <div>
                            <label class="db-field-label" for="pgPort">{{ $t("Port") }}</label>
                            <input id="pgPort" v-model="form.port" class="db-input db-mono" placeholder="5432" />
                        </div>
                        <div>
                            <label class="db-field-label" for="pgDb">{{ $t("dbName") }}</label>
                            <input id="pgDb" v-model="form.dbName" class="db-input db-mono" placeholder="kuma" />
                        </div>
                    </div>
                    <div class="db-field">
                        <label class="db-field-label" for="pgUser">{{ $t("Username") }}</label>
                        <input id="pgUser" v-model="form.username" class="db-input" autocomplete="off" />
                    </div>
                    <div class="db-field">
                        <label class="db-field-label" for="pgPass">{{ $t("Password") }}</label>
                        <input id="pgPass" v-model="form.password" type="password" class="db-input" autocomplete="new-password" />
                    </div>
                </template>

                <hr class="db-rule" />

                <div class="db-field db-field--split">
                    <div>
                        <label class="db-field-label" for="pgSslMode">{{ $t("postgresSslMode") }}</label>
                        <select id="pgSslMode" v-model="form.sslMode" class="db-input">
                            <option value="disable">disable</option>
                            <option value="require">require</option>
                            <option value="verify-ca">verify-ca</option>
                            <option value="verify-full">verify-full</option>
                        </select>
                    </div>
                    <div v-if="form.sslMode === 'verify-ca' || form.sslMode === 'verify-full'">
                        <span class="db-field-label">{{ $t("postgresCaCertificateLabel") }}</span>
                        <span class="db-field-hint">{{ $t("PEM block required for verify-* modes") }}</span>
                    </div>
                </div>

                <div
                    v-if="form.sslMode === 'verify-ca' || form.sslMode === 'verify-full'"
                    class="db-field db-field--full"
                >
                    <textarea
                        v-model="form.ca"
                        class="db-input db-mono db-input--mono-block"
                        rows="4"
                        spellcheck="false"
                        placeholder="-----BEGIN CERTIFICATE-----"
                    />
                </div>
            </fieldset>

            <div class="db-actions">
                <button
                    type="button"
                    class="db-btn db-btn--ghost"
                    :disabled="busy || !canTest"
                    @click="testConnection"
                >
                    <span v-if="testing" class="db-spinner" aria-hidden="true" />
                    {{ testing ? $t("Testing...") : $t("Test connection") }}
                </button>

                <button
                    type="button"
                    class="db-btn db-btn--primary"
                    :disabled="busy || !canMigrate"
                    @click="confirmMigrate"
                >
                    {{ $t("Begin migration") }}
                    <span class="db-arrow" aria-hidden="true">→</span>
                </button>
            </div>

            <p class="db-caption">
                {{ $t("migrateCaption") }}
            </p>

            <div v-if="testResult" class="db-test-result" :data-state="testResult.ok ? 'ok' : 'fail'">
                <span class="db-dot" />
                <span v-if="testResult.ok">{{ $t("Connection OK") }}</span>
                <span v-else>{{ testResult.error }}</span>
            </div>

            <div v-if="progress" class="db-progress">
                <div class="db-stepper">
                    <div
                        v-for="(step, i) in steps"
                        :key="step.key"
                        class="db-step"
                        :data-state="stepState(i)"
                    >
                        <span class="db-step-dot" />
                        <span class="db-step-label">{{ step.label }}</span>
                        <span v-if="i < steps.length - 1" class="db-step-line" />
                    </div>
                </div>

                <div v-if="progress.phase === 'copy' && progress.table" class="db-copy-detail">
                    <span class="db-copy-table db-mono">{{ progress.table }}</span>
                    <span class="db-copy-count db-mono">
                        {{ progress.rowsCopied || 0 }} / {{ progress.rowsTotal || 0 }}
                    </span>
                    <div class="db-copy-bar">
                        <div
                            class="db-copy-bar-fill"
                            :style="{ width: copyPercent + '%' }"
                        />
                    </div>
                </div>

                <div v-if="progress.phase === 'done'" class="db-progress-done">
                    {{ $t("Migration complete — restarting server") }}
                </div>
            </div>
        </section>

        <section v-else class="db-section">
            <div class="db-section-label">{{ $t("Migration") }}</div>
            <p class="db-section-intro">
                {{ $t("currentDbNotSqliteMigrationHidden") }}
            </p>
        </section>
    </div>
</template>

<script>
export default {
    data() {
        return {
            form: {
                useConnectionString: false,
                url: "",
                hostname: "",
                port: "5432",
                username: "",
                password: "",
                dbName: "kuma",
                sslMode: "require",
                ca: "",
            },
            busy: false,
            testing: false,
            migrating: false,
            progress: null,
            testResult: null,
            databaseSize: null,
            steps: [
                { key: "schema", label: "schema" },
                { key: "copy", label: "copy" },
                { key: "sequences", label: "sequences" },
                { key: "done", label: "done" },
            ],
        };
    },
    computed: {
        canTest() {
            return this.canMigrate;
        },
        canMigrate() {
            if (this.form.useConnectionString) return !!this.form.url.trim();
            return !!(this.form.hostname && this.form.username && this.form.dbName);
        },
        copyPercent() {
            if (!this.progress || !this.progress.rowsTotal) return 0;
            return Math.min(100, Math.round((this.progress.rowsCopied / this.progress.rowsTotal) * 100));
        },
    },
    mounted() {
        this.$root.getSocket().on("dbMigrationProgress", this.onProgress);
        this.loadDatabaseSize();
    },
    beforeUnmount() {
        this.$root.getSocket().off("dbMigrationProgress", this.onProgress);
    },
    methods: {
        loadDatabaseSize() {
            this.$root.getSocket().emit("getDatabaseSize", (res) => {
                if (res && res.ok) this.databaseSize = res.size;
            });
        },
        formatBytes(n) {
            if (!Number.isFinite(n)) return "—";
            const units = ["B", "KB", "MB", "GB", "TB"];
            let i = 0;
            let v = n;
            while (v >= 1024 && i < units.length - 1) {
                v /= 1024;
                i++;
            }
            return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
        },
        stepState(i) {
            if (!this.progress) return "idle";
            const currentIdx = this.steps.findIndex(s => s.key === this.progress.phase);
            if (currentIdx === -1) return "idle";
            if (i < currentIdx) return "done";
            if (i === currentIdx) return "active";
            return "pending";
        },
        buildConfig() {
            const cfg = { type: "postgres", sslMode: this.form.sslMode };
            if (this.form.useConnectionString) cfg.url = this.form.url;
            else {
                cfg.hostname = this.form.hostname;
                cfg.port = this.form.port;
                cfg.username = this.form.username;
                cfg.password = this.form.password;
                cfg.dbName = this.form.dbName;
            }
            if (cfg.sslMode === "verify-ca" || cfg.sslMode === "verify-full") cfg.ca = this.form.ca;
            return cfg;
        },
        testConnection() {
            this.busy = true;
            this.testing = true;
            this.testResult = null;
            this.$root.getSocket().emit("testDbConnection", this.buildConfig(), (res) => {
                this.busy = false;
                this.testing = false;
                if (res && res.ok) {
                    this.testResult = { ok: true };
                    this.$root.toastSuccess(this.$t("Connection OK"));
                } else {
                    const err = (res && res.error) || "unknown";
                    this.testResult = { ok: false, error: err };
                    this.$root.toastError(this.$t("Connection failed") + ": " + err);
                }
            });
        },
        confirmMigrate() {
            if (!confirm(this.$t("Migration will restart the server. Continue?"))) return;
            this.busy = true;
            this.migrating = true;
            this.progress = { phase: "schema" };
            this.testResult = null;
            this.$root.getSocket().emit("migrateToPostgres", this.buildConfig(), (res) => {
                this.busy = false;
                this.migrating = false;
                if (!res || !res.ok) {
                    this.$root.toastError(this.$t("Migration failed") + ": " + ((res && res.error) || "unknown"));
                    this.progress = null;
                }
            });
        },
        onProgress(p) {
            this.progress = p;
        },
    },
};
</script>

<style scoped>
/* ---------- tokens ---------- */
.db-panel {
    --db-fg: var(--bs-body-color, #1f2328);
    --db-fg-muted: color-mix(in oklch, var(--db-fg), transparent 45%);
    --db-fg-subtle: color-mix(in oklch, var(--db-fg), transparent 65%);
    --db-bg: var(--bs-body-bg, #ffffff);
    --db-border: color-mix(in oklch, var(--db-fg), transparent 86%);
    --db-border-strong: color-mix(in oklch, var(--db-fg), transparent 75%);
    --db-surface: color-mix(in oklch, var(--db-fg), var(--db-bg) 96%);
    --db-accent: oklch(0.65 0.18 60);          /* amber — destructive-intended action */
    --db-accent-fg: oklch(0.99 0.02 90);
    --db-accent-soft: color-mix(in oklch, var(--db-accent), transparent 85%);
    --db-ok: oklch(0.65 0.18 155);
    --db-ok-soft: color-mix(in oklch, var(--db-ok), transparent 85%);
    --db-fail: oklch(0.6 0.21 25);
    --db-fail-soft: color-mix(in oklch, var(--db-fail), transparent 85%);
    --db-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;

    max-width: 760px;
    color: var(--db-fg);
    font-feature-settings: "ss01", "cv11";
}

.db-mono { font-family: var(--db-mono); font-size: 0.86em; }

/* ---------- header ---------- */
.db-header { margin: 0 0 2.5rem; }
.db-title {
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.015em;
    margin: 0 0 0.35rem;
}
.db-subtitle {
    margin: 0;
    color: var(--db-fg-muted);
    font-size: 0.92rem;
    line-height: 1.5;
}

/* ---------- sections ---------- */
.db-section {
    padding-top: 1.75rem;
    border-top: 1px solid var(--db-border);
    margin-top: 1.75rem;
}
.db-section:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }

.db-section-label {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--db-fg-subtle);
    margin-bottom: 1.25rem;
}
.db-section-intro {
    color: var(--db-fg-muted);
    font-size: 0.92rem;
    line-height: 1.55;
    margin: -0.5rem 0 1.5rem;
    max-width: 56ch;
}

/* ---------- status ---------- */
.db-status {
    display: grid;
    grid-template-columns: 11rem 1fr;
    gap: 0.6rem 1.5rem;
    margin: 0;
    font-size: 0.92rem;
}
.db-status dt {
    color: var(--db-fg-muted);
    font-weight: 400;
}
.db-status dd {
    margin: 0;
    color: var(--db-fg);
}

.db-chip {
    display: inline-block;
    font-family: var(--db-mono);
    font-size: 0.78rem;
    padding: 0.15rem 0.55rem;
    border-radius: 3px;
    background: var(--db-surface);
    border: 1px solid var(--db-border);
    line-height: 1.6;
}
.db-chip[data-kind="sqlite"]   { color: oklch(0.58 0.13 250); border-color: color-mix(in oklch, oklch(0.58 0.13 250), transparent 70%); }
.db-chip[data-kind="postgres"] { color: oklch(0.55 0.13 195); border-color: color-mix(in oklch, oklch(0.55 0.13 195), transparent 70%); }
.db-chip[data-kind="mariadb"], .db-chip[data-kind="embedded-mariadb"] {
    color: oklch(0.55 0.13 35); border-color: color-mix(in oklch, oklch(0.55 0.13 35), transparent 70%);
}

/* ---------- form layout ---------- */
.db-fieldset {
    border: 0;
    padding: 0;
    margin: 0 0 1.5rem;
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
}
.db-fieldset[disabled] { opacity: 0.55; pointer-events: none; }

.db-field { display: grid; grid-template-columns: 11rem 1fr; gap: 0.5rem 1.5rem; align-items: start; }
.db-field--full { grid-template-columns: 1fr; }
.db-field--split { grid-template-columns: 11rem 1fr; }
.db-field--split > div:first-child { grid-column: 1; }
.db-field--split > div:last-child  { grid-column: 2; display: grid; grid-template-columns: 8rem 1fr; gap: 0.5rem 1rem; }

.db-field-label {
    font-size: 0.82rem;
    color: var(--db-fg-muted);
    padding-top: 0.5rem;
    font-weight: 500;
}
.db-field-hint {
    display: block;
    font-size: 0.75rem;
    color: var(--db-fg-subtle);
    margin-top: 0.15rem;
}

/* ---------- inputs ---------- */
.db-input,
select.db-input,
textarea.db-input {
    width: 100%;
    background: var(--db-bg);
    color: var(--db-fg);
    border: 1px solid var(--db-border);
    border-radius: 4px;
    padding: 0.5rem 0.65rem;
    font-size: 0.9rem;
    line-height: 1.4;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    appearance: none;
    font-family: inherit;
}
.db-input:hover { border-color: var(--db-border-strong); }
.db-input:focus {
    outline: none;
    border-color: var(--db-fg);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--db-fg), transparent 88%);
}
.db-input--mono-block { line-height: 1.55; }

select.db-input {
    background-image: linear-gradient(45deg, transparent 50%, var(--db-fg-muted) 50%),
                      linear-gradient(135deg, var(--db-fg-muted) 50%, transparent 50%);
    background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%;
    background-size: 5px 5px;
    background-repeat: no-repeat;
    padding-right: 2rem;
}

/* ---------- segmented control ---------- */
.db-segmented {
    display: inline-flex;
    border: 1px solid var(--db-border);
    border-radius: 4px;
    background: var(--db-surface);
    padding: 2px;
    width: fit-content;
}
.db-segmented button {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 0.35rem 0.9rem;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--db-fg-muted);
    border-radius: 3px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
    font-family: inherit;
}
.db-segmented button:hover { color: var(--db-fg); }
.db-segmented button.active {
    background: var(--db-bg);
    color: var(--db-fg);
    box-shadow: 0 0 0 1px var(--db-border-strong);
}

/* ---------- rule ---------- */
.db-rule {
    grid-column: 1 / -1;
    height: 1px;
    border: 0;
    background: var(--db-border);
    margin: 0.25rem 0;
}

/* ---------- actions ---------- */
.db-actions {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin-bottom: 0.4rem;
}
.db-btn {
    appearance: none;
    border: 1px solid var(--db-border);
    background: var(--db-bg);
    color: var(--db-fg);
    padding: 0.5rem 0.95rem;
    font-size: 0.88rem;
    font-weight: 500;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    font-family: inherit;
}
.db-btn:hover:not(:disabled) { background: var(--db-surface); border-color: var(--db-border-strong); }
.db-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.db-btn--ghost { /* default style above */ }
.db-btn--primary {
    background: var(--db-accent);
    color: var(--db-accent-fg);
    border-color: var(--db-accent);
}
.db-btn--primary:hover:not(:disabled) {
    background: color-mix(in oklch, var(--db-accent), black 8%);
    border-color: color-mix(in oklch, var(--db-accent), black 8%);
}
.db-arrow {
    font-size: 1.05em;
    transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.db-btn--primary:not(:disabled):hover .db-arrow { transform: translateX(2px); }

.db-caption {
    font-size: 0.78rem;
    color: var(--db-fg-subtle);
    margin: 0 0 0.5rem;
    line-height: 1.5;
}

/* ---------- spinner ---------- */
.db-spinner {
    display: inline-block;
    width: 0.85em; height: 0.85em;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: db-spin 0.7s linear infinite;
}
@keyframes db-spin { to { transform: rotate(360deg); } }

/* ---------- test result inline ---------- */
.db-test-result {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.85rem;
    margin-top: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    border: 1px solid;
    font-variant-numeric: tabular-nums;
}
.db-test-result[data-state="ok"]   { color: var(--db-ok);   border-color: var(--db-ok-soft);   background: color-mix(in oklch, var(--db-ok), transparent 94%); }
.db-test-result[data-state="fail"] { color: var(--db-fail); border-color: var(--db-fail-soft); background: color-mix(in oklch, var(--db-fail), transparent 94%); }
.db-test-result .db-dot {
    width: 0.5rem; height: 0.5rem; border-radius: 50%;
    background: currentColor;
}

/* ---------- progress stepper ---------- */
.db-progress {
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px dashed var(--db-border);
}
.db-stepper {
    display: flex;
    align-items: center;
    gap: 0;
    font-size: 0.78rem;
    color: var(--db-fg-subtle);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
}
.db-step {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex: 0 0 auto;
    position: relative;
}
.db-step-dot {
    width: 0.55rem; height: 0.55rem;
    border-radius: 50%;
    background: var(--db-surface);
    border: 1.5px solid var(--db-border-strong);
    flex-shrink: 0;
    transition: background 200ms ease, border-color 200ms ease, transform 200ms ease;
}
.db-step-line {
    width: 2rem;
    height: 1px;
    background: var(--db-border);
    margin: 0 0.75rem;
    flex-shrink: 0;
}
.db-step[data-state="active"] {
    color: var(--db-accent);
}
.db-step[data-state="active"] .db-step-dot {
    background: var(--db-accent);
    border-color: var(--db-accent);
    transform: scale(1.15);
    box-shadow: 0 0 0 4px var(--db-accent-soft);
}
.db-step[data-state="done"] {
    color: var(--db-ok);
}
.db-step[data-state="done"] .db-step-dot {
    background: var(--db-ok);
    border-color: var(--db-ok);
}

.db-copy-detail {
    margin-top: 1rem;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.25rem 1rem;
    align-items: center;
}
.db-copy-table { color: var(--db-fg); }
.db-copy-count { color: var(--db-fg-muted); font-variant-numeric: tabular-nums; }
.db-copy-bar {
    grid-column: 1 / -1;
    height: 2px;
    background: var(--db-border);
    border-radius: 1px;
    overflow: hidden;
}
.db-copy-bar-fill {
    height: 100%;
    background: var(--db-accent);
    transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.db-progress-done {
    margin-top: 1rem;
    font-size: 0.88rem;
    color: var(--db-ok);
}

/* ---------- responsive ---------- */
@media (max-width: 540px) {
    .db-status,
    .db-field,
    .db-field--split,
    .db-field--split > div:last-child {
        grid-template-columns: 1fr;
        gap: 0.35rem;
    }
    .db-field-label { padding-top: 0; }
}

/* ---------- reduced motion ---------- */
@media (prefers-reduced-motion: reduce) {
    .db-spinner,
    .db-step-dot,
    .db-arrow,
    .db-copy-bar-fill,
    .db-input,
    .db-btn { transition: none; animation: none; }
}
</style>
