"""
Tier 1 Local Collector — SQLite WAL Storage
Two tables: local_raw_logs (encrypted) + outbox_queue (allow-listed payloads only).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generator, Optional

from cryptography.fernet import Fernet

from .scrubber import (
    process_raw_telemetry,
    scrub_secrets,
    scrub_dict,
    enforce_allow_list,
    validate_and_sanitize_metrics,
    validate_and_sanitize_collector_meta,
    validate_and_sanitize_security_summary,
    ScrubResult,
)


# ─── Encryption ───

def get_encryption_key() -> bytes:
    """Get or generate Fernet encryption key for local raw log encryption."""
    key_env = os.getenv("LOCAL_ENCRYPTION_KEY") or os.getenv("TIER1_ENCRYPTION_KEY")
    if key_env:
        return key_env.encode() if len(key_env) == 44 else Fernet.generate_key()

    # For local dev, use a file-based key
    key_file = Path(".tier1_encryption_key")
    if key_file.exists():
        return key_file.read_bytes()

    key = Fernet.generate_key()
    key_file.write_bytes(key)
    return key


ENCRYPTION_KEY = get_encryption_key()
FERNET = Fernet(ENCRYPTION_KEY)


def encrypt_data(data: str) -> str:
    """Encrypt string data for local storage."""
    return FERNET.encrypt(data.encode()).decode()


def decrypt_data(encrypted: str) -> str:
    """Decrypt string data from local storage."""
    return FERNET.decrypt(encrypted.encode()).decode()


# ─── Database Setup ───

def get_db_path() -> Path:
    """Get SQLite DB path dynamically from environment."""
    return Path(os.getenv("TIER1_DB_PATH", "./tier1_collector.db"))


DB_PATH = get_db_path()

_lock = threading.RLock()


def get_connection() -> sqlite3.Connection:
    """Get SQLite connection with WAL mode enabled."""
    db_path = get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.row_factory = sqlite3.Row
    return conn


def ensure_db_initialized() -> None:
    """Ensure database tables exist lazily without import side-effects."""
    conn = get_connection()
    try:
        cur = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox_queue'")
        has_table = cur.fetchone() is not None
    finally:
        conn.close()

    if not has_table:
        init_db()


def init_db() -> None:
    """Initialize database tables."""
    with _lock:
        conn = get_connection()
        try:
            # Local raw logs table (encrypted at rest)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS local_raw_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tenant_id TEXT NOT NULL,
                    collector_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    raw_payload TEXT NOT NULL,  -- Encrypted JSON
                    event_timestamp_utc TEXT NOT NULL,
                    received_at_utc TEXT NOT NULL DEFAULT (datetime('now')),
                    redacted_fields_count INTEGER DEFAULT 0,
                    redaction_types TEXT DEFAULT '[]'
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_raw_tenant_time ON local_raw_logs(tenant_id, event_timestamp_utc)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_raw_collector ON local_raw_logs(collector_id)")

            # Outbox queue for egress payloads
            conn.execute("""
                CREATE TABLE IF NOT EXISTS outbox_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    payload_id TEXT NOT NULL UNIQUE,
                    tenant_id TEXT NOT NULL,
                    collector_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    region_id TEXT NOT NULL,
                    egress_payload TEXT NOT NULL,  -- JSON (allow-listed only)
                    status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING, SENT, FAILED
                    redacted_fields_count INTEGER DEFAULT 0,
                    redaction_types TEXT DEFAULT '[]',
                    created_at_utc TEXT NOT NULL DEFAULT (datetime('now')),
                    sent_at_utc TEXT,
                    retry_count INTEGER DEFAULT 0,
                    last_error TEXT
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_outbox_tenant_status ON outbox_queue(tenant_id, status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_outbox_payload_id ON outbox_queue(payload_id)")

            # Egress proof panel log (immutable audit trail)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS egress_proof_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    payload_id TEXT NOT NULL,
                    tenant_id TEXT NOT NULL,
                    egress_payload TEXT NOT NULL,
                    scrub_result TEXT NOT NULL,
                    logged_at_utc TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_proof_tenant_time ON egress_proof_log(tenant_id, logged_at_utc)")

            conn.commit()
        finally:
            conn.close()


def drop_db() -> None:
    """Drop all tables (for testing)."""
    with _lock:
        conn = get_connection()
        try:
            conn.execute("DROP TABLE IF EXISTS local_raw_logs")
            conn.execute("DROP TABLE IF EXISTS outbox_queue")
            conn.execute("DROP TABLE IF EXISTS egress_proof_log")
            conn.commit()
        finally:
            conn.close()


# ─── Repository Functions ───

@contextmanager
def db_transaction() -> Generator[sqlite3.Connection, None, None]:
    """Context manager for database transactions with locking."""
    with _lock:
        ensure_db_initialized()
        conn = get_connection()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def store_raw_log(
    tenant_id: str,
    collector_id: str,
    source_id: str,
    raw_payload: dict,
    event_timestamp_utc: str,
    scrub_result: ScrubResult,
) -> int:
    """Store encrypted raw log locally."""
    encrypted = encrypt_data(json.dumps(raw_payload))
    with db_transaction() as conn:
        cursor = conn.execute(
            """INSERT INTO local_raw_logs
               (tenant_id, collector_id, source_id, raw_payload, event_timestamp_utc, redacted_fields_count, redaction_types)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (tenant_id, collector_id, source_id, encrypted, event_timestamp_utc,
             scrub_result.redactions_count, json.dumps(scrub_result.redaction_types)),
        )
        return cursor.lastrowid


def enqueue_egress_payload(
    payload_id: str,
    tenant_id: str,
    collector_id: str,
    source_id: str,
    region_id: str,
    egress_payload: dict,
    scrub_result: ScrubResult,
) -> None:
    """Add allow-listed payload to outbox queue."""
    with db_transaction() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO outbox_queue
               (payload_id, tenant_id, collector_id, source_id, region_id, egress_payload, redacted_fields_count, redaction_types)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (payload_id, tenant_id, collector_id, source_id, region_id,
             json.dumps(egress_payload), scrub_result.redactions_count, json.dumps(scrub_result.redaction_types)),
        )


def log_egress_proof(
    payload_id: str,
    tenant_id: str,
    egress_payload: dict,
    scrub_result: ScrubResult,
) -> None:
    """Log to immutable egress proof panel."""
    with db_transaction() as conn:
        conn.execute(
            """INSERT INTO egress_proof_log (payload_id, tenant_id, egress_payload, scrub_result)
               VALUES (?, ?, ?, ?)""",
            (payload_id, tenant_id, json.dumps(egress_payload), json.dumps({
                "redactions_count": scrub_result.redactions_count,
                "redaction_types": scrub_result.redaction_types,
            })),
        )


def get_pending_outbox(tenant_id: str, limit: int = 100, include_failed_retries: bool = True, max_retries: int = 10) -> list[dict]:
    """Get pending payloads for forwarding (including eligible failed retries)."""
    with db_transaction() as conn:
        if include_failed_retries:
            rows = conn.execute(
                """SELECT * FROM outbox_queue
                   WHERE tenant_id = ? AND (status = 'PENDING' OR (status = 'FAILED' AND retry_count < ?))
                   ORDER BY created_at_utc ASC LIMIT ?""",
                (tenant_id, max_retries, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT * FROM outbox_queue
                   WHERE tenant_id = ? AND status = 'PENDING'
                   ORDER BY created_at_utc ASC LIMIT ?""",
                (tenant_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]


def retry_failed_outbox(tenant_id: str, max_retries: int = 10) -> int:
    """Reset failed payloads back to PENDING for retry if below max retries."""
    with db_transaction() as conn:
        cursor = conn.execute(
            """UPDATE outbox_queue SET status = 'PENDING'
               WHERE tenant_id = ? AND status = 'FAILED' AND retry_count < ?""",
            (tenant_id, max_retries),
        )
        return cursor.rowcount


def mark_outbox_sent(payload_id: str) -> None:
    """Mark payload as successfully sent."""
    with db_transaction() as conn:
        conn.execute(
            """UPDATE outbox_queue SET status = 'SENT', sent_at_utc = datetime('now')
               WHERE payload_id = ?""",
            (payload_id,),
        )


def mark_outbox_failed(payload_id: str, error: str) -> None:
    """Mark payload as failed, increment retry count."""
    with db_transaction() as conn:
        conn.execute(
            """UPDATE outbox_queue SET status = 'FAILED', retry_count = retry_count + 1, last_error = ?
               WHERE payload_id = ?""",
            (error, payload_id),
        )


def get_outbox_stats(tenant_id: str) -> dict:
    """Get outbox statistics for dashboard."""
    with db_transaction() as conn:
        stats = conn.execute(
            """SELECT
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0) as pending,
                COALESCE(SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END), 0) as sent,
                COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) as failed
               FROM outbox_queue WHERE tenant_id = ?""",
            (tenant_id,),
        ).fetchone()
        return dict(stats) if stats else {"total": 0, "pending": 0, "sent": 0, "failed": 0}


def get_recent_raw_logs(tenant_id: str, limit: int = 50) -> list[dict]:
    """Get recent raw logs for side-by-side proof view (decrypted)."""
    with db_transaction() as conn:
        rows = conn.execute(
            """SELECT * FROM local_raw_logs
               WHERE tenant_id = ?
               ORDER BY event_timestamp_utc DESC LIMIT ?""",
            (tenant_id, limit),
        ).fetchall()

        logs = []
        for row in rows:
            log = dict(row)
            log["raw_payload"] = json.loads(decrypt_data(log["raw_payload"]))
            log["redaction_types"] = json.loads(log["redaction_types"])
            logs.append(log)
        return logs


def get_egress_proof_logs(tenant_id: str, limit: int = 50) -> list[dict]:
    """Get egress proof panel logs."""
    with db_transaction() as conn:
        rows = conn.execute(
            """SELECT * FROM egress_proof_log
               WHERE tenant_id = ?
               ORDER BY logged_at_utc DESC LIMIT ?""",
            (tenant_id, limit),
        ).fetchall()

        logs = []
        for row in rows:
            log = dict(row)
            log["egress_payload"] = json.loads(log["egress_payload"])
            log["scrub_result"] = json.loads(log["scrub_result"])
            logs.append(log)
        return logs


def cleanup_old_logs(tenant_id: str, retention_hours: int = 24) -> int:
    """Clean up old raw logs beyond retention period (for demo)."""
    with db_transaction() as conn:
        cursor = conn.execute(
            """DELETE FROM local_raw_logs
               WHERE tenant_id = ? AND received_at_utc < datetime('now', ?)""",
            (tenant_id, f"-{retention_hours} hours"),
        )
        return cursor.rowcount


# ─── Full Pipeline Function ───

def process_and_store_telemetry(
    raw_data: dict,
    tenant_id: str,
    collector_id: str,
    region_id: str,
    tenant_salt: str,
    payload_id: str,
    event_timestamp_utc: str,
    source_timezone: str,
    event_category: str,
    severity: str,
    health_state: str,
    metrics: dict,
    security_summary: dict | None,
    alert_context: str | None,
    collector_meta: dict,
) -> tuple[dict, ScrubResult]:
    """
    Complete pipeline: process raw telemetry -> store raw locally -> enqueue egress -> log proof.
    Returns (egress_payload, scrub_result).
    """
    # Prepare raw payload for local storage (includes raw telemetry as received)
    raw_payload = {
        **raw_data,
        "payload_id": payload_id,
        "tenant_id": tenant_id,
        "collector_id": collector_id,
        "event_timestamp_utc": event_timestamp_utc,
        "source_timezone": source_timezone,
        "event_category": event_category,
        "severity": severity,
        "health_state": health_state,
        "metrics": metrics,
        "security_summary": security_summary,
        "alert_context": alert_context,
        "collector_meta": collector_meta,
    }

    # Process raw data through scrubber + pseudonymizer
    egress_payload, scrub_result = process_raw_telemetry(
        raw_data, tenant_id, collector_id, region_id, tenant_salt
    )
    source_id = egress_payload.get("source_id", "src_unknown")

    extra_redactions_count = 0
    extra_redaction_types: list[str] = []

    # 1. Scrub alert_context
    clean_alert_context: str | None = None
    if alert_context is not None:
        alert_str = str(alert_context) if not isinstance(alert_context, str) else alert_context
        alert_res = scrub_secrets(alert_str)
        clean_alert_context = alert_res.scrubbed_text
        extra_redactions_count += alert_res.redactions_count
        extra_redaction_types.extend(alert_res.redaction_types)

    # 2. Validate and sanitize metrics against explicit allow-list
    clean_metrics = validate_and_sanitize_metrics(metrics)

    # 3. Scrub and validate security_summary against explicit allow-list
    clean_security_summary, sec_res = validate_and_sanitize_security_summary(security_summary, tenant_salt)
    extra_redactions_count += sec_res.redactions_count
    extra_redaction_types.extend(sec_res.redaction_types)

    # 4. Scrub and validate collector_meta against explicit key allow-list
    clean_collector_meta, meta_res = validate_and_sanitize_collector_meta(collector_meta, tenant_salt)
    extra_redactions_count += meta_res.redactions_count
    extra_redaction_types.extend(meta_res.redaction_types)

    # Combine into composite ScrubResult
    composite_scrub_result = ScrubResult(
        scrubbed_text=scrub_result.scrubbed_text,
        redactions_count=scrub_result.redactions_count + extra_redactions_count,
        redaction_types=sorted(list(set(scrub_result.redaction_types + extra_redaction_types))),
    )

    # 5. Build final egress payload strictly from allow-listed fields
    final_egress_payload = {
        "payload_id": payload_id,
        "tenant_id": tenant_id,
        "collector_id": collector_id,
        "source_id": source_id,
        "region_id": region_id,
        "event_timestamp_utc": event_timestamp_utc,
        "source_timezone": source_timezone,
        "event_category": event_category,
        "severity": severity,
        "health_state": health_state,
        "metrics": clean_metrics,
        "security_summary": clean_security_summary,
        "alert_context": clean_alert_context,
        "collector_meta": clean_collector_meta,
    }

    # 6. Terminal allow-list enforcement immediately before enqueueing
    final_egress_payload = enforce_allow_list(final_egress_payload)

    # Ensure database tables exist lazily before storage operations
    ensure_db_initialized()

    # Store raw locally (encrypted)
    store_raw_log(tenant_id, collector_id, source_id, raw_payload, event_timestamp_utc, composite_scrub_result)

    # Enqueue for egress
    enqueue_egress_payload(payload_id, tenant_id, collector_id, source_id, region_id, final_egress_payload, composite_scrub_result)

    # Log to egress proof panel
    log_egress_proof(payload_id, tenant_id, final_egress_payload, composite_scrub_result)

    return final_egress_payload, composite_scrub_result


# Initialize tables on import (eager, like Tier 2)
init_db()


if __name__ == "__main__":
    print("Tier 1 database initialized")