import json, subprocess, time, statistics, threading, sys, os
from os.path import join, dirname, abspath

HERE = dirname(abspath(__file__))

P = json.load(open(os.environ.get("PARAMS", join(os.environ.get("HERDGATE_BENCH_ROOT", "/tmp/hg-conn"), "params.json"))))
VIA = join(HERE, "..", "..", "..", "..", "templates", "herdgate-via.mjs")
MARK = [
    ("banner", "Remote protocol version"),
    ("kexinit", "SSH2_MSG_KEXINIT sent"),
    ("newkeys", "SSH2_MSG_NEWKEYS received"),
    ("auth", "Authentication succeeded"),
    ("exec", "Sending command:"),
]
LINE = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "hello", "params": {}}) + "\n"


def one(extra, via, limit=8.0):
    cmd = [
        "ssh", "-v",
        "-p", "22" if via else str(P["sshPort"]),
        "-i", P["keyPath"],
        "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10", "-o", "LogLevel=DEBUG1",
    ]
    if via:
        cmd += ["-o", "ProxyCommand=node %s --tunnel --gate http://127.0.0.1:%d" % (VIA, P["httpPort"])]
    cmd += extra + [P["deviceId"] + "@127.0.0.1", "--", "hc connect"]
    t0 = time.monotonic()
    marks = {}
    pr = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    watchdog = threading.Timer(limit, pr.kill)
    watchdog.start()

    def err():
        for line in pr.stderr:
            for k, s in MARK:
                if k not in marks and s in line:
                    marks[k] = time.monotonic() - t0
    th = threading.Thread(target=err, daemon=True)
    th.start()
    pr.stdin.write(LINE)
    pr.stdin.flush()
    pr.stdin.close()
    first = pr.stdout.read(1)
    t_first = time.monotonic() - t0 if first else float("nan")
    pr.kill()
    watchdog.cancel()
    pr.wait()
    return [marks.get(k, float("nan")) for k in ("banner", "kexinit", "newkeys", "auth", "exec")] + [t_first]


def med(rows):
    return [statistics.median(c) * 1000 for c in zip(*rows)]


variants = [
    ("A raw TCP, mac dinh", [], False),
    ("B raw TCP, kex=ecdh-nistp256", ["-o", "KEXAlgorithms=ecdh-sha2-nistp256"], False),
    ("C raw TCP, kex=dh-group14", ["-o", "KEXAlgorithms=diffie-hellman-group14-sha256"], False),
    ("D raw TCP, kex=curve25519", ["-o", "KEXAlgorithms=curve25519-sha256"], False),
    ("E raw TCP, cipher=chacha20", ["-o", "Ciphers=chacha20-poly1305@openssh.com"], False),
    ("F raw TCP, cipher=aes128-gcm", ["-o", "Ciphers=aes128-gcm@openssh.com"], False),
    ("G raw TCP, hostkey=ssh-ed25519 only", ["-o", "HostKeyAlgorithms=ssh-ed25519"], False),
    ("H qua WS (herdgate-via), md", [], True),
]
if __name__ == "__main__":
    sel = set(sys.argv[1:])
    print("ms (median 8 lan):              banner kexinit newkeys   auth   exec  first-data")
    for name, extra, via in variants:
        if sel and name[0] not in sel:
            continue
        rows = [one(extra, via) for _ in range(8)]
        print("%-32s " % name + " ".join("%7.0f" % x for x in med(rows)))
