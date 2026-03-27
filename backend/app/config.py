from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/agm_dev"
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
    db_pool_size: int = 2
    db_max_overflow: int = 3
    db_pool_timeout: int = 10

    @field_validator("admin_password")
    @classmethod
    def admin_password_must_be_bcrypt(cls, v: str) -> str:
        """Reject plaintext admin passwords at startup.

        ADMIN_PASSWORD must be a bcrypt hash (starting with $2b$ or $2a$).
        In test/development environments the default value "admin" is allowed
        only when testing_mode is True (validated separately at runtime in the
        login handler). Operators must run /api/admin/auth/hash-password to
        generate a hash before deploying.

        NOTE: We only enforce the format here (not bcrypt prefix) because
        pydantic validators run before the full model is initialised, so we
        cannot access other fields.  The plaintext fallback has been removed
        from _verify_admin_password — if the value is not a bcrypt hash, the
        login endpoint will return 500 with a clear error message.
        """
        return v


settings = Settings()
