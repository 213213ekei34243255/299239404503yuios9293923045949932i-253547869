"""Reads Electron's app.asar (the owner's installed Electron Jonah) WITHOUT changing it: lists or copies out files.

  python asar_tool.py <app.asar> list <path-prefix>
  python asar_tool.py <app.asar> extract <path-in-asar> <dest dir>     (a folder is copied with everything in it)

asar format: uint32 4, uint32 header pickle size, uint32 ?, uint32 JSON length, JSON header; file data starts at 8 + header size.
Files marked "unpacked" live in app.asar.unpacked next to the archive.
"""
import json, os, shutil, struct, sys


def load(path):
    f = open(path, "rb")
    _, hsize, _, jsize = struct.unpack("<4I", f.read(16))
    header = json.loads(f.read(jsize).decode("utf-8"))
    return f, header, 8 + hsize


def node(header, rel):
    n = header
    for part in [p for p in rel.replace("\\", "/").split("/") if p]:
        n = n["files"][part]
    return n


def walk(n, rel):
    if "files" in n:
        for k, v in n["files"].items():
            yield from walk(v, rel + "/" + k if rel else k)
    else:
        yield rel, n


def read_file(f, header, base, asar, rel):
    n = node(header, rel)
    if n.get("unpacked"):
        return open(os.path.join(asar + ".unpacked", *rel.split("/")), "rb").read()
    f.seek(base + int(n["offset"]))
    return f.read(int(n["size"]))


def closure(f, header, base, asar, roots):
    """The packages `roots` need at run time (package.json dependencies + optionalDependencies, resolved the way Node does:
    nested node_modules first, then each parent's), as asar paths like node_modules/x or node_modules/a/node_modules/b."""
    def exists(rel):
        try:
            node(header, rel)
            return True
        except KeyError:
            return False

    def resolve(name, from_dir):
        d = from_dir
        while True:
            cand = (d + "/node_modules/" if d else "node_modules/") + name
            if exists(cand + "/package.json"):
                return cand
            if not d:
                return None
            # go up one node_modules level
            i = d.rfind("/node_modules/")
            d = d[:i] if i >= 0 else ""

    seen, todo, missing = set(), [], []
    for r in roots:
        p = resolve(r, "")
        if p: todo.append(p)
        else: missing.append(r)
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        seen.add(p)
        pkg = json.loads(read_file(f, header, base, asar, p + "/package.json").decode("utf-8"))
        for dep in list((pkg.get("dependencies") or {}).keys()) + list((pkg.get("optionalDependencies") or {}).keys()):
            q = resolve(dep, p)
            if q: todo.append(q)
            elif dep not in (pkg.get("optionalDependencies") or {}): missing.append(f"{dep} (needed by {p})")
    return sorted(seen), missing


def size_of(header, rel):
    return sum(int(e.get("size", 0)) for _, e in walk(node(header, rel), ""))


def main():
    asar, cmd = sys.argv[1], sys.argv[2]
    f, header, base = load(asar)
    if cmd == "extract-closure":
        # python asar_tool.py <app.asar> extract-closure <roots,...> <dest> [skip,...]   (skip = asar path prefixes left out)
        pkgs, missing = closure(f, header, base, asar, sys.argv[3].split(","))
        dest = sys.argv[4]
        skip = [s for s in (sys.argv[5].split(",") if len(sys.argv) > 5 else []) if s]
        top = [p for p in pkgs if not any(p != q and p.startswith(q + "/") for q in pkgs)]
        count = size = 0
        for p in top:
            if any(p == s or p.startswith(s + "/") for s in skip):
                continue
            for rel, entry in walk(node(header, p), p):
                if "link" in entry or any(rel.startswith(s + "/") or rel == s for s in skip):
                    continue
                out = os.path.join(dest, *rel.split("/"))
                os.makedirs(os.path.dirname(out), exist_ok=True)
                if entry.get("unpacked"):
                    shutil.copyfile(os.path.join(asar + ".unpacked", *rel.split("/")), out)
                else:
                    f.seek(base + int(entry["offset"]))
                    with open(out, "wb") as o:
                        o.write(f.read(int(entry["size"])))
                count += 1
                size += int(entry.get("size", 0))
        print(f"extracted {count} files, {size / 1e6:.1f} MB into {dest}; missing: {missing}")
        return
    if cmd == "closure":
        pkgs, missing = closure(f, header, base, asar, sys.argv[3].split(","))
        # a package nested inside another one in the list is copied with it
        top = [p for p in pkgs if not any(p != q and p.startswith(q + "/") for q in pkgs)]
        total = sum(size_of(header, p) for p in top)
        for p in top:
            print(f"{size_of(header, p) / 1e6:8.1f} MB  {p}")
        print(f"{len(pkgs)} packages ({len(top)} folders), {total / 1e6:.1f} MB; missing: {missing}")
        return
    if cmd == "list":
        prefix = sys.argv[3] if len(sys.argv) > 3 else ""
        n = node(header, prefix)
        for k in sorted(n.get("files", {}).keys()):
            print(k)
        return
    if cmd == "extract":
        rel, dest = sys.argv[3], sys.argv[4]
        n = node(header, rel)
        count = size = 0
        for path, entry in walk(n, ""):
            out = os.path.join(dest, *(path.split("/"))) if path else os.path.join(dest, os.path.basename(rel))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            if "link" in entry:
                continue
            if entry.get("unpacked"):
                src = os.path.join(asar + ".unpacked", *rel.split("/"), *path.split("/"))
                shutil.copyfile(src, out)
            else:
                f.seek(base + int(entry["offset"]))
                with open(out, "wb") as o:
                    o.write(f.read(int(entry["size"])))
            count += 1
            size += int(entry.get("size", 0))
        print(f"copied {rel}: {count} files, {size / 1e6:.1f} MB -> {dest}")


main()
