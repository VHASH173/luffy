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

// ========= FIX: Render Free NO TIENE disco persistente =========
// Forzar users.json A LA CARPETA DEL PROYECTO (escritura permitida).
// Quitamos /var/data (es read-only en free y crashea al guardar).
const DB_PATH = path.join(__dirname, "users.json");

const DEFAULT_VERIFY_CODE = "123456"; // Código fijo demo
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

// POST /secure/register — compatible con register.main.js y con formato simple
app.post("/secure/register", async (req, res) => {
  try {
    // Formato legacy simple (email/nombre/password) y también formato ofuscado register.main.js:
    // nameuser, emailuser, showpassword, phoneuser, cfToken, afiliado
    const email = (req.body.emailuser || req.body.email || "").toString().trim().toLowerCase();
    const nombre = (req.body.nameuser || req.body.nombre || "Usuario").toString().trim();
    const password = (req.body.showpassword || req.body.password || "").toString();
    const phone = (req.body.phoneuser || req.body.telefono || req.body.phone || "").toString().trim();
    const cfToken = req.body.cfToken || req.body.turnstile || "";
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
      cfToken,
      afiliado,
      createdAt: Date.now(),
      code: DEFAULT_VERIFY_CODE,
    });

    // Para que register.main.js abra el modal de verificación, devolvemos status success_mail.
    // (En un entorno real aquí enviaríamos el código por email con SendGrid/Mailgun.)
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

// POST /secure/verify-code — confirma el código (modal de 6 dígitos de register.main.js)
// Si el código es 123456 (DEFAULT_VERIFY_CODE), guarda el usuario y crea cookie de sesión.
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
      redirect: "/productos.html",
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

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload || !payload.email) {
      return res.status(400).json({ status: "error", message: "Token de Google inválido." });
    }

    const email = String(payload.email).trim().toLowerCase();
    const users = loadUsers();
    let user = users.find(u => u.email === email);

    if (!user) {
      user = {
        id: Date.now(),
        email,
        nombre: payload.name || payload.given_name || "Usuario Google",
        password: null,
        provider: "google",
        avatar: payload.picture || "",
        googleSub: payload.sub || "",
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      saveUsers(users);
    } else {
      user.provider = "google";
      user.avatar = payload.picture || user.avatar || "";
      user.googleSub = payload.sub || user.googleSub || "";
      if (!user.nombre) user.nombre = payload.name || payload.given_name || "Usuario Google";
      saveUsers(users);
    }

    const token = signToken(user);
    res.cookie("auth_token", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      status: "success",
      redirect: "/productos.html",
      user: {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        avatar: user.avatar || "",
      },
    });
  } catch (err) {
    console.error("google-login error:", err);
    return res.status(500).json({ status: "error", message: "No se pudo iniciar sesión con Google." });
  }
});

app.get("/api/me", (req, res) => {
  const user = getUserFromReq(req);
  if (!user) return res.json({ authed: false });
  res.json({
    authed: true,
    user: { id: user.id, email: user.email, nombre: user.nombre },
  });
});

// Rutas limpias (sin .html)
// Para que ?cf-turnstile-response=... también funcione (login con Turnstile)
app.get("/unirme", (req, res) => res.sendFile(path.join(__dirname, "unirme.html")));
app.get("/login",  (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/ingresar", (req, res) => res.redirect("/login"));
app.get("/register", (req, res) => res.redirect("/unirme"));
app.get("/signup",   (req, res) => res.redirect("/unirme"));

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
app.get("/leaderboard.html", protectHtml("/login"));

app.use(express.static(__dirname, {
  extensions: ["html"],
  index: ["index.html"],
}));

// Render corre detrás de proxy; confiable para cookies secure en producción
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