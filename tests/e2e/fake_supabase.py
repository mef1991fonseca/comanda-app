"""Backend simulado de Supabase para probar la UI cuando la red del sandbox no llega a supabase.co.

Imita PostgREST/Auth lo suficiente para los flujos de la app y replica las reglas de negocio
de los triggers de Postgres que la UI necesita ver (número de comanda, precios desde la carta,
modificadores, subtotales). La lógica real se prueba aparte con SQL contra la base.
"""
import base64
import json
import time
import uuid
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

USER_ID = str(uuid.uuid4())
EMAIL, PASSWORD, NAME = "qa-sprint0@comanda.test", "Prueba-2026!", "QA Sprint 0"

TABLES = [
    "restaurants", "restaurant_members", "profiles", "dining_areas", "tables", "stations",
    "categories", "products", "modifier_groups", "modifiers", "product_modifier_groups",
    "orders", "order_items", "payments", "payment_methods", "registers", "cash_sessions", "cash_movements",
    "ingredients", "recipe_items", "stock_movements", "restaurant_invites", "mp_charges", "fiscal_settings", "invoices", "customers", "customer_movements", "customer_balances",
    "suppliers", "purchases", "purchase_items", "supplier_movements", "supplier_balances",
]

DEFAULTS = {
    "registers": {"active": True, "blind_close": False},
    "suppliers": {"active": True, "cuit": None, "phone": None, "email": None, "notes": None},
    "customers": {"active": True, "credit_limit": None, "doc_type": None, "doc_number": None, "iva_condition": 5,
                  "phone": None, "email": None, "notes": None},
    "categories": {"active": True, "sort_order": 0, "parent_id": None},
    "products": {"active": True, "sort_order": 0, "is_favorite": False, "description": None, "category_id": None,
                 "station_id": None, "price": 0, "sku": None, "image_url": None},
    "modifier_groups": {"min_select": 0, "max_select": 1},
    "modifiers": {"active": True, "sort_order": 0, "price_delta": 0},
    "product_modifier_groups": {"sort_order": 0},
    "orders": {"type": "dine_in", "status": "open", "table_id": None, "customer_name": None, "guests": None,
               "notes": None, "subtotal": 0, "discount_amount": 0, "total": 0, "paid_total": 0,
               "cash_session_id": None, "closed_at": None, "cancelled_reason": None, "customer_id": None},
    "payments": {"tip": 0, "cash_session_id": None, "reference": None, "voided_at": None, "voided_by": None},
    "cash_sessions": {"opening_amount": 0, "closed_at": None, "closed_by": None, "expected_cash": None,
                      "counted_cash": None, "notes": None},
    "cash_movements": {"reason": None},
    "ingredients": {"unit": "unit", "cost_per_unit": 0, "stock_qty": 0, "min_stock": 0, "active": True},
    "stock_movements": {"unit_cost": None, "order_id": None, "note": None},
    "order_items": {"status": "pending", "modifiers": [], "modifiers_total": 0, "quantity": 1, "notes": None,
                    "guest_number": None, "sent_at": None, "ready_at": None, "station_id": None},
}


def _b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")


def fake_jwt():
    now = int(time.time())
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": USER_ID, "role": "authenticated", "aud": "authenticated", "exp": now + 3600, "iat": now, "email": EMAIL})
    return f"{header}.{payload}.sig"


def now_iso(offset_min=0):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60 * offset_min))


class BusinessError(Exception):
    pass


