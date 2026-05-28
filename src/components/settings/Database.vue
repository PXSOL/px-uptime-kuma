<template>
    <div>
        <h4>{{ $t("Database") }}</h4>
        <div class="my-3">
            <strong>{{ $t("Current type") }}:</strong> {{ $root.info.dbType }}
        </div>

        <div v-if="$root.info.dbType === 'sqlite'" class="card">
            <div class="card-body">
                <h5 class="card-title">{{ $t("Migrate to PostgreSQL") }}</h5>
                <p class="card-text text-muted">
                    {{ $t("migrateToPostgresIntro") }}
                </p>

                <div class="form-check form-switch ps-0 mb-2">
                    <input id="useUrl" v-model="form.useConnectionString" type="checkbox" role="switch" class="form-check-input ms-0 me-2" />
                    <label class="form-check-label" for="useUrl">{{ $t("postgresUseConnectionString") }}</label>
                </div>

                <div v-if="form.useConnectionString" class="mb-2">
                    <textarea v-model="form.url" class="form-control" placeholder="postgres://user:pass@host/db" rows="2" />
                </div>
                <template v-else>
                    <input v-model="form.hostname" class="form-control mb-2" :placeholder="$t('Hostname')" />
                    <input v-model="form.port" class="form-control mb-2" placeholder="5432" />
                    <input v-model="form.username" class="form-control mb-2" :placeholder="$t('Username')" />
                    <input v-model="form.password" type="password" class="form-control mb-2" :placeholder="$t('Password')" />
                    <input v-model="form.dbName" class="form-control mb-2" :placeholder="$t('dbName')" />
                </template>

                <select v-model="form.sslMode" class="form-select mb-2">
                    <option value="disable">disable</option>
                    <option value="require">require</option>
                    <option value="verify-ca">verify-ca</option>
                    <option value="verify-full">verify-full</option>
                </select>

                <div v-if="form.sslMode === 'verify-ca' || form.sslMode === 'verify-full'" class="mb-2">
                    <textarea v-model="form.ca" class="form-control" :placeholder="$t('postgresCaCertificateLabel')" rows="3" />
                </div>

                <div class="d-flex gap-2 mt-3">
                    <button class="btn btn-outline-secondary" :disabled="busy" @click="testConnection">
                        {{ $t("Test connection") }}
                    </button>
                    <button class="btn btn-primary" :disabled="busy || !canMigrate" @click="confirmMigrate">
                        {{ $t("Start migration") }}
                    </button>
                </div>

                <div v-if="progress" class="mt-3">
                    <div><strong>{{ $t("Progress") }}:</strong> {{ progress.phase }}{{ progress.table ? " — " + progress.table : "" }}</div>
                    <div v-if="progress.rowsTotal" class="progress mt-1">
                        <div
                            class="progress-bar"
                            role="progressbar"
                            :style="{ width: ((progress.rowsCopied / progress.rowsTotal) * 100) + '%' }"
                        />
                    </div>
                </div>
            </div>
        </div>

        <div v-else class="alert alert-info">
            {{ $t("currentDbNotSqliteMigrationHidden") }}
        </div>
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
            progress: null,
        };
    },
    computed: {
        canMigrate() {
            if (this.form.useConnectionString) return !!this.form.url.trim();
            return !!(this.form.hostname && this.form.username && this.form.dbName);
        },
    },
    mounted() {
        this.$root.getSocket().on("dbMigrationProgress", this.onProgress);
    },
    beforeUnmount() {
        this.$root.getSocket().off("dbMigrationProgress", this.onProgress);
    },
    methods: {
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
            this.$root.getSocket().emit("testDbConnection", this.buildConfig(), (res) => {
                this.busy = false;
                if (res && res.ok) this.$root.toastSuccess(this.$t("Connection OK"));
                else this.$root.toastError(this.$t("Connection failed") + ": " + ((res && res.error) || "unknown"));
            });
        },
        confirmMigrate() {
            if (!confirm(this.$t("Migration will restart the server. Continue?"))) return;
            this.busy = true;
            this.progress = { phase: "starting" };
            this.$root.getSocket().emit("migrateToPostgres", this.buildConfig(), (res) => {
                this.busy = false;
                if (!res || !res.ok) this.$root.toastError(this.$t("Migration failed") + ": " + ((res && res.error) || "unknown"));
            });
        },
        onProgress(p) {
            this.progress = p;
        },
    },
};
</script>
