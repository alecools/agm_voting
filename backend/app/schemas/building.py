import uuid

from pydantic import BaseModel


class BuildingOut(BaseModel):
    id: uuid.UUID
    name: str

    model_config = {"from_attributes": True}
