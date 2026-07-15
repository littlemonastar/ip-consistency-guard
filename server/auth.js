// Self-hosted GitHub OAuth (authorization-code flow) + a stateless signed-cookie
// session. No third-party auth service, no password storage. Requires, in .env:
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET  (from a GitHub OAuth App)
//   SESSION_SECRET                          (e.g. `openssl rand -hex 32`)

import crypto from "node:crypto";

const GH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GH_TOKEN = "https://github.com/login/oauth/access_token";
const GH_USER = "https://api.github.com/user";

const SESSION_COOKIE = "session";
const STATE_COOKIE = "oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// --- signed cookies (HMAC, no external deps) -------------------------------

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}
function sign(obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(data).digest("base64url");
  return `${data}.${mac}`;
}
function unsign(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx < 0) return null;
  const data = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  let expected;
  try {
    expected = crypto.createHmac("sha256", secret()).update(data).digest("base64url");
  } catch {
    return null; // SESSION_SECRET missing → treat as logged out rather than crash
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString());
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAge, secure) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function clearCookie(res, name) {
  res.append("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// --- session helpers -------------------------------------------------------

export function currentUser(req) {
  return unsign(parseCookies(req)[SESSION_COOKIE]);
}
export function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "Login required." });
  req.user = u;
  next();
}

// --- OAuth routes ----------------------------------------------------------

function callbackUrl(req) {
  return `${req.protocol}://${req.get("host")}/auth/callback`;
}
function isSecure(req) {
  return req.protocol === "https";
}

export function mountAuthRoutes(app) {
  // Kick off the OAuth flow.
  app.get("/auth/github", (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId || !process.env.SESSION_SECRET) {
      return res
        .status(500)
        .send("Auth not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and SESSION_SECRET in .env.");
    }
    const state = crypto.randomBytes(16).toString("hex");
    setCookie(res, STATE_COOKIE, sign({ state }), 600, isSecure(req)); // CSRF guard
    const url = new URL(GH_AUTHORIZE);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl(req));
    url.searchParams.set("scope", ""); // default: public profile is enough
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "true");
    res.redirect(url.toString());
  });

  // OAuth redirect target: verify state, exchange code, load profile, set session.
  app.get("/auth/callback", async (req, res) => {
    try {
      const { code, state } = req.query;
      const saved = unsign(parseCookies(req)[STATE_COOKIE]);
      clearCookie(res, STATE_COOKIE);
      if (!code || !state || !saved || saved.state !== state) {
        return res.status(400).send("Sign-in failed (state mismatch). Please try again.");
      }
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) return res.status(500).send("GitHub OAuth not configured.");

      const tokenRes = await fetch(GH_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl(req),
        }),
      });
      const token = (await tokenRes.json())?.access_token;
      if (!token) return res.status(400).send("Sign-in failed (no access token).");

      const ghRes = await fetch(GH_USER, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "ip-consistency-guard",
          Accept: "application/vnd.github+json",
        },
      });
      const gh = await ghRes.json();
      if (!gh || !gh.id) return res.status(400).send("Sign-in failed (no profile).");

      const user = { uid: `gh_${gh.id}`, login: gh.login, avatar: gh.avatar_url };
      setCookie(res, SESSION_COOKIE, sign(user), SESSION_MAX_AGE, isSecure(req));
      res.redirect("/");
    } catch (err) {
      console.error(err);
      res.status(500).send("Sign-in failed.");
    }
  });

  app.post("/auth/logout", (req, res) => {
    clearCookie(res, SESSION_COOKIE);
    res.json({ ok: true });
  });
}
