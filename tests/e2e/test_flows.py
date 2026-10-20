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
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="es-AR",
                              timezone_id="America/Argentina/Buenos_Aires")
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

    # ---------- Sprint 2 · Cocina (en tablet) ----------
    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Pantalla de cocina").click()
    ticket = page.locator(".kds-ticket").filter(has_text="Mesa 3")
    expect(ticket).to_contain_text("Milanesa napolitana")
    expect(ticket).to_contain_text("Cancelado")  # el bife cancelado se ve tachado
    page.get_by_role("button", name="Activar sonido").click()
    ticket.get_by_role("button", name="Empezar", exact=True).click()
    expect(ticket).to_contain_text("En preparación")
    shot(page, "s2-01-cocina")
    ticket.get_by_role("button", name="Todo listo", exact=True).click()
    expect(page.locator(".kds-ready")).to_contain_text("Mesa 3")
    expect(page.get_by_text("No hay pedidos para preparar.")).to_be_visible()

    # ---------- El mozo ve el plato listo y lo entrega ----------
    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("link", name="Salón").click()
    listo = page.get_by_role("button", name="Mesa 3, ocupada, con platos listos")
    expect(listo).to_contain_text("Listo para servir")
    listo.click()
    page.get_by_role("button", name="Ver comanda").click()
    page.get_by_role("button", name="Ver pedido").click()
    page.get_by_role("button", name="Ver Milanesa napolitana").click()
    page.get_by_role("button", name="Marcar entregado").click()
    expect(page.get_by_role("dialog", name="Pedido")).to_contain_text("Entregado")

    # ---------- Cobro sin caja abierta: efectivo deshabilitado ----------
    page.get_by_role("button", name="Cobrar · $ 25.000").click()
    expect(page.get_by_text("La caja está cerrada")).to_be_visible()
    expect(page.get_by_role("radio", name="Efectivo")).to_be_disabled()
    page.get_by_role("button", name="Volver al pedido").click()

    # ---------- Abrir caja ----------
    page.get_by_role("link", name="Caja").click()
    page.get_by_label("Efectivo inicial").fill("20000")
    page.get_by_role("button", name="Abrir caja").click()
    expect(page.locator(".cash-expected")).to_contain_text("$ 20.000")

    # ---------- Cobrar mesa 3: 10 % de descuento, débito + efectivo con propina y vuelto ----------
    page.get_by_role("link", name="Comandas").click()
    page.get_by_role("button", name="Mesa 3").click()
    page.get_by_role("button", name="Ver pedido").click()
    page.get_by_role("button", name="Cobrar · $ 25.000").click()
    pay = page.get_by_role("dialog")
    page.get_by_label("Descuento ($)").fill("10")
    pay.get_by_role("button", name="%", exact=True).click()
    pay.get_by_role("button", name="Aplicar").click()
    expect(pay.locator(".ticket-total")).to_contain_text("$ 22.500")
    pay.get_by_role("radio", name="Débito").click()
    page.get_by_label("Monto").fill("10000")
    pay.get_by_role("button", name="Registrar pago · $ 10.000").click()
    expect(pay.locator(".ticket-total")).to_contain_text("$ 12.500")
    pay.get_by_role("radio", name="Efectivo").click()
    page.get_by_label("Propina").fill("1500")
    page.get_by_label("Paga con").fill("20000")
    expect(pay.locator(".change-line")).to_contain_text("$ 6.000")
    shot(page, "s2-02-cobro")
    pay.get_by_role("button", name="Registrar pago · $ 12.500").click()
    pay.get_by_role("button", name="Cerrar comanda").click()
    expect(page.get_by_role("button", name="Mesa 3, libre")).to_be_visible()

    # ---------- Venta de mostrador: se cobra antes y lo pendiente va a cocina al cerrar ----------
    page.get_by_role("link", name="Comandas").click()
    page.get_by_role("button", name="Para llevar · Juan").click()
    page.get_by_role("button", name="Ver pedido").click()
    page.get_by_role("button", name="Cobrar · $ 2.000").click()
    pay = page.get_by_role("dialog")
    pay.get_by_role("radio", name="Mercado Pago").click()
    expect(page.get_by_label("Propina")).to_have_count(0)   # con QR no se suma propina
    pay.get_by_role("button", name="Mostrar QR · $ 2.000").click()
    qr = page.get_by_role("dialog", name="Cobrar con QR")
    expect(qr.get_by_role("img", name="Código QR de Mercado Pago").locator("svg")).to_be_visible()
    expect(qr).to_contain_text("Esperando el pago · vence en 1")
    shot(page, "s6-01-qr")
    assert not fake.db["payments"] or all(p["amount"] != 2000 for p in fake.db["payments"])
    fake.mp_pay = True   # el cliente escanea y paga
    expect(qr).to_contain_text("Pago aprobado", timeout=10000)
    shot(page, "s6-02-qr-aprobado")
    fake.mp_pay = False
    qr.get_by_role("button", name="Seguir").click()
    pay = page.get_by_role("dialog", name="Cobrar")
    expect(pay.locator(".ticket-row").filter(has_text="Mercado Pago")).to_contain_text("$ 2.000")
    expect(pay).to_contain_text("Al cerrar, el producto sin enviar va a cocina.")
    pay.get_by_role("button", name="Cerrar comanda").click()
    expect(page.get_by_text("No hay comandas abiertas")).to_be_visible()
    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Pantalla de cocina").click()
    expect(page.locator(".kds-ticket").filter(has_text="Para llevar · Juan")).to_contain_text("Agua sin gas")

    # ---------- Caja: retiro y cierre con arqueo ----------
    page.get_by_role("link", name="Caja").click()
    expected = page.locator(".cash-expected")
    expect(expected).to_contain_text("$ 34.000")  # 20.000 + 12.500 + 1.500 de propina
    page.get_by_role("button", name="Retiro de efectivo").click()
    page.get_by_label("Monto").fill("4000")
    page.get_by_label("Motivo").fill("Hielo")
    page.get_by_role("button", name="Registrar retiro").click()
    expect(expected).to_contain_text("$ 30.000")
    shot(page, "s2-03-caja")
    page.get_by_role("button", name="Cerrar caja").click()
    page.get_by_label("Efectivo contado").fill("29500")
    expect(page.get_by_text("Faltan $ 500.")).to_be_visible()
    page.get_by_role("dialog").get_by_role("button", name="Cerrar caja").click()
    expect(page.get_by_role("heading", name="La caja está cerrada")).to_be_visible()
    expect(page.get_by_text("Cierres anteriores")).to_be_visible()
    shot(page, "s2-04-caja-cerrada")

    # ---------- Sprint 3 · Stock ----------
    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Stock").click()
    expect(page.get_by_text("Todavía no cargaste insumos")).to_be_visible()

    def new_ingredient(name, unit, stock, minimum, cost):
        page.get_by_role("button", name="Nuevo insumo").click()
        page.get_by_label("Nombre").fill(name)
        page.get_by_label("Se mide en").select_option(label=unit)
        page.get_by_label("Stock actual").fill(stock)
        page.get_by_label("Mínimo").fill(minimum)
        page.get_by_label("Costo por").fill(cost)
        page.get_by_role("button", name="Guardar insumo").click()
        expect(page.get_by_role("button", name=name)).to_be_visible()

    new_ingredient("Muzzarella", "Gramos", "2000", "2500", "8")
    new_ingredient("Carne vacuna", "Kilos", "5", "2", "9000")
    expect(page.locator(".stock-alert")).to_contain_text("1 insumo")  # muzzarella arranca debajo del mínimo

    page.get_by_role("button", name="Muzzarella").click()
    sheet = page.get_by_role("dialog")
    page.get_by_label("Cantidad (g)").fill("1000")
    page.get_by_label("Costo total").fill("9000")
    sheet.get_by_role("button", name="Registrar compra").click()
    expect(sheet.locator(".sheet-head")).to_contain_text("3.000 g")
    expect(sheet).to_contain_text("$ 9 por g")
    sheet.get_by_role("button", name="Merma").click()
    page.get_by_label("Cantidad (g)").fill("200")
    page.get_by_label("Motivo").fill("Vencida")
    sheet.get_by_role("button", name="Registrar merma").click()
    expect(sheet.locator(".sheet-head")).to_contain_text("2.800 g")
    sheet.get_by_role("button", name="Conteo").click()
    page.get_by_label("Cantidad contada (g)").fill("2700")
    sheet.get_by_role("button", name="Registrar conteo").click()
    expect(sheet.locator(".sheet-head")).to_contain_text("2.700 g")
    expect(sheet).to_contain_text("Conteo")
    expect(sheet).to_contain_text("-100 g")
    shot(page, "s3-01-insumo")
    sheet.get_by_role("button", name="Cerrar", exact=True).click()
    expect(page.locator(".stock-alert")).to_have_count(0)  # 2700 supera el mínimo de 2500

    # ---------- Receta de la milanesa ----------
    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Carta").click()
    page.get_by_role("button", name="Milanesa napolitana").click()
    page.get_by_role("button", name="Agregar insumo").click()
    page.get_by_label("Insumo 1", exact=True).select_option(label="Muzzarella")
    page.get_by_label("Cantidad del insumo 1").fill("150")
    page.get_by_role("button", name="Agregar insumo").click()
    page.get_by_label("Insumo 2", exact=True).select_option(label="Carne vacuna")
    page.get_by_label("Cantidad del insumo 2").fill("0,2")
    expect(page.locator(".recipe-cost")).to_contain_text("Costo $ 3.150")  # 150 g x $9 + 0,2 kg x $9.000
    expect(page.locator(".recipe-cost")).to_contain_text("margen 75%")
    shot(page, "s3-02-receta")
    page.get_by_role("button", name="Guardar producto").click()

    # ---------- Venta que descuenta stock ----------
    page.get_by_role("link", name="Caja").click()
    page.get_by_label("Efectivo inicial").fill("10000")
    page.get_by_role("button", name="Abrir caja").click()
    page.get_by_role("link", name="Salón").click()
    page.get_by_role("button", name="Mesa 1, libre").click()
    page.get_by_role("button", name="Abrir mesa y cargar pedido").click()
    page.get_by_role("button", name="Favoritos").click()
    page.get_by_role("button", name="Milanesa napolitana $ 12.500").click()
    page.get_by_role("button", name="Milanesa napolitana $ 12.500").click()
    page.get_by_role("button", name="Ver pedido").click()
    page.get_by_role("button", name="Cobrar · $ 25.000").click()
    pay = page.get_by_role("dialog", name="Cobrar")
    pay.get_by_role("button", name="Registrar pago · $ 25.000").click()
    pay.get_by_role("button", name="Cerrar comanda").click()
    expect(page.get_by_role("button", name="Mesa 1, libre")).to_be_visible()

    # ---------- Inicio del dueño ----------
    page.get_by_role("link", name="Inicio").click()
    expect(page.locator(".kpi-main")).to_contain_text("$ 49.500")  # 22.500 + 2.000 + 25.000
    expect(page.locator(".kpis")).to_contain_text("3")
    expect(page.get_by_text("Faltantes de stock")).to_be_visible()
    expect(page.locator(".list-row").filter(has_text="Muzzarella")).to_contain_text("2.400 g")  # 2.700 - 2 x 150
    shot(page, "s3-03-inicio")

    # ---------- Reportes ----------
    page.get_by_role("link", name="Ver reportes").click()
    expect(page.get_by_text("Ventas por hora")).to_be_visible()
    row = page.locator(".report-table tbody tr").filter(has_text="Milanesa napolitana")
    expect(row).to_contain_text("$ 50.000")
    expect(row).to_contain_text("75%")
    expect(page.locator(".report-table tbody tr").filter(has_text="Agua sin gas")).to_contain_text("Sin receta")
    expect(page.locator(".share-list").first).to_contain_text("Efectivo")
    shot(page, "s3-04-reportes")
    page.set_viewport_size({"width": 1180, "height": 820})
    shot(page, "s3-05-reportes-tablet")
    page.set_viewport_size({"width": 390, "height": 844})

    # ---------- Sprint 4 · Sin conexión en pleno servicio ----------
    page.get_by_role("link", name="Salón").click()
    expect(page.get_by_role("button", name="Mesa 4, libre")).to_be_visible()
    ctx.set_offline(True)
    expect(page.locator(".sync-bar.offline")).to_contain_text("Sin conexión")
    page.get_by_role("button", name="Mesa 4, libre").click()
    page.get_by_role("button", name="Abrir mesa y cargar pedido").click()
    expect(page.get_by_role("heading", name="Mesa 4")).to_be_visible()
    expect(page.get_by_text("Comanda nueva (número al sincronizar)")).to_be_visible()
    page.get_by_role("button", name="Favoritos").click()
    page.get_by_role("button", name="Milanesa napolitana $ 12.500").click()
    page.get_by_role("button", name="Bebidas").click()
    page.get_by_role("button", name="Agua sin gas $ 2.000").click()
    expect(page.locator(".order-bar")).to_contain_text("2 por enviar")
    expect(page.locator(".order-bar")).to_contain_text("$ 14.500")
    page.get_by_role("button", name="Ver pedido").click()
    page.get_by_role("button", name="Enviar a cocina · $ 14.500").click()
    expect(page.locator(".order-bar")).to_contain_text("2 enviados")
    page.get_by_role("button", name="Ver pedido").click()
    expect(page.get_by_role("dialog", name="Pedido").get_by_text("Para cobrar hace falta conexión")).to_be_visible()
    shot(page, "s4-01-pedido-sin-conexion")
    page.get_by_role("button", name="Seguir cargando").click()
    page.get_by_role("link", name="Volver").click()
    expect(page.get_by_role("button", name="Mesa 4, ocupada")).to_contain_text("$ 14.500")
    expect(page.locator(".sync-bar.offline")).to_contain_text("4 cambios guardados")
    shot(page, "s4-02-salon-sin-conexion")

    # la cocina, también sin conexión, marca el pedido como listo
    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Pantalla de cocina").click()
    kds = page.locator(".kds-ticket").filter(has_text="Mesa 4")
    expect(kds).to_contain_text("Milanesa napolitana")
    kds.get_by_role("button", name="Todo listo", exact=True).click()
    expect(page.locator(".kds-ready")).to_contain_text("Mesa 4")
    assert not any(o.get("table_id") and o["status"] == "open" and o["total"] == 14500 for o in fake.db["orders"]), "no debería haber llegado al servidor"

    # vuelve la conexión: todo se sincroniza en orden
    ctx.set_offline(False)
    expect(page.locator(".sync-bar")).to_have_count(0, timeout=15000)
    synced = [o for o in fake.db["orders"] if o["status"] == "open" and o["total"] == 14500]
    assert len(synced) == 1 and synced[0]["number"], "la comanda sincronizada debe tener número"
    mesa4 = synced[0]
    items4 = [i for i in fake.db["order_items"] if i["order_id"] == mesa4["id"]]
    assert sorted(i["status"] for i in items4) == ["ready", "ready"], items4
    page.get_by_role("link", name="Salón").click()
    page.get_by_role("button", name="Mesa 4, ocupada, con platos listos").click()
    expect(page.get_by_role("dialog")).to_contain_text(f"Comanda #{mesa4['number']}")
    page.get_by_role("button", name="Cerrar", exact=True).click()

    # conflicto: sin conexión se carga algo en una mesa que otro dispositivo ya cobró y cerró
    page.get_by_role("button", name="Mesa 4, ocupada, con platos listos").click()
    page.get_by_role("button", name="Ver comanda").click()
    ctx.set_offline(True)
    page.get_by_role("button", name="Bebidas").click()
    page.get_by_role("button", name="Agua sin gas $ 2.000").click()
    mesa4["paid_total"], mesa4["status"] = mesa4["total"], "closed"   # otro dispositivo cerró la mesa
    ctx.set_offline(False)
    failed_bar = page.locator(".sync-bar.failed")
    expect(failed_bar).to_contain_text("1 cambio no se pudo guardar", timeout=15000)
    failed_bar.click()
    expect(page.get_by_role("dialog", name="Cambios no guardados")).to_contain_text("Mesa 4: agregar Agua sin gas")
    expect(page.get_by_role("dialog", name="Cambios no guardados")).to_contain_text("ya no está abierta")
    shot(page, "s4-03-conflicto")
    page.get_by_role("button", name="Descartar todos").click()
    expect(page.locator(".sync-bar")).to_have_count(0)

    # ---------- Equipo: invitar, cambiar rol, dar de baja ----------
    import uuid as _uuid
    bodegon = fake.db["restaurants"][0]["id"]
    lucia = str(_uuid.uuid4())
    fake.db["profiles"].append({"id": lucia, "full_name": "Lucía Pérez"})
    fake.db["restaurant_members"].append({"restaurant_id": bodegon, "user_id": lucia, "role": "waiter", "display_name": None, "active": True})
    page.get_by_role("link", name="Más").click()
    expect(page.locator(".list-row").filter(has_text="Mercado Pago (QR)")).to_contain_text("Conectado · cuenta de prueba")
    page.get_by_role("button", name="Equipo Invitar personas y cambiar roles").click()
    expect(page.get_by_role("heading", name="Personas · 2")).to_be_visible()
    page.get_by_role("button", name="Invitar a alguien").click()
    page.get_by_role("dialog").get_by_text("Cocina", exact=True).click()
    shot(page, "s5-01-invitar")
    page.get_by_role("button", name="Crear link de cocina").click()
    share = page.get_by_role("dialog", name="Link para cocina")
    expect(share.get_by_label("Link")).to_have_value(__import__("re").compile(r"/invitacion/[0-9a-f]{24}$"))
    wa = share.get_by_role("link", name="Enviar por WhatsApp").get_attribute("href")
    assert wa.startswith("https://wa.me/?text=") and "Bodeg%C3%B3n%20QA" in wa, wa
    shot(page, "s5-02-link")
    page.keyboard.press("Escape")
    pending = page.locator(".list-row").filter(has_text="Vence el")
    expect(pending).to_have_count(1)
    pending.get_by_role("button", name="Anular").click()
    expect(pending).to_have_count(0)
    assert fake.db["restaurant_invites"][0]["revoked_at"]

    page.get_by_role("button", name="Lucía Pérez, Mozo. Cambiar rol").click()
    page.get_by_role("dialog").get_by_text("Cajero", exact=True).click()
    page.get_by_role("button", name="Guardar rol").click()
    expect(page.get_by_role("button", name="Lucía Pérez, Cajero. Cambiar rol")).to_be_visible()
    shot(page, "s5-03-equipo")
    page.get_by_role("button", name="Lucía Pérez, Cajero. Cambiar rol").click()
    page.once("dialog", lambda d: d.accept())
    page.get_by_role("button", name="Dar de baja del local").click()
    expect(page.get_by_role("heading", name="Personas · 1")).to_be_visible()
    # la dueña no se puede editar a sí misma desde acá
    expect(page.get_by_role("button", name=__import__("re").compile("Cambiar rol"))).to_have_count(0)

    # ---------- Aceptar una invitación a otro local ----------
    otra = str(_uuid.uuid4())
    fake.db["profiles"].append({"id": otra, "full_name": "Marta Gómez"})
    parrilla = fake._create_restaurant({"p_name": "Parrilla Invitada", "p_tables": 4})
    fake.db["restaurant_members"][-1]["user_id"] = otra
    fake.db["restaurant_invites"].append({"id": str(_uuid.uuid4()), "restaurant_id": parrilla, "role": "waiter",
                                          "token": "tok-parrilla-0001", "created_by": otra, "created_at": "2026-10-20T10:00:00Z",
                                          "expires_at": "2099-01-01T00:00:00Z", "accepted_at": None, "accepted_by": None, "revoked_at": None})
    page.goto(BASE + "/invitacion/tok-parrilla-0001")
    expect(page.get_by_role("heading", name="Sumate a Parrilla Invitada")).to_be_visible()
    expect(page.locator(".entry-body")).to_contain_text("Marta Gómez te invitó a Parrilla Invitada como mozo")
    assert page.url == BASE + "/", page.url
    shot(page, "s5-04-aceptar")
    page.get_by_role("button", name="Unirme al equipo").click()
    expect(page.locator(".topbar")).to_contain_text("Parrilla Invitada")
    expect(page.locator(".table-tile")).to_have_count(4)
    expect(page.get_by_role("link", name="Caja")).to_have_count(0)   # mozo: sin caja
    page.goto(BASE + "/invitacion/tok-parrilla-0001")
    expect(page.get_by_role("heading", name="Ya sos parte de Parrilla Invitada")).to_be_visible()
    page.get_by_role("button", name="Entrar").click()
    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Bodegón QA").click()
    expect(page.locator(".topbar")).to_contain_text("Bodegón QA")

    # ---------- Facturación electrónica (ARCA homologación) ----------
    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Facturación electrónica Datos fiscales y facturas").click()
    expect(page.get_by_text("Modo de prueba (homologación de ARCA)")).to_be_visible()
    page.get_by_label("CUIT del local").fill("20-12345678-6")
    page.get_by_label("Razón social").fill("Bodegón QA SRL")
    page.get_by_label("Domicilio comercial").fill("Av. Corrientes 1234, CABA")
    page.get_by_label("Condición frente al IVA").select_option("responsable_inscripto")
    page.get_by_label("Punto de venta").fill("3")
    page.get_by_label("Facturar al cerrar las comandas").check()
    page.get_by_role("button", name="Guardar").click()
    expect(page.get_by_role("status")).to_contain_text("Datos guardados")
    assert fake.db["fiscal_settings"][0]["cuit"] == "20123456786"
    shot(page, "s7-01-facturacion")

    page.get_by_role("link", name="Salón").click()
    page.get_by_role("button", name="Mesa 9, libre").click()
    page.get_by_role("button", name="Abrir mesa y cargar pedido").click()
    page.get_by_role("button", name="Favoritos").click()
    page.get_by_role("button", name="Milanesa napolitana $ 12.500").click()
    page.get_by_role("button", name="Ver pedido").click()
    page.get_by_role("button", name="Cobrar · $ 12.500").click()
    pay = page.get_by_role("dialog", name="Cobrar")
    pay.get_by_role("radio", name="Débito").click()
    pay.get_by_role("button", name="Registrar pago · $ 12.500").click()
    pay.get_by_role("button", name="Cerrar y facturar").click()
    inv = page.get_by_role("dialog", name="Factura")
    inv.get_by_role("button", name="Con DNI o CUIT").click()
    page.get_by_label("Documento").select_option("80")
    page.get_by_label("Número").fill("30712345671")
    page.get_by_label("Nombre o razón social").fill("Eventos Sur SA")
    page.get_by_label("Condición frente al IVA").select_option("1")
    shot(page, "s7-02-emitir")
    inv.get_by_role("button", name="Emitir factura").click()
    expect(page.locator(".invoice-kind")).to_have_text("Factura A")
    expect(page.locator(".invoice")).to_contain_text("N.º 00003-00000001")
    expect(page.locator(".invoice")).to_contain_text("CAE 76123456789012")
    expect(page.locator(".invoice")).to_contain_text("Eventos Sur SA")
    expect(page.locator(".invoice-totals")).to_contain_text("$ 10.330,58")   # neto de 12.500
    expect(page.locator(".invoice-qr svg")).to_be_visible()
    shot(page, "s7-03-factura")

    # anular con nota de crédito y volver a facturar a consumidor final
    page.get_by_role("button", name="Anular con nota de crédito").click()
    page.get_by_label("Motivo").fill("CUIT del cliente mal cargado")
    shot(page, "s7-04-anular")
    page.get_by_role("button", name="Emitir nota de crédito").click()
    expect(page.locator(".invoice-kind")).to_have_text("Nota de crédito A")
    expect(page.locator(".invoice-link")).to_contain_text("Esta nota de crédito anula la Factura A N.º 00003-00000001")
    expect(page.locator(".invoice-letter")).to_contain_text("Cód. 03")
    expect(page.locator(".invoice-assoc")).to_contain_text("Comprobante asociado: Factura A N.º 00003-00000001")
    expect(page.locator(".invoice-assoc")).to_contain_text("Motivo: CUIT del cliente mal cargado")
    shot(page, "s7-05-nota-credito")
    page.locator(".invoice-link").get_by_role("button").click()
    expect(page.locator(".invoice-link")).to_contain_text("Factura anulada con la Nota de crédito A N.º 00003-00000001")
    expect(page.get_by_role("button", name="Anular con nota de crédito")).to_have_count(0)
    page.get_by_role("button", name="Facturar la comanda de nuevo").click()
    page.get_by_role("dialog", name="Facturar de nuevo").get_by_role("button", name="Emitir factura").click()
    expect(page.locator(".invoice-kind")).to_have_text("Factura B")
    expect(page.locator(".invoice")).to_contain_text("N.º 00003-00000001")
    assert fake.db["invoices"][0]["reason"] is None and fake.db["invoices"][1]["reason"] == "CUIT del cliente mal cargado"
    page.goto(BASE + "/facturacion")
    expect(page.locator(".list-row").filter(has_text="Factura A")).to_contain_text("Anulada")
    expect(page.locator(".list-row").filter(has_text="Nota de crédito A")).to_contain_text("−$ 12.500")
    shot(page, "s7-06-listado")
    page.get_by_role("link", name="Salón").click()
    expect(page.get_by_role("button", name="Mesa 9, libre")).to_be_visible()

    # ---------- Operación de salón: mozo, pasar de mesa, unir, imprimir y dividir ----------
    pedro = str(_uuid.uuid4())
    fake.db["profiles"].append({"id": pedro, "full_name": "Pedro Gómez"})
    fake.db["restaurant_members"].append({"restaurant_id": bodegon, "user_id": pedro, "role": "waiter", "display_name": None, "active": True})
    page.add_init_script("window.__prints = 0; window.print = () => { window.__prints++ }")
    page.goto(BASE + "/salon")
    for mesa, cat, prod in (("10", "Favoritos", "Milanesa napolitana $ 12.500"), ("11", "Bebidas", "Agua sin gas $ 2.000")):
        page.get_by_role("button", name=f"Mesa {mesa}, libre").click()
        page.get_by_role("button", name="Abrir mesa y cargar pedido").click()
        page.get_by_role("button", name=cat).click()
        page.get_by_role("button", name=prod).click()
        page.get_by_role("button", name="Ver pedido").click()
        page.get_by_role("button", name=__import__("re").compile("^Enviar a cocina")).click()
        page.get_by_role("link", name="Volver").click()
    page.get_by_role("button", name="Mesa 10, ocupada").click()
    page.get_by_role("button", name="Ver comanda").click()
    page.get_by_role("button", name="Opciones").click()
    opts = page.get_by_role("dialog")
    opts.get_by_role("button", name=__import__("re").compile("^Mozo")).click()
    opts.get_by_role("button", name=__import__("re").compile("^Pedro Gómez")).click()
    expect(page.locator(".order-head")).to_contain_text("Pedro G.")
    page.get_by_role("button", name="Opciones").click()
    opts.get_by_role("button", name="Un comensal más").click()
    opts.get_by_role("button", name="Un comensal más").click()
    opts.get_by_role("button", name="Guardar comensales").click()
    expect(page.locator(".order-head")).to_contain_text("2 comensales")
    page.get_by_role("button", name="Opciones").click()
    shot(page, "s8-01-opciones")
    opts.get_by_role("button", name=__import__("re").compile("^Pasar a otra mesa")).click()
    shot(page, "s8-02-pasar")
    opts.get_by_role("button", name="Pasar a la mesa 12").click()
    expect(page.get_by_role("heading", name="Mesa 12")).to_be_visible()
    page.get_by_role("button", name="Opciones").click()
    opts.get_by_role("button", name=__import__("re").compile("^Unir con otra mesa")).click()
    opts.get_by_role("button", name="Unir la mesa 11").click()
    expect(page.locator(".order-bar")).to_contain_text("$ 14.500")
    page.get_by_role("link", name="Volver").click()
    tile = page.get_by_role("button", name="Mesa 12, ocupada, mozo Pedro Gómez")
    expect(tile.locator(".tile-waiter")).to_have_text("PG")
    shot(page, "s8-06-salon-mozo")
    tile.click()
    page.get_by_role("button", name="Ver comanda").click()

    page.get_by_role("button", name="Opciones").click()
    opts.get_by_role("button", name=__import__("re").compile("^Imprimir precuenta")).click()
    receipt = page.locator(".receipt")
    expect(receipt).to_contain_text("Mesa 12")
    expect(receipt).to_contain_text("Pedro Gómez")
    expect(receipt.locator(".receipt-total")).to_contain_text("$ 14.500")
    expect(receipt).to_contain_text("no válida como factura")
    page.wait_for_function("window.__prints >= 1")
    shot(page, "s8-03-precuenta")
    page.get_by_role("button", name="Volver").click()
    page.get_by_role("button", name="Opciones").click()
    opts.get_by_role("button", name=__import__("re").compile("^Imprimir comanda de cocina")).click()
    expect(page.locator(".receipt-big")).to_have_text("Mesa 12")
    expect(page.locator(".receipt-station").filter(has_text="Cocina")).to_contain_text("Milanesa napolitana")
    expect(page.locator(".receipt-station").filter(has_text="Barra")).to_contain_text("Agua sin gas")
    expect(page.locator(".receipt")).not_to_contain_text("$")
    shot(page, "s8-04-cocina")
    page.get_by_role("button", name="Volver").click()

    page.get_by_role("button", name="Ver pedido").click()
    page.get_by_role("button", name="Cobrar · $ 14.500").click()
    pay = page.get_by_role("dialog", name="Cobrar")
    pay.get_by_role("button", name="En partes").click()
    expect(pay.locator(".split")).to_contain_text("partes de $ 7.250")
    expect(page.get_by_label("Monto")).to_have_value("7250")
    pay.get_by_role("button", name="Por productos").click()
    pay.locator(".split-items label").filter(has_text="Milanesa napolitana").click()
    expect(page.get_by_label("Monto")).to_have_value("12500")
    shot(page, "s8-05-dividir")
    pay.get_by_role("radio", name="Débito").click()
    pay.get_by_role("button", name="Registrar pago · $ 12.500").click()
    expect(pay.locator(".ticket-total")).to_contain_text("$ 2.000")
    expect(pay.locator(".split-items input:checked")).to_have_count(0)
    pay.locator(".split-items label").filter(has_text="Agua sin gas").click()
    pay.get_by_role("button", name="Registrar pago · $ 2.000").click()
    pay.get_by_role("button", name="Cerrar sin factura").click()
    expect(page.get_by_role("button", name="Mesa 12, libre")).to_be_visible()
    expect(page.get_by_role("button", name="Mesa 10, libre")).to_be_visible()
    expect(page.get_by_role("button", name="Mesa 11, libre")).to_be_visible()

    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Cerrar sesión").click()
    expect(page.get_by_label("Email")).to_be_visible()

    # sin sesión, el link de invitación lleva a crear la cuenta
    page.goto(BASE + "/invitacion/tok-sin-cuenta-01")
    expect(page.get_by_text("Te invitaron a sumarte al equipo de un local")).to_be_visible()
    expect(page.get_by_label("Tu nombre")).to_be_visible()
    shot(page, "s5-05-login-invitado")

    browser.close()
    real = [e for e in errors if "WebSocket" not in e and "realtime" not in e.lower() and "status of 400" not in e
            and "ERR_INTERNET_DISCONNECTED" not in e and "Failed to fetch" not in e]
    print("ERRORES DE CONSOLA:", real or "ninguno")
    if real:
        sys.exit(1)
    print("E2E OK")
