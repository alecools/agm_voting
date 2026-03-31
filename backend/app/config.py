from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""  # nosemgrep: no-hardcoded-secrets -- Pydantic Settings field default; real value supplied via SMTP_PASSWORD env var in all deployed environments
    smtp_from_email: str = ""
    allowed_origin: str = "http://localhost:5173"
    session_secret: str = "change_me_to_a_random_secret"  # nosemgrep: no-hardcoded-secrets -- Pydantic Settings field default; overridden by SESSION_SECRET env var; placeholder value intentionally signals misconfiguration
    admin_username: str = "admin"
    admin_password: str = "admin"  # nosemgrep: no-hardcoded-secrets -- Pydantic Settings field default; overridden by ADMIN_PASSWORD env var in all deployed environments
    testing_mode: bool = False
    email_override: str = ""
    environment: str = "development"

    # DB connection pool settings — tuned for serverless Lambda.
    # Override via DB_POOL_SIZE / DB_MAX_OVERFLOW / DB_POOL_TIMEOUT env vars
    # when running in environments with different Neon connection limits.
    #
    # Defaults (pool_size=1, max_overflow=0):
    # - pool_size=1: each Lambda instance holds at most 1 persistent connection.
    #   Lambda instances don't share connections, so a pool larger than 1 wastes
    #   connections and causes exhaustion under autoscaling.
    # - max_overflow=0: no burst connections beyond pool_size for the same reason.
    # - pool_pre_ping=True: set in database.py — detects stale connections.
    db_pool_size: int = 1
    db_max_overflow: int = 0
    db_pool_timeout: int = 10

    @field_validator("admin_password")
    @classmethod
    def admin_password_must_be_bcrypt(cls, v: str) -> str:
        """Reject non-bcrypt admin passwords at startup (RR3-17).

        ADMIN_PASSWORD must be a bcrypt hash (starting with $2b$ or $2a$) or
        the literal dev-only placeholder "admin" (the default for local
        development and CI). Any other non-empty value that is NOT a bcrypt
        hash is rejected immediately at startup to prevent plaintext passwords
        from being deployed to production.

        Operators must run POST /api/admin/auth/hash-password to generate a
        bcrypt hash before setting ADMIN_PASSWORD in a deployed environment.
        """
        _BCRYPT_PREFIXES = ("$2b$", "$2a$")
        _DEV_PLACEHOLDER = "admin"  # allowed default for local dev / CI only
        if v and v != _DEV_PLACEHOLDER and not any(v.startswith(p) for p in _BCRYPT_PREFIXES):
            raise ValueError(
                "ADMIN_PASSWORD must be a bcrypt hash (starting with $2b$ or $2a$). "
                "Run POST /api/admin/auth/hash-password to generate one."
            )
        return v

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


settings = Settings()
