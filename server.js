const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { OAuth2Client } = require("google-auth-library");
const admin = require("firebase-admin");
const multer = require("multer");

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
      id: Date.now(), email,
      nombre: profile.nombre || profile.given_name || "Usuario Google",
      password: null, provider: "google", avatar: profile.picture || "",
      googleSub: profile.sub || "", createdAt: new Date().toISOString(),
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

let firestoreDb = null;
let firebaseBucketName = process.env.FIREBASE_STORAGE_BUCKET || "";
try {
  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || "";
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!firebaseBucketName && projectId) {
    firebaseBucketName = `${projectId}.appspot.com`;
  }
  if (projectId && clientEmail && privateKey) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        storageBucket: firebaseBucketName
      });
    }
    firestoreDb = admin.firestore();
  }
} catch (e) {
  console.warn("Firestore no disponible:", e && e.message);
}
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "luffy@onepiece.com").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
let storeSettings = {
  whatsappNumber: (process.env.WHATSAPP_ADMIN_NUMBER || "51918871372").replace(/\D/g, ""),
  yapeNumber: process.env.YAPE_NUMBER || "918871372",
  yapeQR: "",
  plinNumber: process.env.PLIN_NUMBER || "918871372",
  plinQR: "",
  transferInfo: process.env.BANK_ACCOUNT || "BCP - 193-12345678-0-12 (CCI: 002-193-001234567890-12)",
  transferQR: ""
};

const SETTINGS_PATH = path.join(__dirname, "settings.json");
function loadSettingsLocal() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      if (raw) Object.assign(storeSettings, JSON.parse(raw));
    }
  } catch (_) {}
}
function saveSettingsLocal(data) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (_) {}
}
loadSettingsLocal();

async function getStoreSettings() {
  if (firestoreDb) {
    try {
      const snap = await firestoreDb.collection("settings").doc("store").get();
      if (snap.exists) {
        storeSettings = { ...storeSettings, ...snap.data() };
        saveSettingsLocal(storeSettings);
      }
    } catch (_) {}
  }
  return storeSettings;
}

