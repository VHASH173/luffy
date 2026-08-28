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

  function setBusy(state) {
    if (loader) loader.style.display = state ? "block" : "none";
    if (submitBtn) submitBtn.disabled = !!state;
  }

  function setMsg(text, ok = false) {
    if (!googleMsg) return;
    googleMsg.textContent = text;
    googleMsg.style.color = ok ? "#86efac" : "#cbd5e1";
  }

  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || "Error de servidor");
    return data;
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
      location.href = data.redirect || "/productos.html";
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

      location.href = verify.redirect || "/productos.html";
    } catch (err) {
      alert(err.message || "No se pudo registrar");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogleCredential(response) {
    setBusy(true);
    setMsg("Entrando con Google...");
    try {
      const data = await postJSON("/secure/google-login", {
        credential: response.credential,
      });
      if (data.status !== "success") {
        throw new Error(data.message || "No se pudo iniciar con Google");
      }
      setMsg("Login con Google correcto", true);
      location.href = data.redirect || "/productos.html";
    } catch (err) {
      setMsg(err.message || "Falló Google Sign-In");
      alert(err.message || "Falló Google Sign-In");
    } finally {
      setBusy(false);
    }
  }

  async function initGoogle() {
    try {
      const r = await fetch("/api/auth/config", { credentials: "include" });
      const cfg = await r.json();
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
      });

      window.google.accounts.id.renderButton(googleBtn, {
        theme: "outline",
        size: "large",
        text: isRegisterPage ? "signup_with" : "signin_with",
        shape: "pill",
        width: 320,
      });

      setMsg(isRegisterPage ? "Puedes crear cuenta con Google en un clic." : "Puedes entrar con Google en un clic.");
    } catch (err) {
      setMsg("No se pudo cargar Google Sign-In.");
    }
  }

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