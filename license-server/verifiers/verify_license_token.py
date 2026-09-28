"""Drop-in verifier for any Python backend (Flask, FastAPI, ...). Needs the `cryptography` package. Copy this one file next to your server.

    from verify_license_token import LicenseVerifier, LicenseError

    verifier = LicenseVerifier(keys=[{"kid": "k1234", "spki": "MCowBQYDK2VwAyEA..."}])   # from GET <licence server>/v1/public-keys

    # Flask:
    #   token = request.headers.get("X-Jonah-License", "")
    #   try: claims = verifier.verify_header(token)
    #   except LicenseError: abort(401)
    # FastAPI:
    #   def require_license(x_jonah_license: str = Header("")):
    #       try: return verifier.verify_header(x_jonah_license)
    #       except LicenseError: raise HTTPException(401)

The token lives 3 minutes and the app renews it every minute while the licence server still approves the account, so a backend that checks it
stops serving a banned/revoked/deactivated account within a few minutes, without ever calling the licence server.
"""
import base64
import json
import re
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_der_public_key


class LicenseError(Exception):
    """The token is missing, forged, expired, or not for this service. `reason` says which."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _b64u(data):
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


class LicenseVerifier:
    def __init__(self, keys, issuer="jonah-license", audience="jonah-mac", skew_seconds=30, clock=time.time):
        self._keys = {}
        for k in keys:
            pub = load_der_public_key(_b64u(k["spki"]))
            if not isinstance(pub, Ed25519PublicKey):
                raise ValueError("licence keys must be Ed25519")
            self._keys[k["kid"]] = pub
        if not self._keys:
            raise ValueError("LicenseVerifier needs at least one public key")
        self._issuer, self._audience, self._skew, self._clock = issuer, audience, skew_seconds, clock

    def verify(self, token):
        parts = str(token or "").split(".")
        if len(parts) != 3:
            raise LicenseError("malformed")
        try:
            head = json.loads(_b64u(parts[0]))
            claims = json.loads(_b64u(parts[1]))
            signature = _b64u(parts[2])
        except Exception:
            raise LicenseError("malformed")
        if not isinstance(head, dict) or head.get("alg") != "EdDSA" or head.get("typ") != "JLT":
            raise LicenseError("bad_alg")  # never "none", never a shared secret
        key = self._keys.get(head.get("kid"))
        if key is None:
            raise LicenseError("unknown_kid")
        try:
            key.verify(signature, (parts[0] + "." + parts[1]).encode("ascii"))
        except (InvalidSignature, ValueError):
            raise LicenseError("bad_signature")
        if not isinstance(claims, dict):
            raise LicenseError("malformed")
        if claims.get("iss") != self._issuer:
            raise LicenseError("bad_issuer")
        if claims.get("aud") != self._audience:
            raise LicenseError("bad_audience")
        exp, iat = claims.get("exp"), claims.get("iat")
        if not isinstance(exp, (int, float)) or not isinstance(iat, (int, float)):
            raise LicenseError("malformed")
        now = self._clock()
        if exp + self._skew < now:
            raise LicenseError("expired")
        if iat - self._skew > now:
            raise LicenseError("not_yet_valid")
        if claims.get("unl") != 1:
            raise LicenseError("not_unlimited")
        return claims

    def verify_header(self, value):
        return self.verify(re.sub(r"^Bearer\s+", "", str(value or ""), flags=re.I).strip())