function buildPaymentMethodsList(settings) {
  return [
    { id: "yape", label: "Yape", target: settings.yapeNumber || "", qr: settings.yapeQR || "" },
    { id: "plin", label: "Plin", target: settings.plinNumber || "", qr: settings.plinQR || "" },
    { id: "transferencia", label: "Transferencia", target: settings.transferInfo || "", qr: settings.transferQR || "" },
  ];
}
function ensureFirestore(res) {
  if (firestoreDb) return true;
  res.status(503).json({ status: "error", message: "Firestore no está configurado todavía." });
  return false;
}
function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || "").toLowerCase());
}
async function listProductsStore() {
  const snap = await firestoreDb.collection("products").orderBy("createdAt", "desc").get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(item => item.active !== false);
}
async function saveProductStore(payload, editor) {
  const now = new Date().toISOString();
  const id = payload.id || String(Date.now());
  const product = {
    id,
    name: String(payload.name || "").trim(),
    description: String(payload.description || "").trim(),
    price: Number(payload.price || 0),
    image: String(payload.image || "").trim(),
    category: String(payload.category || "General").trim(),
    paymentMethods: Array.isArray(payload.paymentMethods) && payload.paymentMethods.length ? payload.paymentMethods : ["yape", "plin"],
    active: payload.active !== false,
    createdAt: payload.createdAt || now,
    updatedAt: now,
    createdBy: payload.createdBy || editor.email,
  };
  await firestoreDb.collection("products").doc(id).set(product, { merge: true });
  return product;
}
async function createOrderStore(payload, user) {
  const order = {
    id: `ORD-${Date.now()}`,
    productId: String(payload.productId || ""),
    productName: String(payload.productName || ""),
    amount: Number(payload.amount || 0),
    paymentMethod: String(payload.paymentMethod || "yape"),
    note: String(payload.note || "").trim(),
    status: "pending_payment",
    createdAt: new Date().toISOString(),
    user: { id: user.id, email: user.email, nombre: user.nombre },
  };
  await firestoreDb.collection("orders").doc(order.id).set(order, { merge: true });
  return order;
}
function buildWhatsAppUrl(order) {
  if (!storeSettings.whatsappNumber) return "";
  const text = ["Hola LUFFY LUXE STORE", `Pedido: ${order.id}`, `Producto: ${order.productName}`, `Monto: S/ ${order.amount}`, `Pago: ${order.paymentMethod}`, "Adjuntaré mi captura por este chat."].join("\n");
  return `https://wa.me/${storeSettings.whatsappNumber}?text=${encodeURIComponent(text)}`;
}
function syncUserToFile(user) {
  const users = loadUsers();
  const ix = users.findIndex(u => u.email === user.email);
  if (ix >= 0) users[ix] = { ...users[ix], ...user }; else users.push(user);
  saveUsers(users);
  return user;
}
async function findUserByEmailStore(email) {
  const normalized = (email || "").toLowerCase();
  if (!firestoreDb) return findUserByEmail(normalized);
  try {
    const snap = await firestoreDb.collection("users").where("email", "==", normalized).limit(1).get();
    if (!snap.empty) return syncUserToFile({ ...snap.docs[0].data(), id: Number(snap.docs[0].id) || snap.docs[0].data().id || Date.now() });
  } catch (e) { console.warn("findUserByEmailStore falló:", e && e.message); }
  return findUserByEmail(normalized);
}
async function createUserStore(user) {
  if (firestoreDb) try { await firestoreDb.collection("users").doc(String(user.id)).set(user, { merge: true }); } catch (e) { console.warn("createUserStore falló:", e && e.message); }
  return syncUserToFile(user);
}
async function upsertGoogleUserStore(profile) {
  if (!firestoreDb) return upsertGoogleUser(profile);
  const email = (profile.email || "").toLowerCase();
  try {
    const snap = await firestoreDb.collection("users").where("email", "==", email).limit(1).get();
    const base = snap.empty ? { id: Date.now(), email, createdAt: new Date().toISOString() } : { ...snap.docs[0].data(), id: Number(snap.docs[0].id) || snap.docs[0].data().id || Date.now() };
    const user = { ...base, email, nombre: base.nombre || profile.nombre || profile.given_name || "Usuario Google", password: base.password || null, provider: "google", avatar: profile.picture || base.avatar || "", googleSub: profile.sub || base.googleSub || "" };
    await firestoreDb.collection("users").doc(String(user.id)).set(user, { merge: true });
    return syncUserToFile(user);
  } catch (e) { console.warn("upsertGoogleUserStore falló:", e && e.message); }
  return upsertGoogleUser(profile);
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
function signAdminToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, nombre: user.nombre, role: "admin" },
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
function getAdminFromReq(req) {
  let token = req.cookies?.auth_token || req.cookies?.admin_token;
  if (!token) {
    const auth = req.headers?.authorization || "";
    if (auth.startsWith("Bearer ")) token = auth.slice(7);
  }
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "admin" || !isAdminEmail(decoded.email)) return null;
    return decoded;
  } catch {
    return null;
  }
}
function isValidAccessKey(password) {
  const value = String(password || "");
  return value.length >= 9 && value.length <= 10;
}
function requireAuth(req, res, next) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ status: "error", message: "Sesión inválida" });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const admin = getAdminFromReq(req);
  if (!admin) return res.status(401).json({ status: "error", message: "Sesión de admin inválida." });
  req.user = admin;
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

    const user = await findUserByEmailStore(email);
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

// POST /admin/login — login SEPARADO solo para administradores
app.post("/admin/login", async (req, res) => {
  try {
    const email = (req.body.email || "").toString().trim().toLowerCase();
    const password = (req.body.password || "").toString();

    if (!email || !password) {
      return res.status(400).json({ status: "error", message: "Faltan datos" });
    }
    if (!isAdminEmail(email)) {
      return res.status(403).json({ status: "error", message: "No tienes acceso de administrador." });
    }

    let user = findUserByEmail(email);
    if (!user) {
      try {
        const snap = await firestoreDb.collection("users").where("email", "==", email).limit(1).get();
        if (!snap.empty) user = { id: snap.docs[0].id, ...snap.docs[0].data() };
      } catch (_) {}
    }
    if (!user || !user.password) {
      return res.status(401).json({ status: "error", message: "Credenciales incorrectas. Regístrate primero en la web." });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ status: "error", message: "Contraseña incorrecta." });
    }

    const token = signAdminToken(user);
    const cookieOpts = {
      httpOnly: true,
      sameSite: "lax",
      secure: !!process.env.RENDER_EXTERNAL_URL,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };
    res.cookie("auth_token", token, cookieOpts);
    res.cookie("admin_token", token, cookieOpts);

    return res.json({
      status: "success",
      token: token,
      user: { id: user.id, email: user.email, nombre: user.nombre },
    });
  } catch (err) {
    console.error("admin/login error:", err);
    res.status(500).json({ status: "error", message: "Error interno" });
  }
});

