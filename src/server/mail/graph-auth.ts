import { createHash } from "node:crypto";
import path from "node:path";
import { IDENTITY } from "../../shared/channel.ts";
import { prettyJson, readJson, writeFileAtomic } from "../core/fsx.ts";
import { integrationSecrets } from "../core/secrets.ts";
import { vaultRoot } from "../core/vault.ts";
import { appDataDir } from "../env.ts";
import { host } from "../host.ts";
import { browserCode, OAuthDenied } from "../integrations/oauth-loopback.ts";
import { IntegrationFailure } from "../integrations/registry.ts";
import { isAddress } from "./types.ts";

export type GraphScope = "Mail.Read" | "Mail.Send" | "Mail.ReadWrite";
export type GraphAccount = { key: string; name: string; email: string; scopes: GraphScope[] };
type LocalAccount = GraphAccount & { clientId: string; homeId: string };
type State = { version: 1; accounts: LocalAccount[] };
const service = `${IDENTITY.keychainService}-integrations`;
const authority = "https://login.microsoftonline.com/common";
const scopes: GraphScope[] = ["Mail.Read", "Mail.Send", "Mail.ReadWrite"];
const keyPattern = /^graph:[a-f0-9]{32}$/;
const clientPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const vaultId = () => {
  const root = path.resolve(vaultRoot());
  return createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
};
const file = () => path.join(appDataDir(), `graph-${vaultId()}.json`);
const secretId = (key: string) => `${vaultId()}/graph/${key}`;
let activeSignIn: AbortController | undefined;
const pending = new Map<string, Promise<unknown>>();

async function microsoftClient(clientId: string) {
  const { PublicClientApplication } = await import("@azure/msal-node");
  return new PublicClientApplication({ auth: { clientId, authority } });
}

function state(): State {
  const raw = readJson<State>(file(), { version: 1, accounts: [] });
  if (raw.version !== 1 || !Array.isArray(raw.accounts)) throw new IntegrationFailure("setup", "The local Microsoft connection file is unreadable.");
  const accounts = raw.accounts.filter((a) => a && keyPattern.test(a.key) && clientPattern.test(a.clientId) &&
    typeof a.name === "string" && typeof a.email === "string" && isAddress(a.email) &&
    typeof a.homeId === "string" && Array.isArray(a.scopes) && a.scopes.every((s) => scopes.includes(s)));
  return { version: 1, accounts };
}

function failAuth(error: unknown): IntegrationFailure {
  if (error instanceof IntegrationFailure) return error;
  if (error instanceof OAuthDenied) return new IntegrationFailure(error.admin ? "admin-consent" : "permission", error.message);
  const e = error as { errorCode?: string; errorMessage?: string };
  // MSAL error descriptions can include account data. Never expose them.
  if (/AADSTS(?:65001|65004|90094|900941|50105)/.test(e?.errorMessage ?? ""))
    return new IntegrationFailure("admin-consent", "Your organization may require an administrator to grant Microsoft Graph access.");
  if (e?.errorCode === "interaction_required" || e?.errorCode === "invalid_grant" || e?.errorCode === "no_tokens_found")
    return new IntegrationFailure("not-connected", "Reconnect this Microsoft account to renew its sign-in.");
  if (e?.errorCode === "network_error" || e?.errorCode === "post_request_failed")
    return new IntegrationFailure("offline", "Microsoft sign-in is temporarily unreachable.");
  return new IntegrationFailure("not-connected", "Microsoft sign-in failed. Check the desktop app registration and try again.");
}

function publicAccount({ key, name, email, scopes }: LocalAccount): GraphAccount {
  return { key, name, email, scopes };
}

export function graphAccounts(): GraphAccount[] {
  return state().accounts.map(publicAccount);
}

function getAccount(key: string): LocalAccount {
  const account = state().accounts.find((a) => a.key === key);
  if (!account) throw new IntegrationFailure("not-connected", "Connect this Microsoft account in Settings.");
  return account;
}

async function exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  pending.set(key, next);
  try { return await next; }
  finally { if (pending.get(key) === next) pending.delete(key); }
}

export async function graphToken(key: string, scope: GraphScope, signal?: AbortSignal): Promise<string> {
  return exclusive(key, async () => {
    signal?.throwIfAborted();
    const entry = getAccount(key);
    if (!entry.scopes.includes(scope)) throw new IntegrationFailure("permission", `Enable ${scope} for this account in Settings.`);
    try {
      const id = secretId(entry.key);
      const secrets = integrationSecrets();
      const stored = secrets.get(service, id);
      if (!stored) throw new IntegrationFailure("not-connected", "Reconnect this Microsoft account to renew its sign-in.");
      const client = await microsoftClient(entry.clientId);
      const cache = client.getTokenCache();
      cache.deserialize(stored);
      const account = await cache.getAccountByHomeId(entry.homeId);
      if (!account) throw new IntegrationFailure("not-connected", "Reconnect this Microsoft account to renew its sign-in.");
      const result = await client.acquireTokenSilent({ account, scopes: [scope] });
      const updated = cache.serialize();
      if (updated !== stored) secrets.set(service, id, updated);
      signal?.throwIfAborted();
      return result.accessToken;
    } catch (error) {
      signal?.throwIfAborted();
      throw failAuth(error);
    }
  });
}

