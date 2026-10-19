"""Prueba de punta a punta (sprints 0 y 1).

login → alta de local → salón → carta (categorías, modificadores, productos) →
pedido en mesa con modificadores y nota → envío a cocina → cancelar ítem →
venta de mostrador → comandas abiertas → vista tablet → cerrar sesión.

Uso:  npm run build && npx vite preview --port 4173 &   y luego   python3 tests/e2e/test_flows.py
"""
import os
import sys
from playwright.sync_api import sync_playwright, expect
from fake_supabase import FakeSupabase, EMAIL, PASSWORD

BASE = "http://127.0.0.1:4173"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")
os.makedirs(OUT, exist_ok=True)
proxy = os.environ.get("HTTPS_PROXY")


def shot(page, name):
    page.wait_for_timeout(350)  # deja terminar la animación de las hojas
    page.screenshot(path=f"{OUT}/{name}.png")


with sync_playwright() as p:
    browser = p.chromium.launch(args=[f"--proxy-server={proxy}", "--proxy-bypass-list=127.0.0.1;localhost"] if proxy else [])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="es-AR")
    page = ctx.new_page()
    fake = FakeSupabase()
    page.route("https://mosfrmkbutyqqckjnkkd.supabase.co/**", fake.handle)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))

    # ---------- Acceso y alta de local ----------
    page.goto(BASE)
    page.get_by_label("Email").fill(EMAIL)
    page.get_by_label("Contraseña").fill("mal-password")
    page.get_by_role("button", name="Iniciar sesión").last.click()
    expect(page.get_by_role("alert")).to_contain_text("no coinciden")
    page.get_by_label("Contraseña").fill(PASSWORD)
    page.get_by_role("button", name="Iniciar sesión").last.click()

    page.get_by_label("Nombre del local").fill("Bodegón QA")
    page.get_by_label("Cantidad de mesas").fill("12")
    page.get_by_role("button", name="Crear local").click()
    expect(page.locator(".table-tile")).to_have_count(12, timeout=15000)
    expect(page.locator(".floor-summary")).to_contain_text("12libres")

    # ---------- Mesa sin carta: se abre y se libera ----------
    page.get_by_role("button", name="Mesa 5, libre").click()
    page.get_by_role("button", name="Abrir mesa y cargar pedido").click()
    expect(page.get_by_role("heading", name="Mesa 5")).to_be_visible()
    expect(page.get_by_text("La carta está vacía")).to_be_visible()
    page.get_by_role("link", name="Volver").click()
    page.get_by_role("button", name="Mesa 5, ocupada").click()
    page.get_by_role("button", name="Liberar mesa").click()
    expect(page.get_by_role("button", name="Mesa 5, libre")).to_be_visible()

    # ---------- Carta ----------
    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Carta").click()
    expect(page.get_by_text("Tu carta está vacía")).to_be_visible()
    for cat in ["Principales", "Bebidas"]:
        page.get_by_role("button", name="Nueva categoría").click()
        page.get_by_label("Nombre").fill(cat)
        page.get_by_role("button", name="Guardar categoría").click()
        expect(page.get_by_role("heading", name=cat)).to_be_visible()

    page.get_by_role("link", name="Modificadores (0)").click()
    page.get_by_role("button", name="Nuevo grupo").click()
    page.get_by_label("Nombre del grupo").fill("Punto de la carne")
    page.get_by_label("Mínimo a elegir").fill("1")
    page.get_by_label("Máximo a elegir").fill("1")
    page.get_by_label("Opción 1", exact=True).fill("Jugoso")
    for i, name in [(2, "A punto"), (3, "Cocido")]:
        page.get_by_role("button", name="Agregar opción").click()
        page.get_by_label(f"Opción {i}", exact=True).fill(name)
    page.get_by_role("button", name="Guardar grupo").click()
    expect(page.get_by_text("Obligatorio, elegir 1")).to_be_visible()

    page.get_by_role("button", name="Nuevo grupo").click()
    page.get_by_label("Nombre del grupo").fill("Guarnición")
    page.get_by_label("Mínimo a elegir").fill("0")
    page.get_by_label("Máximo a elegir").fill("2")
    page.get_by_label("Opción 1", exact=True).fill("Papas fritas")
    page.get_by_label("Precio adicional de la opción 1").fill("2500")
    page.get_by_role("button", name="Agregar opción").click()
    page.get_by_label("Opción 2", exact=True).fill("Ensalada")
    page.get_by_label("Precio adicional de la opción 2").fill("1800")
    page.get_by_role("button", name="Guardar grupo").click()
    expect(page.get_by_text("Opcional, hasta 2")).to_be_visible()
    shot(page, "s1-01-modificadores")
    page.get_by_role("link", name="Volver a la carta").click()

    def new_product(name, price, category, station=None, groups=(), favorite=False):
        page.get_by_role("button", name="Nuevo producto").click()
        page.get_by_label("Nombre").fill(name)
        page.get_by_label("Precio").fill(price)
        page.get_by_label("Categoría").select_option(label=category)
        if station:
            page.get_by_label("Se prepara en").select_option(label=station)
        for g in groups:
            page.get_by_role("checkbox", name=g).check()
        if favorite:
            page.get_by_role("checkbox", name="Favorito").check()
        page.get_by_role("button", name="Guardar producto").click()
        expect(page.get_by_text(name, exact=True)).to_be_visible()

    new_product("Bife de chorizo", "15000", "Principales", groups=["Punto de la carne", "Guarnición"])
    new_product("Milanesa napolitana", "12.500", "Principales", favorite=True)
    new_product("Agua sin gas", "2000", "Bebidas", station="Barra")
    expect(page.get_by_text("$ 12.500")).to_be_visible()
    shot(page, "s1-02-carta")

    # ---------- Pedido en mesa ----------
    page.get_by_role("link", name="Salón").click()
    page.get_by_role("button", name="Mesa 3, libre").click()
    page.get_by_role("button", name="Abrir mesa y cargar pedido").click()
    expect(page.get_by_role("heading", name="Mesa 3")).to_be_visible()

    page.get_by_role("button", name="Favoritos").click()
    page.get_by_role("button", name="Milanesa napolitana $ 12.500").click()
    page.get_by_role("button", name="Milanesa napolitana $ 12.500").click()

    page.get_by_role("button", name="Principales").click()
    page.get_by_role("button", name="Bife de chorizo $ 15.000").click()
    expect(page.get_by_role("dialog")).to_contain_text("Punto de la carne")
    page.get_by_role("radio", name="A punto").check()
    page.get_by_role("checkbox", name="Papas fritas").check()
    page.get_by_label("Nota para cocina").fill("sin sal")
    shot(page, "s1-03-modificadores-pedido")
    page.get_by_role("button", name="Agregar · $ 17.500").click()

    page.get_by_role("button", name="Bebidas").click()
    page.get_by_role("button", name="Agua sin gas $ 2.000").click()
    expect(page.locator(".order-bar")).to_contain_text("4 por enviar")
    expect(page.locator(".order-bar")).to_contain_text("$ 44.500")
    shot(page, "s1-04-comanda-celular")

    page.get_by_role("button", name="Ver pedido").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_contain_text("A punto, Papas fritas")
    expect(dialog).to_contain_text("sin sal")
    expect(dialog.locator(".ticket-item").filter(has_text="Milanesa").locator(".stepper span")).to_have_text("2")
    shot(page, "s1-05-pedido")
    dialog.locator(".ticket-item").filter(has_text="Agua sin gas").get_by_role("button", name="Uno menos").click()
    expect(dialog).not_to_contain_text("Agua sin gas")
    dialog.get_by_role("button", name="Enviar a cocina · $ 42.500").click()
    expect(page.locator(".order-bar")).to_contain_text("3 enviados")

    # el salón refleja la mesa ocupada con su total
    page.get_by_role("link", name="Volver").click()
    expect(page.get_by_role("button", name="Mesa 3, ocupada")).to_contain_text("$ 42.500")

    # cancelar un ítem ya enviado
    page.get_by_role("button", name="Mesa 3, ocupada").click()
    page.get_by_role("button", name="Ver comanda").click()
    page.get_by_role("button", name="Ver pedido").click()
    page.get_by_role("button", name="Ver Bife de chorizo").click()
    page.get_by_role("button", name="Cancelar ítem y avisar a cocina").click()
    expect(page.locator(".order-bar")).to_contain_text("$ 25.000")
    page.get_by_role("button", name="Seguir cargando").click()

    # ---------- Venta de mostrador ----------
    page.get_by_role("link", name="Comandas").click()
    page.get_by_role("button", name="Venta de mostrador").click()
    page.get_by_role("button", name="Para llevar").click()
    page.get_by_label("Nombre del cliente").fill("Juan")
    page.get_by_role("button", name="Empezar venta").click()
    expect(page.get_by_role("heading", name="Para llevar · Juan")).to_be_visible()
    page.get_by_role("button", name="Bebidas").click()
    page.get_by_role("button", name="Agua sin gas $ 2.000").click()
    page.get_by_role("link", name="Volver").click()
    expect(page.get_by_text("Mesa 3")).to_be_visible()
    expect(page.get_by_text("1 por enviar")).to_be_visible()
    shot(page, "s1-06-comandas")

    # ---------- Tablet ----------
    page.set_viewport_size({"width": 1180, "height": 820})
    page.get_by_role("button", name="Para llevar · Juan").click()
    expect(page.locator(".ticket-pane")).to_be_visible()
    shot(page, "s1-07-comanda-tablet")

    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Cerrar sesión").click()
    expect(page.get_by_label("Email")).to_be_visible()

    browser.close()
    real = [e for e in errors if "WebSocket" not in e and "realtime" not in e.lower() and "status of 400" not in e]
    print("ERRORES DE CONSOLA:", real or "ninguno")
    if real:
        sys.exit(1)
    print("E2E OK")
