// Google OAuth via Passport, with user rows in Supabase.
// Sessions are signed cookies; the in-memory store is fine for dev (warns in prod).
import type { Express, RequestHandler } from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy, type Profile } from "passport-google-oauth20";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./db.js";

export type Tier = "free" | "starter" | "pro";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  tier: Tier;
}

// Strategy needs a string callback URL — built from env so dev/prod can differ.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Upsert by google_id so re-login updates name/picture without dup rows.
async function upsertUserFromGoogle(
  supabase: SupabaseClient,
  profile: Profile,
): Promise<AuthUser> {
  const email = profile.emails?.[0]?.value;
  if (!email) throw new Error("Google profile has no email");

  const { data, error } = await supabase
    .from("users")
    .upsert(
      {
        google_id: profile.id,
        email,
        name: profile.displayName ?? null,
        picture: profile.photos?.[0]?.value ?? null,
      },
      { onConflict: "google_id" },
    )
    .select("id, email, name, picture, tier")
    .single();
  if (error) throw error;
  return data as AuthUser;
}

export function mountAuth(app: Express): void {
  const sessionSecret = requireEnv("SESSION_SECRET");
  const googleClientId = requireEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const callbackURL = process.env.GOOGLE_CALLBACK_URL
    ?? "http://localhost:8787/auth/google/callback";
  const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

  const supabase = getSupabase();

  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    // Required for `secure` cookies to round-trip behind a TLS-terminating proxy
    // (Vercel, Fly, Render, etc.) — otherwise req.protocol stays 'http' and the
    // browser never sends the session cookie back.
    app.set("trust proxy", 1);
  }
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: isProd,
        maxAge: 1000 * 60 * 60 * 24 * 30,
      },
    }),
  );

  passport.use(
    new GoogleStrategy(
      {
        clientID: googleClientId,
        clientSecret: googleClientSecret,
        callbackURL,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const user = await upsertUserFromGoogle(supabase, profile);
          done(null, user);
        } catch (err) {
          done(err as Error);
        }
      },
    ),
  );

  passport.serializeUser((user, done) => {
    done(null, (user as AuthUser).id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const { data, error } = await supabase
        .from("users")
        .select("id, email, name, picture, tier")
        .eq("id", id)
        .single();
      if (error) throw error;
      done(null, data as AuthUser);
    } catch (err) {
      done(err as Error);
    }
  });

  app.use(passport.initialize());
  app.use(passport.session());

  app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: `${clientOrigin}/?auth=failed` }),
    (_req, res) => {
      res.redirect(clientOrigin);
    },
  );

  app.get("/auth/me", (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    res.json({ user: req.user });
  });

  app.post("/auth/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) {
        next(err);
        return;
      }
      req.session.destroy(() => {
        res.status(204).end();
      });
    });
  });
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: "login required" });
    return;
  }
  next();
};

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}
