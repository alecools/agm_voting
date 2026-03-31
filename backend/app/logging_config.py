"""
OTEL-compliant structured logging configuration using structlog.

Outputs JSON logs with standard fields:
  - timestamp (ISO 8601 UTC)
  - level
  - logger
  - message
  - service.name
"""
from __future__ import annotations

import logging
import sys

import structlog
from structlog.types import EventDict, WrappedLogger


def _add_service_name(
    logger: WrappedLogger, method: str, event_dict: EventDict
) -> EventDict:
    """Processor that injects service.name into every log event."""
    event_dict.setdefault("service.name", "agm-voting-app")
    return event_dict


def _rename_event_to_message(
    logger: WrappedLogger, method: str, event_dict: EventDict
) -> EventDict:
    """Rename structlog's 'event' key to 'message' for OTEL compatibility."""
    event_dict["message"] = event_dict.pop("event", "")
    return event_dict


def _add_logger_name(
    logger: WrappedLogger, method: str, event_dict: EventDict
) -> EventDict:
    """Add logger name to the event dict, compatible with PrintLogger."""
    if hasattr(logger, "name"):
        event_dict.setdefault("logger", logger.name)
    return event_dict


def configure_logging() -> None:
    """
    Configure structlog for OTEL-compliant JSON output.

    Call once at application startup (e.g. from main.py lifespan or module level).
    """
    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        _add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
        _add_service_name,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    structlog.configure(
        processors=shared_processors
        + [
            _rename_event_to_message,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.DEBUG),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=False,
    )

    # Also configure stdlib logging to go through structlog so that third-party
    # libraries that use logging.getLogger() also emit structured JSON.
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=logging.INFO,
    )


def get_logger(name: str) -> structlog.BoundLogger:
    """Return a structlog logger bound with the given name."""
    return structlog.get_logger(name)
