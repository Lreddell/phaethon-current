import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IDENTITY } from "../../shared/channel.ts";
import { prettyJson, readJson, writeFileAtomic } from "../core/fsx.ts";
import { integrationSecrets } from "../core/secrets.ts";
import { vaultRoot } from "../core/vault.ts";
import { appDataDir } from "../env.ts";
import { host } from "../host.ts";
import { browserCode, OAuthDenied } from "./oauth-loopback.ts";
import { IntegrationFailure } from "./registry.ts";

const service = `${IDENTITY.keychainService}-integrations`;
const tokenUrl = "https://oauth2.googleapis.com/token";
const userInfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const clientIdPattern = /^[a-zA-Z0-9_-]{1,186}\.apps\.googleusercontent\.com$/;
const clientSecretPattern = /^[a-zA-Z0-9_-]{8,256}$/;
const emailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const subjectPattern = /^[A-Za-z0-9_-]{1,256}$/;

type Client = { clientId: string; clientSecret: string };
type SavedSecret = Client & { refreshToken: string };
type GoogleToken = { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string; error?: string };
type Identity = { sub?: string; email?: string; email_verified?: boolean };
export type GoogleAccount = { key: string; email: string; scopes: string[] };
type Account = GoogleAccount & { subject: string; clientId: string };

function vaultId(): string {
  const root = path.resolve(vaultRoot());
  return createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
}

export function desktopClient(raw: unknown): Client {
  const installed = (raw as { installed?: { client_id?: unknown; client_secret?: unknown } } | null)?.installed;
  if (typeof installed?.client_id !== "string" || !clientIdPattern.test(installed.client_id) ||
      typeof installed.client_secret !== "string" || !clientSecretPattern.test(installed.client_secret))
    throw new IntegrationFailure("setup", "Choose the OAuth client JSON downloaded for a Google Cloud Desktop app.");
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

async function pickClient(): Promise<Client> {
  const selection = await host().call<string[] | null>({ op: "pickFiles", title: "Choose the Google Desktop OAuth client JSON", multiple: false, filters: [{ name: "Google OAuth client JSON", extensions: ["json"] }] });
  const file = selection?.[0];
  if (!file) throw new IntegrationFailure("not-connected", "No Google OAuth client was selected.");
  try {
    const fd = fs.openSync(file, "r");
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > 16_384) throw new Error("Invalid OAuth client file");
      const contents = Buffer.alloc(16_385);
      const bytes = fs.readSync(fd, contents, 0, contents.length, 0);
      if (bytes > 16_384) throw new Error("OAuth client file too large");
      return desktopClient(JSON.parse(contents.toString("utf8", 0, bytes)));
    } finally { fs.closeSync(fd); }
  } catch {
    throw new IntegrationFailure("setup", "Choose the OAuth client JSON downloaded for a Google Cloud Desktop app.");
  }
}

function publicAccount({ key, email, scopes }: Account): GoogleAccount { return { key, email, scopes }; }

async function responseJson<T>(response: Response): Promise<T> {
  const reader = response.body?.getReader();
  if (!reader) throw new IntegrationFailure("offline", "Google returned an empty sign-in response.");
  const pieces: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(pieces, size).toString("utf8")) as T;
      size += value.length;
      if (size > 65_536) throw new Error("Sign-in response too large");
      pieces.push(value);
    }
  } catch {
    throw new IntegrationFailure("offline", "Google returned an unreadable sign-in response.");
  } finally { await reader.cancel().catch(() => {}); }
}

function granted(token: GoogleToken, wanted: readonly string[], refresh = false) {
  const scopes = token.scope?.split(/\s+/) ?? (refresh ? wanted : []);
  if (wanted.some((scope) => !scopes.includes(scope))) throw new IntegrationFailure("permission", "Google did not grant all the requested permissions.");
}

function checkedAccess(token: GoogleToken): string {
  if (token.token_type?.toLowerCase() !== "bearer" || !token.access_token || !/^[\x21-\x7e]{1,8192}$/.test(token.access_token))
    throw new IntegrationFailure("not-connected", "Reconnect this Google account to renew its sign-in.");
  return token.access_token;
}

export class GoogleDesktopAuth {
  private activeSignIn?: AbortController;
  private pending = new Map<string, Promise<unknown>>();
  private tokens = new Map<string, { token: string; expires: number }>();

  constructor(private readonly namespace: "google-calendar" | "google-mail", private readonly readScopes: readonly string[],
    private readonly writeScopes: readonly string[], private readonly fetcher = fetch) {}

  private file(vault: string): string { return path.join(appDataDir(), `${this.namespace}-${vault}.json`); }
  private secretId(vault: string, key: string): string { return `${vault}/${this.namespace}/${key}`; }

