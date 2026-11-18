"""Copies files out of a Chromium/Electron Cache Storage folder (the "simple cache" format) WITHOUT changing it.

  python cache_extract.py <cache folder> <url prefix> <dest dir>

Each entry file "<hash>_0" is: header (24 bytes) + key (the URL) + stream 1 (the response body) + EOF record + stream 0 (headers) +
EOF record. The body is everything between the key and the first EOF record. Files are written under <dest dir> by their path after
<url prefix> (e.g. ".../resolve/main/onnx/encoder.onnx" -> <dest>/onnx/encoder.onnx).
"""
import os, struct, sys

INITIAL_MAGIC = 0xFCFB6D1BA7725C30
EOF_MAGIC = struct.pack("<Q", 0xF4FA6F45970D41D8)

folder, prefix, dest = sys.argv[1], sys.argv[2], sys.argv[3]
n = 0
for name in sorted(os.listdir(folder)):
    if not name.endswith("_0"):
        continue
    data = open(os.path.join(folder, name), "rb").read()
    magic, version, key_len, key_hash = struct.unpack_from("<QIII", data, 0)
    if magic != INITIAL_MAGIC:
        continue
    key_start = 24
    key = data[key_start:key_start + key_len].decode("utf-8", "replace")
    url = key[key.find("http"):] if "http" in key else key
    if not url.startswith(prefix):
        continue
    body_start = key_start + key_len
    end = data.find(EOF_MAGIC, body_start)
    if end < 0:
        print("no end record:", url); continue
    body = data[body_start:end]
    rel = url[len(prefix):].split("?")[0].lstrip("/")
    out = os.path.join(dest, *rel.split("/"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(body)
    n += 1
    print(f"{len(body):>10} bytes  {rel}")
print(f"{n} files -> {dest}")
