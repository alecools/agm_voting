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
    resend_api_key: str = "re_placeholder"
    resend_from_email: str = "noreply@example.com"
    allowed_origin: str = "http://localhost:5173"
    session_secret: str = "change_me_to_a_random_secret"
    admin_username: str = "admin"
    admin_password: str = "admin"


settings = Settings()
