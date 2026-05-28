import { test, expect } from "@playwright/test";

/*
 * Postgres setup flow — opt-in e2e.
 *
 * This spec is skipped unless KUMA_PG_E2E=1 and a target Postgres is
 * reachable. The expected env vars when opted in:
 *
 *   KUMA_PG_E2E=1
 *   KUMA_PG_HOST=localhost
 *   KUMA_PG_PORT=5432
 *   KUMA_PG_DB=kuma_e2e
 *   KUMA_PG_USER=postgres
 *   KUMA_PG_PASSWORD=postgres
 *
 * The target Postgres database MUST be empty (no tables). The spec
 * does not roll back; clean up between runs.
 *
 * Run with:
 *   KUMA_PG_E2E=1 KUMA_PG_HOST=... npx playwright test setup-postgres
 */

const optedIn = process.env.KUMA_PG_E2E === "1";

test.describe("Postgres setup (opt-in)", () => {
    test.skip(!optedIn, "Set KUMA_PG_E2E=1 (and KUMA_PG_HOST/PORT/DB/USER/PASSWORD) to run this spec");

    test("setup picks Postgres, fills fields, and proceeds", async ({ page }) => {
        await page.goto("./");
        await page.getByText("PostgreSQL").click();

        // Fill the fields path (not connection string)
        await page.locator('label:has-text("Hostname") >> .. >> input').fill(process.env.KUMA_PG_HOST || "localhost");
        await page.locator('label:has-text("Port") >> .. >> input').fill(process.env.KUMA_PG_PORT || "5432");
        await page.locator('label:has-text("Username") >> .. >> input').fill(process.env.KUMA_PG_USER || "postgres");
        await page.locator('label:has-text("Password") >> .. >> input').fill(process.env.KUMA_PG_PASSWORD || "postgres");
        await page.locator('label:has-text("dbName") >> .. >> input, label:has-text("Database Name") >> .. >> input').first().fill(process.env.KUMA_PG_DB || "kuma_e2e");

        // Set SSL mode to disable for local containers (default is "require")
        await page.locator("#pgSslMode").selectOption("disable");

        await page.getByRole("button", { name: "Next" }).click();

        // The setup endpoint usually redirects to /setup once the server is ready
        await page.waitForURL("**/setup", { timeout: 30000 });
        await expect(page).toHaveURL(/setup/);
    });
});
