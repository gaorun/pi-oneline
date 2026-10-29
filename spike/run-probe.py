#!/usr/bin/env python3
"""在真实 PTY 里跑一次 pi 会话，断言折叠行为。

用法：
  python3 spike/run-probe.py                          # group 模式，跑 extensions/oneline
  python3 spike/run-probe.py --expand                 # 回合结束后再按一次 ctrl+o 验证展开
  python3 spike/run-probe.py --mode row --max-visible 4
  python3 spike/run-probe.py --ext path/to/other-extension.ts
  python3 spike/run-probe.py --replay                 # 只分析上一次的日志

产物：/tmp/pi-oneline-probe.{jsonl,tui.log,raw}
"""
import codecs
import fcntl
import json
import os
import re
import select
import struct
import subprocess
import sys
import termios
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEBUG = "/tmp/pi-oneline-probe.jsonl"
TUI_LOG = "/tmp/pi-oneline-probe.tui.log"
RAW = "/tmp/pi-oneline-probe.raw"

DEFAULT_PROMPT = (
    "用三个独立的工具调用完成：1) ls 当前目录 2) 读 docs/DESIGN.md 3) grep 在 docs/DESIGN.md 里搜索 '汇总行'。"
    "每件事一个工具调用。"
)
COLS, ROWS = 120, 45
CTRL_O = b"\x0f"


def argval(flag, default):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def flag(name):
    return name in sys.argv


def cleanup():
    for p in (DEBUG, TUI_LOG, RAW):
        if os.path.exists(p):
            os.remove(p)


def spawn(ext, tui_mode):
    env = dict(os.environ)
    env.update(
        PI_ONELINE_DEBUG=DEBUG,
        PI_TUI_WRITE_LOG=TUI_LOG,
        TERM="xterm-256color",
        COLUMNS=str(COLS),
        LINES=str(ROWS),
    )
    mode_env = argval("--mode", "")
    if mode_env:
        env["PI_ONELINE_MODE"] = mode_env
    cmd = ["pi", "-e", ext if os.path.isabs(ext) else os.path.join(ROOT, ext)]
    if tui_mode:
        cmd += ["--tui-mode", tui_mode]
    master, slave = pty_open()
    proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, cwd=ROOT, env=env, preexec_fn=os.setsid)
    os.close(slave)
    return proc, master