class FakeSupabase:
    def __init__(self):
        self.db = {t: [] for t in TABLES}
        self.db["profiles"].append({"id": USER_ID, "full_name": NAME})
        self.counter = 0
        self.mp_pay = False  # la prueba lo prende para "pagar" el QR desde el celular del cliente

    # ---------- filtros PostgREST ----------
    @staticmethod
    def _filters(qs):
        out = []
        for k, vals in qs.items():
            if k in ("select", "order", "columns", "limit", "offset", "on_conflict"):
                continue
            for v in vals:
                op, _, val = v.partition(".")
                out.append((k, op, val))
        return out

    @staticmethod
    def _match(row, filters):
        for col, op, val in filters:
            cur = row.get(col)
            if op == "eq":
                if str(cur).lower() != val.lower():
                    return False
            elif op == "neq":
                if str(cur).lower() == val.lower():
                    return False
            elif op == "not" and val.startswith("is.null"):
                if cur is None:
                    return False
            elif op == "is" and val == "null":
                if cur is not None:
                    return False
            elif op == "not" and val == "is.null":
                if cur is None:
                    return False
            elif op == "gt":
                if cur is None or str(cur) <= val:
                    return False
            elif op == "gte":
                if cur is None or str(cur) < val:
                    return False
            elif op == "in":
                if str(cur) not in [x.strip('"') for x in val.strip("()").split(",")]:
                    return False
        return True

    def _user(self):
        return {"id": USER_ID, "aud": "authenticated", "role": "authenticated", "email": EMAIL,
                "user_metadata": {"full_name": NAME}, "app_metadata": {"provider": "email"},
                "created_at": "2026-10-19T00:00:00Z"}

    # ---------- reglas de negocio (espejo de los triggers) ----------
    def _find(self, table, id_):
        return next((r for r in self.db[table] if r.get("id") == id_), None)

    def _enrich_item(self, item, is_insert):
        pid = item.get("product_id")
        if not pid:
            return
        if is_insert:
            prod = self._find("products", pid)
            if not prod:
                raise BusinessError("Producto inexistente")
            if not prod["active"]:
                raise BusinessError(f"El producto {prod['name']} no está disponible")
            item["name"], item["unit_price"] = prod["name"], prod["price"]
            item["station_id"] = item.get("station_id") or prod.get("station_id")
        linked = {l["group_id"] for l in self.db["product_modifier_groups"] if l["product_id"] == pid}
        mods = []
        for ref in item.get("modifiers") or []:
            m = self._find("modifiers", ref.get("id"))
            if not m or m["group_id"] not in linked:
                raise BusinessError("Hay modificadores que no corresponden a este producto")
            mods.append({"id": m["id"], "name": m["name"], "price_delta": m["price_delta"]})
        if len({m["id"] for m in mods}) != len(mods):
            raise BusinessError("Hay una opción repetida")
        for gid in linked:
            g = self._find("modifier_groups", gid)
            active = [m for m in self.db["modifiers"] if m["group_id"] == gid and m["active"]]
            chosen = sum(1 for m in mods if any(a["id"] == m["id"] for a in active))
            need = min(g["min_select"], len(active))
            if chosen > g["max_select"]:
                raise BusinessError(f"En {g['name']} se pueden elegir hasta {g['max_select']}")
            if chosen < need:
                raise BusinessError(f"Elegí una opción de {g['name']}" if need == 1 else f"Elegí al menos {need} en {g['name']}")
        item["modifiers"] = mods
        item["modifiers_total"] = sum(m["price_delta"] for m in mods)

    def _item_line(self, item):
        item["line_total"] = round(item["quantity"] * (item["unit_price"] + item["modifiers_total"]), 2)

    def _recalc_order(self, order_id):
        order = self._find("orders", order_id)
        if not order:
            return
        order["subtotal"] = sum(i["line_total"] for i in self.db["order_items"]
                                if i["order_id"] == order_id and i["status"] != "cancelled")
        order["total"] = max(order["subtotal"] - order["discount_amount"], 0)

    def _check_open(self, order_id):
        order = self._find("orders", order_id)
        if order and order["status"] != "open":
            raise BusinessError("La comanda ya no está abierta")

    def _recalc_paid(self, order_id):
        order = self._find("orders", order_id)
        if order:
            order["paid_total"] = sum(p["amount"] for p in self.db["payments"]
                                      if p["order_id"] == order_id and not p.get("voided_at"))

    def _open_session(self, restaurant_id):
        return next((s for s in self.db["cash_sessions"]
                     if s["restaurant_id"] == restaurant_id and not s.get("closed_at")), None)

    def _my_role(self, restaurant_id):
        m = next((m for m in self.db["restaurant_members"] if m["restaurant_id"] == restaurant_id and m["user_id"] == USER_ID), None)
        return m["role"] if m else None

    def _pick_session(self, restaurant_id, requested, cash):
        """Igual que private.pick_cash_session."""
        open_ = sorted([s for s in self.db["cash_sessions"] if s["restaurant_id"] == restaurant_id and not s.get("closed_at")],
                       key=lambda s: s["opened_at"])
        if requested:
            if not any(s["id"] == requested for s in open_):
                raise BusinessError("La caja elegida está cerrada")
            return requested
        mine = [s for s in open_ if s.get("opened_by") == USER_ID]
        if mine:
            return mine[-1]["id"]
        if not open_:
            return None
        if len(open_) > 1 and cash:
            raise BusinessError("Hay varias cajas abiertas: elegí en cuál se cobra desde la pantalla Caja")
        return open_[0]["id"]

    def _before_payment(self, row):
        order = self._find("orders", row["order_id"])
        if not order or order["status"] != "open":
            raise BusinessError("Solo se puede cobrar una comanda abierta")
        if row["amount"] > order["total"] - order["paid_total"] + 0.009:
            raise BusinessError("El pago supera lo que falta cobrar")
        kind = (self._find("payment_methods", row["payment_method_id"]) or {}).get("kind")
        row["cash_session_id"] = self._pick_session(row["restaurant_id"], row.get("cash_session_id"), kind == "cash")
        if kind == "cash" and not row["cash_session_id"]:
            raise BusinessError("Abrí la caja para cobrar en efectivo")

    def _apply_stock(self, mv):
        ing = self._find("ingredients", mv["ingredient_id"])
        if not ing:
            raise BusinessError("Insumo inexistente")
        ing["stock_qty"] = round(ing["stock_qty"] + mv["qty_delta"], 3)
        if mv["reason"] == "purchase" and mv.get("unit_cost") is not None:
            ing["cost_per_unit"] = mv["unit_cost"]

    def _stock_for_order(self, order, sign):
        totals = {}
        for it in self.db["order_items"]:
            if it["order_id"] != order["id"] or it["status"] == "cancelled":
                continue
            for r in self.db["recipe_items"]:
                if r["product_id"] == it.get("product_id"):
                    totals[r["ingredient_id"]] = totals.get(r["ingredient_id"], 0) + r["quantity"] * it["quantity"]
        for ing_id, qty in totals.items():
            mv = {"id": str(uuid.uuid4()), "restaurant_id": order["restaurant_id"], "ingredient_id": ing_id,
                  "qty_delta": sign * qty, "reason": "sale" if sign < 0 else "sale_reversal", "order_id": order["id"],
                  "note": None, "unit_cost": None, "created_at": now_iso()}
            self._apply_stock(mv)
            self.db["stock_movements"].append(mv)

    def _stock_count(self, args):
        ing = self._find("ingredients", args["p_ingredient"])
        delta = round(args["p_counted"] - ing["stock_qty"], 3)
        if delta:
            mv = {"id": str(uuid.uuid4()), "restaurant_id": ing["restaurant_id"], "ingredient_id": ing["id"],
                  "qty_delta": delta, "reason": "count", "note": args.get("p_note") or "Conteo de inventario",
                  "unit_cost": None, "order_id": None, "created_at": now_iso()}
            self._apply_stock(mv)
            self.db["stock_movements"].append(mv)
        return delta

    def _recipe_costs(self):
        ing_cost = {i["id"]: i["cost_per_unit"] for i in self.db["ingredients"]}
        out = {}
        for r in self.db["recipe_items"]:
            out[r["product_id"]] = out.get(r["product_id"], 0) + r["quantity"] * ing_cost.get(r["ingredient_id"], 0)
        return out

    def _sales_report(self, args):
        parse = lambda x: datetime.fromisoformat(x.replace("Z", "+00:00"))
        lo, hi = parse(args["p_from"]), parse(args["p_to"])
        tz = ZoneInfo("America/Argentina/Buenos_Aires")
        orders = [o for o in self.db["orders"] if o["restaurant_id"] == args["p_restaurant"] and o["status"] == "closed"
                  and o.get("closed_at") and lo <= parse(o["closed_at"]) < hi]
        ids = {o["id"] for o in orders}
        pays = [p for p in self.db["payments"] if p["order_id"] in ids and not p.get("voided_at")]
        items = [i for i in self.db["order_items"] if i["order_id"] in ids and i["status"] != "cancelled"]
        ing_cost = {i["id"]: i["cost_per_unit"] for i in self.db["ingredients"]}
        unit_cost = {}
        for r in self.db["recipe_items"]:
            unit_cost[r["product_id"]] = unit_cost.get(r["product_id"], 0) + r["quantity"] * ing_cost.get(r["ingredient_id"], 0)

        def group(rows, keyf):
            out = {}
            for r in rows:
                out.setdefault(keyf(r), []).append(r)
            return out

        local = lambda o: parse(o["closed_at"]).astimezone(tz)
        methods = {m["id"]: m for m in self.db["payment_methods"]}
        products = []
        for (pid, name), rows in group(items, lambda i: (i.get("product_id"), i["name"])).items():
            qty = sum(r["quantity"] for r in rows)
            products.append({"product_id": pid, "name": name, "qty": qty, "revenue": sum(r["line_total"] for r in rows),
                             "cost": round(sum(r["quantity"] * (r.get("unit_cost") or 0) for r in rows), 2),
                             "costed_revenue": sum(r["line_total"] for r in rows if r.get("unit_cost") is not None) or None,
                             "has_recipe": any(r.get("unit_cost") is not None for r in rows)})
        return {
            "totals": {"orders": len(orders), "sales": sum(o["total"] for o in orders), "subtotal": sum(o["subtotal"] for o in orders),
                       "discounts": sum(o["discount_amount"] for o in orders), "tips": sum(p["tip"] for p in pays)},
            "by_hour": sorted([{"hour": h, "sales": sum(o["total"] for o in g), "orders": len(g)}
                               for h, g in group(orders, lambda o: local(o).hour).items()], key=lambda x: x["hour"]),
            "by_day": sorted([{"day": d, "sales": sum(o["total"] for o in g), "orders": len(g)}
                              for d, g in group(orders, lambda o: local(o).date().isoformat()).items()], key=lambda x: x["day"]),
            "by_payment": sorted([{"method": methods[m]["name"], "kind": methods[m]["kind"], "amount": sum(p["amount"] for p in g),
                                   "tips": sum(p["tip"] for p in g), "count": len(g)}
                                  for m, g in group(pays, lambda p: p["payment_method_id"]).items()], key=lambda x: -x["amount"]),
            "by_type": sorted([{"type": t, "sales": sum(o["total"] for o in g), "orders": len(g)}
                               for t, g in group(orders, lambda o: o["type"]).items()], key=lambda x: -x["sales"]),
            "products": sorted(products, key=lambda x: -x["revenue"]),
        }

    def _income_statement(self, args):
        parse = lambda x: datetime.fromisoformat(x.replace("Z", "+00:00"))
        tz = ZoneInfo("America/Argentina/Buenos_Aires")
        rid, n = args["p_restaurant"], int(args.get("p_months") or 6)
        now = datetime.now(tz)
        months = []
        y, m = now.year, now.month
        for _ in range(n):
            months.append(f"{y:04d}-{m:02d}")
            y, m = (y, m - 1) if m > 1 else (y - 1, 12)
        months.reverse()
        ing_cost = {i["id"]: i["cost_per_unit"] for i in self.db["ingredients"]}
        unit_cost = {}
        for r in self.db["recipe_items"]:
            unit_cost[r["product_id"]] = unit_cost.get(r["product_id"], 0) + r["quantity"] * ing_cost.get(r["ingredient_id"], 0)
        out = []
        for key in months:
            orders = [o for o in self.db["orders"] if o["restaurant_id"] == rid and o["status"] == "closed" and o.get("closed_at")
                      and parse(o["closed_at"]).astimezone(tz).strftime("%Y-%m") == key]
            ids = {o["id"] for o in orders}
            items = [i for i in self.db["order_items"] if i["order_id"] in ids and i["status"] != "cancelled"]
            pu = [p for p in self.db["purchases"] if p["restaurant_id"] == rid and not p.get("cancelled_at") and p["issued_on"][:7] == key]
            exp = {}
            for p in pu:
                if p["category"] not in ("mercaderia", "bebidas"):
                    exp[p["category"]] = exp.get(p["category"], 0) + p["total"]
            out.append({
                "month": key, "orders": len(orders), "sales": sum(o["total"] for o in orders),
                "discounts": sum(o["discount_amount"] for o in orders),
                "tips": sum(p["tip"] for p in self.db["payments"] if p["order_id"] in ids and not p.get("voided_at")),
                "cogs": round(sum(i["quantity"] * (i.get("unit_cost") or 0) for i in items), 2),
                "sales_without_recipe": sum(i["line_total"] for i in items if i.get("unit_cost") is None),
                "inventory_purchases": sum(p["total"] for p in pu if p["category"] in ("mercaderia", "bebidas")),
                "expenses": exp,
            })
        return out

    def _close_cash(self, args):
        sess = self._find("cash_sessions", args["p_session"])
        if not sess or sess.get("closed_at"):
            raise BusinessError("La caja ya está cerrada")
        cash_ids = {m["id"] for m in self.db["payment_methods"] if m["kind"] == "cash"}
        sales = sum(p["amount"] + p["tip"] for p in self.db["payments"]
                    if p.get("cash_session_id") == sess["id"] and not p.get("voided_at") and p["payment_method_id"] in cash_ids)
        moves = sum(m["amount"] if m["kind"] == "in" else -m["amount"] for m in self.db["cash_movements"]
                    if m["cash_session_id"] == sess["id"])
        sess.update({"closed_at": now_iso(), "closed_by": USER_ID, "expected_cash": sess["opening_amount"] + sales + moves,
                     "counted_cash": args["p_counted"], "notes": args.get("p_notes")})
        reg = self._find("registers", sess["register_id"])
        if reg and reg.get("blind_close") and self._my_role(sess["restaurant_id"]) not in ("owner", "manager"):
            return {**sess, "expected_cash": None}
        return sess

    def _before_insert(self, table, row):
        if table != "fiscal_settings":
            row.setdefault("id", str(uuid.uuid4()))
        else:
            row.setdefault("environment", "homologacion")
        row.setdefault("created_at", now_iso())
        row.setdefault("updated_at", now_iso())
        for k, v in DEFAULTS.get(table, {}).items():
            row.setdefault(k, json.loads(json.dumps(v)))
        if table == "orders":
            row.setdefault("waiter_id", USER_ID)
            self.counter += 1
            row["number"] = self.counter
            row.setdefault("opened_at", now_iso(offset_min=5))
        if table == "cash_sessions":
            reg = self._find("registers", row["register_id"])
            if not reg or not reg["active"]:
                raise BusinessError("Esa caja no está habilitada")
            row["opened_at"] = now_iso()
            row["opened_by"] = USER_ID
            if any(x["register_id"] == row["register_id"] and not x.get("closed_at") for x in self.db["cash_sessions"]):
                raise BusinessError("Ya hay una caja abierta")
        if table == "cash_movements":
            if not any(x["id"] == row["cash_session_id"] and not x.get("closed_at") for x in self.db["cash_sessions"]):
                raise BusinessError("La caja está cerrada")
        if table == "registers":
            row["name"] = row["name"].strip()
            if any(r["restaurant_id"] == row["restaurant_id"] and r["active"] and r["name"].lower() == row["name"].lower()
                   for r in self.db["registers"]):
                raise BusinessError("Ya hay una caja con ese nombre")
        if table == "payments":
            self._before_payment(row)
            method = self._find("payment_methods", row["payment_method_id"])
            if method and method["kind"] == "account":
                order = self._find("orders", row["order_id"])
                if not order.get("customer_id"):
                    raise BusinessError("Para cobrar a cuenta corriente, asigná un cliente a la comanda")
                self.db["customer_movements"].append({"id": str(uuid.uuid4()), "restaurant_id": row["restaurant_id"],
                    "customer_id": order["customer_id"], "kind": "charge", "amount": row["amount"], "order_id": order["id"],
                    "payment_id": row["id"], "payment_method_id": method["id"], "cash_movement_id": None, "note": None,
                    "created_by": USER_ID, "created_at": now_iso()})
        if table == "ingredients":
            row["stock_qty"] = 0
        if table == "restaurant_invites":
            mine = next((m for m in self.db["restaurant_members"]
                         if m["restaurant_id"] == row["restaurant_id"] and m["user_id"] == USER_ID and m["active"]), None)
            if not mine or mine["role"] not in ("owner", "manager") or (mine["role"] == "manager" and row["role"] == "owner"):
                raise BusinessError("new row violates row-level security policy")
            row.update({"token": uuid.uuid4().hex[:24], "created_by": USER_ID, "accepted_at": None, "accepted_by": None,
                        "revoked_at": None,
                        "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 7 * 86400))})
        if table == "stock_movements":
            self._apply_stock(row)
        if table == "order_items":
            self._check_open(row["order_id"])
            self._enrich_item(row, True)
            if row["status"] in ("sent", "preparing", "ready", "delivered"):
                row["sent_at"] = now_iso()
            self._item_line(row)

    def _after_write(self, table, row):
        if table == "order_items":
            self._recalc_order(row["order_id"])
        if table == "payments":
            self._recalc_paid(row["order_id"])

    def _apply_patch(self, table, row, patch):
        if table == "order_items":
            if any(k in patch for k in ("quantity", "modifiers", "product_id")):
                self._check_open(row["order_id"])
            row.update(patch)
            if "modifiers" in patch:
                self._enrich_item(row, False)
            if row["status"] in ("sent", "preparing", "ready", "delivered") and not row.get("sent_at"):
                row["sent_at"] = now_iso()
            if row["status"] in ("ready", "delivered") and not row.get("ready_at"):
                row["ready_at"] = now_iso()
            self._item_line(row)
        elif table == "orders":
            if patch.get("status") == "cancelled" and row["paid_total"] > 0:
                raise BusinessError("No se puede anular la comanda: tiene pagos registrados")
            closing = patch.get("status") == "closed" and row["status"] != "closed"
            row.update(patch)
            row["total"] = max(row["subtotal"] - row["discount_amount"], 0)
            if closing:
                if row["paid_total"] < row["total"]:
                    row["status"] = "open"
                    raise BusinessError("La comanda no está paga")
                row["closed_at"] = now_iso()
                self._stock_for_order(row, -1)
                costs = self._recipe_costs()
                for i in self.db["order_items"]:
                    if i["order_id"] == row["id"]:
                        i["unit_cost"] = costs.get(i.get("product_id"))
                for i in self.db["order_items"]:
                    if i["order_id"] == row["id"] and i["status"] == "pending":
                        i["status"], i["sent_at"] = "sent", now_iso()
        elif table == "registers":
            if row["active"] and patch.get("active") is False and any(
                    x["register_id"] == row["id"] and not x.get("closed_at") for x in self.db["cash_sessions"]):
                raise BusinessError("Cerrá la caja antes de desactivarla")
            row.update(patch)
        elif table == "restaurant_members":
            if row["role"] == "owner" and row["active"] and (patch.get("role", "owner") != "owner" or patch.get("active") is False) \
                    and not any(m is not row and m["restaurant_id"] == row["restaurant_id"] and m["role"] == "owner" and m["active"]
                                for m in self.db["restaurant_members"]):
                raise BusinessError("El local tiene que tener al menos un dueño activo.")
            row.update(patch)
        else:
            if table == "ingredients" and "stock_qty" in patch and patch["stock_qty"] != row["stock_qty"]:
                raise BusinessError("El stock se modifica registrando una compra, merma, ajuste o conteo")
            row.update(patch)
        row["updated_at"] = now_iso()

    # ---------- Edge function mercadopago ----------
    def _mercadopago(self, body):
        action = body.get("action")
        if action == "status":
            if getattr(self, "mp_own", None):
                return {"connected": True, "own": True, "nickname": self.mp_own, "test": False, "oauth_ready": True,
                        "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 180 * 86400))}
            return {"connected": True, "own": False, "nickname": "TESTUSER123", "test": True, "oauth_ready": True}
        if action == "connect":
            # En la vida real va a auth.mercadopago.com y vuelve por la función; acá se vincula directo
            self.mp_own = "YOPANCHO.LOCAL"
            return {"url": "/mercadopago?mp=conectado"}
        if action == "disconnect":
            self.mp_own = None
            return {"ok": True}
        if action == "create":
            order = self._find("orders", body["order_id"])
            if not order or order["status"] != "open":
                raise BusinessError("Solo se puede cobrar una comanda abierta.")
            if body["amount"] > order["total"] - order["paid_total"] + 0.009:
                raise BusinessError("El monto supera lo que falta cobrar.")
            for c in self.db["mp_charges"]:
                if c["order_id"] == order["id"] and c["status"] == "created":
                    c["status"] = "canceled"
            ch = {"id": str(uuid.uuid4()), "restaurant_id": order["restaurant_id"], "order_id": order["id"],
                  "amount": body["amount"], "status": "created", "mp_order_id": "ORDFAKE" + uuid.uuid4().hex[:10],
                  "mp_payment_id": None, "payment_id": None, "error": None, "created_by": USER_ID,
                  "qr_data": "00020101021243650016com.mercadolibre020130636" + uuid.uuid4().hex + "5204970053030325802AR5909Test Test6004CABA6304ABCD",
                  "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 900)),
                  "created_at": now_iso(), "updated_at": now_iso()}
            self.db["mp_charges"].append(ch)
            return {"charge": ch}
        ch = self._find("mp_charges", body.get("charge_id"))
        if not ch:
            raise BusinessError("No se encontró el cobro.")
        if action == "cancel" and ch["status"] == "created":
            ch["status"] = "canceled"
        if action == "refresh" and ch["status"] == "created" and self.mp_pay:
            method = next(m for m in self.db["payment_methods"] if m["restaurant_id"] == ch["restaurant_id"] and m["kind"] == "mercadopago")
            pay = {"restaurant_id": ch["restaurant_id"], "order_id": ch["order_id"], "payment_method_id": method["id"],
                   "amount": ch["amount"], "reference": "QR Mercado Pago PAYFAKE"}
            self._before_insert("payments", pay)
            self.db["payments"].append(pay)
            self._after_write("payments", pay)
            ch.update({"status": "processed", "payment_id": pay["id"], "mp_payment_id": "PAYFAKE"})
        return {"charge": ch}

    # ---------- Edge function arca ----------
    def _arca(self, body):
        if body.get("action") == "credit_note":
            inv = self._find("invoices", body["invoice_id"])
            if not inv or inv.get("credit_note_id"):
                raise BusinessError("Solo se anulan facturas autorizadas.")
            tipo = {1: 3, 6: 8, 11: 13}[inv["cbte_type"]]
            n = 1 + max([i["number"] for i in self.db["invoices"] if i["cbte_type"] == tipo] or [0])
            nc = dict(inv, id=str(uuid.uuid4()), cbte_type=tipo, number=n, cae="76999999999999", associated_id=inv["id"],
                      credit_note_id=None, reason=body.get("reason"), created_at=now_iso())
            self.db["invoices"].append(nc)
            inv["credit_note_id"] = nc["id"]
            return {"invoice": nc}
        if body.get("action") != "invoice":
            raise BusinessError("No autorizado.")
        order = self._find("orders", body["order_id"])
        if not order or order["status"] != "closed":
            raise BusinessError("Cobrá la comanda antes de facturar.")
        fs = next((f for f in self.db["fiscal_settings"] if f["restaurant_id"] == order["restaurant_id"]), None)
        if not fs or not fs.get("enabled"):
            raise BusinessError("Activá la facturación en Más → Facturación.")
        r = body.get("receiver") or {}
        ri = fs["iva_condition"] == "responsable_inscripto"
        cond = r.get("condition", 5) if r.get("doc_type") == 80 else 5
        tipo = (1 if cond == 1 else 6) if ri else 11
        total = order["total"]
        net = round(total / 1.21, 2) if ri else total
        n = 1 + max([i["number"] for i in self.db["invoices"] if i["cbte_type"] == tipo] or [0])
        inv = {"id": str(uuid.uuid4()), "restaurant_id": order["restaurant_id"], "order_id": order["id"], "environment": "homologacion",
               "cbte_type": tipo, "point_of_sale": fs["point_of_sale"], "number": n, "issued_on": time.strftime("%Y-%m-%d"),
               "doc_type": r.get("doc_type", 99), "doc_number": r.get("doc_number", "0"), "receiver_name": r.get("name"),
               "receiver_condition": cond, "total": total, "net": net, "vat": round(total - net, 2), "cae": "76123456789012",
               "cae_due": time.strftime("%Y-%m-%d", time.gmtime(time.time() + 10 * 86400)), "status": "authorized",
               "error": None, "notes": None, "created_by": USER_ID, "created_at": now_iso(),
               "associated_id": None, "credit_note_id": None, "reason": None}
        self.db["invoices"].append(inv)
        return {"invoice": inv}

    def _merge_orders(self, args):
        t, src = self._find("orders", args["p_target"]), self._find("orders", args["p_source"])
        if not t or not src or t["status"] != "open" or src["status"] != "open":
            raise BusinessError("Las dos comandas tienen que estar abiertas")
        if src["paid_total"] > 0:
            raise BusinessError("La comanda ya tiene pagos")
        for i in self.db["order_items"]:
            if i["order_id"] == src["id"]:
                i["order_id"] = t["id"]
        src.update({"status": "cancelled", "subtotal": 0, "total": 0, "cancelled_reason": f"Unida a la comanda #{t['number']}"})
        self._recalc_order(t["id"])
        if t.get("guests") or src.get("guests"):
            t["guests"] = (t.get("guests") or 0) + (src.get("guests") or 0)
        return t["id"]

    # ---------- RPC ----------
    def _invite(self, token):
        return next((i for i in self.db["restaurant_invites"] if i["token"] == token), None)

    def _invite_preview(self, args):
        inv = self._invite(args["p_token"])
        if not inv:
            return {"status": "invalid"}
        member = any(m["restaurant_id"] == inv["restaurant_id"] and m["user_id"] == USER_ID and m["active"]
                     for m in self.db["restaurant_members"])
        status = ("member" if member else "revoked" if inv["revoked_at"] else "used" if inv["accepted_at"]
                  else "expired" if inv["expires_at"] <= now_iso() else "ok")
        by = self._find("profiles", inv["created_by"])
        return {"status": status, "restaurant_id": inv["restaurant_id"], "role": inv["role"],
                "restaurant_name": self._find("restaurants", inv["restaurant_id"])["name"],
                "invited_by": by["full_name"] if by else None, "expires_at": inv["expires_at"]}

    def _accept_invite(self, args):
        inv = self._invite(args["p_token"])
        if not inv:
            raise BusinessError("El link de invitación no es válido.")
        if inv["revoked_at"]:
            raise BusinessError("Esta invitación fue anulada. Pedí un link nuevo.")
        if inv["accepted_at"]:
            raise BusinessError("Esta invitación ya se usó. Pedí un link nuevo.")
        cur = next((m for m in self.db["restaurant_members"]
                    if m["restaurant_id"] == inv["restaurant_id"] and m["user_id"] == USER_ID), None)
        if cur and cur["active"]:
            raise BusinessError("Ya sos parte de este local.")
        if cur:
            cur.update({"role": inv["role"], "active": True})
        else:
            self.db["restaurant_members"].append({"restaurant_id": inv["restaurant_id"], "user_id": USER_ID,
                                                  "role": inv["role"], "display_name": None, "active": True})
        inv.update({"accepted_at": now_iso(), "accepted_by": USER_ID})
        return inv["restaurant_id"]

    def _create_restaurant(self, args):
        rid = str(uuid.uuid4())
        self.db["restaurants"].append({"id": rid, "name": args["p_name"].strip(), "currency": "ARS",
                                       "timezone": "America/Argentina/Buenos_Aires", "created_at": now_iso(),
                                       "updated_at": now_iso(), "legal_name": None, "cuit": None, "address": None,
                                       "phone": None, "created_by": USER_ID,
                                       "menu_slug": None, "menu_public": False, "menu_note": None, "is_demo": False})
        self.db["restaurant_members"].append({"restaurant_id": rid, "user_id": USER_ID, "role": "owner",
                                              "display_name": None, "active": True})
        for i, name in enumerate(["Cocina", "Barra"]):
            self.db["stations"].append({"id": str(uuid.uuid4()), "restaurant_id": rid, "name": name, "sort_order": i, "active": True})
        self.db["registers"].append({"id": str(uuid.uuid4()), "restaurant_id": rid, "name": "Caja principal",
                                     "active": True, "blind_close": False, "created_at": now_iso()})
        for i, (name, kind) in enumerate([("Efectivo", "cash"), ("Débito", "debit"), ("Crédito", "credit"),
                                          ("Transferencia", "transfer"), ("Mercado Pago", "mercadopago"),
                                          ("Cuenta corriente", "account")]):
            self.db["payment_methods"].append({"id": str(uuid.uuid4()), "restaurant_id": rid, "name": name, "kind": kind,
                                               "sort_order": i, "active": True})
        area = str(uuid.uuid4())
        self.db["dining_areas"].append({"id": area, "restaurant_id": rid, "name": "Salón", "sort_order": 0, "active": True})
        for i in range(1, int(args.get("p_tables", 10)) + 1):
            self.db["tables"].append({"id": str(uuid.uuid4()), "restaurant_id": rid, "area_id": area, "name": str(i),
                                      "seats": 4, "sort_order": i, "active": True, "pos_x": 0, "pos_y": 0})
        return rid

    def _create_demo(self):
        if any(r.get("is_demo") and any(m["restaurant_id"] == r["id"] and m["user_id"] == USER_ID for m in self.db["restaurant_members"])
               for r in self.db["restaurants"]):
            raise BusinessError("Ya tenés un local de demostración. Borralo para crear otro.")
        rid = self._create_restaurant({"p_name": "Bodegón La Esquina (demo)", "p_tables": 12})
        r = self._find("restaurants", rid)
        r.update({"is_demo": True, "address": "Av. Corrientes 1234, CABA"})
        cat = str(uuid.uuid4())
        self.db["categories"].append({"id": cat, "restaurant_id": rid, "name": "Principales", "sort_order": 0, "active": True,
                                      "parent_id": None, "created_at": now_iso()})
        cocina = next(x["id"] for x in self.db["stations"] if x["restaurant_id"] == rid and x["name"] == "Cocina")
        for i, (name, price) in enumerate([("Milanesa napolitana", 14500), ("Bife de chorizo", 18900)]):
            self.db["products"].append({"id": str(uuid.uuid4()), "restaurant_id": rid, "category_id": cat, "station_id": cocina,
                                        "name": name, "description": None, "price": price, "sku": None, "image_url": None,
                                        "is_favorite": True, "sort_order": i, "active": True, "created_at": now_iso()})
        self.demo_days = 0
        return rid

    def _delete_demo(self, rid):
        r = self._find("restaurants", rid)
        if not r or not r.get("is_demo"):
            raise BusinessError("Solo el dueño de un local de demostración puede hacer esto")
        for table, rows in self.db.items():
            if isinstance(rows, list) and table != "restaurants":
                self.db[table] = [x for x in rows if not (isinstance(x, dict) and x.get("restaurant_id") == rid)]
        self.db["restaurants"] = [x for x in self.db["restaurants"] if x["id"] != rid]

    # ---------- handler ----------
    def handle(self, route):
        req = route.request
        u = urlparse(req.url)
        qs = parse_qs(u.query)
        path, method = u.path, req.method
        accept = req.headers.get("accept", "")
        prefer = req.headers.get("prefer", "")
        single = "vnd.pgrst.object" in accept

        def reply(status=200, body=None):
            route.fulfill(status=status, headers={"access-control-allow-origin": "*", "content-type": "application/json"},
                          body="" if body is None else json.dumps(body))

        def rows_out(rows, status=200):
            if single:
                return reply(status, rows[0] if rows else None) if rows else reply(406, {"message": "sin filas"})
            return reply(status, rows)

        if method == "OPTIONS":
            return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*",
                                                      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS"})

        # --- Auth ---
        if path == "/auth/v1/token":
            data = json.loads(req.post_data or "{}")
            if data.get("email") == EMAIL and data.get("password") == PASSWORD:
                return reply(200, {"access_token": fake_jwt(), "token_type": "bearer", "expires_in": 3600,
                                   "expires_at": int(time.time()) + 3600, "refresh_token": "fake-refresh", "user": self._user()})
            return reply(400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})
        if path == "/auth/v1/user":
            return reply(200, self._user())
        if path == "/auth/v1/logout":
            return reply(204)

        if path in ("/rest/v1/rpc/create_demo_restaurant", "/rest/v1/rpc/demo_fill_day", "/rest/v1/rpc/demo_finish",
                    "/rest/v1/rpc/delete_demo_restaurant"):
            a = json.loads(req.post_data or "{}")
            try:
                if path.endswith("create_demo_restaurant"):
                    return reply(200, self._create_demo())
                if path.endswith("demo_fill_day"):
                    self.demo_days = getattr(self, "demo_days", 0) + 1
                    return reply(200, 20)
                if path.endswith("demo_finish"):
                    return reply(204, None)
                self._delete_demo(a["p_restaurant"])
                return reply(204, None)
            except BusinessError as e:
                return reply(400, {"code": "P0001", "message": str(e)})
        if path == "/rest/v1/rpc/create_restaurant":
            return reply(200, self._create_restaurant(json.loads(req.post_data or "{}")))
        if path == "/rest/v1/rpc/set_public_menu":
            a = json.loads(req.post_data or "{}")
            r = self._find("restaurants", a["p_restaurant"])
            slug = a["p_slug"].strip().lower()
            import re as _re
            if not _re.match(r"^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$", slug):
                return reply(400, {"code": "P0001", "message": "La dirección va en minúsculas, sin espacios ni tildes"})
            r.update({"menu_slug": slug, "menu_public": a["p_public"], "menu_note": (a.get("p_note") or "").strip() or None})
            return reply(200, slug)
        if path == "/rest/v1/rpc/public_menu":
            a = json.loads(req.post_data or "{}")
            r = next((x for x in self.db["restaurants"] if x.get("menu_slug") == a["p_slug"].lower() and x.get("menu_public")), None)
            if not r:
                return reply(200, None)
            prods = [p for p in self.db["products"] if p["restaurant_id"] == r["id"] and p["active"]]
            def options(pid):
                out = []
                for l in self.db["product_modifier_groups"]:
                    if l["product_id"] == pid:
                        g = self._find("modifier_groups", l["group_id"])
                        out.append({"group": g["name"], "choices": [{"name": m["name"], "price_delta": m["price_delta"]}
                                    for m in self.db["modifiers"] if m["group_id"] == g["id"] and m["active"]]})
                return out
            return reply(200, {
                "restaurant": {"name": r["name"], "address": r.get("address"), "phone": r.get("phone"), "note": r.get("menu_note")},
                "categories": [{"id": c["id"], "name": c["name"]} for c in self.db["categories"]
                               if c["restaurant_id"] == r["id"] and c["active"] and any(p["category_id"] == c["id"] for p in prods)],
                "products": [{"id": p["id"], "name": p["name"], "description": p.get("description"), "price": p["price"],
                              "category_id": p.get("category_id"), "favorite": p.get("is_favorite"), "image_url": None,
                              "options": options(p["id"])} for p in prods]})
        if path == "/rest/v1/rpc/register_purchase":
            p = json.loads(req.post_data or "{}")["p_purchase"]
            sup = self._find("suppliers", p["supplier_id"])
            pid = str(uuid.uuid4())
            self.db["purchases"].append({"id": pid, "restaurant_id": sup["restaurant_id"], "supplier_id": sup["id"],
                "issued_on": p["issued_on"], "due_on": p.get("due_on"), "doc_kind": p.get("doc_kind") or "factura",
                "doc_number": p.get("doc_number") or None, "category": p.get("category") or "mercaderia", "total": p["total"],
                "notes": p.get("notes") or None, "cancelled_at": None, "created_by": USER_ID, "created_at": now_iso()})
            for it in p["items"]:
                ing = self._find("ingredients", it["ingredient_id"]) if it.get("ingredient_id") else None
                self.db["purchase_items"].append({"id": str(uuid.uuid4()), "restaurant_id": sup["restaurant_id"], "purchase_id": pid,
                    "ingredient_id": it.get("ingredient_id"), "description": it.get("description") or (ing or {}).get("name"),
                    "quantity": it["quantity"], "line_total": it["line_total"]})
                if ing:
                    self._apply_stock({"ingredient_id": ing["id"], "qty_delta": it["quantity"], "reason": "purchase",
                                       "unit_cost": round(it["line_total"] / it["quantity"], 4) if it["line_total"] else None})
            mv = lambda kind, amount, **kw: self.db["supplier_movements"].append(dict({"id": str(uuid.uuid4()),
                "restaurant_id": sup["restaurant_id"], "supplier_id": sup["id"], "kind": kind, "amount": amount, "purchase_id": pid,
                "payment_method_id": None, "cash_movement_id": None, "note": None, "created_by": USER_ID, "created_at": now_iso()}, **kw))
            mv("purchase", p["total"], note=p.get("doc_number"))
            if p.get("paid"):
                mv("payment", -p["paid"]["amount"], payment_method_id=p["paid"]["method_id"])
            return reply(200, pid)
        if path == "/rest/v1/rpc/supplier_payment":
            a = json.loads(req.post_data or "{}")
            sup = self._find("suppliers", a["p_supplier"])
            bal = sum(m["amount"] for m in self.db["supplier_movements"] if m["supplier_id"] == sup["id"])
            if a["p_amount"] > bal + 0.009:
                return reply(400, {"code": "P0001", "message": "El pago supera lo que se le debe"})
            self.db["supplier_movements"].append({"id": str(uuid.uuid4()), "restaurant_id": sup["restaurant_id"], "supplier_id": sup["id"],
                "kind": "payment", "amount": -a["p_amount"], "purchase_id": None, "payment_method_id": a["p_method"],
                "cash_movement_id": None, "note": a.get("p_note"), "created_by": USER_ID, "created_at": now_iso()})
            return reply(200, bal - a["p_amount"])
        if path == "/rest/v1/rpc/customer_payment":
            a = json.loads(req.post_data or "{}")
            bal = sum(m["amount"] for m in self.db["customer_movements"] if m["customer_id"] == a["p_customer"])
            if a["p_amount"] > bal + 0.009:
                return reply(400, {"code": "P0001", "message": f"El pago supera la deuda ({bal})"})
            c = self._find("customers", a["p_customer"])
            self.db["customer_movements"].append({"id": str(uuid.uuid4()), "restaurant_id": c["restaurant_id"], "customer_id": c["id"],
                "kind": "payment", "amount": -a["p_amount"], "order_id": None, "payment_id": None, "payment_method_id": a["p_method"],
                "cash_movement_id": None, "note": a.get("p_note"), "created_by": USER_ID, "created_at": now_iso()})
            return reply(200, bal - a["p_amount"])
        if path == "/rest/v1/rpc/merge_orders":
            try:
                return reply(200, self._merge_orders(json.loads(req.post_data or "{}")))
            except BusinessError as e:
                return reply(400, {"code": "P0001", "message": str(e)})
        if path == "/rest/v1/rpc/stock_count":
            return reply(200, self._stock_count(json.loads(req.post_data or "{}")))
        if path == "/rest/v1/rpc/income_statement":
            return reply(200, self._income_statement(json.loads(req.post_data or "{}")))
        if path == "/rest/v1/rpc/sales_report":
            return reply(200, self._sales_report(json.loads(req.post_data or "{}")))
        if path == "/functions/v1/arca":
            try:
                return reply(200, self._arca(json.loads(req.post_data or "{}")))
            except BusinessError as e:
                return reply(400, {"error": str(e)})
        if path == "/functions/v1/mercadopago":
            try:
                return reply(200, self._mercadopago(json.loads(req.post_data or "{}")))
            except BusinessError as e:
                return reply(400, {"error": str(e)})
        if path in ("/rest/v1/rpc/invite_preview", "/rest/v1/rpc/accept_invite"):
            fn = self._invite_preview if path.endswith("preview") else self._accept_invite
            try:
                return reply(200, fn(json.loads(req.post_data or "{}")))
            except BusinessError as e:
                return reply(400, {"code": "P0001", "message": str(e)})
        if path == "/rest/v1/rpc/close_cash_session":
            try:
                return reply(200, self._close_cash(json.loads(req.post_data or "{}")))
            except BusinessError as e:
                return reply(400, {"code": "P0001", "message": str(e)})

        if not path.startswith("/rest/v1/"):
            return reply(404, {"message": f"sin simular: {method} {path}"})

        table = path.removeprefix("/rest/v1/")
        if table not in self.db:
            return reply(404, {"message": f"tabla desconocida {table}"})
        rows = self.db[table]
        filters = self._filters(qs)

        try:
            if method == "HEAD":
                n = len([r for r in rows if self._match(r, filters)])
                return route.fulfill(status=200, headers={"access-control-allow-origin": "*",
                                                          "access-control-expose-headers": "content-range",
                                                          "content-range": f"0-{max(n - 1, 0)}/{n}"}, body="")
            if method == "GET":
                if table == "supplier_balances":
                    rows = [{"id": x["id"], "restaurant_id": x["restaurant_id"],
                             "balance": sum(m["amount"] for m in self.db["supplier_movements"] if m["supplier_id"] == x["id"])}
                            for x in self.db["suppliers"]]
                if table == "customer_balances":
                    rows = [{"id": c["id"], "restaurant_id": c["restaurant_id"],
                             "balance": sum(m["amount"] for m in self.db["customer_movements"] if m["customer_id"] == c["id"])}
                            for c in self.db["customers"]]
                result = [r for r in rows if self._match(r, filters)]
                if table == "restaurant_members" and "restaurant:restaurants" in qs.get("select", [""])[0]:
                    result = [{"role": r["role"], "restaurant": self._find("restaurants", r["restaurant_id"])} for r in result]
                return rows_out(result)

            if method == "POST":
                body = json.loads(req.post_data or "{}")
                new_rows = body if isinstance(body, list) else [body]
                created = []
                for row in new_rows:
                    self._before_insert(table, row)
                    rows.append(row)
                    self._after_write(table, row)
                    created.append(row)
                return rows_out(created, 201) if "return=representation" in prefer else reply(201)

            if method == "PATCH":
                patch = json.loads(req.post_data or "{}")
                changed = []
                for r in [r for r in rows if self._match(r, filters)]:
                    self._apply_patch(table, r, patch)
                    self._after_write(table, r)
                    changed.append(r)
                return rows_out(changed) if "return=representation" in prefer else reply(204)

            if method == "DELETE":
                gone = [r for r in rows if self._match(r, filters)]
                for r in gone:
                    if table == "order_items":
                        self._check_open(r["order_id"])
                    rows.remove(r)
                    self._after_write(table, r)
                return reply(204)
        except BusinessError as e:
            return reply(400, {"code": "P0001", "message": str(e)})

        return reply(405, {"message": f"método no simulado {method}"})
