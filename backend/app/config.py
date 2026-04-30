from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/agm_dev"

    @field_validator("database_url")
    @classmethod
    def database_url_must_be_postgresql_asyncpg(cls, v: str) -> str:
        """Validate DATABASE_URL at startup (RR3-23).

        Rejects:
        - Empty / missing URL
        - URLs not using the postgresql+asyncpg:// scheme (e.g. sqlite, postgres://)
        - URLs containing channel_binding (asyncpg rejects this libpq-only parameter)
        - URLs using sslmode= instead of ssl= (asyncpg syntax differs from psycopg2)
        """
        if not v:
            raise ValueError(
                "DATABASE_URL must not be empty. "
                "Set DATABASE_URL to a postgresql+asyncpg:// connection string."
            )
        if not v.startswith("postgresql+asyncpg://"):
            raise ValueError(
                f"DATABASE_URL must start with 'postgresql+asyncpg://' (got: {v[:40]!r}). "
                "asyncpg requires this scheme; 'postgres://' and 'postgresql://' are not accepted."
            )
        if "channel_binding" in v:
            raise ValueError(
                "DATABASE_URL must not contain 'channel_binding' — this is a libpq-only "
                "parameter that asyncpg rejects. Remove it from the connection string."
            )
        if "sslmode=" in v:
            raise ValueError(
                "DATABASE_URL must not use 'sslmode=' — asyncpg uses 'ssl=' instead. "
                "Replace 'sslmode=require' with 'ssl=require'."
            )
        return v

    test_database_url: str = (
        "postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test"
    )
    # Deprecated — retained for Alembic migration seeding only.
    # These values are no longer used at runtime; SMTP settings are read from the
    # tenant_smtp_config DB table by smtp_config_service.get_smtp_config().
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""  # nosemgrep: no-hardcoded-secrets -- Pydantic Settings field default; real value supplied via SMTP_PASSWORD env var in all deployed environments
    smtp_from_email: str = ""
    # AES-256-GCM key for encrypting SMTP passwords stored in DB.
    # Must be a base64-encoded 32-byte random value.
    # If empty, password storage is unavailable and a WARNING is logged on startup.
    smtp_encryption_key: str = ""  # nosemgrep: no-hardcoded-secrets -- Pydantic Settings field default; real value supplied via SMTP_ENCRYPTION_KEY env var
    allowed_origin: str = "http://localhost:5173"
    session_secret: str = "change_me_to_a_random_secret"  # nosemgrep: no-hardcoded-secrets -- Pydantic Settings field default; overridden by SESSION_SECRET env var; placeholder value intentionally signals misconfiguration
    # Base URL of the Neon Auth / Better Auth instance.
    # Used by require_admin to call GET {neon_auth_base_url}/api/auth/get-session
    # for HTTP session introspection.  Empty string in development (Better Auth
    # is not required for local dev without a Neon project).
    neon_auth_base_url: str = ""
    testing_mode: bool = False
    email_override: str = ""
    environment: str = "development"
    # Production guard for the ballot-reset endpoint (RR5-01).
    # Must be explicitly set to True via ENABLE_BALLOT_RESET env var to enable the endpoint.
    # Defaults to False so the endpoint is blocked in all deployed environments unless opted in.
    enable_ballot_reset: bool = False

    # Pool settings for the persistent pool (see database.py).
    # DATABASE_URL_UNPOOLED (direct Neon endpoint, no PgBouncer) is used for the
    # runtime engine, so statement_cache_size can be non-zero — asyncpg caches
    # prepared statements and performs type introspection once per connection
    # lifetime instead of every query.
    # pool_size=20 supports up to 20 concurrent DB operations per Lambda instance
    # under Fluid Compute's concurrent request handling. Because direct connections
    # are used (no PgBouncer), Neon's per-project connection limit applies directly.
    # Reduce DB_POOL_SIZE if approaching that limit across many Lambda instances.
    # max_overflow=10 provides burst headroom up to 30 total connections per instance.
    # pool_timeout=10s: longer wait since more connections are available, reducing the
    # need to fail fast.
    # Override via DB_POOL_SIZE, DB_MAX_OVERFLOW, DB_POOL_TIMEOUT env vars if needed.
    db_pool_size: int = 20
    db_max_overflow: int = 10
    db_pool_timeout: int = 10

    @model_validator(mode="after")
    def testing_mode_forbidden_in_production(self) -> "Settings":
        """Refuse to start when testing_mode is enabled in a production environment.

        testing_mode disables OTP rate-limiting, cookie security flags, and
        exposes test-only endpoints.  If it is accidentally set to True while
        environment is 'production', the application must refuse to start.

        Allowed combinations:
        - environment='production', testing_mode=False  → OK
        - environment='development', testing_mode=True  → OK
        - environment='testing', testing_mode=True      → OK
        """
        if self.testing_mode and self.environment == "production":
            raise ValueError(
                "TESTING_MODE is enabled in a production environment. "
                "Refusing to start. Unset TESTING_MODE or set ENV/ENVIRONMENT "
                "to a non-production value."
            )
        return self

    @model_validator(mode="after")
    def reject_weak_secrets_outside_development(self) -> "Settings":
        """Reject known-weak SESSION_SECRET outside development (RR3-35).

        In production or preview environments, weak defaults are rejected at
        startup to prevent misconfigured deployments from accepting real traffic.

        Weak SESSION_SECRET values:
        - The shipped placeholder "change_me_to_a_random_secret"
        - Any value shorter than 32 characters
        """
        # Only enforce in production and preview — development and testing environments
        # use weak defaults intentionally for developer ergonomics and CI.
        _EXEMPT_ENVIRONMENTS = {"development", "testing"}
        if self.environment in _EXEMPT_ENVIRONMENTS:
            return self

        # Reject weak session secret
        _WEAK_SESSION_SECRETS = {"change_me_to_a_random_secret"}
        if self.session_secret in _WEAK_SESSION_SECRETS or len(self.session_secret) < 32:
            raise ValueError(
                "SESSION_SECRET is too weak for a non-development environment. "
                "Use a random string of at least 32 characters."
            )

        return self


settings = Settings()
