from app.models.base import Base, TimestampMixin
from app.models.auth_otp import AuthOtp
from app.models.building import Building
from app.models.person import Person
from app.models.lot_person import lot_persons
from app.models.lot import Lot, LotOwner, FinancialPosition
from app.models.general_meeting import GeneralMeeting, GeneralMeetingStatus, get_effective_status
from app.models.motion import Motion, MotionType
from app.models.motion_option import MotionOption
from app.models.general_meeting_lot_weight import GeneralMeetingLotWeight, FinancialPositionSnapshot
from app.models.vote import Vote, VoteChoice, VoteStatus
from app.models.ballot_submission import BallotSubmission
from app.models.lot_proxy import LotProxy
from app.models.session_record import SessionRecord
from app.models.email_delivery import EmailDelivery, EmailDeliveryStatus
from app.models.tenant_config import TenantConfig
from app.models.otp_rate_limit import OTPRateLimit
from app.models.admin_login_attempt import AdminLoginAttempt
from app.models.tenant_smtp_config import TenantSmtpConfig
from app.models.tenant_settings import TenantSettings

__all__ = [
    "Base",
    "AuthOtp",
    "TimestampMixin",
    "Building",
    "Person",
    "lot_persons",
    "Lot",
    "LotOwner",  # backward-compatible alias for Lot
    "FinancialPosition",
    "GeneralMeeting",
    "GeneralMeetingStatus",
    "get_effective_status",
    "Motion",
    "MotionType",
    "MotionOption",
    "GeneralMeetingLotWeight",
    "FinancialPositionSnapshot",
    "Vote",
    "VoteChoice",
    "VoteStatus",
    "BallotSubmission",
    "LotProxy",
    "SessionRecord",
    "EmailDelivery",
    "EmailDeliveryStatus",
    "TenantConfig",
    "OTPRateLimit",
    "AdminLoginAttempt",
    "TenantSmtpConfig",
    "TenantSettings",
]
