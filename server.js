const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { OAuth2Client } = require("google-auth-library");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "cambia-esto-por-un-secreto-fuerte-local";

const DB_PATH = path.join(__dirname, "users.json");

const DEFAULT_VERIFY_CODE = "123456";
const pendingRegisters = new Map();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// -------- Timeout global 25s: si cualquier ruta cuelga, responde error y no deja el navegador colgado --------
app.use((req, res, next) => {
  const t = setTimeout(() => {
    try {
      if (!res.headersSent) {
        res.status(504).json({ status: "timeout", message: "El servidor tardó demasiado. Refresca la página." });
      }
    } catch {}
  }, 25000);
  res.on("finish", () => clearTimeout(t));
  res.on("close", () => clearTimeout(t));
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// -------- loadUsers / saveUsers ROBUSTOS (NUNCA deben crashear el proceso) --------
function loadUsers() {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    try {
      const raw = fs.readFileSync(DB_PATH, "utf-8");
      if (!raw) return [];
      try { return JSON.parse(raw) || []; } catch { return []; }
    } catch (e) {
      console.warn("loadUsers no leyó el archivo:", e && e.message);
      return [];
    }
  } catch {
    return [];
  }
}
function saveUsers(list) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(list || [], null, 2), "utf-8");
  } catch (e) {
    console.warn("saveUsers falló (no se pudo escribir en disco, los usuarios no se persistirán):", e && e.message);
  }
}
function findUserByEmail(email) {
  const users = loadUsers();
  return users.find(u => u.email === email) || null;
}
function upsertGoogleUser(profile) {
  const users = loadUsers();
  const email = (profile.email || "").toLowerCase();
  let user = users.find(u => u.email === email);
  if (!user) {
    user = {
      id: Date.now(),
      email,
      nombre: profile.nombre || profile.given_name || "Usuario Google",
      password: null,
      provider: "google",
      avatar: profile.picture || "",
      googleSub: profile.sub || "",
      createdAt: new Date().toISOString(),
    };
    users.push(user);
  } else {
    user.provider = "google";
    user.avatar = profile.picture || user.avatar || "";
    user.googleSub = profile.sub || user.googleSub || "";
    user.nombre = user.nombre || profile.nombre || "Usuario Google";
  }
  saveUsers(users);
  return user;
}

// -------- Handler global de errores Express (cualquier excepción no capturada responde 500 y NO cuelga) --------
app.use((err, req, res, next) => {
  console.error("Express error handler:", err && err.stack || err);
  try {
    if (!res.headersSent) {
      res.status(500).json({ status: "error", message: "Ocurrió un error en el servidor." });
    }
  } catch {}
});
process.on("uncaughtException", (e) => {
  console.error("uncaughtException:", e && e.stack || e);
});
process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection:", e);
});
(function seedDefaultUser() {
  const users = loadUsers();
  if (!users.find(u => u.email === "luffy@onepiece.com")) {
    users.push({
      id: Date.now(),
      email: "luffy@onepiece.com",
      password: bcrypt.hashSync("nakama123", 10),
      nombre: "Luffy Demo",
      createdAt: new Date().toISOString(),
    });
    saveUsers(users);
  }
})();


function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, nombre: user.nombre },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}
function getUserFromReq(req) {
  const token = req.cookies?.auth_token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}
function requireAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ status: "error", message: "Sesión inválida" });
  req.user = user;
  next();
}

app.use((req, res, next) => {
  const user = getUserFromReq(req);
  res.locals.authed = !!user;
  res.locals.userEmail = user?.email || "";
  next();
});

