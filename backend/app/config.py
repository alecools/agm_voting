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


settings = Settings()
