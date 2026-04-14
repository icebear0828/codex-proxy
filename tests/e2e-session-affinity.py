#!/usr/bin/env python3
"""
E2E test: Session Affinity + Prompt Cache

Usage:
  python3 tests/e2e-session-affinity.py [base_url] [api_key]

Defaults: http://localhost:8080  pwd
"""

import json, subprocess, sys, time

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
KEY = sys.argv[2] if len(sys.argv) > 2 else "pwd"
MAX_RETRIES = 5

def req(body: dict, attempt: int = 1) -> dict:
    r = subprocess.run(
        ["curl", "-s", f"{BASE}/v1/responses",
         "-H", "Content-Type: application/json",
         "-H", f"Authorization: Bearer {KEY}",
         "-d", json.dumps(body)],
        capture_output=True, text=True, timeout=180,
    )
    data = json.loads(r.stdout, strict=False)
    # Retry on transient errors (deactivated account, 429, etc.)
    err = data.get("error")
    if err and attempt < MAX_RETRIES:
        msg = err.get("message", str(err))[:80] if isinstance(err, dict) else str(err)[:80]
        print(f"    ⚠ Retry {attempt}/{MAX_RETRIES}: {msg}")
        time.sleep(3)
        return req(body, attempt + 1)
    return data

def extract(resp: dict) -> dict:
    err = resp.get("error")
    if err:
        msg = err.get("message", str(err))[:120] if isinstance(err, dict) else str(err)[:120]
        print(f"  ✗ {msg}")
        sys.exit(1)
    u = resp["usage"]
    return {
        "id": resp["id"],
        "input": u["input_tokens"],
        "output": u["output_tokens"],
        "cached": u["input_tokens_details"]["cached_tokens"],
    }

# ── Config ──
INSTR = "You are a senior software architect. Give detailed answers with code."
TURNS = [
    "Design an event-driven microservices architecture for a trading platform. "
    "Cover order management, matching engine, risk management, market data, settlement. "
    "Include TypeScript interfaces, Kafka topics, CQRS and Saga patterns with code.",

    "Add WebSocket real-time price streaming. Show full implementation.",

    "Add circuit breaker and retry with exponential backoff for the order service.",

    "Summarize the complete architecture: all services, responsibilities, key patterns.",

    "Recommend a monitoring stack: Prometheus metrics, Grafana dashboards, distributed tracing.",
]

# ── Run ──
print("=" * 62)
print("  E2E: Session Affinity + Prompt Cache")
print("=" * 62)

results = []
prev_id = None

for i, content in enumerate(TURNS, 1):
    print(f"\n[Turn {i}] {content[:60]}...")
    body: dict = {
        "model": "codex",
        "input": [{"role": "user", "content": content}],
        "stream": False,
        "instructions": INSTR,
    }
    if prev_id:
        body["previous_response_id"] = prev_id

    r = req(body)
    info = extract(r)
    prev_id = info["id"]
    pct = info["cached"] / info["input"] * 100 if info["input"] else 0
    print(f"  in={info['input']}  out={info['output']}  cached={info['cached']} ({pct:.0f}%)")
    results.append(info)
    if i < len(TURNS):
        time.sleep(5)

# ── Summary ──
print("\n" + "=" * 62)
print(f"{'Turn':<8} {'in':>7} {'out':>7} {'cached':>8} {'cache%':>8}")
print("-" * 62)
total_in = total_out = total_cached = 0
for i, r in enumerate(results, 1):
    pct = r["cached"] / r["input"] * 100 if r["input"] else 0
    total_in += r["input"]; total_out += r["output"]; total_cached += r["cached"]
    marker = " ✓" if r["cached"] > 0 else ""
    print(f"Turn {i:<4} {r['input']:>7} {r['output']:>7} {r['cached']:>8} {pct:>7.1f}%{marker}")
print("-" * 62)
pct = total_cached / total_in * 100 if total_in else 0
print(f"{'Total':<8} {total_in:>7} {total_out:>7} {total_cached:>8} {pct:>7.1f}%")

effective = total_in - total_cached * 0.5
savings = total_cached * 0.5 / total_in * 100 if total_in else 0
print(f"\nEffective input: {effective:.0f} tokens (saved {savings:.1f}%)")

# ── Assertions ──
errors = []
if len(results) < 5:
    errors.append("Not all 5 turns completed")
if results[-1]["cached"] == 0:
    errors.append("Last turn has no cached tokens — prompt cache not working")
if total_cached == 0:
    errors.append("No cached tokens across entire conversation")

# Check affinity: input should grow (backend accumulates history)
for i in range(1, len(results)):
    if results[i]["input"] <= results[i - 1]["input"]:
        errors.append(f"Turn {i+1} input ({results[i]['input']}) <= Turn {i} ({results[i-1]['input']}) — previous_response_id may be broken")

if errors:
    print(f"\n✗ FAILED:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
else:
    print(f"\n✓ PASSED: affinity working, prompt cache active")
print("=" * 62)
