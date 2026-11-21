#!/usr/bin/env python3
"""
TLS Certificate Generator for CICADA 2026 Tier 2 SaaS
Generates self-signed certificates valid for localhost, 127.0.0.1, and 10.30.165.15
"""

from __future__ import annotations

import argparse
import ipaddress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def generate_self_signed_cert(
    output_dir: Path = Path("."),
    cert_name: str = "cert.pem",
    key_name: str = "key.pem",
    valid_days: int = 365,
    san_ips: list[str] | None = None,
    san_dns: list[str] | None = None,
) -> tuple[Path, Path]:
    """
    Generate a self-signed TLS certificate with SAN entries.

    Args:
        output_dir: Directory to write cert and key files
        cert_name: Certificate filename
        key_name: Private key filename
        valid_days: Certificate validity period in days
        san_ips: Additional IP addresses for SAN
        san_dns: Additional DNS names for SAN

    Returns:
        Tuple of (cert_path, key_path)
    """
    # Default SANs for CICADA demo
    default_san_ips = ["127.0.0.1", "10.30.165.15"]
    default_san_dns = ["localhost"]

    all_san_ips = list(set(default_san_ips + (san_ips or [])))
    all_san_dns = list(set(default_san_dns + (san_dns or [])))

    # Generate private key
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )

    # Build subject and issuer (self-signed)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "California"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "San Francisco"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "CICADA 2026"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "Tier 2 SaaS"),
        x509.NameAttribute(NameOID.COMMON_NAME, "cicada-tier2.local"),
    ])

    # Build SAN extension
    san_entries = []
    for dns in all_san_dns:
        san_entries.append(x509.DNSName(dns))
    for ip_str in all_san_ips:
        try:
            san_entries.append(x509.IPAddress(ipaddress.ip_address(ip_str)))
        except ValueError:
            print(f"Warning: Invalid IP address '{ip_str}' skipped")

    san_extension = x509.SubjectAlternativeName(san_entries)

    # Build certificate
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=valid_days))
        .add_extension(san_extension, critical=False)
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None),
            critical=True,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([
                x509.oid.ExtendedKeyUsageOID.SERVER_AUTH,
                x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH,
            ]),
            critical=True,
        )
    )

    certificate = builder.sign(private_key, hashes.SHA256())

    # Write certificate
    cert_path = output_dir / cert_name
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))

    # Write private key
    key_path = output_dir / key_name
    key_path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )

    print(f"[OK] Certificate generated: {cert_path}")
    print(f"[OK] Private key generated: {key_path}")
    print(f"[OK] Valid for {valid_days} days")
    print(f"[OK] SAN DNS: {all_san_dns}")
    print(f"[OK] SAN IPs: {all_san_ips}")

    return cert_path, key_path


def main():
    parser = argparse.ArgumentParser(
        description="Generate self-signed TLS certificate for CICADA Tier 2 SaaS"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("."),
        help="Output directory for cert and key (default: current directory)",
    )
    parser.add_argument(
        "--cert-name",
        default="cert.pem",
        help="Certificate filename (default: cert.pem)",
    )
    parser.add_argument(
        "--key-name",
        default="key.pem",
        help="Private key filename (default: key.pem)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=365,
        help="Certificate validity in days (default: 365)",
    )
    parser.add_argument(
        "--san-ip",
        action="append",
        help="Additional IP address for SAN (can be used multiple times)",
    )
    parser.add_argument(
        "--san-dns",
        action="append",
        help="Additional DNS name for SAN (can be used multiple times)",
    )

    args = parser.parse_args()

    # Ensure output directory exists
    args.output_dir.mkdir(parents=True, exist_ok=True)

    generate_self_signed_cert(
        output_dir=args.output_dir,
        cert_name=args.cert_name,
        key_name=args.key_name,
        valid_days=args.days,
        san_ips=args.san_ip,
        san_dns=args.san_dns,
    )


if __name__ == "__main__":
    main()