"""Prueba de punta a punta del sprint 0: login → crear local → abrir y liberar mesa → Más."""
import os
import sys
from playwright.sync_api import sync_playwright, expect
from fake_supabase import FakeSupabase

BASE = "http://127.0.0.1:4173"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")
os.makedirs(OUT, exist_ok=True)
EMAIL, PASSWORD = "qa-sprint0@comanda.test", "Prueba-2026!"

proxy = os.environ.get("HTTPS_PROXY")

with sync_playwright() as p:
    browser = p.chromium.launch(args=[f"--proxy-server={proxy}", "--proxy-bypass-list=127.0.0.1;localhost"] if proxy else [])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, locale="es-AR")
    page = ctx.new_page()
    fake = FakeSupabase()
    page.route("https://mosfrmkbutyqqckjnkkd.supabase.co/**", fake.handle)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))

    page.goto(BASE)
    expect(page.get_by_text("Comandá").first).to_be_visible()
    page.screenshot(path=f"{OUT}/01-login.png")

    page.get_by_label("Email").fill(EMAIL)
    page.get_by_label("Contraseña").fill("mal-password")
    page.get_by_role("button", name="Iniciar sesión").last.click()
    expect(page.get_by_role("alert")).to_contain_text("no coinciden")

    page.get_by_label("Contraseña").fill(PASSWORD)
    page.get_by_role("button", name="Iniciar sesión").last.click()

    expect(page.get_by_label("Nombre del local")).to_be_visible(timeout=15000)
    page.screenshot(path=f"{OUT}/02-onboarding.png")
    page.get_by_label("Nombre del local").fill("Bodegón QA")
    page.get_by_label("Cantidad de mesas").fill("12")
    page.get_by_role("button", name="Crear local").click()

    expect(page.get_by_role("heading", name="Salón")).to_be_visible(timeout=15000)
    expect(page.locator(".table-tile")).to_have_count(12)
    expect(page.locator(".floor-summary")).to_contain_text("12libres")

    page.get_by_role("button", name="Mesa 3, libre").click()
    page.get_by_role("button", name="Abrir mesa").click()
    expect(page.get_by_role("button", name="Mesa 3, ocupada")).to_be_visible(timeout=10000)
    page.get_by_role("button", name="Mesa 7, libre").click()
    page.get_by_role("button", name="Abrir mesa").click()
    expect(page.get_by_role("button", name="Mesa 7, ocupada")).to_be_visible(timeout=10000)
    page.screenshot(path=f"{OUT}/03-salon.png")

    page.get_by_role("button", name="Mesa 3, ocupada").click()
    expect(page.get_by_role("dialog")).to_contain_text("Comanda #1")
    expect(page.get_by_role("button", name="Liberar mesa")).to_have_count(0)
    page.wait_for_timeout(400)
    page.screenshot(path=f"{OUT}/04-mesa-ocupada.png")
    page.get_by_role("button", name="Cerrar", exact=True).click()
    page.get_by_role("button", name="Mesa 7, ocupada").click()
    page.get_by_role("button", name="Liberar mesa").click()
    expect(page.get_by_role("button", name="Mesa 7, libre")).to_be_visible(timeout=10000)

    page.get_by_role("link", name="Más").click()
    expect(page.get_by_text("QA Sprint 0")).to_be_visible()
    expect(page.get_by_text("Dueño")).to_be_visible()
    page.screenshot(path=f"{OUT}/05-mas.png")

    page.get_by_role("link", name="Cocina").click()
    page.screenshot(path=f"{OUT}/06-cocina.png")

    # Tablet / PC
    page.set_viewport_size({"width": 1180, "height": 820})
    page.get_by_role("link", name="Salón").click()
    expect(page.locator(".table-tile")).to_have_count(12)
    page.screenshot(path=f"{OUT}/07-salon-tablet.png")

    page.get_by_role("link", name="Más").click()
    page.get_by_role("button", name="Cerrar sesión").click()
    expect(page.get_by_label("Email")).to_be_visible()

    browser.close()
    real_errors = [e for e in errors if "favicon" not in e and "WebSocket" not in e and "realtime" not in e.lower()]
    print("CONSOLE ERRORS:", real_errors or "ninguno")
    print("E2E OK")
    sys.exit(0)
