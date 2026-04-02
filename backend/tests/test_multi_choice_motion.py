"""Tests for multi-choice motion type feature.

Covers:
- Slice 1: MotionOption model, Vote.motion_option_id, enum values
- Slice 2: Admin API — create/add/update meeting with multi-choice motions, tally
- Slice 3: Voter API — list motions with options, submit multi-choice ballot, my-ballot
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    BallotSubmission,
    Building,
    GeneralMeeting,
    GeneralMeetingLotWeight,
    GeneralMeetingStatus,
    LotOwner,
    Motion,
    MotionOption,
    MotionType,
    Vote,
    VoteChoice,
    VoteStatus,
)
from app.models.lot_owner_email import LotOwnerEmail
from app.models.session_record import SessionRecord
from tests.conftest import meeting_dt, closing_dt


# ---------------------------------------------------------------------------
# Helper fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def mc_building(db_session: AsyncSession) -> Building:
    """Building with 3 lot owners for multi-choice tests."""
    b = Building(name="MC Test Building", manager_email="mc@test.com")
    db_session.add(b)
    await db_session.flush()
    for i in range(1, 4):
        lo = LotOwner(
            building_id=b.id,
            lot_number=str(i),
            unit_entitlement=100 * i,
        )
        db_session.add(lo)
        await db_session.flush()
        db_session.add(LotOwnerEmail(lot_owner_id=lo.id, email=f"lot{i}@test.com"))
    await db_session.commit()
    return b


@pytest_asyncio.fixture
async def mc_meeting(client: AsyncClient, mc_building: Building) -> dict:
    """Create a meeting with a multi-choice motion and two general motions."""
    payload = {
        "building_id": str(mc_building.id),
        "title": "MC Meeting",
        "meeting_at": meeting_dt().isoformat(),
        "voting_closes_at": closing_dt().isoformat(),
        "motions": [
            {
                "title": "Board Election",
                "description": "Vote for board members",
                "display_order": 1,
                "motion_type": "general",
                "is_multi_choice": True,
                "option_limit": 2,
                "options": [
                    {"text": "Alice", "display_order": 1},
                    {"text": "Bob", "display_order": 2},
                    {"text": "Carol", "display_order": 3},
                ],
            },
            {
                "title": "Budget Approval",
                "description": "Approve the budget",
                "display_order": 2,
                "motion_type": "general",
            },
        ],
    }
    resp = await client.post("/api/admin/general-meetings", json=payload)
    assert resp.status_code == 201
    return resp.json()


async def _create_voter_session(
    db_session: AsyncSession,
    general_meeting_id: uuid.UUID,
    voter_email: str,
    building_id: uuid.UUID,
) -> str:
    """Create a session record and return a signed token."""
    import secrets
    from app.services.auth_service import _sign_token

    raw_token = secrets.token_urlsafe(32)
    session = SessionRecord(
        session_token=raw_token,
        voter_email=voter_email,
        building_id=building_id,
        general_meeting_id=general_meeting_id,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db_session.add(session)
    await db_session.flush()
    return _sign_token(raw_token)


# ---------------------------------------------------------------------------
# Slice 1: Model-level tests
# ---------------------------------------------------------------------------


class TestMotionOptionModel:
    # --- Happy path ---

    async def test_motion_option_creation(self, db_session: AsyncSession, mc_building: Building):
        """MotionOption can be created and FK-linked to a Motion."""
        gm = GeneralMeeting(
            building_id=mc_building.id,
            title="Model Test Meeting",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(gm)
        await db_session.flush()

        motion = Motion(
            general_meeting_id=gm.id,
            title="Election",
            display_order=1,
            motion_number="1",
            motion_type=MotionType.general,
            is_multi_choice=True,
            option_limit=2,
        )
        db_session.add(motion)
        await db_session.flush()

        opt1 = MotionOption(motion_id=motion.id, text="Alice", display_order=1)
        opt2 = MotionOption(motion_id=motion.id, text="Bob", display_order=2)
        db_session.add_all([opt1, opt2])
        await db_session.commit()

        result = await db_session.execute(
            select(MotionOption).where(MotionOption.motion_id == motion.id).order_by(MotionOption.display_order)
        )
        opts = result.scalars().all()
        assert len(opts) == 2
        assert opts[0].text == "Alice"
        assert opts[1].text == "Bob"

    async def test_motion_option_cascade_delete(self, db_session: AsyncSession, mc_building: Building):
        """Deleting a Motion cascades to its MotionOptions."""
        gm = GeneralMeeting(
            building_id=mc_building.id,
            title="Cascade Test",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(gm)
        await db_session.flush()

        motion = Motion(
            general_meeting_id=gm.id,
            title="Election",
            display_order=1,
            motion_number="1",
            motion_type=MotionType.general,
            is_multi_choice=True,
            option_limit=1,
        )
        db_session.add(motion)
        await db_session.flush()

        motion_id = motion.id
        opt = MotionOption(motion_id=motion.id, text="Only Option", display_order=1)
        db_session.add(opt)
        await db_session.commit()

        # Delete motion — options should cascade
        await db_session.delete(motion)
        await db_session.commit()

        remaining = await db_session.execute(
            select(MotionOption).where(MotionOption.motion_id == motion_id)
        )
        assert remaining.scalars().all() == []

    async def test_vote_choice_selected_enum(self):
        """VoteChoice.selected is a valid enum value."""
        assert VoteChoice.selected == "selected"
        assert "selected" in [c.value for c in VoteChoice]

    async def test_motion_is_multi_choice_field(self):
        """Motion.is_multi_choice is a separate bool field, not a MotionType value."""
        assert MotionType.general == "general"
        assert MotionType.special == "special"
        # multi_choice is NOT a MotionType value — it is represented by is_multi_choice=True
        assert "multi_choice" not in [t.value for t in MotionType]

    async def test_vote_with_motion_option_id(self, db_session: AsyncSession, mc_building: Building):
        """Vote can store a motion_option_id."""
        gm = GeneralMeeting(
            building_id=mc_building.id,
            title="Option Vote Test",
            status=GeneralMeetingStatus.open,
            meeting_at=meeting_dt(),
            voting_closes_at=closing_dt(),
        )
        db_session.add(gm)
        await db_session.flush()

        # Get lot owners
        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        assert lot is not None

        # Create weight snapshot
        db_session.add(GeneralMeetingLotWeight(
            general_meeting_id=gm.id,
            lot_owner_id=lot.id,
            unit_entitlement_snapshot=lot.unit_entitlement,
        ))

        motion = Motion(
            general_meeting_id=gm.id,
            title="Election",
            display_order=1,
            motion_number="1",
            motion_type=MotionType.general,
            is_multi_choice=True,
            option_limit=1,
        )
        db_session.add(motion)
        await db_session.flush()

        opt = MotionOption(motion_id=motion.id, text="Alice", display_order=1)
        db_session.add(opt)
        await db_session.flush()

        vote = Vote(
            general_meeting_id=gm.id,
            motion_id=motion.id,
            voter_email="test@test.com",
            lot_owner_id=lot.id,
            choice=VoteChoice.selected,
            motion_option_id=opt.id,
            status=VoteStatus.submitted,
        )
        db_session.add(vote)
        await db_session.commit()

        loaded = await db_session.execute(select(Vote).where(Vote.id == vote.id))
        loaded_vote = loaded.scalar_one()
        assert loaded_vote.motion_option_id == opt.id
        assert loaded_vote.choice == VoteChoice.selected


# ---------------------------------------------------------------------------
# Slice 2: Admin API — multi-choice motion management
# ---------------------------------------------------------------------------


class TestCreateMeetingWithMultiChoiceMotion:
    # --- Happy path ---

    async def test_create_meeting_with_multi_choice_motion(
        self, client: AsyncClient, mc_building: Building
    ):
        """Create a meeting with a multi-choice motion returns 201 with options."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test MC Meeting",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Board Election",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 2,
                    "options": [
                        {"text": "Alice", "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                        {"text": "Carol", "display_order": 3},
                    ],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 201
        data = resp.json()
        motion = data["motions"][0]
        assert motion["motion_type"] == "general"
        assert motion["is_multi_choice"] is True
        assert motion["option_limit"] == 2
        assert len(motion["options"]) == 3
        assert motion["options"][0]["text"] == "Alice"
        assert motion["options"][1]["text"] == "Bob"
        assert motion["options"][2]["text"] == "Carol"

    async def test_create_meeting_with_mixed_motion_types(
        self, client: AsyncClient, mc_building: Building
    ):
        """Meeting with both general and multi-choice motions is created correctly."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Mixed Motion Meeting",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Budget",
                    "display_order": 1,
                    "motion_type": "general",
                },
                {
                    "title": "Board Election",
                    "display_order": 2,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 1,
                    "options": [
                        {"text": "Alice", "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                    ],
                },
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 201
        motions = resp.json()["motions"]
        assert motions[0]["motion_type"] == "general"
        assert motions[0]["is_multi_choice"] is False
        assert motions[0]["options"] == []
        assert motions[0]["option_limit"] is None
        assert motions[1]["motion_type"] == "general"
        assert motions[1]["is_multi_choice"] is True
        assert len(motions[1]["options"]) == 2
        assert motions[1]["option_limit"] == 1

    # --- Input validation ---

    async def test_multi_choice_requires_option_limit(
        self, client: AsyncClient, mc_building: Building
    ):
        """Multi-choice motion without option_limit is rejected with 422."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Election",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "options": [
                        {"text": "Alice", "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                    ],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 422

    async def test_multi_choice_requires_at_least_two_options(
        self, client: AsyncClient, mc_building: Building
    ):
        """Multi-choice motion with only 1 option is rejected."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Election",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 1,
                    "options": [{"text": "Only One", "display_order": 1}],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 422

    async def test_option_limit_cannot_exceed_option_count(
        self, client: AsyncClient, mc_building: Building
    ):
        """option_limit > len(options) is rejected."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Election",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 5,
                    "options": [
                        {"text": "Alice", "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                    ],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 422

    async def test_non_mc_motion_cannot_have_options(
        self, client: AsyncClient, mc_building: Building
    ):
        """General motion with options is rejected."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Budget",
                    "display_order": 1,
                    "motion_type": "general",
                    "options": [{"text": "Option", "display_order": 1}],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 422

    async def test_non_mc_motion_cannot_have_option_limit(
        self, client: AsyncClient, mc_building: Building
    ):
        """General motion with option_limit is rejected."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Budget",
                    "display_order": 1,
                    "motion_type": "general",
                    "option_limit": 1,
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 422

    # --- Boundary values ---

    async def test_option_limit_equals_option_count(
        self, client: AsyncClient, mc_building: Building
    ):
        """option_limit == len(options) is valid."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Election",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 2,
                    "options": [
                        {"text": "Alice", "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                    ],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 201

    async def test_option_limit_one_single_select(
        self, client: AsyncClient, mc_building: Building
    ):
        """option_limit=1 is valid for single-select."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Single Select Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Choice",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 1,
                    "options": [
                        {"text": "Option A", "display_order": 1},
                        {"text": "Option B", "display_order": 2},
                    ],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 201

    async def test_option_text_empty_rejected(
        self, client: AsyncClient, mc_building: Building
    ):
        """Empty option text is rejected."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Election",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 1,
                    "options": [
                        {"text": "", "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                    ],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 422

    async def test_option_text_max_length_exceeded(
        self, client: AsyncClient, mc_building: Building
    ):
        """Option text > 200 chars is rejected."""
        payload = {
            "building_id": str(mc_building.id),
            "title": "Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Election",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 1,
                    "options": [
                        {"text": "A" * 201, "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                    ],
                }
            ],
        }
        resp = await client.post("/api/admin/general-meetings", json=payload)
        assert resp.status_code == 422


class TestAddMotionToMeetingMultiChoice:
    # --- Happy path ---

    async def test_add_multi_choice_motion_to_meeting(
        self, client: AsyncClient, mc_meeting: dict
    ):
        """Admin can add a multi-choice motion to an existing meeting."""
        meeting_id = mc_meeting["id"]
        payload = {
            "title": "New Election",
            "motion_type": "general",
            "is_multi_choice": True,
            "option_limit": 1,
            "options": [
                {"text": "Yes Option", "display_order": 1},
                {"text": "No Option", "display_order": 2},
            ],
        }
        resp = await client.post(f"/api/admin/general-meetings/{meeting_id}/motions", json=payload)
        assert resp.status_code == 201
        data = resp.json()
        assert data["motion_type"] == "general"
        assert data["is_multi_choice"] is True
        assert data["option_limit"] == 1
        assert len(data["options"]) == 2
        assert data["is_visible"] is False

    async def test_add_general_motion_still_has_empty_options(
        self, client: AsyncClient, mc_meeting: dict
    ):
        """Adding a general motion returns empty options list."""
        meeting_id = mc_meeting["id"]
        payload = {
            "title": "Budget Motion",
            "motion_type": "general",
        }
        resp = await client.post(f"/api/admin/general-meetings/{meeting_id}/motions", json=payload)
        assert resp.status_code == 201
        data = resp.json()
        assert data["options"] == []
        assert data["option_limit"] is None

    # --- Input validation ---

    async def test_add_multi_choice_without_options_rejected(
        self, client: AsyncClient, mc_meeting: dict
    ):
        """Adding multi-choice motion without options is rejected."""
        meeting_id = mc_meeting["id"]
        payload = {
            "title": "Bad Motion",
            "motion_type": "general",
            "is_multi_choice": True,
            "option_limit": 1,
        }
        resp = await client.post(f"/api/admin/general-meetings/{meeting_id}/motions", json=payload)
        assert resp.status_code == 422


class TestUpdateMotionMultiChoice:
    # --- Happy path ---

    async def test_update_multi_choice_motion_options(
        self, client: AsyncClient, mc_meeting: dict, db_session: AsyncSession
    ):
        """Updating options on a hidden multi-choice motion replaces existing options."""
        meeting_id = mc_meeting["id"]
        # Find the multi-choice motion
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        motion_id = mc_motion["id"]

        # First, ensure the motion is hidden (it's already created as visible=True in meeting)
        # Hide it
        await client.patch(
            f"/api/admin/motions/{motion_id}/visibility",
            json={"is_visible": False},
        )

        # Update options
        payload = {
            "options": [
                {"text": "New Option 1", "display_order": 1},
                {"text": "New Option 2", "display_order": 2},
                {"text": "New Option 3", "display_order": 3},
            ],
            "option_limit": 2,
        }
        resp = await client.patch(f"/api/admin/motions/{motion_id}", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["option_limit"] == 2
        assert len(data["options"]) == 3
        assert data["options"][0]["text"] == "New Option 1"

    async def test_update_motion_type_from_mc_clears_options(
        self, client: AsyncClient, mc_building: Building, db_session: AsyncSession
    ):
        """Changing motion_type away from multi_choice clears options and option_limit."""
        # Create a meeting with only a multi-choice motion
        meeting_payload = {
            "building_id": str(mc_building.id),
            "title": "Type Change Test",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "Election",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 1,
                    "options": [
                        {"text": "Alice", "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                    ],
                }
            ],
        }
        create_resp = await client.post("/api/admin/general-meetings", json=meeting_payload)
        assert create_resp.status_code == 201
        motion_id = create_resp.json()["motions"][0]["id"]

        # Hide the motion so we can edit it
        await client.patch(
            f"/api/admin/motions/{motion_id}/visibility",
            json={"is_visible": False},
        )

        # Change is_multi_choice to false — should clear options and option_limit
        resp = await client.patch(
            f"/api/admin/motions/{motion_id}",
            json={"is_multi_choice": False},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["motion_type"] == "general"
        assert data["is_multi_choice"] is False
        assert data["options"] == []
        assert data["option_limit"] is None


class TestGetMeetingDetailWithMultiChoice:
    # --- Happy path ---

    async def test_detail_includes_options_for_mc_motion(
        self, client: AsyncClient, mc_meeting: dict
    ):
        """GET meeting detail includes options and option_limit for multi-choice motions."""
        meeting_id = mc_meeting["id"]
        resp = await client.get(f"/api/admin/general-meetings/{meeting_id}")
        assert resp.status_code == 200
        data = resp.json()
        mc_motion = next(m for m in data["motions"] if m["is_multi_choice"])
        assert mc_motion["option_limit"] == 2
        assert len(mc_motion["options"]) == 3
        assert mc_motion["tally"]["yes"]["voter_count"] == 0
        # No votes yet — each option should have 0 tally
        assert len(mc_motion["tally"]["options"]) == 3
        for opt_tally in mc_motion["tally"]["options"]:
            assert opt_tally["voter_count"] == 0
            assert opt_tally["entitlement_sum"] == 0

    async def test_detail_general_motion_has_empty_options(
        self, client: AsyncClient, mc_meeting: dict
    ):
        """GET meeting detail: general motions have empty options list."""
        meeting_id = mc_meeting["id"]
        resp = await client.get(f"/api/admin/general-meetings/{meeting_id}")
        data = resp.json()
        gen_motion = next(m for m in data["motions"] if not m["is_multi_choice"])
        assert gen_motion["options"] == []
        assert gen_motion["option_limit"] is None
        assert gen_motion["tally"]["options"] == []

    # --- State-based tally tests ---

    async def test_multi_choice_tally_after_vote(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Tally shows per-option UOE totals after voters submit ballots."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        mc_motion_id = uuid.UUID(mc_motion["id"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])
        bob_opt_id = uuid.UUID(mc_motion["options"][1]["id"])

        # Get lot owners for this building
        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).order_by(LotOwner.lot_number)
        )
        lots = list(lots_result.scalars().all())
        lot1, lot2 = lots[0], lots[1]

        # lot1 (UOE=100) votes for Alice
        # lot2 (UOE=200) votes for Alice and Bob
        for lot, opts in [(lot1, [alice_opt_id]), (lot2, [alice_opt_id, bob_opt_id])]:
            # Create a vote submission directly via DB
            emails_result = await db_session.execute(
                select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
            )
            email = emails_result.scalars().first()
            voter_email = email.email if email else "voter@test.com"
            token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)
            for opt_id in opts:
                db_session.add(Vote(
                    general_meeting_id=meeting_id,
                    motion_id=mc_motion_id,
                    voter_email=voter_email,
                    lot_owner_id=lot.id,
                    choice=VoteChoice.selected,
                    motion_option_id=opt_id,
                    status=VoteStatus.submitted,
                ))
            # Also vote on general motion (abstained)
            gen_motion = next(m for m in mc_meeting["motions"] if not m["is_multi_choice"])
            db_session.add(Vote(
                general_meeting_id=meeting_id,
                motion_id=uuid.UUID(gen_motion["id"]),
                voter_email=voter_email,
                lot_owner_id=lot.id,
                choice=VoteChoice.abstained,
                status=VoteStatus.submitted,
            ))
            db_session.add(BallotSubmission(
                general_meeting_id=meeting_id,
                lot_owner_id=lot.id,
                voter_email=voter_email,
            ))
        await db_session.commit()

        resp = await client.get(f"/api/admin/general-meetings/{meeting_id}")
        assert resp.status_code == 200
        data = resp.json()
        mc_detail = next(m for m in data["motions"] if m["is_multi_choice"])

        # Alice selected by lot1 (100) and lot2 (200) = 300 entitlement, 2 voters
        alice_tally = next(o for o in mc_detail["tally"]["options"] if o["option_text"] == "Alice")
        assert alice_tally["voter_count"] == 2
        assert alice_tally["entitlement_sum"] == 300

        # Bob selected by lot2 (200) = 200 entitlement, 1 voter
        bob_tally = next(o for o in mc_detail["tally"]["options"] if o["option_text"] == "Bob")
        assert bob_tally["voter_count"] == 1
        assert bob_tally["entitlement_sum"] == 200

        # Carol not selected
        carol_tally = next(o for o in mc_detail["tally"]["options"] if o["option_text"] == "Carol")
        assert carol_tally["voter_count"] == 0
        assert carol_tally["entitlement_sum"] == 0

        # yes/no are zero for multi-choice
        assert mc_detail["tally"]["yes"]["voter_count"] == 0
        assert mc_detail["tally"]["no"]["voter_count"] == 0


class TestToggleVisibilityMultiChoice:
    # --- Happy path ---

    async def test_toggle_visibility_returns_options(
        self, client: AsyncClient, mc_meeting: dict
    ):
        """Toggle visibility on multi-choice motion includes options in response."""
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        motion_id = mc_motion["id"]

        # Hide it
        resp = await client.patch(
            f"/api/admin/motions/{motion_id}/visibility",
            json={"is_visible": False},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["motion_type"] == "general"
        assert data["is_multi_choice"] is True
        assert len(data["options"]) == 3
        assert data["option_limit"] == 2


# ---------------------------------------------------------------------------
# Slice 3: Voter API — multi-choice
# ---------------------------------------------------------------------------


class TestListMotionsWithMultiChoice:
    # --- Happy path ---

    async def test_list_motions_includes_options_for_mc(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """GET motions endpoint returns options and option_limit for multi-choice."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        motions = resp.json()
        mc_motion = next(m for m in motions if m["is_multi_choice"])
        assert mc_motion["option_limit"] == 2
        assert len(mc_motion["options"]) == 3
        assert mc_motion["options"][0]["text"] == "Alice"
        assert mc_motion["already_voted"] is False

    async def test_list_motions_general_motion_has_empty_options(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """General motion in list has empty options and null option_limit."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        motions = resp.json()
        gen_motion = next(m for m in motions if not m["is_multi_choice"])
        assert gen_motion["options"] == []
        assert gen_motion["option_limit"] is None


class TestSubmitBallotMultiChoice:
    # --- Happy path ---

    async def test_submit_multi_choice_ballot_happy_path(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Voter submits multi-choice ballot with valid options; Vote rows created."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        gen_motion = next(m for m in mc_meeting["motions"] if not m["is_multi_choice"])
        alice_opt_id = mc_motion["options"][0]["id"]
        bob_opt_id = mc_motion["options"][1]["id"]

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [{"motion_id": gen_motion["id"], "choice": "yes"}],
            "multi_choice_votes": [
                {
                    "motion_id": mc_motion["id"],
                    "option_choices": [
                        {"option_id": alice_opt_id, "choice": "for"},
                        {"option_id": bob_opt_id, "choice": "for"},
                    ],
                }
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["submitted"] is True

        # Verify vote rows in DB
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.status == VoteStatus.submitted,
            )
        )
        votes = list(votes_result.scalars().all())
        mc_votes = [v for v in votes if v.motion_id == uuid.UUID(mc_motion["id"])]
        assert len(mc_votes) == 2
        opt_ids = {v.motion_option_id for v in mc_votes}
        assert uuid.UUID(alice_opt_id) in opt_ids
        assert uuid.UUID(bob_opt_id) in opt_ids
        for v in mc_votes:
            assert v.choice == VoteChoice.selected

    async def test_submit_mc_abstain_when_no_options_selected(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Voter sends empty option_ids for MC motion — records abstained."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {"motion_id": mc_motion["id"], "option_choices": []}
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.motion_id == uuid.UUID(mc_motion["id"]),
                Vote.status == VoteStatus.submitted,
            )
        )
        mc_votes = list(votes_result.scalars().all())
        # Abstained = one vote row with choice=abstained and no motion_option_id
        assert len(mc_votes) == 1
        assert mc_votes[0].choice == VoteChoice.abstained
        assert mc_votes[0].motion_option_id is None

    async def test_submit_mc_without_mc_votes_records_abstained(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Voter doesn't include multi_choice_votes — MC motion recorded as abstained."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.motion_id == uuid.UUID(mc_motion["id"]),
                Vote.status == VoteStatus.submitted,
            )
        )
        mc_votes = list(votes_result.scalars().all())
        assert len(mc_votes) == 1
        assert mc_votes[0].choice == VoteChoice.abstained

    # --- Input validation ---

    async def test_submit_with_invalid_option_id_rejected(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Submitting an option_id that doesn't belong to the motion returns 400."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        fake_option_id = str(uuid.uuid4())
        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {"motion_id": mc_motion["id"], "option_choices": [{"option_id": fake_option_id, "choice": "for"}]}
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 400

    async def test_submit_exceeding_option_limit_rejected(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Submitting more option_ids than option_limit returns 422."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        # option_limit=2, try to submit 3
        opt_ids = [o["id"] for o in mc_motion["options"]]

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {
                    "motion_id": mc_motion["id"],
                    "option_choices": [{"option_id": oid, "choice": "for"} for oid in opt_ids],  # 3 opts, limit=2
                }
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422

    async def test_submit_unknown_mc_motion_id_rejected(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Submitting multi_choice_votes with unknown motion_id returns 400."""
        meeting_id = uuid.UUID(mc_meeting["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {"motion_id": str(uuid.uuid4()), "option_choices": [{"option_id": str(uuid.uuid4()), "choice": "for"}]}
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 400

    # --- State tests ---

    async def test_in_arrear_lot_gets_not_eligible_on_mc_motion(
        self,
        client: AsyncClient,
        mc_building: Building,
        db_session: AsyncSession,
    ):
        """In-arrear lots get not_eligible for multi-choice motions (same as general)."""
        from app.models import FinancialPositionSnapshot

        # Create meeting with a multi-choice motion
        payload = {
            "building_id": str(mc_building.id),
            "title": "In Arrear MC Meeting",
            "meeting_at": meeting_dt().isoformat(),
            "voting_closes_at": closing_dt().isoformat(),
            "motions": [
                {
                    "title": "MC Motion",
                    "display_order": 1,
                    "motion_type": "general",
                    "is_multi_choice": True,
                    "option_limit": 1,
                    "options": [
                        {"text": "Alice", "display_order": 1},
                        {"text": "Bob", "display_order": 2},
                    ],
                }
            ],
        }
        create_resp = await client.post("/api/admin/general-meetings", json=payload)
        assert create_resp.status_code == 201
        meeting_data = create_resp.json()
        meeting_id = uuid.UUID(meeting_data["id"])
        mc_motion_id = meeting_data["motions"][0]["id"]
        alice_opt_id = meeting_data["motions"][0]["options"][0]["id"]

        # Get a lot owner and mark them in_arrear in the weight snapshot
        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        # Update the snapshot to in_arrear
        weight_result = await db_session.execute(
            select(GeneralMeetingLotWeight).where(
                GeneralMeetingLotWeight.general_meeting_id == meeting_id,
                GeneralMeetingLotWeight.lot_owner_id == lot.id,
            )
        )
        weight = weight_result.scalar_one()
        weight.financial_position_snapshot = FinancialPositionSnapshot.in_arrear
        await db_session.commit()

        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        # Try to vote — backend should record not_eligible
        submit_payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {"motion_id": mc_motion_id, "option_choices": [{"option_id": alice_opt_id, "choice": "for"}]}
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=submit_payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

        # Verify: not_eligible vote recorded
        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.motion_id == uuid.UUID(mc_motion_id),
                Vote.status == VoteStatus.submitted,
            )
        )
        votes = list(votes_result.scalars().all())
        assert len(votes) == 1
        assert votes[0].choice == VoteChoice.not_eligible
        assert votes[0].motion_option_id is None


class TestMyBallotMultiChoice:
    # --- Happy path ---

    async def test_my_ballot_shows_selected_options(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """my-ballot response shows selected options for multi-choice motions."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Insert Vote rows directly
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.selected,
            motion_option_id=alice_opt_id,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        lot_ballot = data["submitted_lots"][0]
        mc_vote = next(v for v in lot_ballot["votes"] if v["motion_id"] == mc_motion["id"])
        assert mc_vote["motion_type"] == "general"
        assert mc_vote["is_multi_choice"] is True
        assert mc_vote["choice"] == "selected"
        assert len(mc_vote["selected_options"]) == 1
        assert mc_vote["selected_options"][0]["text"] == "Alice"

    async def test_my_ballot_shows_abstained_for_empty_mc_vote(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """my-ballot shows abstained for multi-choice motion voted with empty options."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Insert abstained vote
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.abstained,
            motion_option_id=None,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        lot_ballot = data["submitted_lots"][0]
        mc_vote = next(v for v in lot_ballot["votes"] if v["motion_id"] == mc_motion["id"])
        assert mc_vote["choice"] == "abstained"
        assert mc_vote["selected_options"] == []

    async def test_my_ballot_multiple_mc_options_grouped(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """my-ballot groups multiple selected vote rows into one BallotVoteItem."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])
        bob_opt_id = uuid.UUID(mc_motion["options"][1]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Insert two Vote rows for the same MC motion
        for opt_id in [alice_opt_id, bob_opt_id]:
            db_session.add(Vote(
                general_meeting_id=meeting_id,
                motion_id=uuid.UUID(mc_motion["id"]),
                voter_email=voter_email,
                lot_owner_id=lot.id,
                choice=VoteChoice.selected,
                motion_option_id=opt_id,
                status=VoteStatus.submitted,
            ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        lot_ballot = data["submitted_lots"][0]
        # Should be exactly one BallotVoteItem for the MC motion
        mc_votes_items = [v for v in lot_ballot["votes"] if v["motion_id"] == mc_motion["id"]]
        assert len(mc_votes_items) == 1
        assert mc_votes_items[0]["motion_type"] == "general"
        assert mc_votes_items[0]["is_multi_choice"] is True
        assert len(mc_votes_items[0]["selected_options"]) == 2
        option_texts = {o["text"] for o in mc_votes_items[0]["selected_options"]}
        assert option_texts == {"Alice", "Bob"}

    async def test_my_ballot_second_row_abstained_option_shows_abstained(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """my-ballot: second DB row for MC motion with choice=abstained+option_id shows 'abstained'.

        Specifically exercises the `else: choice_str = "abstained"` branch in the
        already-seen path of get_my_ballot (voting_service.py, line 772).
        Two rows for the same MC motion: alice=selected (first), bob=abstained (second).
        The secondary sort by Vote.id ensures alice's row is processed first, so
        bob's row hits the already-seen branch.
        """
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])
        bob_opt_id = uuid.UUID(mc_motion["options"][1]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Insert alice (selected) first — creates the initial BallotVoteItem entry
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.selected,
            motion_option_id=alice_opt_id,
            status=VoteStatus.submitted,
        ))
        await db_session.flush()  # Force alice to get a lower Vote.id

        # Insert bob (abstained with option_id) second — hits the already-seen else branch
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.abstained,
            motion_option_id=bob_opt_id,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        lot_ballot = data["submitted_lots"][0]
        mc_votes_items = [v for v in lot_ballot["votes"] if v["motion_id"] == mc_motion["id"]]
        assert len(mc_votes_items) == 1
        assert mc_votes_items[0]["is_multi_choice"] is True
        option_choices = {oc["option_id"]: oc["choice"] for oc in mc_votes_items[0]["option_choices"]}
        assert option_choices[str(alice_opt_id)] == "for"
        assert option_choices[str(bob_opt_id)] == "abstained"


# ---------------------------------------------------------------------------
# Pydantic schema unit tests
# ---------------------------------------------------------------------------


class TestMotionOptionSchemas:
    # --- Input validation ---

    def test_motion_option_create_empty_text_rejected(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionOptionCreate
        with pytest.raises(ValidationError):
            MotionOptionCreate(text="", display_order=1)

    def test_motion_option_create_whitespace_text_rejected(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionOptionCreate
        with pytest.raises(ValidationError):
            MotionOptionCreate(text="   ", display_order=1)

    def test_motion_option_create_max_length_text_rejected(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionOptionCreate
        with pytest.raises(ValidationError):
            MotionOptionCreate(text="A" * 201, display_order=1)

    def test_motion_option_create_max_length_text_accepted(self):
        from app.schemas.admin import MotionOptionCreate
        opt = MotionOptionCreate(text="A" * 200, display_order=1)
        assert len(opt.text) == 200

    def test_motion_option_create_valid(self):
        from app.schemas.admin import MotionOptionCreate
        opt = MotionOptionCreate(text="Alice", display_order=1)
        assert opt.text == "Alice"
        assert opt.display_order == 1

    def test_motion_option_create_default_display_order(self):
        from app.schemas.admin import MotionOptionCreate
        opt = MotionOptionCreate(text="Alice")
        assert opt.display_order == 1


class TestMotionUpdateRequestMultiChoice:
    # --- Input validation ---

    def test_update_with_options_and_option_limit(self):
        from app.schemas.admin import MotionUpdateRequest, MotionOptionCreate
        req = MotionUpdateRequest(
            options=[
                MotionOptionCreate(text="A", display_order=1),
                MotionOptionCreate(text="B", display_order=2),
            ],
            option_limit=1,
        )
        assert req.option_limit == 1
        assert len(req.options) == 2

    def test_update_with_only_option_limit(self):
        from app.schemas.admin import MotionUpdateRequest
        req = MotionUpdateRequest(option_limit=3)
        assert req.option_limit == 3

    def test_update_empty_no_fields_rejected(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionUpdateRequest
        with pytest.raises(ValidationError):
            MotionUpdateRequest()

    def test_update_all_none_rejected(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionUpdateRequest
        # All None is rejected because at least one field required
        with pytest.raises(ValidationError):
            MotionUpdateRequest(title=None, description=None, motion_type=None, motion_number=None)


class TestMotionAddRequestValidation:
    """Cover MotionAddRequest validator branches (lines 320, 324, 327, 329)."""

    def test_add_multi_choice_option_limit_zero_rejected(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionAddRequest, MotionOptionCreate
        with pytest.raises(ValidationError):
            MotionAddRequest(
                title="Election",
                is_multi_choice=True,
                option_limit=0,
                options=[
                    MotionOptionCreate(text="A", display_order=1),
                    MotionOptionCreate(text="B", display_order=2),
                ],
            )

    def test_add_multi_choice_option_limit_exceeds_count(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionAddRequest, MotionOptionCreate
        with pytest.raises(ValidationError):
            MotionAddRequest(
                title="Election",
                is_multi_choice=True,
                option_limit=3,
                options=[
                    MotionOptionCreate(text="A", display_order=1),
                    MotionOptionCreate(text="B", display_order=2),
                ],
            )

    def test_add_non_mc_with_option_limit_rejected(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionAddRequest
        with pytest.raises(ValidationError):
            MotionAddRequest(
                title="Budget",
                motion_type=MotionType.general,
                option_limit=1,
            )

    def test_add_non_mc_with_options_rejected(self):
        from pydantic import ValidationError
        from app.schemas.admin import MotionAddRequest, MotionOptionCreate
        with pytest.raises(ValidationError):
            MotionAddRequest(
                title="Budget",
                motion_type=MotionType.general,
                options=[MotionOptionCreate(text="A", display_order=1)],
            )


class TestReorderMotionsWithMultiChoice:
    """Cover reorder_motions with multi-choice motions (lines 2115-2121)."""

    async def test_reorder_meeting_with_mc_motion_returns_options(
        self, client: AsyncClient, mc_meeting: dict
    ):
        """Reordering motions in a meeting with multi-choice returns options in response."""
        meeting_id = mc_meeting["id"]
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        gen_motion = next(m for m in mc_meeting["motions"] if not m["is_multi_choice"])

        # Reorder: put general first, mc second
        payload = {
            "motions": [
                {"motion_id": gen_motion["id"], "display_order": 1},
                {"motion_id": mc_motion["id"], "display_order": 2},
            ]
        }
        resp = await client.put(
            f"/api/admin/general-meetings/{meeting_id}/motions/reorder",
            json=payload,
        )
        assert resp.status_code == 200
        data = resp.json()
        mc_result = next(m for m in data["motions"] if m["id"] == mc_motion["id"])
        assert mc_result["option_limit"] == 2
        assert len(mc_result["options"]) == 3


class TestListMotionsSubmittedOptionChoices:
    """list_motions returns submitted_option_choices (option_id → choice string) for already-voted MC motions."""

    # --- Happy path ---

    async def test_list_motions_returns_submitted_option_choices_after_vote(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """After a voter submits a multi-choice ballot, list_motions returns
        submitted_option_choices with option_id → choice string mapping."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])
        bob_opt_id = uuid.UUID(mc_motion["options"][1]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Insert selected Vote rows directly
        for opt_id in [alice_opt_id, bob_opt_id]:
            db_session.add(Vote(
                general_meeting_id=meeting_id,
                motion_id=uuid.UUID(mc_motion["id"]),
                voter_email=voter_email,
                lot_owner_id=lot.id,
                choice=VoteChoice.selected,
                motion_option_id=opt_id,
                status=VoteStatus.submitted,
            ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        motions = resp.json()
        mc_out = next(m for m in motions if m["is_multi_choice"])
        assert mc_out["already_voted"] is True
        submitted_choices = mc_out["submitted_option_choices"]
        assert str(alice_opt_id) in submitted_choices
        assert str(bob_opt_id) in submitted_choices
        assert submitted_choices[str(alice_opt_id)] == "for"
        assert submitted_choices[str(bob_opt_id)] == "for"
        assert len(submitted_choices) == 2

    async def test_list_motions_submitted_option_choices_empty_before_vote(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Before voting, submitted_option_choices is an empty dict."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        motions = resp.json()
        mc_out = next(m for m in motions if m["is_multi_choice"])
        assert mc_out["submitted_option_choices"] == {}

    async def test_list_motions_submitted_option_choices_empty_on_abstain(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """When voter abstains (choice=abstained, no option), submitted_option_choices is empty dict."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.abstained,
            motion_option_id=None,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        motions = resp.json()
        mc_out = next(m for m in motions if m["is_multi_choice"])
        assert mc_out["already_voted"] is True
        assert mc_out["submitted_option_choices"] == {}

    async def test_list_motions_general_motion_submitted_option_choices_always_empty(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """General (non-MC) motions always have empty submitted_option_choices dict."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        gen_motion = next(m for m in mc_meeting["motions"] if not m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(gen_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        motions = resp.json()
        gen_out = next(m for m in motions if not m["is_multi_choice"])
        assert gen_out["submitted_option_choices"] == {}

    # --- Edge cases ---

    async def test_list_motions_deduplicates_option_choices_from_multiple_lots(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """If the voter controls multiple lots that each voted for the same option,
        submitted_option_choices deduplicates — each option ID appears at most once."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])

        # Get two lots for the same voter email
        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(2)
        )
        lots = list(lots_result.scalars().all())
        assert len(lots) >= 2

        # Give both lots the same voter email
        voter_email = "shared@test.com"
        for lot in lots:
            db_session.add(LotOwnerEmail(lot_owner_id=lot.id, email=voter_email))
        await db_session.flush()

        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        for lot in lots:
            db_session.add(Vote(
                general_meeting_id=meeting_id,
                motion_id=uuid.UUID(mc_motion["id"]),
                voter_email=voter_email,
                lot_owner_id=lot.id,
                choice=VoteChoice.selected,
                motion_option_id=alice_opt_id,
                status=VoteStatus.submitted,
            ))
            db_session.add(BallotSubmission(
                general_meeting_id=meeting_id,
                lot_owner_id=lot.id,
                voter_email=voter_email,
            ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        motions = resp.json()
        mc_out = next(m for m in motions if m["is_multi_choice"])
        # Alice's option should appear only once despite two lots
        submitted_choices = mc_out["submitted_option_choices"]
        assert str(alice_opt_id) in submitted_choices
        assert submitted_choices[str(alice_opt_id)] == "for"
        assert len(submitted_choices) == 1


class TestAbstainedIdsComputationFix:
    """Fix 3: abstained_ids uses this motion's vote rows, not global submitted_lot_owner_ids.

    Bug: abstained_ids was computed as submitted_lot_owner_ids - not_eligible_ids - selected_lot_ids.
    This caused lots that abstained on OTHER motions (but had no vote row for THIS motion) to
    appear as abstained in the MC tally when the meeting was still open (no absent records yet).

    Fix: derive abstained_ids from motion_vote_rows filtered to choice=="abstained".
    """

    # --- Happy path ---

    async def test_abstained_ids_only_counts_lots_with_explicit_abstain_vote(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Lot that voted abstained on the MC motion appears in abstained tally."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        email_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        voter_email = email_result.scalars().first().email

        # Submit: abstain on MC motion
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.abstained,
            motion_option_id=None,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(f"/api/admin/general-meetings/{meeting_id}")
        assert resp.status_code == 200
        data = resp.json()
        mc_detail = next(m for m in data["motions"] if m["is_multi_choice"])
        assert mc_detail["tally"]["abstained"]["voter_count"] == 1

    async def test_abstained_ids_excludes_lots_that_only_voted_on_other_motions(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Bug fix: a lot that voted yes on the general motion but has no vote row for
        the MC motion must NOT appear in the MC tally's abstained category.

        Before the fix, abstained = submitted_lot_owner_ids - not_eligible - selected,
        so any submitted lot with no selected/not_eligible vote on the MC motion was
        counted as abstained even if they never submitted a vote for that motion.
        """
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        gen_motion = next(m for m in mc_meeting["motions"] if not m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        email_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        voter_email = email_result.scalars().first().email

        # Submit a vote only on the GENERAL motion (not on the MC motion)
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(gen_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.yes,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(f"/api/admin/general-meetings/{meeting_id}")
        assert resp.status_code == 200
        data = resp.json()
        mc_detail = next(m for m in data["motions"] if m["is_multi_choice"])
        # The lot should NOT appear as abstained on the MC motion because it has no vote row for it
        assert mc_detail["tally"]["abstained"]["voter_count"] == 0

    async def test_abstained_ids_not_eligible_lot_not_counted_as_abstained(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Lot with not_eligible vote on MC motion must not appear in abstained tally."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        email_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        voter_email = email_result.scalars().first().email

        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.not_eligible,
            motion_option_id=None,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(f"/api/admin/general-meetings/{meeting_id}")
        assert resp.status_code == 200
        data = resp.json()
        mc_detail = next(m for m in data["motions"] if m["is_multi_choice"])
        assert mc_detail["tally"]["abstained"]["voter_count"] == 0
        assert mc_detail["tally"]["not_eligible"]["voter_count"] == 1


class TestAdminServiceSanitiseOptionText:
    # --- Unit tests for the sanitise function ---

    def test_sanitise_strips_html(self):
        from app.services.admin_service import _sanitise_option_text
        result = _sanitise_option_text("<b>Alice</b>")
        assert result == "Alice"

    def test_sanitise_plain_text_unchanged(self):
        from app.services.admin_service import _sanitise_option_text
        result = _sanitise_option_text("Alice Smith")
        assert result == "Alice Smith"

    def test_sanitise_strips_leading_trailing_spaces(self):
        from app.services.admin_service import _sanitise_option_text
        result = _sanitise_option_text("  Alice  ")
        assert result == "Alice"


class TestSlice3ForAgainstAbstain:
    """Slice 3 — Per-option For/Against/Abstain on multi-choice motions.

    Test cases from the design doc Slice 3 section:
    - Submit with For on 2 options (limit 2): 2 Vote(choice=selected) rows
    - Submit with Against on 1 option: 1 Vote(choice=against) row
    - Submit with For > option_limit: returns 422
    - Motion-level abstain (no option_choices): 1 Vote(choice=abstained, option_id=None)
    - Mixed For/Against/Abstain per option
    - get_my_ballot returns per-option choices including 'against'
    - list_motions returns submitted_option_choices with 'against' choices
    - option_limit only counts 'for' choices; 'against'/'abstained' don't consume the limit
    """

    async def test_submit_for_two_options_stores_selected(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Submit For on 2 options within limit: 2 Vote(choice=selected) rows created."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = mc_motion["options"][0]["id"]
        bob_opt_id = mc_motion["options"][1]["id"]

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {
                    "motion_id": mc_motion["id"],
                    "option_choices": [
                        {"option_id": alice_opt_id, "choice": "for"},
                        {"option_id": bob_opt_id, "choice": "for"},
                    ],
                }
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.motion_id == uuid.UUID(mc_motion["id"]),
                Vote.status == VoteStatus.submitted,
            )
        )
        mc_votes = list(votes_result.scalars().all())
        assert len(mc_votes) == 2
        for v in mc_votes:
            assert v.choice == VoteChoice.selected
        opt_ids = {v.motion_option_id for v in mc_votes}
        assert uuid.UUID(alice_opt_id) in opt_ids
        assert uuid.UUID(bob_opt_id) in opt_ids

    async def test_submit_against_one_option_stores_against(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Submit Against on 1 option: 1 Vote(choice=against) row stored."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = mc_motion["options"][0]["id"]

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {
                    "motion_id": mc_motion["id"],
                    "option_choices": [
                        {"option_id": alice_opt_id, "choice": "against"},
                    ],
                }
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.motion_id == uuid.UUID(mc_motion["id"]),
                Vote.status == VoteStatus.submitted,
                Vote.motion_option_id == uuid.UUID(alice_opt_id),
            )
        )
        mc_votes = list(votes_result.scalars().all())
        assert len(mc_votes) == 1
        assert mc_votes[0].choice == VoteChoice.against

    async def test_submit_for_exceeds_limit_returns_422(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Submitting more 'for' choices than option_limit returns 422."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        # option_limit=2, send 3 'for' choices
        opt_ids = [o["id"] for o in mc_motion["options"]]

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {
                    "motion_id": mc_motion["id"],
                    "option_choices": [
                        {"option_id": oid, "choice": "for"} for oid in opt_ids
                    ],
                }
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422

    async def test_against_does_not_consume_option_limit(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Against choices do not count toward option_limit; 2 for + 1 against within limit=2."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        # option_limit=2; send 2 'for' + 1 'against' — should succeed
        opt_ids = [o["id"] for o in mc_motion["options"]]
        alice_opt_id, bob_opt_id, carol_opt_id = opt_ids[0], opt_ids[1], opt_ids[2]

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {
                    "motion_id": mc_motion["id"],
                    "option_choices": [
                        {"option_id": alice_opt_id, "choice": "for"},
                        {"option_id": bob_opt_id, "choice": "for"},
                        {"option_id": carol_opt_id, "choice": "against"},
                    ],
                }
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.motion_id == uuid.UUID(mc_motion["id"]),
                Vote.status == VoteStatus.submitted,
            )
        )
        mc_votes = list(votes_result.scalars().all())
        assert len(mc_votes) == 3
        choices_by_opt = {str(v.motion_option_id): v.choice for v in mc_votes}
        assert choices_by_opt[alice_opt_id] == VoteChoice.selected
        assert choices_by_opt[bob_opt_id] == VoteChoice.selected
        assert choices_by_opt[carol_opt_id] == VoteChoice.against

    async def test_motion_level_abstain_when_no_option_choices(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """No option_choices sent → motion-level abstain: 1 Vote(choice=abstained, option_id=None)."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {"motion_id": mc_motion["id"], "option_choices": []},
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.motion_id == uuid.UUID(mc_motion["id"]),
                Vote.status == VoteStatus.submitted,
            )
        )
        mc_votes = list(votes_result.scalars().all())
        assert len(mc_votes) == 1
        assert mc_votes[0].choice == VoteChoice.abstained
        assert mc_votes[0].motion_option_id is None

    async def test_get_my_ballot_returns_option_choices_including_against(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """get_my_ballot returns option_choices including 'against' entries."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])
        bob_opt_id = uuid.UUID(mc_motion["options"][1]["id"])
        carol_opt_id = uuid.UUID(mc_motion["options"][2]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Alice: For, Bob: Against, Carol: Abstained
        for opt_id, vote_choice in [
            (alice_opt_id, VoteChoice.selected),
            (bob_opt_id, VoteChoice.against),
            (carol_opt_id, VoteChoice.abstained),
        ]:
            db_session.add(Vote(
                general_meeting_id=meeting_id,
                motion_id=uuid.UUID(mc_motion["id"]),
                voter_email=voter_email,
                lot_owner_id=lot.id,
                choice=vote_choice,
                motion_option_id=opt_id,
                status=VoteStatus.submitted,
            ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        lot_ballot = data["submitted_lots"][0]
        mc_vote = next(v for v in lot_ballot["votes"] if v["motion_id"] == mc_motion["id"])
        assert mc_vote["is_multi_choice"] is True
        option_choices = {oc["option_id"]: oc["choice"] for oc in mc_vote["option_choices"]}
        assert option_choices[str(alice_opt_id)] == "for"
        assert option_choices[str(bob_opt_id)] == "against"
        assert option_choices[str(carol_opt_id)] == "abstained"

    async def test_list_motions_returns_against_in_submitted_option_choices(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """list_motions returns submitted_option_choices including 'against' choices."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])
        carol_opt_id = uuid.UUID(mc_motion["options"][2]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Alice: For, Carol: Against
        for opt_id, vote_choice in [
            (alice_opt_id, VoteChoice.selected),
            (carol_opt_id, VoteChoice.against),
        ]:
            db_session.add(Vote(
                general_meeting_id=meeting_id,
                motion_id=uuid.UUID(mc_motion["id"]),
                voter_email=voter_email,
                lot_owner_id=lot.id,
                choice=vote_choice,
                motion_option_id=opt_id,
                status=VoteStatus.submitted,
            ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        motions = resp.json()
        mc_out = next(m for m in motions if m["is_multi_choice"])
        submitted_choices = mc_out["submitted_option_choices"]
        assert submitted_choices[str(alice_opt_id)] == "for"
        assert submitted_choices[str(carol_opt_id)] == "against"

    async def test_per_option_abstain_stored_with_option_id(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """Per-option 'abstained' choice stores Vote(choice=abstained, motion_option_id set)."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = mc_motion["options"][0]["id"]

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        token = await _create_voter_session(db_session, meeting_id, email.email, mc_building.id)

        payload = {
            "lot_owner_ids": [str(lot.id)],
            "votes": [],
            "multi_choice_votes": [
                {
                    "motion_id": mc_motion["id"],
                    "option_choices": [
                        {"option_id": alice_opt_id, "choice": "abstained"},
                    ],
                }
            ],
        }
        resp = await client.post(
            f"/api/general-meeting/{meeting_id}/submit",
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200

        votes_result = await db_session.execute(
            select(Vote).where(
                Vote.general_meeting_id == meeting_id,
                Vote.lot_owner_id == lot.id,
                Vote.motion_id == uuid.UUID(mc_motion["id"]),
                Vote.status == VoteStatus.submitted,
            )
        )
        mc_votes = list(votes_result.scalars().all())
        assert len(mc_votes) == 1
        assert mc_votes[0].choice == VoteChoice.abstained
        # Per-option abstain has motion_option_id set (unlike motion-level abstain)
        assert mc_votes[0].motion_option_id == uuid.UUID(alice_opt_id)

    async def test_votechoice_against_enum_value_exists(self):
        """VoteChoice enum has 'against' value stored as 'against'."""
        assert VoteChoice.against == "against"
        assert VoteChoice.against.value == "against"

    async def test_list_motions_returns_abstained_choice_for_per_option_abstain(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """list_motions returns 'abstained' choice string for per-option abstained votes."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Insert per-option abstained vote (motion_option_id set, choice=abstained)
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.abstained,
            motion_option_id=alice_opt_id,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/motions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        motions = resp.json()
        mc_out = next(m for m in motions if m["is_multi_choice"])
        submitted_choices = mc_out["submitted_option_choices"]
        assert submitted_choices[str(alice_opt_id)] == "abstained"

    async def test_get_my_ballot_first_row_against_shows_against_choice(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """get_my_ballot: when first DB row for MC motion has choice=against, option_choices shows 'against'."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Only one vote row: against on Alice
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.against,
            motion_option_id=alice_opt_id,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        lot_ballot = data["submitted_lots"][0]
        mc_vote = next(v for v in lot_ballot["votes"] if v["motion_id"] == mc_motion["id"])
        assert mc_vote["is_multi_choice"] is True
        assert len(mc_vote["option_choices"]) == 1
        assert mc_vote["option_choices"][0]["choice"] == "against"
        assert mc_vote["option_choices"][0]["option_id"] == str(alice_opt_id)

    async def test_get_my_ballot_first_row_per_option_abstain_shows_abstained(
        self,
        client: AsyncClient,
        mc_meeting: dict,
        db_session: AsyncSession,
        mc_building: Building,
    ):
        """get_my_ballot: when first DB row for MC motion has choice=abstained with option_id, shows 'abstained'."""
        meeting_id = uuid.UUID(mc_meeting["id"])
        mc_motion = next(m for m in mc_meeting["motions"] if m["is_multi_choice"])
        alice_opt_id = uuid.UUID(mc_motion["options"][0]["id"])

        lots_result = await db_session.execute(
            select(LotOwner).where(LotOwner.building_id == mc_building.id).limit(1)
        )
        lot = lots_result.scalars().first()
        emails_result = await db_session.execute(
            select(LotOwnerEmail).where(LotOwnerEmail.lot_owner_id == lot.id).limit(1)
        )
        email = emails_result.scalars().first()
        voter_email = email.email
        token = await _create_voter_session(db_session, meeting_id, voter_email, mc_building.id)

        # Only one vote row: per-option abstain on Alice (motion_option_id set)
        db_session.add(Vote(
            general_meeting_id=meeting_id,
            motion_id=uuid.UUID(mc_motion["id"]),
            voter_email=voter_email,
            lot_owner_id=lot.id,
            choice=VoteChoice.abstained,
            motion_option_id=alice_opt_id,
            status=VoteStatus.submitted,
        ))
        db_session.add(BallotSubmission(
            general_meeting_id=meeting_id,
            lot_owner_id=lot.id,
            voter_email=voter_email,
        ))
        await db_session.commit()

        resp = await client.get(
            f"/api/general-meeting/{meeting_id}/my-ballot",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        lot_ballot = data["submitted_lots"][0]
        mc_vote = next(v for v in lot_ballot["votes"] if v["motion_id"] == mc_motion["id"])
        assert mc_vote["is_multi_choice"] is True
        assert len(mc_vote["option_choices"]) == 1
        assert mc_vote["option_choices"][0]["choice"] == "abstained"
        assert mc_vote["option_choices"][0]["option_id"] == str(alice_opt_id)