// POST /secure/login — compatible con login.main.js
app.post("/secure/login", async (req, res) => {
  try {
    const { emailuser, showpassword, cfToken, afiliado } = req.body;
    const email = (emailuser || req.body.email || "").toString().trim().toLowerCase();
    const password = (showpassword || req.body.password || "").toString();

    if (!email || !password) {
      return res.json({ status: "error", message: "Faltan datos" });
    }
    if (password.length < 6) {
      return res.json({ status: "passwordlegn", message: "Contraseña muy corta" });
    }

    const users = loadUsers();
    const user = users.find(u => u.email === email);
    if (!user) {
      return res.json({ status: "error_success_mail", message: "Usuario no existe" });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.json({ status: "errordenied", message: "Contraseña incorrecta" });
    }

    const token = signToken(user);
    res.cookie("auth_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: !!process.env.RENDER_EXTERNAL_URL,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      status: "success",
      redirect: "/productos",
      user: { id: user.id, email: user.email, nombre: user.nombre },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: "Error interno" });
  }
});

app.post("/secure/register", async (req, res) => {
  try {
    const email = (req.body.emailuser || req.body.email || "").toString().trim().toLowerCase();
    const nombre = (req.body.nameuser || req.body.nombre || "Usuario").toString().trim();
    const password = (req.body.showpassword || req.body.password || "").toString();
    const phone = (req.body.phoneuser || req.body.telefono || req.body.phone || "").toString().trim();
    const afiliado = req.body.afiliado || "";

    if (!email || !password) {
      return res.json({ status: "error", message: "Faltan datos" });
    }
    if (password.length < 6) {
      return res.json({ status: "passwordlegn", message: "Tu contraseña no debe ser menor a 6 caracteres." });
    }

    const users = loadUsers();
    if (users.find(u => u.email === email)) {
      return res.json({ status: "deniedafilied", message: "El correo ya está registrado. Intenta con otro." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    pendingRegisters.set(email, {
      nombre,
      passwordHash,
      phone,
      afiliado,
      createdAt: Date.now(),
      code: DEFAULT_VERIFY_CODE,
    });

    console.log(`[DEMO] Código de verificación para ${email} -> ${DEFAULT_VERIFY_CODE}`);
    return res.json({
      status: "success_mail",
      message: "Te enviamos un código a tu correo. (Demo: usa 123456)",
      email,
      code: DEFAULT_VERIFY_CODE,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error" });
  }
});

// POST /secure/verify-code
app.post("/secure/verify-code", async (req, res) => {
  try {
    const email = (req.body.email || req.body.emailuser || "").toString().trim().toLowerCase();
    const code = (req.body.code || req.body.codigo || req.body.cfcode || "").toString().trim();

    if (!email || !code) {
      return res.json({ status: "error", message: "Faltan datos" });
    }
    const pending = pendingRegisters.get(email);
    if (!pending) {
      return res.json({ status: "error_success_mail", message: "No hay registro pendiente para este correo." });
    }
    if (pending.code !== code) {
      return res.json({ status: "errordenied", message: "Código incorrecto. Intenta de nuevo." });
    }

    const users = loadUsers();
    if (users.find(u => u.email === email)) {
      pendingRegisters.delete(email);
      return res.json({ status: "deniedafilied", message: "El correo ya está registrado." });
    }

    const newUser = {
      id: Date.now(),
      email,
      nombre: pending.nombre,
      phone: pending.phone,
      afiliado: pending.afiliado,
      password: pending.passwordHash,
      createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    saveUsers(users);
    pendingRegisters.delete(email);

    const token = signToken(newUser);
    res.cookie("auth_token", token, {
      httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      status: "success",
      redirect: "/productos",
      user: { id: newUser.id, email, nombre: newUser.nombre },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error" });
  }
});

app.post("/secure/logout", (req, res) => {
  res.clearCookie("auth_token");
  res.json({ status: "ok" });
});

app.get("/api/auth/config", (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || "" });
});

app.post("/secure/google-login", async (req, res) => {
  try {
    if (!googleClient || !GOOGLE_CLIENT_ID) {
      return res.status(400).json({ status: "error", message: "Falta GOOGLE_CLIENT_ID en el servidor." });
    }

    const credential = (req.body.credential || "").toString().trim();
    if (!credential) {
      return res.status(400).json({ status: "error", message: "No llegó el token de Google." });
    }

    const ticket = await Promise.race([
      googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("GOOGLE_VERIFY_TIMEOUT")), 12000)),
    ]);
    const payload = ticket.getPayload();

    if (!payload || !payload.email) {
      return res.status(400).json({ status: "error", message: "Token de Google inválido." });
    }

    const email = String(payload.email).trim().toLowerCase();
    const user = upsertGoogleUser({
      email,
      nombre: payload.name || payload.given_name || "Usuario Google",
      picture: payload.picture || "",
      sub: payload.sub || "",
    });

    const token = signToken(user);
    res.cookie("auth_token", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      status: "success",
      redirect: "/productos",
      user: {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        avatar: user.avatar || "",
      },
    });
  } catch (err) {
    console.error("google-login error:", err);
    if (err && err.message === "GOOGLE_VERIFY_TIMEOUT") {
      return res.status(504).json({ status: "error", message: "Google tardó demasiado en validar la cuenta. Intenta otra vez." });
    }
    if (err && /Wrong recipient|audience|Token used too late|Malformed|Invalid token/i.test(String(err.message || err))) {
      return res.status(400).json({ status: "error", message: "Google devolvió un token inválido para esta app." });
    }
    return res.status(500).json({ status: "error", message: "No se pudo iniciar sesión con Google." });
  }
});

app.get("/api/me", (req, res) => {
  const rawToken = req.cookies?.auth_token;
  const user = getUserFromReq(req);
  res.set("X-Luffy-Auth-Cookie", rawToken ? "present" : "missing");
  res.set("X-Luffy-Auth-State", user ? "valid" : (rawToken ? "invalid" : "missing"));
  if (!user) {
    return res.json({
      authed: false,
      debug: { cookie: !!rawToken, state: rawToken ? "invalid" : "missing" },
    });
  }
  res.json({
    authed: true,
    user: { id: user.id, email: user.email, nombre: user.nombre },
    debug: { cookie: true, state: "valid" },
  });
});

// Rutas limpias (sin .html)
// UNICA VENTANA DE ACCESO: Google-only (google.html).
app.get("/google", (req, res) => res.sendFile(path.join(__dirname, "google.html")));
// Todo flujo de acceso => /google
app.get("/login",        (req, res) => res.redirect("/google"));
app.get("/ingresar",     (req, res) => res.redirect("/google"));
app.get("/login-manual", (req, res) => res.redirect("/google"));
app.get("/unirme",       (req, res) => res.redirect("/google"));
app.get("/register",     (req, res) => res.redirect("/google"));
app.get("/signup",       (req, res) => res.redirect("/google"));
// Si alguien intenta abrir los .html antiguos directamente => Google.
app.get("/login.html",   (req, res) => res.redirect("/google"));
app.get("/unirme.html",  (req, res) => res.redirect("/google"));
// Rutas internas de la app.
app.get("/premios",      (req, res) => res.redirect("/productos"));

// Protegemos páginas HTML
function protectHtml(redirectTo = "/login") {
  return (req, res, next) => {
    const user = getUserFromReq(req);
    if (!user) return res.redirect(redirectTo);
    next();
  };
}
app.get("/productos.html", protectHtml("/login"));
app.get("/productos", protectHtml("/login"));
app.get("/leaderboard", (req, res) => res.redirect("/productos"));
app.get("/leaderboard.html", (req, res) => res.redirect("/productos"));

app.use(express.static(__dirname, {
  extensions: ["html"],
  index: ["index.html"],
}));

app.set("trust proxy", 1);

const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL
    : `http://localhost:${PORT}`;
  console.log(`✅ Servidor corriendo: ${baseUrl}`);
  console.log(`   Base de datos: ${DB_PATH}`);
  console.log(`   Login demo: luffy@onepiece.com  /  nakama123`);
});