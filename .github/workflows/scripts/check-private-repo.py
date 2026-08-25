#!/usr/bin/env python3
"""Valida que el repo privado de datos exista, sea privado y el token pueda escribir.

Uso: check-private-repo.py <archivo-con-la-respuesta-de-la-API-de-GitHub>
"""
import json
import sys

with open(sys.argv[1]) as f:
    d = json.load(f)

if "private" not in d:
    print(f"::error::La API no devolvió un repo válido: {d.get('message', d)}")
    sys.exit(1)

print(f"  private: {d['private']} | default_branch: {d['default_branch']} | permissions: {d.get('permissions')}")

if not d["private"]:
    print("::error::El repo no figura como privado.")
    sys.exit(1)

if not d.get("permissions", {}).get("push"):
    print("::error::El token no tiene permiso de push sobre este repo.")
    sys.exit(1)
