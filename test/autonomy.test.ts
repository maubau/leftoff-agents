import { ok } from "node:assert/strict";
import { test } from "node:test";
import { looksIrreversible } from "../src/hub/autonomy.ts";

test("destructive, irreversible or costly instructions are recognised in every language", () => {
  for (const text of [
    "Force-push the rebased branch to origin",
    "git push --force origin main",
    "Run git reset --hard origin/main and rm -rf dist",
    "Delete the old release branches",
    "Drop table bookings and recreate it",
    "Deploy the new version to production",
    "npm publish the package",
    "Buy the domain harbor.example",
    "Elimina il branch feat/old e cancella i dati di test del database",
    "Rilascia in produzione la versione 2",
    "Lösche den Branch und die Datenbank",
    "Supprime la branche et déploie en production",
    "Borra la rama vieja",
    "Apague o banco de dados",
    "Upgrade the plan to Pro",
  ]) ok(looksIrreversible(text), text);
});

test("everyday instructions are not taken for destructive ones", () => {
  for (const text of [
    "Rebase your branch on main and open a PR",
    "Add a payload field to the webhook",
    "Aggiungi la pagina di pagamento con il form",
    "Fix the failing test in bookings.test.ts",
    "Remove the unused import in app.js",
    "Merge PR 12 into main after CI is green",
    "Write the setup guide and push your branch",
    "Implementa il deploy script ma non lanciarlo",
  ]) ok(!looksIrreversible(text), text);
});
