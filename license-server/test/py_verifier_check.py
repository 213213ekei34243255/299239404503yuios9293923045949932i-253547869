"""Used by verifier.test.cjs: verifies tokens made by the Node server with the Python verifier, and prints one result per token."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "verifiers"))
from verify_license_token import LicenseError, LicenseVerifier  # noqa: E402

fixture = json.load(open(sys.argv[1]))
verifier = LicenseVerifier(keys=fixture["keys"], clock=lambda: fixture["now"])
out = {}
for name, token in fixture["tokens"].items():
    try:
        claims = verifier.verify_header("Bearer " + token if name != "raw" else token)
        out[name] = "ok:" + str(claims.get("usr"))
    except LicenseError as e:
        out[name] = "refused:" + e.reason
print(json.dumps(out))
