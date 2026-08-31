(() => {
  const state = {
    items: [],
    filtered: [],
    config: { isAdmin: false, paymentMethods: [] },
    current: null,
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function fetchJSON(url, options) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status === "error") {
      throw new Error(data.message || "Error de servidor");
    }
    return data;
  }

  function hideSection(node) {
    if (!node) return;
    node.style.display = "none";
    node.hidden = true;
  }

  function hideLoader() {
    const loader = $("contener_kik_lop");
    if (loader) loader.style.display = "none";
  }

  function isAuthed() {
    return !!window.__LUFFY_ME__;
  }

  function setStatus(main, sub, allowHtml) {
    const statusText = $("model_buyresting");
    const statusSub = $("i9844_sur");
    if (statusText) statusText.textContent = main || "";
    if (statusSub) {
      if (allowHtml) statusSub.innerHTML = sub || "";
      else statusSub.textContent = sub || "";
    }
  }

  function currency(value) {
    return "S/ " + Number(value || 0).toFixed(2);
  }

  function bindSearch() {
    const input = $("search-inputdouble");
    const button = $("search-icondouble");
    const run = () => {
      const q = String(input?.value || "").trim().toLowerCase();
      state.filtered = !q
        ? state.items.slice()
        : state.items.filter((item) =>
            [item.name, item.description, item.category].join(" ").toLowerCase().includes(q)
          );
      renderProducts();
    };
    if (input) input.addEventListener("input", run);
    if (button) button.addEventListener("click", run);
  }

  function ensureModal() {
    if (document.getElementById("storeCheckoutOverlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "storeCheckoutOverlay";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "display:none",
      "align-items:center",
      "justify-content:center",
      "padding:20px",
      "background:rgba(2,6,23,.78)",
      "backdrop-filter:blur(10px)",
      "z-index:9999"
    ].join(";");

    overlay.innerHTML = `
      <div style="width:min(100%,560px);border-radius:28px;border:1px solid rgba(96,165,250,.18);background:linear-gradient(180deg,rgba(7,13,24,.96),rgba(4,8,18,.9));box-shadow:0 24px 60px rgba(0,0,0,.34);padding:22px;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:16px;">
          <div>
            <p style="color:#93c5fd;font-weight:800;font-size:.82rem;letter-spacing:.08em;text-transform:uppercase;">Pago manual</p>
            <h3 id="checkoutTitle" style="font-size:1.4rem;color:#fff;">Comprar producto</h3>
          </div>
          <button id="checkoutClose" type="button" style="border:0;border-radius:999px;background:rgba(239,68,68,.16);color:#fff;width:40px;height:40px;font-size:1.2rem;cursor:pointer;">✕</button>
        </div>
        <p id="checkoutMeta" style="color:#cbd5e1;margin-bottom:14px;"></p>
        <div id="checkoutMethods" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;"></div>
        <textarea id="checkoutNote" placeholder="Opcional: detalle del pedido o referencia..." style="width:100%;min-height:100px;border-radius:18px;border:1px solid rgba(96,165,250,.18);background:rgba(15,23,42,.72);color:#fff;padding:14px 16px;outline:none;"></textarea>
        <div id="checkoutResult" style="margin-top:14px;color:#cbd5e1;"></div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.style.display = "none";
    });
    document.getElementById("checkoutClose").addEventListener("click", () => {
      overlay.style.display = "none";
    });
  }

  async function submitOrder(methodId) {
    const method = (state.config.paymentMethods || []).find((item) => item.id === methodId);
    const result = document.getElementById("checkoutResult");
    const note = document.getElementById("checkoutNote").value.trim();

    result.textContent = "Registrando pedido...";
    try {
      const data = await fetchJSON("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          productId: state.current.id,
          productName: state.current.name,
          amount: state.current.price,
          paymentMethod: methodId,
          note,
        }),
      });

      const target = method && method.target ? method.target : "Configura este método en Render";
      const waButton = data.whatsappUrl
        ? `<a href="${data.whatsappUrl}" target="_blank" rel="noopener" style="display:inline-flex;margin-top:12px;padding:12px 18px;border-radius:999px;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;text-decoration:none;font-weight:800;">Enviar pedido por WhatsApp</a>`
        : "";

      result.innerHTML = `
        <div style="padding:16px;border-radius:18px;border:1px solid rgba(96,165,250,.18);background:rgba(15,23,42,.6);">
          <strong style="display:block;color:#86efac;margin-bottom:8px;">Pedido registrado: ${escapeHtml(data.order.id)}</strong>
          <p style="margin:0 0 8px;color:#e5e7eb;">Método: <strong>${escapeHtml(method ? method.label : methodId)}</strong></p>
          <p style="margin:0 0 8px;color:#e5e7eb;">Monto: <strong>${currency(state.current.price)}</strong></p>
          <p style="margin:0;color:#cbd5e1;">Dato de pago: <strong>${escapeHtml(target)}</strong></p>
          <p style="margin:10px 0 0;color:#cbd5e1;">Haz el pago y adjunta la captura manualmente por WhatsApp.</p>
          ${waButton}
        </div>
      `;
    } catch (error) {
      result.innerHTML = `<span style="color:#fca5a5;">${escapeHtml(error.message || "No se pudo registrar el pedido.")}</span>`;
    }
  }

  function openCheckout(item) {
    if (!isAuthed()) {
      setStatus("🔐 Estás viendo la tienda como invitado.", '<a href="/google" style="color:#93c5fd;text-decoration:none;font-weight:800;">Inicia sesión para comprar</a>', true);
      return;
    }
    state.current = item;
    ensureModal();

    const overlay = document.getElementById("storeCheckoutOverlay");
    const title = document.getElementById("checkoutTitle");
    const meta = document.getElementById("checkoutMeta");
    const methods = document.getElementById("checkoutMethods");
    const result = document.getElementById("checkoutResult");
    const itemMethods = Array.isArray(item.paymentMethods) && item.paymentMethods.length
      ? item.paymentMethods
      : ["yape", "plin"];

    title.textContent = item.name || "Comprar producto";
    meta.textContent = `${currency(item.price)} · ${item.category || "General"}`;
    result.innerHTML = "";
    methods.innerHTML = itemMethods.map((methodId) => {
      const info = (state.config.paymentMethods || []).find((entry) => entry.id === methodId);
      return `<button data-method="${escapeHtml(methodId)}" type="button" style="border:0;cursor:pointer;padding:12px 16px;border-radius:999px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;font-weight:800;">${escapeHtml(info ? info.label : methodId)}</button>`;
    }).join("");

    methods.querySelectorAll("[data-method]").forEach((button) => {
      button.addEventListener("click", () => submitOrder(button.getAttribute("data-method")));
    });

    overlay.style.display = "flex";
  }

  function renderProducts() {
    const grid = $("stream-container");
    if (!grid) return;

    if (!state.filtered.length) {
      grid.innerHTML = `
        <section style="width:min(100%,760px);margin:0 auto;padding:26px;border-radius:28px;border:1px solid rgba(96,165,250,.18);background:linear-gradient(180deg,rgba(7,13,24,.92),rgba(4,8,18,.84));box-shadow:0 22px 48px rgba(0,0,0,.26);text-align:center;">
          <img src="/logosrevis.png" alt="LUFFY LUXE STORE" style="width:92px;height:92px;object-fit:cover;border-radius:999px;border:3px solid rgba(239,68,68,.82);display:block;margin:0 auto 14px;">
          <h3 style="margin:0 0 10px;color:#fff;">Aún no hay productos publicados</h3>
          <p style="margin:0;color:#cbd5e1;">Sube productos desde el panel admin y aquí aparecerán automáticamente.</p>
        </section>
      `;
      return;
    }

    grid.innerHTML = state.filtered.map((item) => `
      <article style="border-radius:26px;border:1px solid rgba(96,165,250,.16);background:linear-gradient(180deg,rgba(7,13,24,.94),rgba(4,8,18,.88));box-shadow:0 18px 42px rgba(0,0,0,.24);overflow:hidden;">
        <img src="${escapeHtml(item.image || "/logosrevis.png")}" alt="${escapeHtml(item.name || "Producto")}" style="width:100%;height:220px;object-fit:cover;background:#0f172a;">
        <div style="padding:18px;display:grid;gap:10px;">
          <span style="display:inline-flex;width:fit-content;padding:6px 10px;border-radius:999px;background:rgba(127,29,29,.18);border:1px solid rgba(250,204,21,.26);color:#fcd34d;font-size:.8rem;font-weight:800;">${escapeHtml(item.category || "General")}</span>
          <h3 style="margin:0;color:#fff;font-size:1.18rem;">${escapeHtml(item.name || "Sin nombre")}</h3>
          <p style="margin:0;color:#cbd5e1;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;max-height:4.5em;">${escapeHtml(item.description || "Sin descripción")}</p>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
            <strong style="font-size:1.15rem;color:#fff;">${currency(item.price)}</strong>
            <button data-buy="${escapeHtml(item.id)}" type="button" style="border:0;cursor:pointer;padding:12px 18px;border-radius:999px;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;font-weight:800;">Comprar</button>
          </div>
        </div>
      </article>
    `).join("");

    grid.querySelectorAll("[data-buy]").forEach((button) => {
      button.addEventListener("click", () => {
        const item = state.items.find((entry) => entry.id === button.getAttribute("data-buy"));
        if (item) openCheckout(item);
      });
    });
  }

  async function init() {
    [
      $("categoriesdv"),
      $("container-strmr"),
      $("claster_social"),
      $("empty_aviament"),
      $("claseter_top"),
      $("claseter_topai"),
      $("contener_kik_lop09"),
      $("containeradultscategory"),
      $("pagination-controls-sav"),
    ].forEach(hideSection);

    bindSearch();
    setStatus("⏳ Cargando catálogo real...", "Espera un momento");

    try {
      const [configData, productsData] = await Promise.all([
        fetchJSON("/api/store/config"),
        fetchJSON("/api/products"),
      ]);

      state.config = configData;
      state.items = Array.isArray(productsData.items) ? productsData.items : [];
      state.filtered = state.items.slice();

      const sub = configData.isAdmin
        ? '<a href="/admin" style="color:#93c5fd;text-decoration:none;font-weight:800;">Abrir panel admin</a>'
        : (configData.authed ? "Tu cuenta está lista para comprar." : '<a href="/google" style="color:#93c5fd;text-decoration:none;font-weight:800;">Estás como invitado, inicia sesión para comprar</a>');

      setStatus(
        state.items.length ? (configData.authed ? "✅ Catálogo listo para comprar." : "👀 Catálogo visible como invitado.") : "📦 Aún no hay productos publicados.",
        sub,
        true
      );

      renderProducts();
    } catch (error) {
      setStatus("❌ No se pudo cargar el catálogo.", error.message || "Revisa Firestore.");
      const grid = $("stream-container");
      if (grid) {
        grid.innerHTML = `<div style="padding:22px;border-radius:22px;border:1px solid rgba(239,68,68,.18);background:rgba(127,29,29,.12);color:#fecaca;text-align:center;">${escapeHtml(error.message || "Error cargando productos")}</div>`;
      }
    } finally {
      hideLoader();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
