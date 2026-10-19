"""Backend simulado de Supabase para probar la UI cuando la red del sandbox no llega a supabase.co.

Imita PostgREST/Auth lo suficiente para los flujos de la app y replica las reglas de negocio
de los triggers de Postgres que la UI necesita ver (número de comanda, precios desde la carta,
modificadores, subtotales). La lógica real se prueba aparte con SQL contra la base.
"""
import base64
import json
import time
import uuid
from urllib.parse import urlparse, parse_qs

USER_ID = str(uuid.uuid4())
EMAIL, PASSWORD, NAME = "qa-sprint0@comanda.test", "Prueba-2026!", "QA Sprint 0"

TABLES = [
    "restaurants", "restaurant_members", "profiles", "dining_areas", "tables", "stations",
    "categories", "products", "modifier_groups", "modifiers", "product_modifier_groups",
    "orders", "order_items", "payments",
]

DEFAULTS = {
    "categories": {"active": True, "sort_order": 0, "parent_id": None},
    "products": {"active": True, "sort_order": 0, "is_favorite": False, "description": None, "category_id": None,
                 "station_id": None, "price": 0, "sku": None, "image_url": None},
    "modifier_groups": {"min_select": 0, "max_select": 1},
    "modifiers": {"active": True, "sort_order": 0, "price_delta": 0},
    "product_modifier_groups": {"sort_order": 0},
    "orders": {"type": "dine_in", "status": "open", "table_id": None, "customer_name": None, "guests": None,
               "notes": None, "subtotal": 0, "discount_amount": 0, "total": 0, "paid_total": 0,
               "cash_session_id": None, "closed_at": None, "cancelled_reason": None},
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

    def _before_insert(self, table, row):
        row.setdefault("id", str(uuid.uuid4()))
        row.setdefault("created_at", now_iso())
        row.setdefault("updated_at", now_iso())
        for k, v in DEFAULTS.get(table, {}).items():
            row.setdefault(k, json.loads(json.dumps(v)))
        if table == "orders":
            self.counter += 1
            row["number"] = self.counter
            row.setdefault("opened_at", now_iso(offset_min=5))
        if table == "order_items":
            self._check_open(row["order_id"])
            self._enrich_item(row, True)
            if row["status"] in ("sent", "preparing", "ready", "delivered"):
                row["sent_at"] = now_iso()
            self._item_line(row)

    def _after_write(self, table, row):
        if table == "order_items":
            self._recalc_order(row["order_id"])

    def _apply_patch(self, table, row, patch):
        if table == "order_items":
            self._check_open(row["order_id"]) if any(k in patch for k in ("quantity", "modifiers", "product_id")) else None
            row.update(patch)
            if "modifiers" in patch:
                self._enrich_item(row, False)
            if row["status"] in ("sent", "preparing", "ready", "delivered") and not row.get("sent_at"):
                row["sent_at"] = now_iso()
            self._item_line(row)
        elif table == "orders":
            if patch.get("status") == "cancelled" and row["paid_total"] > 0:
                raise BusinessError("No se puede anular la comanda: tiene pagos registrados")
            row.update(patch)
            row["total"] = max(row["subtotal"] - row["discount_amount"], 0)
        else:
            row.update(patch)
        row["updated_at"] = now_iso()

    # ---------- RPC ----------
    def _create_restaurant(self, args):
        rid = str(uuid.uuid4())
        self.db["restaurants"].append({"id": rid, "name": args["p_name"].strip(), "currency": "ARS",
                                       "timezone": "America/Argentina/Buenos_Aires", "created_at": now_iso(),
                                       "updated_at": now_iso(), "legal_name": None, "cuit": None, "address": None,
                                       "phone": None, "created_by": USER_ID})
        self.db["restaurant_members"].append({"restaurant_id": rid, "user_id": USER_ID, "role": "owner",
                                              "display_name": None, "active": True})
        for i, name in enumerate(["Cocina", "Barra"]):
            self.db["stations"].append({"id": str(uuid.uuid4()), "restaurant_id": rid, "name": name, "sort_order": i, "active": True})
        area = str(uuid.uuid4())
        self.db["dining_areas"].append({"id": area, "restaurant_id": rid, "name": "Salón", "sort_order": 0, "active": True})
        for i in range(1, int(args.get("p_tables", 10)) + 1):
            self.db["tables"].append({"id": str(uuid.uuid4()), "restaurant_id": rid, "area_id": area, "name": str(i),
                                      "seats": 4, "sort_order": i, "active": True, "pos_x": 0, "pos_y": 0})
        return rid

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

        if path == "/rest/v1/rpc/create_restaurant":
            return reply(200, self._create_restaurant(json.loads(req.post_data or "{}")))

        if not path.startswith("/rest/v1/"):
            return reply(404, {"message": f"sin simular: {method} {path}"})

        table = path.removeprefix("/rest/v1/")
        if table not in self.db:
            return reply(404, {"message": f"tabla desconocida {table}"})
        rows = self.db[table]
        filters = self._filters(qs)

        try:
            if method == "GET":
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