export async function connectGraph(input: { clientId?: unknown; key?: unknown; scope?: unknown }, signal: AbortSignal): Promise<GraphAccount> {
  if (!host().available) throw new IntegrationFailure("unsupported", "Microsoft sign-in needs the Phaethon desktop app.");
  if (activeSignIn) throw new IntegrationFailure("restricted", "A Microsoft sign-in is already in progress.");
  const existing = typeof input.key === "string" ? getAccount(input.key) : undefined;
  const clientId = existing?.clientId ?? (typeof input.clientId === "string" ? input.clientId.trim().toLowerCase() : "");
  if (!clientPattern.test(clientId)) throw new IntegrationFailure("setup", "Enter the application ID from your Microsoft Entra desktop app registration.");
  const added = input.scope ?? "Mail.Read";
  if (!scopes.includes(added as GraphScope) || (!existing && added !== "Mail.Read"))
    throw new IntegrationFailure("permission", "Connect the account with read access first.");
  const wanted = [...new Set([...existing?.scopes ?? [], added as GraphScope])];
  const controller = new AbortController();
  activeSignIn = controller;
  const lifetime = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(180_000)]);
  try {
    const client = await microsoftClient(clientId);
    const { code, redirectUri, verifier } = await browserCode(async (redirectUri, state, codeChallenge) => {
      const url = await client.getAuthCodeUrl({
        scopes: wanted, redirectUri, state, codeChallenge, codeChallengeMethod: "S256",
        ...(existing ? { loginHint: existing.email } : { prompt: "select_account" }),
      });
      await host().call({ op: "openExternal", url });
    }, lifetime);
    const result = await client.acquireTokenByCode({ code, redirectUri, codeVerifier: verifier, scopes: wanted });
    lifetime.throwIfAborted();
    const granted = new Set(result.scopes.map((scope) => scope.split("/").at(-1)?.toLowerCase()));
    if (wanted.some((scope) => !granted.has(scope.toLowerCase()) && !(scope === "Mail.Read" && granted.has("mail.readwrite"))))
      throw new IntegrationFailure("permission", "Microsoft did not grant all the requested permissions.");
    const account = result.account;
    if (!account?.homeAccountId || !isAddress(account.username) || (existing && existing.homeId !== account.homeAccountId))
      throw new IntegrationFailure("permission", "Sign in to the Microsoft account you selected in Phaethon.");
    const key = `graph:${createHash("sha256").update(clientId + "\0" + account.homeAccountId).digest("hex").slice(0, 32)}`;
    const entry: LocalAccount = { key, clientId, homeId: account.homeAccountId, email: account.username.toLowerCase(),
      name: account.name?.slice(0, 120) || account.username, scopes: wanted };
    return await exclusive(key, async () => {
      lifetime.throwIfAborted();
      const previous = state();
      if (existing && !previous.accounts.some((a) => a.key === key)) throw new IntegrationFailure("not-connected", "This account was disconnected during sign-in.");
      if (!existing && previous.accounts.some((a) => a.key === key)) throw new IntegrationFailure("setup", "This Microsoft account is already connected. Use Reconnect on its account row.");
      const cache = integrationSecrets();
      const oldSecret = cache.get(service, secretId(key));
      cache.set(service, secretId(key), client.getTokenCache().serialize());
      try {
        writeFileAtomic(file(), prettyJson({ version: 1, accounts: [...previous.accounts.filter((a) => a.key !== key), entry] }) + "\n", { mode: 0o600 });
      } catch (error) {
        if (oldSecret === null) cache.delete(service, secretId(key));
        else cache.set(service, secretId(key), oldSecret);
        throw error;
      }
      return publicAccount(entry);
    });
  } catch (error) {
    if (lifetime.aborted) throw new IntegrationFailure("not-connected", "Microsoft sign-in was cancelled or timed out.");
    throw failAuth(error);
  } finally {
    activeSignIn = undefined;
  }
}

export function cancelGraphSignIn(): void {
  activeSignIn?.abort();
}

export async function disconnectGraph(key: string): Promise<void> {
  await exclusive(key, async () => {
    getAccount(key);
    integrationSecrets().delete(service, secretId(key));
    writeFileAtomic(file(), prettyJson({ version: 1, accounts: state().accounts.filter((a) => a.key !== key) }) + "\n", { mode: 0o600 });
  });
}
