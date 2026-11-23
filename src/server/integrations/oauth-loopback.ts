import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export async function browserCode(
  open: (redirectUri: string, state: string, challenge: string) => Promise<void>,
  signal: AbortSignal,
): Promise<{ code: string; redirectUri: string; verifier: string }> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  lifetime.throwIfAborted();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let accept!: (code: string) => void;
  let refuse!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => { accept = resolve; refuse = reject; });
  // May be rejected while the browser handoff is still in progress.
  void result.catch(() => {});
  let authority = "";
  const server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL("http://localhost" + (req.url?.startsWith("/") ? req.url : "/"));
    const received = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(state);
    if (req.method !== "GET" || req.headers.host !== authority || url.pathname !== "/oauth/callback" ||
        received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.writeHead(400).end("Invalid sign-in callback.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) {
      const denied = url.searchParams.get("error_description") ?? "";
      const admin = /AADSTS(?:65001|65004|90094|900941|50105)/.test(denied);
      res.end("Sign-in was denied. Return to Phaethon.");
      refuse(new OAuthDenied(admin));
      return;
    }
    res.end("Sign-in received. Return to Phaethon.", () => accept(code));
  });
  const abort = () => refuse(new Error("Sign-in cancelled or timed out."));
  lifetime.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("The sign-in callback did not start.");
    authority = `localhost:${bound.port}`;
    const redirectUri = `http://${authority}/oauth/callback`;
    lifetime.throwIfAborted();
    await open(redirectUri, state, challenge);
    return { code: await result, redirectUri, verifier };
  } finally {
    lifetime.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
  }
}

export class OAuthDenied extends Error {
  constructor(readonly admin: boolean) {
    super(admin ? "Your organization may require an administrator to grant access." : "Microsoft sign-in or consent was cancelled.");
  }
}
