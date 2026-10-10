import { dirname, resolve } from "node:path";
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}
export async function objectStore(): Promise<ObjectStore> {
  const base = Deno.env.get("S3_BASE_URL");
  if (!base) {
    // A local stand-in so the complete snapshot/restore flow runs without a cloud account.
    // This is NOT off-host redundancy.
    const root = resolve(Deno.env.get("LOCAL_OBJECT_DIR") ?? "./object-store");
    const path = (key: string) => {
      if (!/^[A-Za-z0-9_./-]+$/.test(key) || key.split("/").includes("..") || key.startsWith("/")) {
        throw new Error("Invalid key");
      }
      return resolve(root, key);
    };
    return {
      async put(key, bytes) {
        const file = path(key);
        await Deno.mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomUUID()}.tmp`;
        await Deno.writeFile(tmp, bytes);
        await Deno.rename(tmp, file);
      },
      get: (key) => Deno.readFile(path(key)),
    };
  }
  const { AwsClient } = await import("aws4fetch");
  const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) throw new Error("S3 credentials are required");
  const signer = new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken: Deno.env.get("AWS_SESSION_TOKEN"),
    service: "s3",
    region: Deno.env.get("AWS_REGION") ?? "us-east-1",
    retries: 3,
  });
  // Base includes the bucket: virtual-hosted S3 or a path-style S3-compatible URL.
  const url = (key: string) =>
    `${base.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async put(key, bytes) {
      const response = await signer.fetch(url(key), {
        method: "PUT",
        body: bytes.slice().buffer,
        headers: { "content-type": "application/octet-stream" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`S3 PUT failed (${response.status}): ${await response.text()}`);
      await response.body?.cancel();
    },
    async get(key) {
      const response = await signer.fetch(url(key), { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`S3 GET failed (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