// POST /admin/logout
app.post("/admin/logout", (req, res) => {
  res.clearCookie("admin_token");
  res.json({ status: "success" });
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
    if (!isValidAccessKey(password)) {
      return res.json({ status: "passwordlegn", message: "Tu llave debe tener entre 9 y 10 caracteres." });
    }

    const existingUser = await findUserByEmailStore(email);
    if (existingUser) {
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

    const existingUser = await findUserByEmailStore(email);
    if (existingUser) {
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
    await createUserStore(newUser);
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
  res.clearCookie("admin_token");
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
    const user = await upsertGoogleUserStore({
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
  if (!user) return res.json({ authed: false, debug: { cookie: !!rawToken, state: rawToken ? "invalid" : "missing" } });
  res.json({ authed: true, user: { id: user.id, email: user.email, nombre: user.nombre }, isAdmin: isAdminEmail(user.email), debug: { cookie: true, state: "valid" } });
});
app.get("/api/store/config", (req, res) => {
  const user = getUserFromReq(req);
  const admin = getAdminFromReq(req);
  const s = storeSettings;
  res.json({
    status: "success",
    authed: !!user,
    isAdmin: !!admin,
    whatsappNumber: s.whatsappNumber,
    paymentMethods: buildPaymentMethodsList(s),
  });
});
app.get("/api/products", async (req, res) => {
  if (!ensureFirestore(res)) return;
  try { res.json({ status: "success", items: await listProductsStore() }); }
  catch (err) { res.status(500).json({ status: "error", message: "No se pudieron cargar los productos." }); }
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Solo se permiten imágenes"));
  }
});

app.post("/api/admin/upload-image", requireAdmin, upload.single("image"), async (req, res) => {
  if (!ensureFirestore(res)) return;
  if (!req.file) return res.status(400).json({ status: "error", message: "No se recibió archivo" });
  try {
    const bucketName = firebaseBucketName || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`;
    const bucket = admin.storage().bucket(bucketName);
    const fileName = `products/${Date.now()}-${req.file.originalname.replace(/\s+/g, "_")}`;
    const file = bucket.file(fileName);
    await file.save(req.file.buffer, { metadata: { contentType: req.file.mimetype }, public: true, resumable: false });
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    res.json({ status: "success", url: publicUrl });
  } catch (err) {
    console.error("Upload error details:", err.code, err.message, err.errors || err.stack);
    res.status(500).json({ status: "error", message: "Error al subir imagen" });
  }
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await getStoreSettings();
    res.json({ status: "success", settings });
  } catch (err) {
    res.status(500).json({ status: "error", message: "No se pudieron cargar los ajustes." });
  }
});
app.put("/api/admin/settings", requireAdmin, express.json(), async (req, res) => {
  try {
    const { whatsappNumber, yapeNumber, yapeQR, plinNumber, plinQR, transferInfo, transferQR } = req.body || {};
    if (whatsappNumber) storeSettings.whatsappNumber = String(whatsappNumber).replace(/\D/g, "");
    if (yapeNumber !== undefined) storeSettings.yapeNumber = String(yapeNumber);
    if (yapeQR !== undefined) storeSettings.yapeQR = String(yapeQR);
    if (plinNumber !== undefined) storeSettings.plinNumber = String(plinNumber);
    if (plinQR !== undefined) storeSettings.plinQR = String(plinQR);
    if (transferInfo !== undefined) storeSettings.transferInfo = String(transferInfo);
    if (transferQR !== undefined) storeSettings.transferQR = String(transferQR);
    saveSettingsLocal(storeSettings);
    if (firestoreDb) {
      try { await firestoreDb.collection("settings").doc("store").set(storeSettings, { merge: true }); } catch (_) {}
    }
    res.json({ status: "success", settings: storeSettings });
  } catch (err) {
    res.status(500).json({ status: "error", message: "No se pudieron guardar los ajustes." });
  }
});

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  if (!ensureFirestore(res)) return;
  try { res.json({ status: "success", item: await saveProductStore(req.body || {}, req.user) }); }
  catch (err) { res.status(500).json({ status: "error", message: "No se pudo guardar el producto." }); }
});
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  if (!ensureFirestore(res)) return;
  try { await firestoreDb.collection("products").doc(String(req.params.id)).delete(); res.json({ status: "success" }); }
  catch (err) { res.status(500).json({ status: "error", message: "No se pudo borrar el producto." }); }
});
app.post("/api/orders", requireAuth, async (req, res) => {
  if (!ensureFirestore(res)) return;
  try {
    const order = await createOrderStore(req.body || {}, req.user);
    res.json({ status: "success", order, whatsappUrl: buildWhatsAppUrl(order), paymentMethods: buildPaymentMethodsList(storeSettings) });
  } catch (err) {
    res.status(500).json({ status: "error", message: "No se pudo registrar el pedido." });
  }
});

// Rutas de administración
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Rutas limpias (sin .html)
// Login normal de usuario => Google OAuth
app.get("/login", (req, res) => res.redirect("/google.html"));
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
