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

  let activeCategory = "Todos";

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
      applyCategoryFilter();
    };
    if (input) input.addEventListener("input", run);
    if (button) button.addEventListener("click", run);
  }

  function buildCategoryFilters() {
    const container = $("category-filters");
    if (!container) return;
    const cats = [...new Set(state.items.map(i => i.category || "Otros"))].sort();
    container.innerHTML = "";
    const allBtn = document.createElement("button");
    allBtn.textContent = "Todos";
    allBtn.style.cssText = "border:0;padding:8px 16px;border-radius:999px;font-weight:700;font-size:.85rem;cursor:pointer;white-space:nowrap;" + (activeCategory === "Todos" ? "background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;" : "background:rgba(30,41,59,.7);color:#94a3b8;");
    allBtn.onclick = () => { activeCategory = "Todos"; buildCategoryFilters(); applyCategoryFilter(); };
    container.appendChild(allBtn);
    cats.forEach(cat => {
      const btn = document.createElement("button");
      btn.textContent = cat;
      btn.style.cssText = "border:0;padding:8px 16px;border-radius:999px;font-weight:700;font-size:.85rem;cursor:pointer;white-space:nowrap;" + (activeCategory === cat ? "background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;" : "background:rgba(30,41,59,.7);color:#94a3b8;");
      btn.onclick = () => { activeCategory = cat; buildCategoryFilters(); applyCategoryFilter(); };
      container.appendChild(btn);
    });
  }

  function applyCategoryFilter() {
    const q = String($("search-inputdouble")?.value || "").trim().toLowerCase();
    let items = q ? state.items.filter(i => [i.name, i.description, i.category].join(" ").toLowerCase().includes(q)) : state.items.slice();
    if (activeCategory !== "Todos") items = items.filter(i => (i.category || "Otros") === activeCategory);
    state.filtered = items;
    renderProducts();
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
            <p style="color:#93c5fd;font-weight:800;font-size:.82rem;letter-spacing:.08em;text-transform:uppercase;">Pago por Yape</p>
            <h3 id="checkoutTitle" style="font-size:1.4rem;color:#fff;">Comprar producto</h3>
          </div>
          <button id="checkoutClose" type="button" style="border:0;border-radius:999px;background:rgba(239,68,68,.16);color:#fff;width:40px;height:40px;font-size:1.2rem;cursor:pointer;">✕</button>
        </div>
        <p id="checkoutMeta" style="color:#cbd5e1;margin-bottom:14px;"></p>
        <div id="checkoutMethods" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;"></div>
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
    const displayPrice = item.presalePrice || item.price;
    const yapeNumber = "918871372";
    const showQr = item.showQr !== false;
    const qrHtml = showQr
      ? `<img src="/yape-qr.png" alt="QR Yape" style="width:200px;height:200px;border-radius:16px;background:#fff;padding:8px;margin:8px auto;display:block;" />`
      : "";
    const instrucciones = showQr
      ? `<p style="color:#cbd5e1;font-size:.82rem;margin:0 0 12px;">Escanea el QR y paga <strong>S/ ${Number(displayPrice).toFixed(2)}</strong></p>`
      : `<p style="color:#cbd5e1;font-size:.82rem;margin:0 0 6px;">Yapea a: <strong style="color:#57ff5a;">${yapeNumber}</strong></p>
         <p style="color:#fcd34d;font-weight:800;font-size:1.1rem;margin:4px 0 12px;">${currency(displayPrice)}</p>`;

    title.textContent = item.name || "Comprar producto";
    meta.textContent = currency(displayPrice) + (item.presalePrice ? " (preventa)" : "") + " · " + (item.category || "General");
    methods.innerHTML = "";
    result.innerHTML = `
      <div style="text-align:center;">
        <p style="color:#93c5fd;font-weight:700;margin:0 0 6px;font-size:.85rem;">Pago por Yape</p>
        ${qrHtml}
        ${instrucciones}
        <a href="https://wa.me/51${yapeNumber}?text=${encodeURIComponent("Hola, compré " + item.name + " por " + currency(displayPrice) + ". Adjunto comprobante.")}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:999px;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;text-decoration:none;font-weight:800;font-size:.9rem;">
          Enviar comprobante por WhatsApp
        </a>
      </div>
    `;

    overlay.style.display = "flex";
  }

  function renderProducts() {
    const grid = $("stream-container");
    if (!grid) return;

    if (!state.filtered.length) {
      grid.innerHTML = `
        <section style="width:min(100%,760px);margin:0 auto;padding:26px;border-radius:28px;border:1px solid rgba(96,165,250,.18);background:linear-gradient(180deg,rgba(7,13,24,.92),rgba(4,8,18,.84));box-shadow:0 22px 48px rgba(0,0,0,.26);text-align:center;grid-column:1/-1;">
          <img src="/logosrevis.png" alt="LUFFY LUXE STORE" style="width:92px;height:92px;object-fit:cover;border-radius:999px;border:3px solid rgba(239,68,68,.82);display:block;margin:0 auto 14px;">
          <h3 style="margin:0 0 10px;color:#fff;">${activeCategory !== "Todos" ? "No hay productos en esta categoría" : "Aún no hay productos publicados"}</h3>
          <p style="margin:0;color:#cbd5e1;">${activeCategory !== "Todos" ? "Prueba otra categoría o sube productos desde el admin." : "Sube productos desde el panel admin y aquí aparecerán automáticamente."}</p>
        </section>
      `;
      return;
    }

    grid.innerHTML = state.filtered.map((item) => `
      <article style="border-radius:22px;border:1px solid rgba(96,165,250,.16);background:linear-gradient(180deg,rgba(7,13,24,.94),rgba(4,8,18,.88));box-shadow:0 14px 32px rgba(0,0,0,.22);overflow:hidden;">
        <img src="${escapeHtml(item.image || "/logosrevis.png")}" alt="${escapeHtml(item.name || "Producto")}" style="width:100%;height:180px;object-fit:cover;background:#0f172a;">
        <div style="padding:14px;display:grid;gap:8px;">
          <span style="display:inline-flex;width:fit-content;padding:4px 10px;border-radius:999px;background:rgba(127,29,29,.18);border:1px solid rgba(250,204,21,.26);color:#fcd34d;font-size:.75rem;font-weight:800;">${escapeHtml(item.category || "General")}</span>
          <h3 style="margin:0;color:#fff;font-size:1.05rem;">${escapeHtml(item.name || "Sin nombre")}</h3>
          <p style="margin:0;color:#cbd5e1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:3em;font-size:.88rem;">${escapeHtml(item.description || "Sin descripción")}</p>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div>
              ${item.presalePrice
                ? `<span style="font-size:1rem;color:#fff;text-decoration:line-through;opacity:0.5;margin-right:6px;">${currency(item.price)}</span><strong style="font-size:1rem;color:#86efac;">${currency(item.presalePrice)}</strong>`
                : `<strong style="font-size:1rem;color:#fff;">${currency(item.price)}</strong>`
              }
            </div>
            <button data-buy="${escapeHtml(item.id)}" type="button" style="border:0;cursor:pointer;padding:10px 16px;border-radius:999px;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;font-weight:800;font-size:.88rem;">Comprar</button>
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
      buildCategoryFilters();
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
