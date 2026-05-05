# Backward-compatibility shim — import from lot.py instead.
# All code should migrate to importing from app.models.lot or app.models directly.
from app.models.lot import Lot, LotOwner, FinancialPosition  # noqa: F401

__all__ = ["Lot", "LotOwner", "FinancialPosition"]
