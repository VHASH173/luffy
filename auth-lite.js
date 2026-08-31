(() => {
  const $ = (s) => document.querySelector(s);
  const form = $("form.login-module__Si-P0q__form");
  const emailInput = $("#emailuser");
  const passwordInput = $("#showpassword");
  const nameInput = $("#nameuser");
  const phoneInput = $("#phoneuser");
  const loader = $("#contener_kik_lop");
  const googleMsg = $("#googleAuthMsg");
  const googleBtn = $("#googleSignInBtn");
  const submitBtn = $("#onreadyregister");
  const isRegisterPage = !!nameInput;
  const REQUEST_TIMEOUT_MS = 30000;

  function setBusy(state) {
    if (loader) loader.style.display = state ? "block" : "none";
    if (submitBtn) submitBtn.disabled = !!state;
  }

  function setMsg(text, ok = false) {
    if (!googleMsg) return;
    googleMsg.textContent = text;
    googleMsg.style.color = ok ? "#86efac" : "#cbd5e1";
  }

  function stashUser(user, redirect) {
    try {
      if (!user) return;
      sessionStorage.setItem("__LUFFY_LOGIN_BOOTSTRAP__", JSON.stringify({
        user,
        redirect: redirect || "/perfil",
        ts: Date.now()
      }));
    } catch {}
  }

  async function postJSON(url, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || "Error de servidor");
      return data;
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error("El servidor tardó demasiado. Intenta otra vez.");
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function handleLogin(ev) {
    ev.preventDefault();
    setBusy(true);
    try {
      const data = await postJSON("/secure/login", {
        emailuser: emailInput?.value?.trim() || "",
        showpassword: passwordInput?.value || "",
        cfToken: "demo-turnstile-token",
      });
      if (data.status !== "success") {
        throw new Error(data.message || "No se pudo iniciar sesión");
      }
      stashUser(data.user, "/perfil");
      location.href = data.redirect || "/productos";
    } catch (err) {
      alert(err.message || "No se pudo iniciar sesión");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister(ev) {
    ev.preventDefault();
    setBusy(true);
    try {
      const reg = await postJSON("/secure/register", {
        emailuser: emailInput?.value?.trim() || "",
        nameuser: nameInput?.value?.trim() || "",
        showpassword: passwordInput?.value || "",
        phoneuser: phoneInput?.value?.trim() || "",
        cfToken: "demo-turnstile-token",
      });

      if (reg.status !== "success_mail") {
        throw new Error(reg.message || "No se pudo registrar");
      }

      const code = window.prompt("Escribe el código de verificación. Demo: 123456", "123456");
      if (!code) throw new Error("Verificación cancelada");

      const verify = await postJSON("/secure/verify-code", {
        email: emailInput?.value?.trim() || "",
        code,
      });

      if (verify.status !== "success") {
        throw new Error(verify.message || "No se pudo verificar la cuenta");
      }

      stashUser(verify.user, "/perfil");
      location.href = verify.redirect || "/productos";
    } catch (err) {
      alert(err.message || "No se pudo registrar");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogleCredential(response) {
    const credential = response?.credential || "";
    if (!credential) {
      setMsg("Google no devolvió la credencial. Intenta otra vez.");
      alert("Google no devolvió la credencial. Intenta otra vez.");
      return;
    }
    setBusy(true);
    setMsg("Entrando con Google...");
    try {
      const data = await postJSON("/secure/google-login", {
        credential,
      });
      if (data.status !== "success") {
        throw new Error(data.message || "No se pudo iniciar con Google");
      }
      stashUser(data.user, "/perfil");
      setMsg("Login con Google correcto", true);
      location.href = data.redirect || "/productos";
    } catch (err) {
      setMsg(err.message || "Falló Google Sign-In");
      alert(err.message || "Falló Google Sign-In");
    } finally {
      setBusy(false);
    }
  }

  async function initGoogle() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch("/api/auth/config", {
        credentials: "include",
        signal: controller.signal,
      });
      const cfg = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error("No se pudo leer la config de Google.");
      }
      if (!cfg.googleClientId) {
        setMsg("Falta configurar GOOGLE_CLIENT_ID en Render.");
        return;
      }
      if (!window.google || !window.google.accounts || !googleBtn) {
        setMsg("Google Sign-In aún no cargó. Refresca la página.");
        return;
      }

      window.google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: handleGoogleCredential,
        auto_select: false,
        cancel_on_tap_outside: true,
        context: isRegisterPage ? "signup" : "signin",
        itp_support: true,
      });

      window.google.accounts.id.renderButton(googleBtn, {
        theme: "outline",
        size: "large",
        text: isRegisterPage ? "signup_with" : "signin_with",
        shape: "pill",
        width: Math.min(380, googleBtn.clientWidth || 380),
        locale: "es",
      });

      setMsg(isRegisterPage ? "Puedes crear cuenta con Google en un clic." : "Puedes entrar con Google en un clic.");
    } catch (err) {
      if (err && err.name === "AbortError") {
        setMsg("Google tardó demasiado en cargar. Recarga la página.");
      } else {
        setMsg(err.message || "No se pudo cargar Google Sign-In.");
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // === Corte "mano firme" a Google ===
  // Desde la página de registro, el link "Iniciar sesión" debe ir a /google (no a manual).
  // Desde el login manual, el link "Regístrate" sigue a /unirme (se mantiene plan B).
  (function fixLinks() {
    try {
      var openregister = document.getElementById("openregister");
      if (openregister && openregister.tagName === "A") {
        if (isRegisterPage) {
          // En registro: link "Iniciar sesión" => ventana solo Google.
          openregister.setAttribute("href", "/google");
          openregister.textContent = "Iniciar con Google";
        }
      }
      // Si alguien abre /login-manual y NO tiene sesión, mostramos un link para ir a /google.
      var manualHint = document.createElement("div");
      manualHint.style.margin = "10px 0 0";
      manualHint.style.textAlign = "center";
      manualHint.style.fontSize = "12px";
      manualHint.style.color = "#86efac";
      if (!isRegisterPage && form) {
        manualHint.innerHTML = 'Modo manual. Recomendado: <a href="/google" style="color:#86efac;text-decoration:underline;">entrar con Google</a>.';
        form.parentNode.insertBefore(manualHint, form.nextSibling);
      }
    } catch (_) {}
  })();

  if (form) {
    form.addEventListener("submit", isRegisterPage ? handleRegister : handleLogin);
  }

  let tries = 0;
  const waitGoogle = setInterval(() => {
    tries += 1;
    if (window.google?.accounts?.id) {
      clearInterval(waitGoogle);
      initGoogle();
    } else if (tries > 60) {
      clearInterval(waitGoogle);
      setMsg("Google no cargó. Revisa tu conexión o el client id.");
    }
  }, 250);
})();