  private state(vault: string): Account[] {
    const raw = readJson<{ version: number; accounts: Account[] }>(this.file(vault), { version: 1, accounts: [] });
    if (raw?.version !== 1 || !Array.isArray(raw.accounts)) throw new IntegrationFailure("setup", "The local Google connection file is unreadable.");
    const keyPattern = new RegExp(`^${this.namespace}:[a-f0-9]{32}$`);
    return raw.accounts.filter((entry) => entry && keyPattern.test(entry.key) && clientIdPattern.test(entry.clientId) &&
      subjectPattern.test(entry.subject) && typeof entry.email === "string" && entry.email.length <= 320 && emailPattern.test(entry.email) &&
      Array.isArray(entry.scopes) && this.readScopes.every((scope) => entry.scopes.includes(scope)) &&
      entry.scopes.every((scope) => this.readScopes.includes(scope) || this.writeScopes.includes(scope)));
  }

  accounts(): GoogleAccount[] { return this.state(vaultId()).map(publicAccount); }

  private account(vault: string, key: string): Account {
    const entry = this.state(vault).find((account) => account.key === key);
    if (!entry) throw new IntegrationFailure("not-connected", "Connect this Google account in Settings.");
    return entry;
  }

  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.pending.set(key, next);
    try { return await next; }
    finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }

  private secret(vault: string, entry: Account): SavedSecret {
    try {
      const saved = JSON.parse(integrationSecrets().get(service, this.secretId(vault, entry.key)) ?? "null") as SavedSecret | null;
      if (saved?.clientId === entry.clientId && clientSecretPattern.test(saved.clientSecret) && /^[\x21-\x7e]{1,8192}$/.test(saved.refreshToken)) return saved;
    } catch {
      throw new IntegrationFailure("not-connected", "The Google credential could not be read from the system keychain.");
    }
    throw new IntegrationFailure("not-connected", "Reconnect this Google account with its Desktop OAuth client JSON.");
  }

  private async request(url: typeof tokenUrl | typeof userInfoUrl, signal: AbortSignal, options: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetcher(url, { ...options, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    } catch {
      signal.throwIfAborted();
      throw new IntegrationFailure("offline", "Google sign-in could not be reached.");
    }
  }

  private async exchange(client: Client, args: Record<string, string>, signal: AbortSignal): Promise<GoogleToken> {
    const response = await this.request(tokenUrl, signal, { method: "POST", body: new URLSearchParams({ ...args, client_id: client.clientId, client_secret: client.clientSecret }) });
    const token = await responseJson<GoogleToken>(response);
    if (!response.ok) {
      if (token.error === "invalid_grant") throw new IntegrationFailure("not-connected", "Reconnect this Google account to renew its sign-in.");
      if (token.error === "invalid_client") throw new IntegrationFailure("setup", "Google rejected the Desktop OAuth client registration.");
      throw new IntegrationFailure("not-connected", "Google did not complete sign-in. Check the OAuth registration and account access.");
    }
    return token;
  }

  async token(key: string, scope: string, signal = new AbortController().signal): Promise<string> {
    const vault = vaultId();
    const id = this.secretId(vault, key);
    return this.exclusive(id, async () => {
      signal.throwIfAborted();
      const entry = this.account(vault, key);
      if (!entry.scopes.includes(scope)) throw new IntegrationFailure("permission", "Enable this Google permission in Settings.");
      const cached = this.tokens.get(id);
      if (cached && cached.expires > Date.now()) return cached.token;
      this.tokens.delete(id);
      const saved = this.secret(vault, entry);
      const result = await this.exchange(saved, { grant_type: "refresh_token", refresh_token: saved.refreshToken }, signal);
      granted(result, entry.scopes, true);
      const token = checkedAccess(result);
      if (result.refresh_token && result.refresh_token !== saved.refreshToken) {
        try { integrationSecrets().set(service, id, JSON.stringify({ ...saved, refreshToken: result.refresh_token })); }
        catch { throw new IntegrationFailure("setup", "The system keychain could not update this Google connection."); }
      }
      this.cacheToken(id, token, result.expires_in);
      return token;
    });
  }

  private cacheToken(id: string, token: string, expiry: number | undefined): void {
    const now = Date.now();
    for (const [key, previous] of this.tokens) if (previous.expires <= now) this.tokens.delete(key);
    if (this.tokens.size < 64 && typeof expiry === "number" && Number.isFinite(expiry) && expiry > 60)
      this.tokens.set(id, { token, expires: now + (Math.min(expiry, 3600) - 60) * 1000 });
  }

  async connect(input: { key?: unknown; editing?: unknown; replaceClient?: unknown }, signal: AbortSignal): Promise<GoogleAccount> {
    if (!host().available) throw new IntegrationFailure("unsupported", "Google sign-in needs the Phaethon desktop app.");
    if (this.activeSignIn) throw new IntegrationFailure("restricted", "A Google sign-in is already in progress.");
    const vault = vaultId();
    const existing = typeof input.key === "string" ? this.account(vault, input.key) : undefined;
    if (input.editing === true && !existing) throw new IntegrationFailure("permission", "Connect the account with read access first.");
    const controller = new AbortController();
    this.activeSignIn = controller;
    const lifetime = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(180_000)]);
    try {
      const client = existing && input.replaceClient !== true ? this.secret(vault, existing) : await pickClient();
      if (existing && existing.clientId !== client.clientId) throw new IntegrationFailure("setup", "Choose the Desktop OAuth client used for this connection.");
      const wanted = [...new Set([...this.readScopes, ...(existing?.scopes ?? []), ...(input.editing === true ? this.writeScopes : [])])];
      const { code, redirectUri, verifier } = await browserCode(async (redirect, state, challenge) => {
        const url = new URL(googleAuthUrl);
        url.search = new URLSearchParams({
          client_id: client.clientId, response_type: "code", redirect_uri: redirect, state, access_type: "offline",
          scope: ["openid", "email", ...wanted].join(" "), code_challenge: challenge, code_challenge_method: "S256",
          prompt: existing ? "consent" : "select_account consent", ...(existing ? { login_hint: existing.email } : {}),
        }).toString();
        await host().call({ op: "openExternal", url: url.href });
      }, lifetime, "127.0.0.1");
      const result = await this.exchange(client, { code, redirect_uri: redirectUri, code_verifier: verifier, grant_type: "authorization_code" }, lifetime);
      granted(result, wanted);
      const access = checkedAccess(result);
      if (!result.refresh_token || !/^[\x21-\x7e]{1,8192}$/.test(result.refresh_token))
        throw new IntegrationFailure("not-connected", "Google did not grant offline access. Reconnect and review the sign-in permissions.");
      const response = await this.request(userInfoUrl, lifetime, { headers: { Authorization: `Bearer ${access}` } });
      const identity = response.ok ? await responseJson<Identity>(response) : null;
      if (!response.ok) await response.body?.cancel().catch(() => {});
      if (!identity?.sub || !subjectPattern.test(identity.sub) || !identity.email_verified || !identity.email ||
          identity.email.length > 320 || !emailPattern.test(identity.email) || (existing && existing.subject !== identity.sub))
        throw new IntegrationFailure("permission", "Sign in to the Google account you selected in Phaethon.");
      const key = `${this.namespace}:${createHash("sha256").update(client.clientId + "\0" + identity.sub).digest("hex").slice(0, 32)}`;
      const entry: Account = { key, clientId: client.clientId, subject: identity.sub, email: identity.email, scopes: wanted };
      const id = this.secretId(vault, key);
      return await this.exclusive(id, async () => {
        lifetime.throwIfAborted();
        if (vaultId() !== vault) throw new IntegrationFailure("restricted", "Switch back to the original vault before connecting this account.");
        const previous = this.state(vault);
        const already = previous.some((item) => item.key === key);
        if (!existing && already) throw new IntegrationFailure("setup", "This Google account is already connected. Use Reconnect on its account row.");
        if (existing && !already) throw new IntegrationFailure("not-connected", "This account was disconnected during sign-in.");
        const storage = integrationSecrets();
        const old = storage.get(service, id);
        storage.set(service, id, JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: result.refresh_token }));
        try { writeFileAtomic(this.file(vault), prettyJson({ version: 1, accounts: [...previous.filter((a) => a.key !== key), entry] }) + "\n", { mode: 0o600 }); }
        catch (error) {
          if (old === null) storage.delete(service, id);
          else storage.set(service, id, old);
          throw error;
        }
        this.tokens.delete(id);
        this.cacheToken(id, access, result.expires_in);
        return publicAccount(entry);
      });
    } catch (error) {
      if (lifetime.aborted || error instanceof OAuthDenied) throw new IntegrationFailure("not-connected", "Google sign-in was cancelled, denied, or timed out.");
      if (error instanceof IntegrationFailure) throw error;
      throw new IntegrationFailure("setup", "Google sign-in could not be saved. Check the Desktop OAuth registration and the system keychain.");
    } finally { this.activeSignIn = undefined; }
  }

  cancel(): void { this.activeSignIn?.abort(); }

  async disconnect(key: string): Promise<void> {
    const vault = vaultId();
    const id = this.secretId(vault, key);
    await this.exclusive(id, async () => {
      this.account(vault, key);
      this.tokens.delete(id);
      try {
        integrationSecrets().delete(service, id);
        writeFileAtomic(this.file(vault), prettyJson({ version: 1, accounts: this.state(vault).filter((entry) => entry.key !== key) }) + "\n", { mode: 0o600 });
      } catch { throw new IntegrationFailure("setup", "The local Google connection could not be removed. Check the system keychain and try again."); }
    });
  }
}
