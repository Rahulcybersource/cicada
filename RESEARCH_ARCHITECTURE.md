# CICADA 2026: Research Architecture & Implementation Mapping

This repository implements the end-to-end **CICADA 2026 Secure AIOps Observability Platform**, integrating cryptographic edge privacy guardrails from 14 peer-reviewed research papers and lightweight FastAPI control-plane patterns from `observantio/watchdog`.

---

## 1. Research Papers Implementation Matrix

| # | Paper Citation & Domain | Core Algorithm / Scheme | Implemented Module | Key Methods / Capabilities |
|---|---|---|---|---|
| **01** | **Li & Fujita (IEEE IPDPSW 2026)**<br>*A Two-Tier Secure Event Model for Privacy-Preserving IoT with Encrypted Reductions* | Lightweight additive blind reduction & fleet-wide privacy | [`services/tier1_collector/edge_security.py`](file:///services/tier1_collector/edge_security.py) | `blind_aggregate_value()`, `unblind_aggregate_sum()` |
| **02** | **He et al. (IEEE TDSC / POP & Drain)**<br>*Towards Automated Log Parsing for Large-Scale Log Data Analysis* | Automated log de-parameterization & structure clustering | [`services/tier1_collector/log_parser.py`](file:///services/tier1_collector/log_parser.py) | `LogTemplateParser.parse()`, deterministic `template_id` (e.g. `EVT_042`) |
| **03** | **Xu et al. (Google / SLAML)**<br>*Experience Mining Google's Production Console Logs* | Token cardinality separation & scoped variable hashing | [`services/tier1_collector/log_parser.py`](file:///services/tier1_collector/log_parser.py) | Type-scoped HMAC hashing (`<EMAIL:hash>`, `<PATH:hash>`, `<IP:hash>`) while preserving numeric counters |
| **04** | **Ding, Kulkarni, Yekhanin (Microsoft Research / NeurIPS)**<br>*Collecting Telemetry Data Privately* | 1-Bit Mean Mechanism with $\alpha$-point randomized rounding & permanent memoization | [`services/tier1_collector/ldp_privacy.py`](file:///services/tier1_collector/ldp_privacy.py) | `LDP1BitMeanMechanism.perturb_counter()`, privacy budget $\epsilon$, permanent deterministic memoization per epoch |
| **05** | **Saha et al. (Nature Scientific Reports 2026)**<br>*PEWTAF: A Privacy-Aware Lightweight Edge Intelligent Framework* | EFPM (Ephemeral Raw Purge) & TTVM (Temporal Threat Validation Module) | [`services/tier1_collector/edge_intelligence.py`](file:///services/tier1_collector/edge_intelligence.py) | `EphemeralMemoryPurge.purge_buffer()`, `TemporalThreatValidationModule.update()` ($P_t = n_p / N$, $\tau_p = 0.60$) |
| **06** | **Bin Shafi et al. (IEICE 2026)**<br>*Next-Generation Communications, Computing and Sensing for Industrial AIoT* | Fast Learning System (FLS) to Slow Learning System (SLS) escalation | [`services/tier1_collector/edge_intelligence.py`](file:///services/tier1_collector/edge_intelligence.py) | `ThreatAssessmentNetwork.evaluate_risk()`, `ailc_escalation` tag |
| **07** | **Tran (Thesis 2026)**<br>*A Secure Multi-Layer Embedded Framework for Real-Time Fault Detection in IIoT* | Anti-replay monotonic sequencing & Modbus CRC-16 frame integrity | [`services/tier1_collector/edge_security.py`](file:///services/tier1_collector/edge_security.py) | `MonotonicSequenceTracker.next_seq()`, `crc16_modbus()` ($0\text{xA001}$), `compute_frame_sha256()` |
| **08** | **Onishi, Michaelis, Kanemasa (Fujitsu / IEEE/ACM IoTDI 2020)**<br>*Recovery-Conscious Adaptive Watermark Generation for Time-Order Event Stream Processing* | Dynamic watermark $W_m = \hat{t}_e - (\mu_u + 2.58 \sigma_u)$ & post-outage recovery burst relaxation | [`services/tier2_saas/adaptive_watermark.py`](file:///services/tier2_saas/adaptive_watermark.py) | `AdaptiveWatermarkSorter`, `compute_watermark()`, `sort_and_filter_batch()`, `watermark_lag_ms`, `reversals_prevented` |
| **09** | **Google LLC (US Patent US 2025/0190292 A1)**<br>*Multivariate Time Series Anomaly Detection* | Ordinary Least Squares residual extraction from exogenous covariates | [`services/tier2_saas/multivariate_detector.py`](file:///services/tier2_saas/multivariate_detector.py) | `MultivariateResidualDetector`, $r_t = y_t - \hat{y}_t$, interval threshold $\pm 1.96 \sigma_r$ ($p > 0.95$) |
| **10** | **Adaptive Operational Incident Management (AOIM)**<br>*Dynamic Alert Weighting & Feature Attribution* | Importance score $w_i = \alpha_i \times S_i$, confidence gating, dual explanation modes | [`services/tier2_saas/aoim_triage.py`](file:///services/tier2_saas/aoim_triage.py) | `AOIMTriageEngine.evaluate_incident()`, operator summary + deep technical explanation |
| **11-14** | **Multi-Tenant Cryptographic RBAC & Graduated Response**<br>*Non-Repudiation Audit Logs & Operator Policy Chains* | Role-Based Access Control, dual approval for critical incidents, SHA-256 tamper-evident hash chaining | [`services/tier2_saas/auth_rbac.py`](file:///services/tier2_saas/auth_rbac.py)<br>[`services/tier2_saas/remediation.py`](file:///services/tier2_saas/remediation.py) | `Role.ADMINISTRATOR`, `Role.OPERATOR`, `Role.VIEWER`, `AuditLogChain.append()`, `verify_chain()`, `remediation_orchestrator` |

---

## 2. Watchdog Control-Plane Modules (`observantio/watchdog`)

Integrated under [`services/tier2_saas/watchdog_modules/`](file:///services/tier2_saas/watchdog_modules/):

1. **Resolver (`resolver.py`):**
   - Asynchronous multi-hypothesis root cause analysis jobs.
   - `POST /api/v1/rca/jobs`: Rank top-3 candidate causes with normalized probabilities and supporting evidence.
   - `GET /api/v1/rca/jobs/{incident_id}`: Query completed candidate rankings.
2. **Watchdog Config (`watchdog_config.py`):**
   - Dynamic tenant/collector initialization.
   - `POST /api/v1/tenants/{tenant_id}/collector-config`: Returns copy-paste `.env` configuration and Windows PowerShell launch snippets.
3. **Notifier (`notifier.py`):**
   - Alert suppression windows and incident state lifecycle tracking.
   - `POST /api/v1/silences`, `GET /api/v1/silences`, `DELETE /api/v1/silences/{silence_id}`.
   - `PATCH /api/v1/incidents/{incident_id}/state` (`open` $\rightarrow$ `acknowledged` $\rightarrow$ `resolved`) with audit trail logging.
4. **Gatekeeper (`gatekeeper.py`):**
   - Cryptographic compliance audit trail endpoint.
   - `GET /api/v1/audit`: Proves unbroken SHA-256 hash chaining (`chain_valid: true`).

---

## 3. Verification & Testing

The platform is covered by 92 automated tests passing in sub-3 seconds:
- `tests/test_4laptop_readiness.py`: 23 tests (Multi-laptop networking, trust boundary, zero secrets, SLA bounds).
- `tests/test_hybrid_aiops.py`: 18 tests (Rolling Z-score, 120s correlator, LLM timeout fallback, health transitions).
- `tests/test_phase1_redaction.py`: 33 tests (Secret scrubber, HMAC pseudonymization, Pydantic `extra="forbid"` allowlist).
- `tests/test_research_and_watchdog_integrations.py`: 18 tests (All 14 paper algorithms, Watchdog API endpoints, and cryptographic audit chains).