def pty_open():
    mo, sl = __import__("pty").openpty()
    fcntl.ioctl(sl, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    return mo, sl


def pump(master, buf, until_idle):
    last = time.time()
    while time.time() - last <= until_idle:
        r, _, _ = select.select([master], [], [], 0.2)
        if not r:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return
        if not chunk:
            return
        buf.extend(chunk)
        last = time.time()


def analyze():
    if not os.path.exists(DEBUG):
        print("!! 没有产生追踪日志；pi 可能没跑起来，看 " + RAW)
        return 1
    events = [json.loads(l) for l in open(DEBUG) if l.strip()]
    max_visible = int(argval("--max-visible", "1"))

    order = []                      # 首次出现顺序
    batch_of = {}                   # id -> 批次号
    state = {}                      # id -> {"call": n, "result": n}
    demoted = set()
    violations, regressions = [], []

    for e in events:
        if e["ev"] not in ("render-call", "render-result"):
            continue
        tid = e["id"]
        if tid not in order:
            order.append(tid)
        if e.get("batch") is not None:
            batch_of[tid] = e["batch"]
        slot = "call" if e["ev"] == "render-call" else "result"
        st = state.setdefault(tid, {"call": 0, "result": 0})
        st[slot] = e["lines"]
        # group 模式才要求"非末行必须为空"；row 模式每行本来就各占一行
        if e.get("mode") == "group" and e.get("isLast") is False:
            demoted.add(tid)
        total = st["call"] + st["result"]
        if tid in demoted and total > 0:
            regressions.append((e["ev"], tid, total))
        live = [k for k, v in state.items() if v["call"] + v["result"] > 0]
        # 每轮各自最多 max_visible 行；不同轮次各有一条汇总是预期行为
        by_batch = {}
        for k in live:
            by_batch.setdefault(batch_of.get(k), []).append(k)
        for b, members in by_batch.items():
            if len(members) > max_visible:
                violations.append((e["ev"], tid, b, members.copy()))

    mode = argval("--mode", "group")
    final = [k for k, v in state.items() if v["call"] + v["result"] > 0]
    # 末态：每轮各留一条汇总是预期；这里统计"每批次的可见行数上限"
    final_by_batch = {}
    for k in final:
        final_by_batch.setdefault(batch_of.get(k), []).append(k)
    summary = ""
    for e in events:
        if e["ev"] == "render-call" and e.get("text"):
            summary = e["text"]
    ends = [e for e in events if e["ev"] == "agent_end"]
    starts = [e for e in events if e["ev"] == "start"]
    detail_lines = max((v["result"] for v in state.values()), default=0)

    print(f"事件数: {len(events)}")
    print(f"顶层调用: {len(starts)} → {[s['name'] for s in starts]}")
    print(f"末态可见行: {len(final)}（允许上限 {max_visible}）")
    print(f"汇总行文本: {summary or '(空)'}")
    print(f"明细行数: {detail_lines}")
    print(f"同时可见超限: {len(violations)} 次")
    for v in violations[:3]:
        print(f"   {v}")
    print(f"降级后回弹: {len(regressions)} 次（应为 0）")

    ansi = open(TUI_LOG, "rb").read().decode("utf-8", "replace") if os.path.exists(TUI_LOG) else ""
    plain = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07", "", ansi)
    expect = argval("--expect", "")
    if expect:
        hit = plain.count(expect)
        print(f"预期文本 `{expect}` 出现: {hit} 次")
        if hit == 0:
            print("FAIL")
            return 1
    print(f"屏幕流里汇总行出现: {plain.count('call')} 次 · 独立工具行: {len(re.findall(r'(?m)^\s*(read|bash|grep|ls)\s+\S', plain))}")

    # 多轮隔离：每个批次渲染出的 calls 数，不得越过该批次自己的调用数
    per_batch_end = {}
    for e in events:
        if e["ev"] == "agent_end" and e.get("batch") is not None:
            per_batch_end[e["batch"]] = e["calls"]
    per_batch_seen = {}
    first_seen = {}
    leakage = []
    for e in events:
        if e["ev"] != "render-call" or e.get("batch") is None:
            continue
        b = e["batch"]
        first_seen.setdefault(b, len(first_seen))
        if "calls" in e:
            per_batch_seen.setdefault(b, set()).add(e["calls"])
            if b in per_batch_end and e["calls"] > per_batch_end[b]:
                leakage.append((b, e["calls"], per_batch_end[b]))

    def final_text(batch):
        out = ""
        for e in events:
            if e["ev"] == "render-call" and e.get("batch") == batch and e.get("text"):
                out = e["text"]
        return out

    if per_batch_end:
        print(f"批次数: {len(per_batch_end)}")
        for b in sorted(per_batch_end):
            print(f"  批次 {b}: 调用 {per_batch_end[b]} · 汇总 {final_text(b) or '(空)'}")
        print(f"跨批次污染（某轮汇总显示了别的轮调用数）: {len(leakage)} 次（应为 0）")
        if leakage:
            for l in leakage[:3]:
                print("   ", l)

    renders = [e for e in events if e["ev"].startswith("render")]
    if mode == "off":
        # off 模式：完全交给 pi 原生渲染，本扩展不应该画任何东西
        ok = len(renders) == 0
        print(f"渲染事件: {len(renders)}（应为 0）")
    else:
        per_batch_ok = all(len(v) <= max_visible for v in final_by_batch.values()) and len(final_by_batch) >= 1
        ok = not violations and not regressions and not leakage and per_batch_ok
    print("\n" + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main():
    if flag("--replay"):
        return analyze()
    cleanup()
    ext = argval("--ext", "extensions/oneline/index.ts")
    proc, master = spawn(ext, argval("--tui", "regular"))
    raw = bytearray()
    try:
        pump(master, raw, 12.0)
        os.write(master, argval("--prompt", DEFAULT_PROMPT).encode() + b"\r")
        pump(master, raw, 15.0)
        prompt2 = argval("--prompt2", "")
        if prompt2:
            os.write(master, prompt2.encode() + b"\r")
            pump(master, raw, 15.0)
        if flag("--expand"):
            os.write(master, CTRL_O)
            pump(master, raw, 4.0)
        cmd = argval("--cmd", "")
        if cmd:
            os.write(master, cmd.encode() + b"\r")
            pump(master, raw, 8.0)
        keys = argval("--keys", "")
        if keys:
            os.write(master, codecs.decode(keys, "unicode_escape").encode())
            pump(master, raw, 4.0)
        os.write(master, b"/quit\r")
        pump(master, raw, 5.0)
    finally:
        open(RAW, "wb").write(bytes(raw))
        for stop in (proc.terminate, proc.kill):
            try:
                stop()
                proc.wait(timeout=5)
                break
            except Exception:
                continue
    return analyze()


if __name__ == "__main__":
    sys.exit(main())
