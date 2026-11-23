// Cross-site request and DNS-rebinding protection for the loopback API.
// Binding to 127.0.0.1 does not stop a web page in the user's browser from calling this API, so every request is checked:
//   Host must be loopback (stops DNS rebinding), Origin must match Host when present (stops cross-site requests),
//   and POST must be application/json (a type a browser cannot send cross-site without a CORS preflight, which we never grant).
export type GuardInput = { method: string; host?: string; origin?: string; contentType?: string };
export type GuardResult = { ok: true } | { ok: false; status: 403 | 415; error: string };

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i;

export function checkRequest(r: GuardInput): GuardResult {
  if (!r.host || !LOOPBACK_HOST.test(r.host)) return { ok: false, status: 403, error: "forbidden host: this API only answers on 127.0.0.1 or localhost" };
  if (r.origin !== undefined && r.origin.toLowerCase() !== `http://${r.host.toLowerCase()}`) {
    return { ok: false, status: 403, error: "forbidden origin: cross-site requests are not allowed" };
  }
  if (r.method.toUpperCase() === "POST" && (r.contentType ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, status: 415, error: "content-type must be application/json" };
  }
  return { ok: true };
}
