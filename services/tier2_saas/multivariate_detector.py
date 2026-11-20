"""
services/tier2_saas/multivariate_detector.py
Multivariate Residual Anomaly Detection
Based on:
- Google Patent US 2025/0190292 A1: "Multivariate time series anomaly detection"

Strips exogenous covariates (e.g. bandwidth_mbps, request_rate, mem_pct) from an endogenous
target metric (e.g. cpu_pct, latency_ms) using rolling Ordinary Least Squares (OLS) linear
regression, extracting the univariate residual r_t. Flags an anomaly when actual value falls
outside expected +/- interval_size (p > 0.95 threshold, |r_t| > 1.96 * sigma_r).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class MultivariateAnomalyResult:
    """Detection result for a multivariate target."""
    is_anomaly: bool
    target_metric: str
    actual_value: float
    expected_value: float
    residual: float
    interval_size: float
    confidence: float
    covariates_used: list[str]
    z_score_residual: float


class MultivariateResidualDetector:
    """
    Rolling multivariate regression model for anomaly detection.
    Maintains historical observations of (target, covariates), estimates weights
    via OLS, and evaluates residuals.
    """

    def __init__(
        self,
        target_metric: str = "cpu_pct",
        covariate_metrics: list[str] | None = None,
        history_window: int = 100,
        z_threshold: float = 1.96,  # ~95% confidence interval
    ):
        self.target_metric = target_metric
        self.covariate_metrics = covariate_metrics or ["mem_pct", "bandwidth_mbps", "latency_ms"]
        self.history_window = history_window
        self.z_threshold = z_threshold

        # Rolling storage: deque of (target, [covariates])
        self._history: deque[tuple[float, list[float]]] = deque(maxlen=history_window)
        self._residual_history: deque[float] = deque(maxlen=history_window)

        # Regression weights: y_hat = b0 + b1*x1 + b2*x2 + ...
        self._intercept: float = 0.0
        self._weights: list[float] = [0.0] * len(self.covariate_metrics)

    def update(self, metrics: dict[str, float]) -> None:
        """Add observation to history and recalculate regression coefficients."""
        if self.target_metric not in metrics:
            return

        target_val = float(metrics[self.target_metric])
        cov_vals = [float(metrics.get(cov, 0.0)) for cov in self.covariate_metrics]

        self._history.append((target_val, cov_vals))

        if len(self._history) >= 8:
            self._fit_ols()

    def _fit_ols(self) -> None:
        """
        Fit multiple linear regression using Normal Equations:
        b = (X^T X)^-1 X^T y (simplified/regularized for small dimension)
        Or univariate/pairwise approximations for fast sub-millisecond execution.
        """
        n = len(self._history)
        if n < 5:
            return

        # Simple coordinate-wise / independent OLS estimation with regularization
        y_vals = [y for y, _ in self._history]
        y_mean = sum(y_vals) / n

        weights = []
        for i in range(len(self.covariate_metrics)):
            x_vals = [covs[i] for _, covs in self._history]
            x_mean = sum(x_vals) / n

            # Covariance and variance
            cov_xy = sum((x_vals[k] - x_mean) * (y_vals[k] - y_mean) for k in range(n))
            var_x = sum((x_vals[k] - x_mean) ** 2 for k in range(n))

            if var_x > 1e-6:
                w = cov_xy / var_x
            else:
                w = 0.0
            weights.append(w)

        self._weights = weights
        # Compute intercept
        cov_means = [sum(covs[i] for _, covs in self._history) / n for i in range(len(self.covariate_metrics))]
        self._intercept = y_mean - sum(w * m for w, m in zip(self._weights, cov_means))

        # Recompute recent residuals
        self._residual_history.clear()
        for y, covs in self._history:
            y_hat = self._intercept + sum(w * c for w, c in zip(self._weights, covs))
            self._residual_history.append(y - y_hat)

    def check_anomaly(self, metrics: dict[str, float]) -> MultivariateAnomalyResult | None:
        """
        Check if the target metric is an anomaly given the current covariates.
        Returns MultivariateAnomalyResult or None if insufficient data.
        """
        if self.target_metric not in metrics or len(self._history) < 8:
            return None

        target_val = float(metrics[self.target_metric])
        cov_vals = [float(metrics.get(cov, 0.0)) for cov in self.covariate_metrics]

        expected_val = self._intercept + sum(w * c for w, c in zip(self._weights, cov_vals))
        residual = target_val - expected_val

        # Compute residual standard deviation
        if len(self._residual_history) >= 5:
            r_mean = sum(self._residual_history) / len(self._residual_history)
            r_var = sum((r - r_mean) ** 2 for r in self._residual_history) / len(self._residual_history)
            r_std = math.sqrt(max(1e-4, r_var))
        else:
            r_std = 5.0  # Default initial tolerance

        z_residual = abs(residual) / r_std
        interval_size = self.z_threshold * r_std
        is_anomaly = abs(residual) > interval_size

        # Confidence mapped from z-residual
        confidence = min(0.99, max(0.50, 0.50 + (z_residual - self.z_threshold) * 0.15)) if is_anomaly else 0.50

        return MultivariateAnomalyResult(
            is_anomaly=is_anomaly,
            target_metric=self.target_metric,
            actual_value=round(target_val, 2),
            expected_value=round(expected_val, 2),
            residual=round(residual, 2),
            interval_size=round(interval_size, 2),
            confidence=round(confidence, 3),
            covariates_used=self.covariate_metrics,
            z_score_residual=round(z_residual, 2),
        )
