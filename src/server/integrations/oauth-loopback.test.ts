import { createHash } from "node:crypto";
import { get } from "node:http";
import { expect, it } from "vitest";
import { browserCode } from "./oauth-loopback.ts";

it("rejects a forged callback and binds the accepted code to a PKCE verifier", async () => {
  let challenge = "";
  const code = await browserCode(async (redirectUri, state, sentChallenge) => {
    challenge = sentChallenge;
    const url = new URL(redirectUri);
    const local = redirectUri.replace("localhost", "127.0.0.1");
    const callback = (query: string) => new Promise<{ status?: number; cache?: string }>((resolve, reject) => {
      get(`${local}?${query}`, { headers: { Host: url.host } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, cache: res.headers["cache-control"] }));
      }).on("error", reject);
    });
    await expect(callback("state=wrong&code=forged")).resolves.toMatchObject({ status: 400 });
    await expect(callback(`state=${state}&code=test-code`)).resolves.toEqual({ status: 200, cache: "no-store" });
  }, AbortSignal.timeout(10_000));
  expect(code.code).toBe("test-code");
  expect(createHash("sha256").update(code.verifier).digest("base64url")).toBe(challenge);
});
