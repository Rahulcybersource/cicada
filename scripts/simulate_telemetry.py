"""
CICADA 2026 — Emergency Tier 1 Local Telemetry Simulator
Simulates realistic organizer telemetry streams for hackathon demonstration.

Submits telemetry events directly to the Tier 1 Local Collector HTTP ingestion endpoint:
    POST /local/ingest

Supports:
- All 7 required telemetry categories:
  1. CPU (cpu_pct)
  2. Memory (mem_pct)
  3. Disk (disk_pct)
  4. Bandwidth (bandwidth_mbps)
  5. Latency (latency_ms)
  6. Packet Loss (packet_loss_pct)
  7. Failed Logins (failed_login_count)
- Normal baseline generation + realistic anomaly drift (triggers AIOps Z-score incidents)
- Privacy verification scenario (embeds passwords, API keys, JWT tokens, internal IPs to prove live scrubbing)
- Dual-collector mode (Acme :8001 + Globex :8002) for multi-tenant 4-laptop presentation
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Generator


# ─── Terminal Colors ───

class Colors:
    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    MAGENTA = "\033[35m"
    BOLD = "\033[1m"
    RESET = "\033[0m"


def print_banner():
    banner = f"""
{Colors.CYAN}{Colors.BOLD}╔═════════════════════════════════════════════════════════════════════════╗
║                   CICADA 2026 — SMART OBSERVABILITY                     ║
║              Emergency Tier 1 Local Telemetry Simulator                 ║
╚═════════════════════════════════════════════════════════════════════════╝{Colors.RESET}
"""
    print(banner)


# ─── Telemetry Event Generators ───

def generate_normal_baseline(host_id: int = 1) -> dict[str, Any]:
    """Normal operations: healthy infrastructure, low latency, 0 failed logins."""
    cpu = round(random.uniform(25.0, 52.0), 1)
    mem = round(random.uniform(40.0, 62.0), 1)
    disk = round(random.uniform(35.0, 48.0), 1)
    bw = round(random.uniform(750.0, 950.0), 1)
    lat = round(random.uniform(12.0, 24.0), 1)
    loss = 0.0

    return {
        "payload": {
            "hostname": f"prod-app-srv-{host_id:02d}",
            "source_ip": f"10.0.{host_id}.15",
            "message": f"Service heartbeat ok. Process pool active on host {host_id:02d}.",
        },
        "event_category": "infrastructure",
        "severity": "info",
        "health_state": "Excellent",
        "metrics": {
            "cpu_pct": cpu,
            "mem_pct": mem,
            "disk_pct": disk,
            "bandwidth_mbps": bw,
            "latency_ms": lat,
            "packet_loss_pct": loss,
            "failed_login_count": 0,
            "service_up": True,
        },
        "alert_context": None,
        "security_summary": {
            "failed_login_count_60s": 0,
            "risk_indicator": "low",
        },
    }


def generate_cpu_drift_anomaly(host_id: int = 1) -> dict[str, Any]:
    """Infrastructure anomaly: sudden CPU and memory saturation (triggers Z-score breach & RCA)."""
    cpu = round(random.uniform(92.0, 99.5), 1)
    mem = round(random.uniform(88.0, 96.0), 1)
    disk = round(random.uniform(70.0, 82.0), 1)
    bw = round(random.uniform(250.0, 450.0), 1)
    lat = round(random.uniform(65.0, 110.0), 1)
    loss = round(random.uniform(0.1, 0.5), 2)

    return {
        "payload": {
            "hostname": f"prod-app-srv-{host_id:02d}",
            "source_ip": f"10.0.{host_id}.15",
            "message": f"Worker threads starvation detected in container pool worker-{host_id:02d}.",
        },
        "event_category": "infrastructure",
        "severity": "critical",
        "health_state": "Poor",
        "metrics": {
            "cpu_pct": cpu,
            "mem_pct": mem,
            "disk_pct": disk,
            "bandwidth_mbps": bw,
            "latency_ms": lat,
            "packet_loss_pct": loss,
            "failed_login_count": 0,
            "service_up": True,
        },
        "alert_context": f"CRITICAL: CPU utilization {cpu}% breached 90% SLA threshold on host {host_id:02d}.",
        "security_summary": None,
    }


def generate_network_spike_anomaly(host_id: int = 1) -> dict[str, Any]:
    """Network anomaly: packet loss and severe latency degradation."""
    cpu = round(random.uniform(40.0, 58.0), 1)
    mem = round(random.uniform(50.0, 65.0), 1)
    disk = round(random.uniform(40.0, 50.0), 1)
    bw = round(random.uniform(15.0, 60.0), 1)
    lat = round(random.uniform(320.0, 890.0), 1)
    loss = round(random.uniform(4.5, 14.8), 2)

    return {
        "payload": {
            "hostname": f"gateway-edge-{host_id:02d}",
            "source_ip": f"10.0.{host_id}.1",
            "message": f"BGP link flapping detected on upstream border interface eth{host_id}.",
        },
        "event_category": "network",
        "severity": "critical",
        "health_state": "Poor",
        "metrics": {
            "cpu_pct": cpu,
            "mem_pct": mem,
            "disk_pct": disk,
            "bandwidth_mbps": bw,
            "latency_ms": lat,
            "packet_loss_pct": loss,
            "failed_login_count": 0,
            "service_up": True,
        },
        "alert_context": f"Network SLA Breach: Latency {lat}ms (>300ms SLA), packet loss {loss}%.",
        "security_summary": None,
    }


def generate_brute_force_security(host_id: int = 1) -> dict[str, Any]:
    """Security anomaly: credential stuffing / SSH brute force attacks."""
    failed_logins = random.randint(18, 45)
    attacker_ip = f"198.51.100.{random.randint(10, 250)}"

    return {
        "payload": {
            "hostname": f"auth-bastion-{host_id:02d}",
            "source_ip": f"10.0.{host_id}.5",
            "attacker_ip": attacker_ip,
            "message": f"Failed password for invalid user root from {attacker_ip} port 44321 ssh2",
        },
        "event_category": "security",
        "severity": "critical",
        "health_state": "Poor",
        "metrics": {
            "cpu_pct": round(random.uniform(35.0, 55.0), 1),
            "mem_pct": round(random.uniform(45.0, 60.0), 1),
            "disk_pct": round(random.uniform(30.0, 40.0), 1),
            "bandwidth_mbps": round(random.uniform(500.0, 700.0), 1),
            "latency_ms": round(random.uniform(15.0, 30.0), 1),
            "packet_loss_pct": 0.0,
            "failed_login_count": failed_logins,
            "service_up": True,
        },
        "alert_context": f"Security Alert: {failed_logins} failed authentication attempts in last 60s from {attacker_ip}.",
        "security_summary": {
            "failed_login_count_60s": failed_logins,
            "risk_indicator": "high",
            "flagged_user": "root",
        },
    }


def generate_secret_leak_privacy_proof(host_id: int = 1) -> dict[str, Any]:
    """
    Privacy demonstration: raw payload deliberately injects real-looking secrets:
    - Passwords, API keys, Bearer tokens, private IPv4s
    Proves that Tier 1 scrubs them immediately into [REDACTED_*] before outbox & SaaS forwarding!
    """
    fake_password = f"SecretPasswd!_{random.randint(1000, 9999)}"
    fake_api_key = f"sk_live_collector_token_{random.randint(100000, 999999)}"
    fake_jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFsaWNlIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    internal_ip = f"192.168.1.{random.randint(10, 200)}"

    return {
        "payload": {
            "hostname": f"billing-app-{host_id:02d}",
            "source_ip": internal_ip,
            "message": f"Payment API auth attempt with password={fake_password} api_key={fake_api_key} token={fake_jwt} on {internal_ip}",
            "secret_note": "This raw note will be stored encrypted locally in SQLite, but excluded from egress!",
        },
        "event_category": "security",
        "severity": "warning",
        "health_state": "Fair",
        "metrics": {
            "cpu_pct": 52.0,
            "mem_pct": 64.0,
            "disk_pct": 45.0,
            "bandwidth_mbps": 820.0,
            "latency_ms": 22.0,
            "packet_loss_pct": 0.0,
            "failed_login_count": 1,
            "service_up": True,
        },
        "alert_context": f"Auth check failed for internal operator password={fake_password} token={fake_jwt}",
        "security_summary": {
            "failed_login_count_60s": 1,
            "risk_indicator": "medium",
            "flagged_credential": f"token={fake_jwt}",
        },
    }


# ─── HTTP Sender ───

def post_telemetry(endpoint_url: str, telemetry_event: dict[str, Any], timeout: float = 5.0) -> tuple[int, dict[str, Any], float]:
    """
    Sends telemetry to Tier 1 collector: POST /local/ingest
    Returns (status_code, response_dict, latency_ms).
    """
    url = endpoint_url.rstrip("/")
    if not url.endswith("/local/ingest"):
        url = f"{url}/local/ingest"

    # Add ISO timestamp if missing
    if "event_timestamp_utc" not in telemetry_event or not telemetry_event["event_timestamp_utc"]:
        telemetry_event["event_timestamp_utc"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    data = json.dumps(telemetry_event).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "Cicada-Simulator/1.0"},
        method="POST",
    )

    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            latency_ms = (time.time() - start) * 1000.0
            resp_bytes = response.read().decode("utf-8")
            return response.status, json.loads(resp_bytes), latency_ms
    except urllib.error.HTTPError as e:
        latency_ms = (time.time() - start) * 1000.0
        err_msg = e.read().decode("utf-8")
        try:
            return e.code, json.loads(err_msg), latency_ms
        except Exception:
            return e.code, {"error": err_msg}, latency_ms
    except Exception as e:
        latency_ms = (time.time() - start) * 1000.0
        return 0, {"error": str(e)}, latency_ms


# ─── Event Scenario Streamer ───

def event_stream(scenario: str) -> Generator[tuple[str, dict[str, Any]], None, None]:
    """Generates continuous or configured telemetry events."""
    seq = 0
    while True:
        seq += 1
        host_id = (seq % 4) + 1

        if scenario == "baseline":
            yield "Baseline Normal", generate_normal_baseline(host_id)
        elif scenario == "cpu_drift":
            yield "CPU/Mem Drift Anomaly", generate_cpu_drift_anomaly(host_id)
        elif scenario == "network_spike":
            yield "Network Latency/Loss Spike", generate_network_spike_anomaly(host_id)
        elif scenario == "brute_force":
            yield "Brute Force Security Event", generate_brute_force_security(host_id)
        elif scenario == "secret_leak":
            yield "Privacy Proof Secret Injection", generate_secret_leak_privacy_proof(host_id)
        else:
            # Mixed demo sequence:
            # 6 baseline pulses -> 1 secret leak -> 2 CPU drifts -> 1 network spike -> 1 brute force
            cycle = seq % 11
            if cycle in (1, 2, 3, 4, 5, 6):
                yield "Baseline Normal", generate_normal_baseline(host_id)
            elif cycle == 7:
                yield "Privacy Proof Secret Injection", generate_secret_leak_privacy_proof(host_id)
            elif cycle in (8, 9):
                yield "CPU/Mem Drift Anomaly", generate_cpu_drift_anomaly(host_id)
            elif cycle == 10:
                yield "Network Latency/Loss Spike", generate_network_spike_anomaly(host_id)
            else:
                yield "Brute Force Security Event", generate_brute_force_security(host_id)


# ─── Main Execution Loop ───

def run_simulator(
    target_urls: list[str],
    interval: float,
    scenario: str,
    max_count: int,
    warmup: bool,
    verbose: bool,
) -> None:
    print_banner()
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Configuration:")
    print(f"  • Target Collector(s): {', '.join(target_urls)}")
    print(f"  • Ingestion Endpoint:  /local/ingest")
    print(f"  • Telemetry Scenario:  {scenario.upper()}")
    print(f"  • Interval:            {interval}s")
    print(f"  • Event Count Limit:   {'Infinite (Press Ctrl+C to stop)' if max_count == 0 else max_count}")
    print(f"  • Z-Score Warmup:      {'ENABLED (12 baseline pulses)' if warmup else 'Disabled'}")
    print("─" * 75)

    # Warmup phase
    if warmup:
        print(f"\n{Colors.YELLOW}[Warmup] Seeding 12 baseline pulses to establish rolling Z-score baselines...{Colors.RESET}")
        for w in range(1, 13):
            for t_url in target_urls:
                base_event = generate_normal_baseline(host_id=(w % 3) + 1)
                code, resp, lat = post_telemetry(t_url, base_event)
                if code == 200:
                    sys.stdout.write(f"{Colors.GREEN}.{Colors.RESET}")
                else:
                    sys.stdout.write(f"{Colors.RED}x{Colors.RESET}")
                sys.stdout.flush()
                time.sleep(0.1)
        print(f"\n{Colors.GREEN}[Warmup Complete] Rolling baselines primed. Starting scenario stream...{Colors.RESET}\n")

    sent_count = 0
    success_count = 0
    fail_count = 0
    total_redactions = 0
    start_time = time.time()

    generator = event_stream(scenario)

    try:
        while True:
            if max_count > 0 and sent_count >= max_count:
                break

            label, event = next(generator)
            sent_count += 1

            # Alternate between targets if multiple are given
            target_idx = (sent_count - 1) % len(target_urls)
            target = target_urls[target_idx]

            status_code, response, latency_ms = post_telemetry(target, event)

            ts = datetime.now().strftime("%H:%M:%S")
            metrics = event["metrics"]
            metric_str = (
                f"CPU:{metrics.get('cpu_pct', 0.0):4.1f}% | "
                f"Mem:{metrics.get('mem_pct', 0.0):4.1f}% | "
                f"Lat:{metrics.get('latency_ms', 0.0):5.1f}ms | "
                f"Loss:{metrics.get('packet_loss_pct', 0.0):4.1f}% | "
                f"FailedLogins:{metrics.get('failed_login_count', 0)}"
            )

            if status_code == 200:
                success_count += 1
                payload_id = response.get("payload_id", "unknown")
                source_id = response.get("source_id", "unknown")
                redactions = response.get("redacted_fields_count", 0)
                redaction_types = response.get("redaction_types", [])
                total_redactions += redactions

                redaction_tag = ""
                if redactions > 0:
                    redaction_tag = f" {Colors.MAGENTA}[SCRUBBED: {redactions} secrets ({','.join(redaction_types)})]{Colors.RESET}"

                color = Colors.GREEN if event["severity"] == "info" else (Colors.YELLOW if event["severity"] == "warning" else Colors.RED)

                print(
                    f"[{ts}] #{sent_count:03d} {color}[{event['severity'].upper():8s}]{Colors.RESET} "
                    f"{label:30s} -> {target} "
                    f"({latency_ms:4.1f}ms) "
                    f"id={payload_id} src={source_id}"
                    f"{redaction_tag}"
                )
                print(f"      Metrics: {metric_str}")

                if verbose:
                    print(f"      Raw Payload: {json.dumps(event['payload'])}")
                    if event.get("alert_context"):
                        print(f"      Alert Context: {event['alert_context']}")
            else:
                fail_count += 1
                err = response.get("error") or response.get("detail") or "Unknown error"
                print(
                    f"[{ts}] #{sent_count:03d} {Colors.RED}[FAILED HTTP {status_code}]{Colors.RESET} "
                    f"{label} -> {target}: {err}"
                )

            time.sleep(interval)

    except KeyboardInterrupt:
        print(f"\n{Colors.YELLOW}[Interrupted by user]{Colors.RESET}")

    duration = time.time() - start_time
    print("\n" + "═" * 75)
    print(f"{Colors.BOLD}CICADA Simulator Session Summary:{Colors.RESET}")
    print(f"  • Total Events Generated:  {sent_count}")
    print(f"  • Successfully Ingested:   {Colors.GREEN}{success_count}{Colors.RESET}")
    print(f"  • Ingestion Errors:        {Colors.RED if fail_count > 0 else Colors.GREEN}{fail_count}{Colors.RESET}")
    print(f"  • Secrets Scrubbed at Edge:{Colors.MAGENTA}{total_redactions}{Colors.RESET}")
    print(f"  • Running Duration:        {duration:.1f}s")
    print(f"  • Ingestion Proof View:    http://localhost:8001/local/egress-proof")
    print(f"  • Next.js Control Plane:   http://localhost:3000")
    print("═" * 75)


# ─── Command Line Interface ───

def main():
    parser = argparse.ArgumentParser(
        description="CICADA 2026 — Emergency Tier 1 Local Telemetry Simulator",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--target", "-t",
        default="http://localhost:8001",
        help="Primary Tier 1 Collector URL",
    )
    parser.add_argument(
        "--collector2", "-c2",
        default=None,
        help="Optional secondary Tier 1 Collector URL (e.g. http://localhost:8002 for Globex)",
    )
    parser.add_argument(
        "--dual-tenant",
        action="store_true",
        help="Send interleaved telemetry to both Acme (:8001) and Globex (:8002)",
    )
    parser.add_argument(
        "--interval", "-i",
        type=float,
        default=2.0,
        help="Interval between telemetry submissions (seconds)",
    )
    parser.add_argument(
        "--count", "-n",
        type=int,
        default=0,
        help="Total number of events to send (0 = infinite loop)",
    )
    parser.add_argument(
        "--scenario", "-s",
        choices=["mixed", "baseline", "cpu_drift", "network_spike", "brute_force", "secret_leak"],
        default="mixed",
        help="Telemetry scenario pattern to generate",
    )
    parser.add_argument(
        "--warmup", "-w",
        action="store_true",
        help="Send 12 fast baseline pulses on start to prime Tier 2 Z-score baseline",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print verbose payload and alert context details",
    )

    args = parser.parse_args()

    target_urls = [args.target]
    if args.dual_tenant:
        target_urls = ["http://localhost:8001", "http://localhost:8002"]
    elif args.collector2:
        target_urls.append(args.collector2)

    run_simulator(
        target_urls=target_urls,
        interval=args.interval,
        scenario=args.scenario,
        max_count=args.count,
        warmup=args.warmup,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    main()
