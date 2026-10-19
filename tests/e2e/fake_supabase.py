"""Backend simulado de Supabase para probar la UI cuando la red no llega a supabase.co.
Implementa solo los endpoints que usa el sprint 0."""
import base64
import json
import time
import uuid
from urllib.parse import urlparse, parse_qs

USER_ID = str(uuid.uuid4())
EMAIL, PASSWORD, NAME = "qa-sprint0@comanda.test", "Prueba-2026!", "QA Sprint 0"


def _b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")


def fake_jwt():
    now = int(time.time())
    return f"{_b64({'alg': 'HS256', 'typ': 'JWT'})}.{_b64({'sub': USER_ID, 'role': 'authenticated', 'aud': 'authenticated', 'exp': now + 3600, 'iat': now, 'email': EMAIL})}.sig"


class FakeSupabase:
    def __init__(self):
        self.db = {k: [] for k in ["restaurants", "restaurant_members", "dining_areas", "tables", "orders", "profiles"]}
        self.db["profiles"].append({"id": USER_ID, "full_name": NAME})
        self.counter = 0

    # ---------- utilidades ----------
    @staticmethod
    def _filters(qs):
        out = []
        for k, vals in qs.items():
            if k in ("select", "order", "columns", "limit"):
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
                if str(cur).lower() != val.lower() and str(cur) != val:
                    return False
            elif op == "not" and val.startswith("is.null"):
                if cur is None:
                    return False
            elif op == "in":
                if str(cur) not in val.strip("()").split(","):
                    return False
        return True

    def _user(self):
        return {"id": USER_ID, "aud": "authenticated", "role": "authenticated", "email": EMAIL,
                "user_metadata": {"full_name": NAME}, "app_metadata": {"provider": "email"},
                "created_at": "2026-10-19T00:00:00Z"}

    # ---------- handler ----------
    def handle(self, route):
        req = route.request
        u = urlparse(req.url)
        qs = parse_qs(u.query)
        path = u.path
        method = req.method

        def reply(status=200, body=None):
            headers = {"access-control-allow-origin": "*", "content-type": "application/json"}
            route.fulfill(status=status, headers=headers, body="" if body is None else json.dumps(body))

        if method == "OPTIONS":
            return route.fulfill(status=200, headers={
                "access-control-allow-origin": "*", "access-control-allow-headers": "*",
                "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS"})

        # --- Auth ---
        if path == "/auth/v1/token":
            data = json.loads(req.post_data or "{}")
            if data.get("email") == EMAIL and data.get("password") == PASSWORD:
                return reply(200, {"access_token": fake_jwt(), "token_type": "bearer", "expires_in": 3600,
                                   "expires_at": int(time.time()) + 3600, "refresh_token": "fake-refresh",
                                   "user": self._user()})
            return reply(400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})
        if path == "/auth/v1/user":
            return reply(200, self._user())
        if path == "/auth/v1/logout":
            return reply(204)

        # --- RPC ---
        if path == "/rest/v1/rpc/create_restaurant":
            args = json.loads(req.post_data or "{}")
            rid = str(uuid.uuid4())
            now = "2026-10-19T12:00:00Z"
            self.db["restaurants"].append({"id": rid, "name": args["p_name"].strip(), "currency": "ARS",
                                           "timezone": "America/Argentina/Buenos_Aires", "created_at": now, "updated_at": now,
                                           "legal_name": None, "cuit": None, "address": None, "phone": None, "created_by": USER_ID})
            self.db["restaurant_members"].append({"restaurant_id": rid, "user_id": USER_ID, "role": "owner",
                                                  "display_name": None, "active": True})
            area = str(uuid.uuid4())
            self.db["dining_areas"].append({"id": area, "restaurant_id": rid, "name": "Salón", "sort_order": 0, "active": True})
            for i in range(1, int(args.get("p_tables", 10)) + 1):
                self.db["tables"].append({"id": str(uuid.uuid4()), "restaurant_id": rid, "area_id": area, "name": str(i),
                                          "seats": 4, "sort_order": i, "active": True, "pos_x": 0, "pos_y": 0})
            return reply(200, rid)

        # --- REST ---
        if path.startswith("/rest/v1/"):
            table = path.removeprefix("/rest/v1/")
            rows = self.db.get(table)
            if rows is None:
                return reply(404, {"message": f"tabla desconocida {table}"})
            filters = self._filters(qs)

            if method == "GET":
                result = [r for r in rows if self._match(r, filters)]
                if table == "restaurant_members" and "restaurant:restaurants" in qs.get("select", [""])[0]:
                    result = [{"role": r["role"], "restaurant": next(x for x in self.db["restaurants"] if x["id"] == r["restaurant_id"])}
                              for r in result]
                return reply(200, result)

            if method == "POST" and table == "orders":
                body = json.loads(req.post_data or "{}")
                body = body[0] if isinstance(body, list) else body
                self.counter += 1
                now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60 * 23 * self.counter))
                body.update({"id": str(uuid.uuid4()), "number": self.counter, "status": "open", "subtotal": 0,
                             "discount_amount": 0, "total": 18400 * (self.counter % 2), "paid_total": 0, "opened_at": now})
                rows.append(body)
                return reply(201)

            if method == "PATCH" and table == "orders":
                patch = json.loads(req.post_data or "{}")
                for r in rows:
                    if self._match(r, filters):
                        if patch.get("status") == "cancelled" and (r["total"] or r["paid_total"]):
                            return reply(400, {"message": "No se puede anular la comanda: tiene consumo"})
                        r.update(patch)
                return reply(204)

        return route.continue_() if False else reply(404, {"message": f"sin simular: {method} {path}"})
