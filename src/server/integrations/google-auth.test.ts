import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { host, setHost } from "../host.ts";
import type { HostOp } from "../../shared/host.ts";
import { GoogleDesktopAuth, desktopClient } from "./google-auth.ts";

const env = tempHome("phaethon-google-oauth-");
const originalHost = host();
afterEach(() => setHost(originalHost));
afterAll(env.cleanup);

const client = { installed: { client_id: "123-test.apps.googleusercontent.com", client_secret: "fixture_secret", token_uri: "https://example.invalid" } };
const read = "https://www.googleapis.com/auth/calendar.events.readonly";
const write = "https://www.googleapis.com/auth/calendar.events";

it("accepts a desktop OAuth registration only and ignores endpoints in the downloaded file", () => {
  expect(desktopClient(client)).toEqual({ clientId: client.installed.client_id, clientSecret: client.installed.client_secret });
  expect(() => desktopClient({ web: client.installed })).toThrow("Desktop app");
});

it("uses a local PKCE callback and stores Google access independently from mail", async () => {
  const file = path.join(env.home, "desktop-client.json");
  fs.writeFileSync(file, JSON.stringify(client));
  let challenge = "";
  let scope = "";
  let subject = "fixture-user";
  setHost({
    available: true,
    call: async <T,>(op: HostOp) => {
      if (op.op === "pickFiles") return [file] as T;
      if (op.op !== "openExternal") throw new Error("Unexpected host operation");
      const url = new URL(op.url);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.has("client_secret")).toBe(false);
      scope = url.searchParams.get("scope") ?? "";
      challenge = url.searchParams.get("code_challenge") ?? "";
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      expect(callback.hostname).toBe("127.0.0.1");
      callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "fixture-code" }).toString();
      expect((await fetch(callback)).status).toBe(200);
      return undefined as T;
    },
    on: () => () => {},
  });
  const net = vi.fn<typeof fetch>(async (input, options) => {
    const url = String(input);
    expect(options?.redirect).toBe("error");
    if (url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(options?.body));
      expect(body.get("client_secret")).toBe(client.installed.client_secret);
      if (body.get("grant_type") === "authorization_code") {
        expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge);
        return Response.json({ access_token: "on-connect", refresh_token: "fixture-refresh-token", token_type: "Bearer", scope, expires_in: 0 });
      }
      expect(body.get("refresh_token")).toBe("fixture-refresh-token");
      return Response.json({ access_token: "from-refresh", token_type: "Bearer", expires_in: 3600 });
    }
    expect(url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer on-connect");
    return Response.json({ sub: subject, email: "fixture@example.invalid", email_verified: true });
  });
  const auth = new GoogleDesktopAuth("google-calendar", [read], [write], net);
  const mail = new GoogleDesktopAuth("google-mail", [read], [write], net);
  const signal = AbortSignal.timeout(10_000);
  await expect(auth.connect({ editing: true }, signal)).rejects.toThrow("read access first");
  const account = await auth.connect({}, signal);
  expect(account).toMatchObject({ email: "fixture@example.invalid", scopes: [read] });
  expect(mail.accounts()).toEqual([]);
  await expect(auth.token(account.key, write)).rejects.toThrow("Enable this Google permission");
  await expect(auth.token(account.key, read)).resolves.toBe("from-refresh");
  subject = "wrong-account";
  await expect(auth.connect({ key: account.key, editing: true }, signal)).rejects.toThrow("Google account you selected");
  expect(auth.accounts()).toEqual([account]);
  subject = "fixture-user";
  await expect(auth.connect({ key: account.key, editing: true }, signal)).resolves.toMatchObject({ key: account.key, scopes: [read, write] });
  const metadata = fs.readFileSync(path.join(env.appData, fs.readdirSync(env.appData).find((filename) => filename.startsWith("google-calendar-"))!), "utf8");
  expect(metadata).not.toContain("fixture-refresh-token");
  expect(metadata).not.toContain(client.installed.client_secret);
  await auth.disconnect(account.key);
  expect(auth.accounts()).toEqual([]);
  await expect(auth.token(account.key, read)).rejects.toThrow("Connect this Google account");
});
