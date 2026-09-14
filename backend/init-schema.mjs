#!/usr/bin/env node
/**
 * Yakfal Hub - automated PocketBase schema initializer.
 *
 * Reads ./pb_schema.json and, using the PocketBase Admin API,
 * idempotently creates/updates the required collections.
 * Relation fields reference other collections by NAME in the manifest;
 * the script resolves them to collection ids before creating.
 *
 * Env:
 *   POCKETBASE_URL            default http://127.0.0.1:8090
 *   POCKETBASE_ADMIN_EMAIL    superuser email          (required)
 *   POCKETBASE_ADMIN_PASSWORD superuser password       (required)
 *   DRY_RUN=1                 print the plan without hitting the API
 *
 * Usage (from Windows against the deployed server):
 *   set POCKETBASE_ADMIN_EMAIL=you@example.com
 *   set POCKETBASE_ADMIN_PASSWORD=secret
 *   set POCKETBASE_URL=http://132.145.159.2:8090
 *   node init-schema.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(path.join(here, "pb_schema.json"), "utf8"));
const baseUrl = (process.env.POCKETBASE_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
const adminEmail = process.env.POCKETBASE_ADMIN_EMAIL;
const adminPass = process.env.POCKETBASE_ADMIN_PASSWORD;
const dryRun = process.env.DRY_RUN === "1";

if (!adminEmail || !adminPass) {
  console.error("Missing credentials. Set POCKETBASE_ADMIN_EMAIL and POCKETBASE_ADMIN_PASSWORD.");
  process.exit(1);
}

const log = (step, s) => console.log(`[${step}] ${s}`);

const REQUIRED_FIELD_TYPES = new Set([
  "text", "email", "url", "number", "bool", "date", "file", "select",
  "relation", "json", "editor", "autodate", "password",
]);

async function api(method, pathname, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const msg = json?.message || text || `HTTP ${res.status}`;
    log("ERROR", `${method} ${pathname} -> ${res.status}: ${msg}`);
    throw new Error(msg);
  }
  return json;
}

async function superuserLogin() {
  for (const authType of ["_superusers", "_admins"]) {
    try {
      const json = await api("POST", `/api/collections/${authType}/auth-with-password`, {
        identity: adminEmail,
        password: adminPass,
      });
      log("AUTH", `ok via /${authType} as ${json.record?.email || adminEmail}`);
      return json.token;
    } catch {
      // PB >= 0.23 uses _superusers, older uses _admins. Try the next one.
    }
  }
  throw new Error("Superuser login failed (email/password wrong, or no superuser seeded).");
}

async function listCollections(token) {
  const json = await api("GET", "/api/collections?page=1&perPage=200", undefined, token);
  return (json.items || []).map((c) => ({ id: c.id, name: c.name, fields: c.fields }));
}

function buildFields(fieldDefs, idByName) {
  return fieldDefs.map((f) => {
    const field = { ...f };
    if (field.collectionId) {
      const targetId = idByName.get(field.collectionId);
      if (!targetId) throw new Error(`schema: unknown relation target '${field.collectionId}' for '${field.name}'`);
      field.collectionId = targetId;
    }
    if (!field.type) throw new Error(`schema: field '${field.name}' missing type`);
    if (!REQUIRED_FIELD_TYPES.has(field.type)) {
      throw new Error(`schema: field '${field.name}' has unhandled type '${field.type}'`);
    }
    // PocketBase never accepts creation with a password field value; drop falsy config keys.
    for (const k of Object.keys(field)) {
      if (field[k] === undefined || field[k] === null) delete field[k];
    }
    return field;
  });
}

async function main() {
  log("SCHEMA", `collections: ${Object.keys(schema.collections).join(", ")}`);
  log("TARGET", baseUrl + (dryRun ? "  [DRY RUN]" : ""));

  const token = dryRun ? "dry-token" : await superuserLogin();
  const existingList = dryRun ? [] : await listCollections(token);
  const existingByName = new Map(existingList.map((c) => [c.name, c]));
  const idByName = new Map(existingList.map((c) => [c.name, c.id]));

  for (const [name, def] of Object.entries(schema.collections)) {
    const found = idByName.has(name);
    const payload = {
      name,
      type: def.type || (name === "users" ? "auth" : "base"),
      fields: buildFields(def.fields, idByName),
      options: def.options || {},
      ...(def.rules || {}),
    };

    if (found) {
      // Converge: append any schema fields the existing collection lacks
      // (e.g. PocketBase ships a default `users` auth collection without a
      //  `username` field — our manifest declares one) and align access rules.
      const existing = existingByName.get(name);
      const have = new Set((existing?.fields || []).map((f) => f.name));
      const missing = payload.fields.filter((f) => !have.has(f.name));
      const ruleKeys = Object.keys(def.rules || {});
      const ruleDiff = ruleKeys.filter((k) => existing && String(existing[k] ?? "") !== String(payload[k] ?? ""));
      if ((missing.length > 0 || ruleDiff.length > 0) && !dryRun) {
        const patchBody = {};
        if (missing.length > 0) patchBody.fields = [...(existing.fields || []), ...missing];
        if (ruleDiff.length > 0) for (const k of ruleKeys) patchBody[k] = payload[k];
        const patched = await api("PATCH", `/api/collections/${existing.id}`, patchBody, token);
        idByName.set(name, patched.id);
        log("PATCH", `${name} ${missing.length > 0 ? `+${missing.length} field${missing.length > 1 ? "s" : ""}: ${missing.map((f) => f.name).join(", ")}` : ""}${ruleDiff.length > 0 ? `${missing.length > 0 ? "; " : ""}rules: ${ruleDiff.join(", ")}` : ""}`);
      } else if (missing.length > 0 && dryRun) {
        log("PLAN", `patch '${name}' adding ${missing.map((f) => f.name).join(", ")}`);
      } else {
        log("SKIP", `${name} already exists`);
      }
      continue;
    }

    if (dryRun) {
      log("PLAN", `create '${name}' (type=${payload.type}, ${payload.fields.length} fields)`);
      continue;
    }

    const created = await api("POST", "/api/collections", payload, token);
    idByName.set(name, created.id);
    log("CREATE", `${name} (id=${created.id})`);
  }

  log("DONE", dryRun ? "dry-run plan printed; no changes made" : "collections ensured");
}

main().catch((err) => {
  console.error(`\nSchema init failed: ${err.message}`);
  process.exit(1);
});