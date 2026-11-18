"""Builds <jonah dir>\\noah-native: the parts of Electron Jonah that must run in Node (unchanged code), next to the browser.

  python make_noah_native.py <electron project dir> <jonah dir> [<jonah dir> ...]

Contents:
  node.exe                     Node from the Chromium checkout (C:\\src\\chromium\\src\\third_party\\node\\win\\node.exe - Google's copy,
                               fetched by gclient sync; nothing new is downloaded)
  app\\Noah\\                    Electron Jonah's Noah folder, unchanged (tests, benchmarks and docs left out): the computer agent
  app\\attachments.cjs, file-extract.cjs, search-proxy.cjs, search-providers.cjs, app\\Rexy\\llm.cjs, grounding.cjs, chat-complete.cjs,
  logger.cjs                   Electron Jonah's files, unchanged: chat attachments (PDF, Word, Excel, PowerPoint, OpenDocument, images
                               with tesseract OCR...), and the chat's answers with web search
  app\\node_modules\\            the libraries those files use (pdfjs-dist, mammoth, word-extractor, SheetJS, jszip, cfb, tesseract.js,
                               axios, transformers.js + ONNX runtime), copied out of the owner's INSTALLED Electron Jonah (app.asar)
                               by scripts\\asar_tool.py into downloads\\from-electron - no download
  app\\models\\                  Moonshine-base speech recognition (Electron's voice), copied out of Electron Jonah's own browser cache
                               by scripts\\cache_extract.py - no download
  noah-native-host.cjs, noah-stop-bar.ps1, noah-ocr.ps1, noah-elevated-host.ps1   Jonah's own glue (scripts\\jonah-ext-src\\native)
  noah-native.cmd              what Chromium starts
  com.cogniai.jonah.noah.json  the native messaging manifest; Jonah finds it in <exe dir>\\noah-native (launch_context_win.cc), no registry
  data\\                        created at run time (settings, task history, audit log, noah-native.log, tesseract-cache\\eng.traineddata
                               copied from Electron Jonah's data) - kept across updates
"""
import json, shutil, sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "jonah-ext-src" / "native"
FROM_ELECTRON = HERE.parent / "downloads" / "from-electron"   # node_modules, models, tesseract-cache (see above)
NODE = Path(r"C:\src\chromium\src\third_party\node\win\node.exe")
EXT_ID = "idkbjcjlmnkoikibnjjlajfjmimdmajp"
SKIP = {"bench", "test", "docs"}
APP_FILES = ["attachments.cjs", "file-extract.cjs", "search-proxy.cjs", "search-providers.cjs",
             "Rexy/llm.cjs", "Rexy/grounding.cjs", "Rexy/chat-complete.cjs", "Rexy/logger.cjs",
             "Trust/controller.cjs", "Trust/service.cjs", "Trust/engine.cjs"]

electron = Path(sys.argv[1])
targets = [Path(p) for p in sys.argv[2:]]
if not targets:
    sys.exit(__doc__)
noah = electron / "Noah"
assert (noah / "autonomy" / "service.cjs").is_file(), f"Noah not found in {electron}"
assert NODE.is_file(), f"{NODE} missing"
for need in ("node_modules/tesseract.js/package.json", "node_modules/@huggingface/transformers/package.json",
             "models/onnx-community/moonshine-base-ONNX/onnx/encoder_model_quantized.onnx", "tesseract-cache/eng.traineddata"):
    assert (FROM_ELECTRON / need).is_file(), f"{FROM_ELECTRON / need} missing (run asar_tool.py / cache_extract.py first)"


def sync_tree(src: Path, dst: Path):
    """Copy files that are missing or differ in size (the big library/model folders change rarely)."""
    n = 0
    for f in src.rglob("*"):
        if not f.is_file():
            continue
        d = dst / f.relative_to(src)
        if d.is_file() and d.stat().st_size == f.stat().st_size:
            continue
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, d)
        n += 1
    return n


for jonah in targets:
    out = jonah / "noah-native"
    app = out / "app"
    app.mkdir(parents=True, exist_ok=True)
    # older layout had Noah\ at the top: it moved into app\ (next to the Electron files that use ..\Noah)
    if (out / "Noah").exists():
        shutil.rmtree(out / "Noah")
    # Noah + Electron's files: replaced whole each time (data\ is never touched)
    if (app / "Noah").exists():
        shutil.rmtree(app / "Noah")
    shutil.copytree(noah, app / "Noah", ignore=lambda d, names: [n for n in names if (Path(d) == noah and n in SKIP) or n == "node_modules"])
    for rel in APP_FILES:
        (app / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(electron / rel, app / rel)
    libs = sync_tree(FROM_ELECTRON / "node_modules", app / "node_modules")
    models = sync_tree(FROM_ELECTRON / "models", app / "models")
    tess = out / "data" / "tesseract-cache" / "eng.traineddata"
    if not tess.is_file():
        tess.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(FROM_ELECTRON / "tesseract-cache" / "eng.traineddata", tess)
    if not (out / "node.exe").is_file() or (out / "node.exe").stat().st_size != NODE.stat().st_size:
        shutil.copy2(NODE, out / "node.exe")
    for f in ("noah-native-host.cjs", "noah-stop-bar.ps1", "noah-ocr.ps1", "noah-elevated-host.ps1"):
        shutil.copyfile(SRC / f, out / f)
    # "@" keeps cmd from echoing anything: stdout is the native messaging channel
    (out / "noah-native.cmd").write_text('@"%~dp0node.exe" "%~dp0noah-native-host.cjs" %*\r\n', encoding="ascii")
    (out / "com.cogniai.jonah.noah.json").write_text(json.dumps({
        "name": "com.cogniai.jonah.noah",
        "description": "Noah, Jonah's helper outside the browser: the computer agent, file attachments, chat with web search, speech recognition",
        "path": "noah-native.cmd",
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXT_ID}/"],
    }, indent=2) + "\n", encoding="utf-8")
    files = sum(1 for _ in out.rglob("*") if _.is_file())
    print(f"noah-native ready in {out} ({files} files; libraries updated {libs}, model files updated {models})")
